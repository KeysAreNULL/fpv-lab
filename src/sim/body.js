// Rigid-body dynamics and aerodynamics.
//
// State is world position/velocity, body-frame angular velocity and an
// orientation quaternion. Integration is semi-implicit (symplectic) Euler at the
// physics rate, which stays stable for a stiff prop/wake system as long as the
// substep is small enough - the solver runs at 5 kHz for that reason.
//
// Aerodynamics are built from flat-plate surfaces rather than a lumped drag
// coefficient. Each surface sees the local airflow - including the omega x r
// velocity of the point it sits on - and produces a normal force plus skin
// friction. That single mechanism gives us, for free: aerodynamic pitch/roll/
// yaw damping, drag growth with angle of attack, the stabilising effect of
// aligning a quad's discs with the relative wind, and the destabilising pitch
// that every multirotor has.

import {
  v3, vcross, clamp, q4, qToMat3, qIntegrate, m3, m3mulVec,
  m3mulVecT, m3invSym, InertiaBuilder, G0,
} from '../core/math.js';

export class RigidBody {
  constructor() {
    this.mass = 0.5;
    this.I = m3();        // inertia about the COM, body frame
    this.Iinv = m3();
    this.pos = v3();
    this.vel = v3();      // world
    this.quat = q4();
    this.omega = v3();    // body frame rad/s
    this.R = m3();        // cached rotation
    this.force = v3();    // world, cleared each step
    this.torque = v3();   // body, cleared each step
    this.accel = v3();
    this.onGround = false;
    this.groundY = 0;
    this.contacts = [];
  }

  setMassProperties(mass, I, R) {
    this.mass = mass;
    if (I) { this.I.set(I); }
    m3invSym(this.I, this.Iinv);
    if (R) this.R.set(R);
  }

  updateRotation() { qToMat3(this.quat, this.R); }

  toBody(v, out = {}) { return m3mulVecT(this.R, v, out); }
  toWorld(v, out = {}) { return m3mulVec(this.R, v, out); }

  /** Body-frame point -> world position (rotation *and* translation). */
  pointToWorld(bodyPoint, out = {}) {
    const r = m3mulVec(this.R, bodyPoint, { x: 0, y: 0, z: 0 });
    out.x = this.pos.x + r.x; out.y = this.pos.y + r.y; out.z = this.pos.z + r.z;
    return out;
  }

  /** Velocity of a point given in body-frame coordinates, in world frame. */
  pointVelocityWorld(bodyPoint, out = {}) {
    const r = m3mulVec(this.R, bodyPoint, { x: 0, y: 0, z: 0 });
    const wb = this.omega;
    const wWorld = { x: this.R[0] * wb.x + this.R[1] * wb.y + this.R[2] * wb.z,
                     y: this.R[3] * wb.x + this.R[4] * wb.y + this.R[5] * wb.z,
                     z: this.R[6] * wb.x + this.R[7] * wb.y + this.R[8] * wb.z };
    out.x = this.vel.x + (wWorld.y * r.z - wWorld.z * r.y);
    out.y = this.vel.y + (wWorld.z * r.x - wWorld.x * r.z);
    out.z = this.vel.z + (wWorld.x * r.y - wWorld.y * r.x);
    return out;
  }

  addForceWorld(f) {
    this.force.x += f.x; this.force.y += f.y; this.force.z += f.z;
  }
  addForceBody(f) {
    const w = m3mulVec(this.R, f, { x: 0, y: 0, z: 0 });
    this.force.x += w.x; this.force.y += w.y; this.force.z += w.z;
  }
  /** Force applied at a body-frame point: contributes to the body torque. */
  addForceAtBody(f, bodyPoint) {
    this.addForceBody(f);
    const t = vcross(bodyPoint, f);
    this.torque.x += t.x; this.torque.y += t.y; this.torque.z += t.z;
  }
  addTorqueBody(t) { this.torque.x += t.x; this.torque.y += t.y; this.torque.z += t.z; }

  /** Angular momentum vector of the body in the body frame. */
  angularMomentum(out = {}) {
    const I = this.I, w = this.omega;
    out.x = I[0] * w.x + I[1] * w.y + I[2] * w.z;
    out.y = I[3] * w.x + I[4] * w.y + I[5] * w.z;
    out.z = I[6] * w.x + I[7] * w.y + I[8] * w.z;
    return out;
  }

  /** Total rotor angular momentum from the spinning props (body frame). */
  rotorAngularMomentum(props, out = {}) {
    let x = 0, y = 0, z = 0;
    for (const p of props) {
      const L = p.Irotor * p.n;
      // axis is body +/- z (all props spin about the body Z axis)
      x += p.axis * L * 0;
      z += p.axis * L;
    }
    out.x = x; out.y = y; out.z = z;
    return out;
  }

  /** Semi-implicit Euler step. */
  step(dt, gravity = true) {
    // --- linear
    let ax = this.force.x / this.mass;
    let ay = this.force.y / this.mass;
    let az = this.force.z / this.mass;
    if (gravity) ay -= G0;
    this.accel.x = ax; this.accel.y = ay; this.accel.z = az;
    this.vel.x += ax * dt; this.vel.y += ay * dt; this.vel.z += az * dt;
    this.pos.x += this.vel.x * dt; this.pos.y += this.vel.y * dt; this.pos.z += this.vel.z * dt;

    // --- angular: Euler's equation in the body frame, I w' = tau - w x (I w)
    const I = this.I, Ii = this.Iinv, w = this.omega;
    const Lx = I[0] * w.x + I[1] * w.y + I[2] * w.z;
    const Ly = I[3] * w.x + I[4] * w.y + I[5] * w.z;
    const Lz = I[6] * w.x + I[7] * w.y + I[8] * w.z;
    const gx = w.y * Lz - w.z * Ly;
    const gy = w.z * Lx - w.x * Lz;
    const gz = w.x * Ly - w.y * Lx;
    const tx = this.torque.x - gx, ty = this.torque.y - gy, tz = this.torque.z - gz;
    const alx = Ii[0] * tx + Ii[1] * ty + Ii[2] * tz;
    const aly = Ii[3] * tx + Ii[4] * ty + Ii[5] * tz;
    const alz = Ii[6] * tx + Ii[7] * ty + Ii[8] * tz;
    this.omega.x += alx * dt; this.omega.y += aly * dt; this.omega.z += alz * dt;

    // --- orientation
    qIntegrate(this.quat, this.omega, dt, this.quat);
    this.updateRotation();

    this.force.x = this.force.y = this.force.z = 0;
    this.torque.x = this.torque.y = this.torque.z = 0;
  }
}

/* ------------------------------------------------------------ aerodynamic surfaces */

// A thin flat plate in the body frame. `normal` is the body-frame plate normal;
// `area` in m^2; `cd0` is the zero-angle skin friction; `clSlope` the lift slope.
export class AeroSurface {
  constructor({ pos, normal, area, cd0 = 0.02, clSlope = 1.6, type = 'plate', cdPost = 0, name = '' }) {
    this.pos = pos;          // body frame
    this.normal = normal;    // body frame, unit
    this.area = area;
    this.cd0 = cd0;
    this.clSlope = clSlope;
    this.type = type;        // 'plate' | 'arm' | 'disc' | 'canopy'
    this.cdPost = cdPost;    // base drag added behind the plate
    this.name = name;
    // Scratch
    this.force = v3();
  }

  /**
   * Force on this surface from the relative airflow, in the body frame.
   * @param vRelBody relative airflow at the surface point (body frame)
   * @param omegaBody body angular velocity (for the local rotational velocity)
   * @param rho air density
   */
  compute(vRelBody, rho, out = {}) {
    const w = vRelBody;
    const speed = Math.hypot(w.x, w.y, w.z);
    out.ax = 0; out.ay = 0; out.az = 0;
    if (speed < 1e-4) return out;
    const q = 0.5 * rho * speed * speed * this.area;
    const n = this.normal;
    const un = (w.x * n.x + w.y * n.y + w.z * n.z) / speed;   // normal component (-1..1)
    const s = clamp(Math.abs(un), 0, 1);
    const s2 = s * s;
    const alpha = Math.asin(clamp(un, -1, 1));
    // Flat-plate normal force: peaks around 45 degrees, zero when flat.
    const CN = this.clSlope * s2;
    // Skin friction plus post-plate base drag, and pressure drag at incidence.
    let CD = this.cd0 + (1.1 * s2 + this.cdPost) * (this.type === 'arm' ? 1.35 : 1);
    // Arms are thin tubes: almost no normal force, mostly profile drag.
    if (this.type === 'arm') { CD = this.cd0 + 1.1 * s2 + this.cdPost; }
    // Disc: has meaningful drag even at zero incidence.
    if (this.type === 'disc') { CD = this.cd0 + 0.9 * s2 + this.cdPost; }
    const fx = -w.x / speed, fy = -w.y / speed, fz = -w.z / speed;  // drag direction
    const N = CN * q;
    const D = CD * q;
    // The plate is pushed away from whichever face the flow is hitting, so the
    // normal force always opposes the through-flow component.
    const sgn = un >= 0 ? -1 : 1;
    out.ax = N * sgn * n.x + D * fx;
    out.ay = N * sgn * n.y + D * fy;
    out.az = N * sgn * n.z + D * fz;
    out.lift = N; out.drag = D; out.alpha = alpha; out.q = q;
    return out;
  }
}

/**
 * Apply all aerodynamic surfaces to a body. `relWind` is the air velocity
 * relative to the body, in the world frame (i.e. wind minus body velocity).
 */
export function applyAero(body, surfaces, relWind, rho, opts = {}) {
  const relB = body.toBody(relWind, { x: 0, y: 0, z: 0 });
  const wb = body.omega;
  let dragE = 0, liftE = 0, aoaSum = 0;
  for (const s of surfaces) {
    if (!s.active) continue;
    // local velocity = relWind - omega x r  (body frame)
    const lx = relB.x - (wb.y * s.pos.z - wb.z * s.pos.y);
    const ly = relB.y - (wb.z * s.pos.x - wb.x * s.pos.z);
    const lz = relB.z - (wb.x * s.pos.y - wb.y * s.pos.x);
    s.compute({ x: lx, y: ly, z: lz }, rho, TMPF);
    body.addForceAtBody({ x: TMPF.ax, y: TMPF.ay, z: TMPF.az }, s.pos);
    dragE += TMPF.drag || 0;
    liftE += TMPF.lift || 0;
    aoaSum += Math.abs(TMPF.alpha || 0) * s.area;
  }
  return { drag: dragE, lift: liftE, aoa: aoaSum / Math.max(1e-6, totalArea(surfaces)) };
}
const TMPF = {};
function totalArea(surfaces) {
  let a = 0;
  for (const s of surfaces) a += s.area;
  return a;
}

/* --------------------------------------------------------------- ground */

export function applyGroundContact(body, groundY = 0, restitution = 0.15, friction = 0.75, legStiff = 900, legDamp = 45) {
  const contacts = body.contacts;
  contacts.length = 0;
  const minY = body.pos.y; // the frame is treated as a point plus gear offset
  const pen = groundY - minY;
  body.onGround = false;
  if (pen > 0) {
    body.onGround = true;
    const n = { x: 0, y: 1, z: 0 };
    let fn = 0;
    const approachV = -body.vel.y;
    if (approachV > 0) fn = legDamp * approachV;
    fn += legStiff * pen;
    fn += body.mass * G0 * 0.0; // gravity applied separately
    body.addForceWorld({ x: 0, y: fn, z: 0 });
    // Coulomb friction on tangential velocity
    const vtx = body.vel.x, vtz = body.vel.z;
    const vt = Math.hypot(vtx, vtz);
    if (vt > 1e-5) {
      const ffr = friction * Math.min(1, fn / Math.max(1, body.mass * G0));
      body.addForceWorld({ x: -vtx / vt * ffr, y: 0, z: -vtz / vt * ffr });
    }
    contacts.push({ point: { x: body.pos.x, y: groundY, z: body.pos.z }, normal: n, depth: pen, force: fn });
  }
  return contacts;
}

/* ------------------------------------------------------- world collision */

/**
 * Swept sphere-versus-AABB resolution against the track geometry.
 *
 * A quad is not a point: its props stick out roughly half a metre, so it is
 * modelled as a sphere of the frame's own radius. Getting this roughly right
 * matters a great deal for how a race feels - clipping a wall should be a
 * scrappy brush with the frame, not an invisible wall.
 *
 * Returns the hardest impact found, so the caller can apply prop-strike damage
 * and shake the feed.
 */
export function collideWorld(body, boxes, radius, restitution = 0.28, friction = 0.55) {
  let worst = null;
  if (!boxes || !boxes.length) return worst;
  for (let iter = 0; iter < 2; iter++) {
    let any = false;
    for (const b of boxes) {
      const p = body.pos;
      // Closest point on the box to the centre.
      const cx = Math.max(b.min.x, Math.min(p.x, b.max.x));
      const cy = Math.max(b.min.y, Math.min(p.y, b.max.y));
      const cz = Math.max(b.min.z, Math.min(p.z, b.max.z));
      let dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > radius * radius) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-6) {
        // The centre is inside the box. Nudging it out by `radius` is not
        // enough when the box is thick, and picking the exit face purely by
        // depth can shove the body out through the *far* side - which is how a
        // craft ends up under a ceiling it should be resting on. So eject it
        // properly: pick an axis, then teleport it just outside that face.
        const depths = [p.x - b.min.x, b.max.x - p.x, p.y - b.min.y, b.max.y - p.y,
          p.z - b.min.z, b.max.z - p.z];
        // axis 0 = x-, 1 = x+, 2 = y-, 3 = y+, 4 = z-, 5 = z+
        // Ties go to the positive face, and the positive-Y face in particular:
        // a craft embedded in a slab with no velocity has almost always fallen
        // in from above, so resting on top is the physically sane outcome.
        let best = 0;
        for (let k = 1; k < 6; k++) if (depths[k] <= depths[best]) best = k;
        const AX = ['x', 'x', 'y', 'y', 'z', 'z'];
        const SG = [-1, 1, -1, 1, -1, 1];
        // If the body is moving, it entered through the face opposite to its
        // travel, so put it back out that way. Ejecting through the near face
        // instead drives it deeper on the next substep, and for a thin slab
        // like a hangar roof that means straight through to the floor.
        const v = body.vel;
        const entry = [[0, 1], [2, 3], [4, 5]].find(([lo, hi]) => (
          (AX[lo] === 'x' && Math.abs(v.x) > 1e-4)
          || (AX[lo] === 'y' && Math.abs(v.y) > 1e-4)
          || (AX[lo] === 'z' && Math.abs(v.z) > 1e-4)));
        if (entry) {
          const [lo, hi] = entry;
          const c = AX[lo];
          // Travelling negative means it came in over the +face.
          best = v[c] < 0 ? hi : lo;
        }
        const ax = AX[best], sg = SG[best];
        p[ax] = (sg > 0 ? b.max[ax] : b.min[ax]) + sg * radius;
        d = 0;
        dx = ax === 'x' ? sg : 0;
        dy = ax === 'y' ? sg : 0;
        dz = ax === 'z' ? sg : 0;
      }
      const inv = d > 1e-6 ? 1 / d : 0;
      const nx = dx * inv, ny = dy * inv, nz = dz * inv;
      const pen = radius - d;
      // Positional correction.
      body.pos.x += nx * pen;
      body.pos.y += ny * pen;
      body.pos.z += nz * pen;
      // Split the velocity into normal and tangential parts.
      const vn = body.vel.x * nx + body.vel.y * ny + body.vel.z * nz;
      if (vn < 0) {
        const impact = -vn;
        body.vel.x -= nx * vn * (1 + restitution);
        body.vel.y -= ny * vn * (1 + restitution);
        body.vel.z -= nz * vn * (1 + restitution);
        // Scrape friction along the surface.
        const tvx = body.vel.x - nx * (body.vel.x * nx + body.vel.y * ny + body.vel.z * nz);
        const tvy = body.vel.y - ny * (body.vel.x * nx + body.vel.y * ny + body.vel.z * nz);
        const tvz = body.vel.z - nz * (body.vel.x * nx + body.vel.y * ny + body.vel.z * nz);
        body.vel.x -= tvx * friction;
        body.vel.y -= tvy * friction;
        body.vel.z -= tvz * friction;
        // Angular kick from an off-centre hit.
        const lever = 0.08;
        body.omega.x += (nz * tvy - ny * tvz) * lever * impact * 0.05;
        body.omega.y += (nx * tvz - nz * tvx) * lever * impact * 0.05;
        body.omega.z += (ny * tvx - nx * tvy) * lever * impact * 0.05;
        if (!worst || impact > worst.impact) {
          worst = { impact, n: { x: nx, y: ny, z: nz }, box: b };
        }
      }
      any = true;
    }
    if (!any) break;
  }
  return worst;
}

/** Keeps the craft inside the arena: walls on four sides and a roof. */
export function containInBounds(body, bounds, radius = 0.3) {
  if (!bounds || bounds.half == null) return 0;   // free flight: no arena
  const h = bounds.half, top = bounds.ceiling;
  const hit = {};
  if (body.pos.x - radius < -h) { body.pos.x = -h + radius; hit.x = 1; }
  if (body.pos.x + radius > h) { body.pos.x = h - radius; hit.x = -1; }
  if (body.pos.z - radius < -h) { body.pos.z = -h + radius; hit.z = 1; }
  if (body.pos.z + radius > h) { body.pos.z = h - radius; hit.z = -1; }
  if (top != null && body.pos.y + radius > top) { body.pos.y = top - radius; hit.y = -1; }
  if (top != null && body.pos.y - radius < -radius * 2) { body.pos.y = -radius * 2; hit.y = 1; }
  const speed = Math.hypot(body.vel.x, body.vel.y, body.vel.z);
  if (speed > 0.01 && (hit.x || hit.y || hit.z)) {
    // Absorb the component into the wall and scrub some energy.
    if (hit.x) { body.vel.x *= -0.2; body.vel.z *= 0.75; }
    if (hit.z) { body.vel.z *= -0.2; body.vel.x *= 0.75; }
    if (hit.y) { body.vel.y *= -0.2; }
    return speed;
  }
  return 0;
}

/** Small helper for building inertia from a frame + components (see craft.js). */
export { InertiaBuilder };
