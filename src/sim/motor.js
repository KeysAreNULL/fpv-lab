// Motor and ESC electrical model.
//
// Electrical state per motor (simplified H-bridge equivalent):
//     V_esc = duty * V_pack - FET/body-diode losses
//     dI/dt = (V_esc - R(T) I - Ke w) / L
//     tau   = Kt I - tau_losses(w) - Q_prop(w)
//
// The inductance term matters: with L ~ 40 uH and R ~ 0.09 ohm the electrical
// time constant is a fraction of a millisecond, which is the same order as the
// PID loop period. It is why throttle response feels "soft" and why a big
// punchout is a current *slope* problem as much as a steady-state one.
//
// Temperature matters too: copper resistance rises about 0.39 %/C, so a motor
// that has been flying hard for ninety seconds draws meaningfully more current
// for the same torque, sags the pack further, and can brown out the flight
// controller at the end of a pack.

import { clamp, approach, smoothstep } from '../core/math.js';

const CU_ALPHA = 0.0039;   // copper temperature coefficient, 1/C
const KPMS = 2 * Math.PI / 60;   // rad/s per rpm
const INV_TAU = 1 / (2 * Math.PI); // rad/s -> revolutions per second
// The prop callback takes rev/s (its own native unit), so angular velocity in
// rad/s must be converted with INV_TAU, not with KPMS.

export class Motor {
  /**
   * @param {object} spec catalog motor
   * @param {number} kvIndex index into spec.kv
   * @param {object} opt { bidirectional, idleThrottle }
   */
  constructor(spec, kvIndex = 0, opt = {}) {
    this.spec = spec;
    this.kv = spec.kv[clamp(kvIndex, 0, spec.kv.length - 1)];
    // Ke = 1 / (KV in rad/s per volt)
    this.Ke = 1 / (this.kv * KPMS);
    // Real outrunners are magnetically saturated, so the torque constant is
    // measurably below Ke - usually by 10-15 %. It costs efficiency and it is
    // why a motor never quite reaches its rated KV on the bench.
    this.Kt = this.Ke * (spec.ktRatio || 0.88);
    // Winding resistance is quoted at the lowest KV in the list: fewer turns of
    // thinner wire for a higher KV means much more resistance, roughly
    // R proportional to KV^-1.7.
    const kvRef = spec.kv[0];
    this.R25 = (spec.Rm__r / 1000) * Math.pow(kvRef / this.kv, 1.7);
    this.L = (spec.Lm__u || 40) * 1e-6;
    this.maxPowerW = spec.maxPowerW;
    this.Irotor = spec.J__J;
    // Friction + iron loss torque as a function of speed (rad/s). Sized so a good
    // 5" motor loses roughly 5 W at 28k rpm: bearing drag is a near-constant
    // Coulomb term, windage and eddy losses go with omega^2.
    this.tauCoulomb = 0.0006 * Math.pow(spec.stator / 20, 2);
    this.viscous = 6.0e-11;
    this.ironCoef = (spec.ironLoss || 0.008) * 1.0e-8;

    // Runtime
    this.omega = 0;          // rad/s
    this.current = 0;        // A
    this.currentSmooth = 0;
    this.duty = 0;           // commanded 0..1 (after mixer)
    this.tempC = 24;
    this.R = this.R25;
    this.torque = 0;
    this.powerIn = 0;
    this.voltage = 0;
    this.throttled = false;  // current-limited
    this.desync = 0;         // 0..1, commutation faults from a starved ESC
    this.bidirectional = !!opt.bidirectional;
  }
  get RPM() { return this.omega / KPMS; }

  lossTorque(w) {
    const sgn = w < 0 ? -1 : 1;
    const a = Math.abs(w);
    const fc = this.tauCoulomb * Math.tanh(a / 40);
    return sgn * (fc + (this.viscous + this.ironCoef) * a * a);
  }

  /**
   * Integrate one motor for dt seconds.
   * @param {number} duty     0..1 commanded throttle
   * @param {number} vPack    pack voltage (V)
   * @param {function} propTorqueAt  (n_rps) -> shaft torque (N*m)
   * @param {object} esc      ESC descriptor {maxContA, resistance, derate}
   */
  step(dt, duty, vPack, propTorqueAt, esc) {
    this.duty = duty;
    const lim = esc.derate || 1;
    const d = clamp(duty, 0, 1);

    // --- resistance from winding temperature
    this.R = this.R25 * (1 + CU_ALPHA * (this.tempC - 25));
    const Reff = this.R + (esc.resistance || 0);

    // --- ESC output voltage. DShot is linear in duty; the MOSFET and body
    // diode drops eat a few percent that a real pilot can see as lost punch.
    const vFet = 0.012;
    let vEsc = d * vPack - (1 - d) * vFet - d * vFet * 2;
    if (this.bidirectional && d < 0.05) {
      // Active brake: the H-bridge drives the opposite way, so the motor
      // decelerates and pushes energy back into the pack.
      vEsc = -(0.05 - d) * vPack * 0.7;
    }

    // --- steady-state operating point (used for the equilibrium solve and for
    // the current limiter). Iterate: current depends on speed, speed depends
    // on current through the prop load.
    let w = this.omega;
    let i = this.current;
    for (let k = 0; k < 4; k++) {
      const tProp = propTorqueAt(w * INV_TAU);
      const iNeed = (tProp + this.lossTorque(w)) / this.Kt;
      const wEq = (vEsc - Reff * iNeed) / this.Ke;
      w = wEq;
      i = iNeed;
    }

    // --- current limit: real ESCs fold back rather than exceeding their rating
    let target = i;
    const iMax = (esc.maxContA || 60) * lim;
    if (target > iMax) {
      target = iMax;
      this.throttled = true;
      // Constant-current operation clamps the applied voltage instead.
      const vClamp = iMax * Reff + this.Ke * w;
      if (vEsc > vClamp) vEsc = vClamp;
    } else {
      this.throttled = false;
    }

    // --- inductor integration: the current cannot follow a step in voltage
    const di = (vEsc - Reff * i - this.Ke * w) / this.L;
    i = Math.max(0, i + di * dt);
    // Speed responds to the net torque with the rotor's inertia.
    const tProp = propTorqueAt(w * INV_TAU);
    const tNet = this.Kt * i - this.lossTorque(w) - tProp;
    const J = this.propInertia != null ? this.Irotor + this.propInertia : this.Irotor;
    w = Math.max(0, w + (tNet / J) * dt);

    this.omega = w;
    this.current = i;
    this.currentSmooth = i;
    this.voltage = Math.max(0, vEsc);
    this.torque = tProp;
    this.powerIn = vEsc * i;
    this.emf = this.Ke * w;

    // --- motor thermals: copper losses plus iron losses heat the stator
    const pLoss = i * i * Reff + Math.abs(this.lossTorque(w) * w);
    const heatCap = 26;                     // J/K lumped for a 30 g motor
    const coolTau = 42;                     // s to ambient through the frame
    this.tempC += (pLoss / heatCap - (this.tempC - 24) / coolTau) * dt;

    // --- commutation faults: a starved or hot ESC cannot commutate a big prop
    // at low rpm, and the gyro sees the result as a sharp spike.
    const starvation = smoothstep(0.0, 0.12, d) < 0.4 && i > iMax * 0.92 ? 1 : 0;
    this.desync = approach(this.desync, Math.max(starvation, 1 - lim), dt * 3);
    return this;
  }

  // The prop's rotational inertia spins with the shaft; craft.js sets this so
  // the two can be solved as one body.
  setPropInertia(I) { this.propInertia = I; this.totalInertia = this.Irotor + (I || 0); }

  /** Steady-state solve: rev/s and current for a given duty, ignoring transients.
   * Honours the ESC current limit: past it the motor holds maximum current and
   * the speed becomes whatever the remaining voltage allows, which is why a
   * current-limited punch tops out at a predictable speed instead of diverging.
   */
  steadyState(duty, vPack, propTorqueAt, esc) {
    const Reff = this.R + (esc.resistance || 0);
    const d = clamp(duty, 0, 1);
    const vEsc = d * vPack;
    const iMax = (esc.maxContA || 1e9) * (esc.derate || 1);
    let w = 0, i = 0;
    for (let k = 0; k < 28; k++) {
      const tProp = propTorqueAt(w * INV_TAU);
      i = (tProp + this.lossTorque(w)) / this.Kt;
      if (i > iMax) {
        w = Math.max(0, (vEsc - iMax * Reff) / this.Ke);
        i = iMax;
      } else {
        w = Math.max(0, (vEsc - Reff * i) / this.Ke);
      }
    }
    const tProp = propTorqueAt(w * INV_TAU);
    i = Math.min(i, iMax);
    const limited = i >= iMax - 1e-6;
    return { rpm: w / KPMS, rps: w * INV_TAU, current: i, torque: tProp, power: vEsc * i, limited };
  }
}

/**
 * ESC with thermal state. A 4-in-1 stack runs hot under hard 6S current and
 * derates itself, which shows up as sudden loss of control authority.
 */
export class ESC {
  constructor(spec) {
    this.spec = spec;
    this.maxContA = spec.maxContA;
    this.maxBurstA = spec.maxBurstA;
    this.resistance = spec.escRTotal__r / 1000;
    this.derate = 1;
    this.tempC = 24;
    this.protocol = spec.protocol;
    this.overTemp = false;
  }
  step(dt, currentA) {
    // A 4-in-1 stack is four bridges sharing one board, so total dissipation is
    // four times the per-channel I^2R. Real numbers: about 5 W at 30 A per
    // motor, which is why a hard 6S punch climbs 20-40 C in a minute.
    const p = currentA * currentA * this.resistance * 4;
    const heatCap = 14;
    const coolTau = 50;
    this.tempC += (p / heatCap - (this.tempC - 24) / coolTau) * dt;
    // Warning above 70 C, hard derate above 85 C.
    this.overTemp = this.tempC > 85;
    this.derate = 1 - smoothstep(70, 100, this.tempC) * 0.55;
    return this.derate;
  }
}

/**
 * Match a motor to a prop/pack: find the duty that produces a given rpm, and
 * the resulting current. Used by the builder for throttle-curve and
 * "motor output at hover" estimates.
 */
export function matchDutyForRPM(motor, targetRPM, vPack, prop, esc, density = 1.225) {
  const torqueAt = (n) => {
    prop.solve(n, 0.0, density, { aoa: 0, height: 99, speed: 0 });
    return prop.torque;
  };
  let lo = 0, hi = 1;
  const ss = motor.steadyState;
  for (let k = 0; k < 22; k++) {
    const mid = (lo + hi) / 2;
    const r = ss(mid, vPack, torqueAt, { resistance: esc.resistance, maxContA: esc.maxContA });
    if (r.rpm < targetRPM) lo = mid; else hi = mid;
  }
  const duty = (lo + hi) / 2;
  return { duty, ...ss(duty, vPack, torqueAt, { resistance: esc.resistance, maxContA: esc.maxContA }) };
}
