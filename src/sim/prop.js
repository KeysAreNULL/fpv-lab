// Propeller aerodynamics.
//
// The model is momentum theory with measured-style coefficient curves, which is
// what makes it stable enough to run at 5 kHz inside a closed loop with the
// other three props:
//
//   1. Thrust is set by rpm and a thrust-coefficient curve. The curve is keyed
//      to the *effective* advance ratio, i.e. the axial disc velocity with the
//      static induced component removed:
//          J_eff = V_disc / (n D) - sqrt(2 CT0 / pi)
//      so J_eff = 0 in a clean hover, >0 in forward flight (drag rises, CT
//      falls) and <0 when another prop's wake arrives (thrust rises, which is
//      exactly what propwash does to a quad).
//   2. Power comes from an induced-power term divided by a figure of merit, so
//      the shaft torque is always physical and the motor solver stays stable.
//   3. Induced velocity is solved from momentum theory and handed to the other
//      props as a wash source.
//   4. Ground effect raises thrust via Prandtl's correction; vortex ring state
//      collapses it when the disc is at a high angle of attack and slow.
//
// Everything is SI. `n` is revolutions per second, not rpm.

import { clamp, tableEval, smoothstep } from '../core/math.js';

const MU = 1.81e-5; // air dynamic viscosity, Pa*s

// Normalised thrust/power coefficient response to effective advance ratio.
const CT_CURVE = [
  [-0.45, 1.32], [-0.30, 1.21], [-0.20, 1.12], [-0.10, 1.055], [0.0, 1.0],
  [0.10, 0.945], [0.20, 0.878], [0.30, 0.800], [0.40, 0.712], [0.50, 0.612],
  [0.60, 0.500], [0.70, 0.375], [0.80, 0.240], [0.90, 0.115], [1.00, 0.02],
];
const FM_CURVE = [
  [-0.45, 0.62], [-0.30, 0.80], [-0.20, 0.90], [-0.10, 0.955], [0.0, 1.0],
  [0.10, 0.985], [0.20, 0.945], [0.30, 0.885], [0.40, 0.815], [0.50, 0.740],
  [0.60, 0.660], [0.75, 0.555], [0.90, 0.450], [1.05, 0.360],
];

export class Prop {
  /** @param {object} spec catalog prop entry */
  constructor(spec) {
    this.spec = spec;
    this.D = spec.D__mm / 1000;
    this.pitch = spec.pitch__mm / 1000;
    this.blades = spec.blades;
    this.A = Math.PI * this.D * this.D / 4;
    this.mass = spec.mass__m / 1000;
    // Mean blade chord from pitch ratio; used for the Reynolds number.
    this.chord = clamp(0.075 * this.D * (this.pitch / (0.86 * this.D)), 0.002, 0.04);

    // --- static thrust coefficient, anchored on the well-known 5x4.3x3 result
    // (about 0.17 CT0, 1.2 kg static thrust at 28k rpm in 1.225 kg/m3 air).
    this.CT0 = 0.17
      * Math.pow(this.blades / 3, -0.30)
      * Math.pow((this.pitch / (0.86 * this.D)) ** 0.55, 1)
      * Math.pow(this.D / 0.127, 0.10);
    this.fmBase = spec.fmBase;
    this.sizeBonus = 1 + 0.10 * Math.log2(Math.max(0.4, this.D / 0.127));

    // Effective advance ratio that corresponds to a clean static hover.
    this.Jhover = Math.sqrt(Math.max(1e-4, 2 * this.CT0 / Math.PI));
    // Rotational inertia of the prop itself (hub + blades as a ring).
    this.Irotor = (this.mass * this.D * this.D) / 8 * 1.9;

    // Runtime state, refreshed every solver pass.
    this.n = 0;
    this.thrust = 0;
    this.torque = 0;
    this.power = 0;
    this.w = 0;          // induced velocity at the disc (m/s)
    this.swirl = 0;      // tangential component of the induced flow
    this.Vdisc = 0;      // axial disc velocity used for J_eff
    this.Jeff = 0;
    this.washFrom = 0;   // dB-ish scalar, how much of the inflow is wake
    this.geFactor = 1;
    this.ringFactor = 1;
    this.eff = 0;
    this.RPM = 0;
  }

  /** Reynolds-limited figure of merit (small props are viscous, not efficient). */
  fmReynolds(vTip) {
    const Re = 1.225 * vTip * this.chord / MU;
    const f = 0.70 + 0.30 * Math.cbrt(Re / (Re + 3.0e5));
    return this.fmBase * f * this.sizeBonus;
  }

  /**
   * Solve one prop.
   * @param {number} n       revolutions per second
   * @param {object} u       axial disc velocity (m/s, + = air arriving at the disc)
   * @param {number} density kg/m^3
   * @param {object} opt     { aoa, height, altitudeFactor, ring }
   * @returns {object} per-step results
   */
  solve(n, u, density, opt = {}) {
    const nSafe = Math.max(0, n);
    const vTip = Math.PI * this.D * nSafe;
    this.RPM = nSafe * 60;

    // Reynolds / speed correction: a prop that never reaches its design speed
    // loses figure of merit, which is why undersized props on big motors suffer.
    const fm0 = this.fmReynolds(vTip);

    // Advance ratio. u is the free-stream axial component at the disc, positive
    // when air is arriving through the disc (descending, or flying backwards
    // into the rotors). CT0 is the static value at u = 0, so no offset is needed
    // here: Jhover is what momentum theory will produce, not an input.
    const Jeff = u / Math.max(1e-6, nSafe * this.D);

    const ctShape = tableEval(CT_CURVE, Jeff);
    const fmShape = tableEval(FM_CURVE, Jeff);
    let CT = this.CT0 * ctShape;
    const FM = Math.max(0.05, fm0 * fmShape);

    // --- ground effect. The streamtube cannot expand below roughly one rotor
    // diameter, so a prop close to the ground makes more thrust from the same
    // induced velocity. Fitted to rotorcraft measurements: about +35 % at
    // h/D = 0.3, +18 % at 0.5, +6 % at 1, negligible past 2.
    const h = Math.max(0, opt.height != null ? opt.height : 99);
    const hd = h / this.D;
    const ge = 1 + 0.62 / (1 + Math.pow(hd / 0.34, 2.1));
    this.geFactor = ge;
    this.surfaceWash = opt.surfaceWash || 0;

    // --- vortex ring state: a disc at high angle of attack with almost no
    // through-flow sheds its tip vortices into a ring and stops making useful
    // thrust. The state is hysteretic because the rings take time to wash off,
    // which is why a quad that tips over hard keeps "falling" for a moment.
    const aoa = Math.abs(opt.aoa || 0);
    const speed = Math.abs(opt.speed || 0);
    const ringDrive = smoothstep(0.62, 1.15, aoa) * smoothstep(2.6, 0.35, speed);
    // Hysteresis only matters once engaged; from clean air it must reach 1.
    const held = this.ringFactor > 0.9 ? ringDrive : Math.max(ringDrive, this.ringFactor * 0.97);
    this.ringFactor = clamp(1 - 0.72 * held, 0.05, 1);
    if (opt.ring != null) this.ringFactor = clamp(opt.ring, 0.05, 1);

    CT *= ge * this.ringFactor;
    // Wash and ground effect both raise the operating point, so the induced
    // velocity is solved rather than assumed.
    const T = CT * density * nSafe * nSafe * Math.pow(this.D, 4);

    // Momentum theory: T = 2 rho A Vd w with Vd = u + w.
    //   w^2 + u w - T / (2 rho A) = 0
    const twoRhoA = 2 * density * this.A;
    const cTerm = T / Math.max(1e-9, twoRhoA);
    const w = (-u + Math.sqrt(Math.max(0, u * u + 4 * cTerm))) / 2;
    const Vd = u + w;
    this.Jhover = w / Math.max(1e-6, nSafe * this.D);

    // Shaft power: induced power from the figure of merit, plus the profile
    // power floor that keeps a spinning prop from costing nothing.
    const Pinduced = Math.pow(Math.max(T, 0), 1.5) / Math.sqrt(Math.max(1e-9, 2 * density * this.A));
    const Pprofile = 0.0022 * density * nSafe * nSafe * nSafe * Math.pow(this.D, 5) * 2.0;
    const power = Pinduced / FM + Pprofile;
    const torque = nSafe > 1 ? power / (2 * Math.PI * nSafe) : 0;

    this.n = nSafe; this.thrust = T; this.torque = torque; this.power = power;
    this.w = w; this.Vdisc = Vd; this.Jeff = Jeff;
    this.fm = FM;
    // Helical wake: swirl angle beta = atan(U / (2 pi n r)).
    this.swirl = nSafe > 1 ? Math.atan(Math.abs(Vd) / (2 * Math.PI * nSafe * this.D * 0.45)) : 0;
    this.tipSpeed = vTip;
    this.eff = power > 1 ? T / power : 0; // N/W
    return this;
  }

  /** Wake velocity this prop leaves at a point offset from its hub.
   * The slipstream leaves the disc as a column roughly the diameter of the prop
   * and spreads at about 11 degrees half angle downstream, so the tube grows
   * linearly with distance. Inside it there is a faster vortex core and a slower
   * surrounding jet; outside, viscous decay has eaten the flow.
   */
  wakeAt(offset, axisWorld, density, out = {}) {
    const dAx = offset.x * axisWorld.x + offset.y * axisWorld.y + offset.z * axisWorld.z;
    if (dAx <= 0) { out.hit = false; out.axial = 0; out.tangential = 0; return out; }
    const rx = offset.x - dAx * axisWorld.x;
    const ry = offset.y - dAx * axisWorld.y;
    const rz = offset.z - dAx * axisWorld.z;
    const radial = Math.hypot(rx, ry, rz);
    const dD = dAx / this.D;
    const tubeR = this.D * (0.5 * (1 + 0.19 * dD));
    const r2 = radial / Math.max(tubeR, 1e-3);
    const coreR = this.D * 0.32;
    const jet = Math.exp(-r2 * r2);
    const core = Math.exp(-Math.pow(radial / coreR, 2));
    const shape = 0.32 * jet + 0.85 * core;
    if (shape < 0.002) { out.hit = false; out.axial = 0; out.tangential = 0; return out; }
    // Axial decay: the momentum spreads into a growing tube, so the induced
    // velocity falls roughly as 1/(1 + k*d) with extra viscous loss far out.
    const decay = 1 / (1 + 0.34 * dD + 0.05 * dD * dD);
    out.hit = true;
    out.axial = this.w * decay * shape;
    out.tangential = this.w * Math.tan(this.swirl) * decay * shape;
    out.distance = dAx;
    out.radial = radial;
    return out;
  }
}

/** Convenience: figure of merit / thrust-to-power in a clean hover, for the builder UI. */
export function propHoverMetrics(prop, density = 1.225) {
  const n = 0; // filled by caller
  const p = prop.solve(0, 0.001, density, { aoa: 0, height: 99, speed: 0 });
  return p;
}
