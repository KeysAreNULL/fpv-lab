// Math primitives for the FPV LAB simulator.
// Vectors are plain {x,y,z}; quaternions {x,y,z,w}; matrices are row-major Float64Array(9).
// Everything here is allocation-conscious: operations take an explicit `out` where it matters.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const G0 = 9.80665; // standard gravity, m/s^2

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
// Move `cur` toward `tgt` by at most `maxStep`.
export const approach = (cur, tgt, maxStep) => {
  const d = tgt - cur;
  if (Math.abs(d) <= maxStep) return tgt;
  return cur + Math.sign(d) * maxStep;
};
// First-order lag: exponential approach with time constant tau (seconds).
export function lag(cur, tgt, tau, dt) {
  if (tau <= 0) return tgt;
  const a = 1 - Math.exp(-dt / tau);
  return cur + (tgt - cur) * a;
}

/* ------------------------------------------------------------------ vectors */

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const vclone = (a) => ({ x: a.x, y: a.y, z: a.z });
export const vset = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
export const vcopy = (o, a) => { o.x = a.x; o.y = a.y; o.z = a.z; return o; };
export const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vmul = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vaddScaled = (a, b, s) => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s });
export const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const vlen = (a) => Math.hypot(a.x, a.y, a.z);
export const vlen2 = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export function vnorm(a) {
  const l = vlen(a);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
}
export const vmulTo = (out, a, s) => { out.x = a.x * s; out.y = a.y * s; out.z = a.z * s; return out; };
export const vaddTo = (out, a, b) => { out.x = a.x + b.x; out.y = a.y + b.y; out.z = a.z + b.z; return out; };
export const vsubTo = (out, a, b) => { out.x = a.x - b.x; out.y = a.y - b.y; out.z = a.z - b.z; return out; };
export const vlerp = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });
// Component of `a` along unit vector `u`.
export const vprojOn = (a, u) => vdot(a, u);
/* ------------------------------------------------------- matrices (row-major)
// m[r*3+c]; v (world->body) => R^T v ; body->world => R v                      */

export const m3 = () => new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
export const m3zero = () => new Float64Array(9);
export const m3set = (m, a, b, c, d, e, f, g, h, i) => {
  m[0] = a; m[1] = b; m[2] = c; m[3] = d; m[4] = e; m[5] = f; m[6] = g; m[7] = h; m[8] = i;
  return m;
};
export const m3copy = (o, a) => { o.set(a); return o; };

export function m3mulVec(m, v, out = {}) {
  const x = v.x, y = v.y, z = v.z;
  out.x = m[0] * x + m[1] * y + m[2] * z;
  out.y = m[3] * x + m[4] * y + m[5] * z;
  out.z = m[6] * x + m[7] * y + m[8] * z;
  return out;
}
// transpose-multiply: world -> body for a rotation matrix
export function m3mulVecT(m, v, out = {}) {
  const x = v.x, y = v.y, z = v.z;
  out.x = m[0] * x + m[3] * y + m[6] * z;
  out.y = m[1] * x + m[4] * y + m[7] * z;
  out.z = m[2] * x + m[5] * y + m[8] * z;
  return out;
}
export const m3transpose = (m, o = m3()) => {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  m3set(o, a, d, g, b, e, h, c, f, i);
  return o;
};
export function m3mul(a, b, o = m3()) {
  const r = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  o.set(r);
  return o;
}
export function m3invert(m, o = m3()) {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  let det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) { o.set(m3()); return o; }
  det = 1 / det;
  m3set(o, A * det, -(b * i - c * h) * det, (b * f - c * e) * det,
        B * det, (a * i - c * g) * det, -(a * f - c * d) * det,
        C * det, -(a * h - b * g) * det, (a * e - b * d) * det);
  return o;
}
// Symmetric 3x3 inverse via adjugate (valid for inertia tensors).
export function m3invSym(m, o = m3()) {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  let det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-20) { o.set(m3()); return o; }
  det = 1 / det;
  m3set(o, A * det, -(b * i - c * h) * det, (b * f - c * e) * det,
        B * det, (a * i - c * g) * det, -(a * f - c * d) * det,
        C * det, -(a * h - b * g) * det, (a * e - b * d) * det);
  return o;
}

/* -------------------------------------------------------------- quaternions */

export const q4 = () => ({ x: 0, y: 0, z: 0, w: 1 });
export const qclone = (q) => ({ x: q.x, y: q.y, z: q.z, w: q.w });
export const qcopy = (o, q) => { o.x = q.x; o.y = q.y; o.z = q.z; o.w = q.w; return o; };

export function qmul(a, b, out = {}) {
  const ax = a.x, ay = a.y, az = a.z, aw = a.w;
  const bx = b.x, by = b.y, bz = b.z, bw = b.w;
  out.x = aw * bx + ax * bw + ay * bz - az * by;
  out.y = aw * by - ax * bz + ay * bw + az * bx;
  out.z = aw * bz + ax * by - ay * bx + az * bw;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}
export function qnorm(q, out = {}) {
  const l = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  out.x = q.x / l; out.y = q.y / l; out.z = q.z / l; out.w = q.w / l;
  return out;
}
export const qconj = (q, out = {}) => { out.x = -q.x; out.y = -q.y; out.z = -q.z; out.w = q.w; return out; };

// Integrate quaternion by body-frame angular velocity over dt.
export function qIntegrate(q, w, dt, out = {}) {
  const hx = w.x * dt * 0.5, hy = w.y * dt * 0.5, hz = w.z * dt * 0.5;
  const ax = q.x, ay = q.y, az = q.z, aw = q.w;
  out.x = ax + (aw * hx + ay * hz - az * hy);
  out.y = ay + (aw * hy - ax * hz + az * hx);
  out.z = az + (aw * hz + ax * hy - ay * hx);
  out.w = aw - (ax * hx + ay * hy + az * hz);
  return qnorm(out, out);
}

export function qFromAxisAngle(ax, ang, out = {}) {
  const h = ang * 0.5, s = Math.sin(h);
  out.x = ax.x * s; out.y = ax.y * s; out.z = ax.z * s; out.w = Math.cos(h);
  return out;
}
// Intrinsic yaw(Z) -> pitch(Y) -> roll(X), the usual aviation/FPV convention.
export function qFromEuler(roll, pitch, yaw, out = {}) {
  const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  out.x = sr * cp * cy - cr * sp * sy;
  out.y = cr * sp * cy + sr * cp * sy;
  out.z = cr * cp * sy - sr * sp * cy;
  out.w = cr * cp * cy + sr * sp * sy;
  return out;
}
export function qToEuler(q) {
  const { x, y, z, w } = q;
  const sinp = 2 * (w * x - y * z);
  const roll = Math.abs(sinp) > 0.99999 ? Math.sign(sinp) * Math.PI / 2 : Math.asin(sinp);
  const pitch = Math.atan2(2 * (w * y + z * x), 1 - 2 * (x * x + y * y));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { roll, pitch, yaw };
}
// Rotation matrix (body -> world) from a unit quaternion.
export function qToMat3(q, o = m3()) {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  m3set(o,
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy));
  return o;
}
export const qRotateVec = (q, v, out = {}) => {
  // v' = v + 2w(q_xyz x v) + 2 q_xyz x (q_xyz x v)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  out.x = v.x + q.w * tx + (q.y * tz - q.z * ty);
  out.y = v.y + q.w * ty + (q.z * tx - q.x * tz);
  out.z = v.z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
};
export const qRotateVecInv = (q, v, out = {}) => qRotateVec(qconj(q, QTMP), v, out);
const QTMP = q4();

/**
 * Quaternion from a rotation matrix (row-major 3x3). Shepperd's method: pick the
 * branch with the largest pivot so the square root is well conditioned.
 * Used to define the level-attitude offset between the NED body frame and the
 * Y-up world frame.
 */
export function m3ToQuat(m, out = {}) {
  const t = m[0] + m[4] + m[8];
  let x, y, z, w;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    w = 0.25 * s; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[7] - m[5]) / s; x = 0.25 * s; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = 0.25 * s; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = 0.25 * s;
  }
  out.x = x; out.y = y; out.z = z; out.w = w;
  return qnorm(out, out);
}

/* ------------------------------------------------------------------- noise */

// Deterministic value noise (1D + 3D) with a hash based on integer lattice.
function hash1(n) {
  n = (n << 13) ^ n;
  return 1 - ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824;
}
function hash3(x, y, z) {
  let n = x * 374761393 + y * 668265263 + z * 2147483647;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 2147483648 - 1;
}
export function valueNoise1(x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i), hash1(i + 1), u);
}
export function fbm1(x, octaves = 3) {
  let s = 0, amp = 0.5, fr = 1;
  for (let i = 0; i < octaves; i++) { s += amp * valueNoise1(x * fr + i * 17.3); fr *= 2.03; amp *= 0.5; }
  return s;
}
export function valueNoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const c = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), ux);
  const x10 = lerp(c(0, 1, 0), c(1, 1, 0), ux);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), ux);
  const x11 = lerp(c(0, 1, 1), c(1, 1, 1), ux);
  return lerp(lerp(x00, x10, uy), lerp(x01, x11, uy), uz);
}

/* ------------------------------------------------------------ interpolation */

// Catmull-Rom through an array of [x,y] pairs, sorted by x. Clamped at ends.
export function curveEval(pts, x) {
  const n = pts.length;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];
  let i = 0;
  while (i < n - 2 && x > pts[i + 1][0]) i++;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
  const t = (x - p1[0]) / (p2[0] - p1[0]);
  const t2 = t * t, t3 = t2 * t;
  const m1 = (p2[1] - p0[1]) / (p2[0] - p0[0]);
  const m2 = (p3[1] - p1[1]) / (p3[0] - p1[0]);
  return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 +
         (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
}

// Piecewise-linear lookup, same contract as curveEval.
export function tableEval(pts, x) {
  const n = pts.length;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];
  let i = 0;
  while (i < n - 2 && x > pts[i + 1][0]) i++;
  const t = (x - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
  return lerp(pts[i][1], pts[i + 1][1], t);
}

// Deterministic PRNG (mulberry32) so builds/races are reproducible.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------- rigid-body inertia */

// Accumulate rigid-body inertia from a solid, used when a build has real geometry.
// `type`: 'box' (full exts w/h/d) or 'cyl' (radius r, length L along its axis)
// `axis`: for cylinders, the body-frame axis ('x'|'y'|'z').
export class InertiaBuilder {
  constructor() {
    this.m = m3zero();
    this.mass = 0;
    this.com = v3();
    this._firstM = null;
  }
  add(mass, pos, type = 'box', dims = null, axis = 'y') {
    const I = { x: 0, y: 0, z: 0 };
    if (type === 'box') {
      const [w, h, d] = dims;
      I.x = (mass / 12) * (h * h + d * d);
      I.y = (mass / 12) * (w * w + d * d);
      I.z = (mass / 12) * (w * w + h * h);
    } else {
      const [r, L] = dims;
      const along = 0.5 * mass * r * r;
      const perp = (mass / 12) * (3 * r * r + L * L);
      if (axis === 'y') { I.x = perp; I.y = along; I.z = perp; }
      else if (axis === 'x') { I.x = along; I.y = perp; I.z = perp; }
      else { I.x = perp; I.y = perp; I.z = along; }
    }
    const m = this.m;
    // own inertia, then parallel axis theorem about the origin
    m[0] += I.x + mass * (pos.y * pos.y + pos.z * pos.z);
    m[4] += I.y + mass * (pos.x * pos.x + pos.z * pos.z);
    m[8] += I.z + mass * (pos.x * pos.x + pos.y * pos.y);
    m[1] -= mass * pos.x * pos.y;
    m[2] -= mass * pos.x * pos.z;
    m[3] -= mass * pos.y * pos.x;
    m[5] -= mass * pos.y * pos.z;
    m[6] -= mass * pos.z * pos.x;
    m[7] -= mass * pos.z * pos.y;
    this.mass += mass;
    if (this._firstM === null) this._firstM = mass;
    this.com.x += mass * pos.x; this.com.y += mass * pos.y; this.com.z += mass * pos.z;
    return this;
  }
  // Re-express accumulated inertia about the centre of mass.
  aboutCOM() {
    if (this.mass <= 0) return { I: m3(), mass: 0, com: v3() };
    const c = this.com;
    const m = this.mass;
    c.x /= m; c.y /= m; c.z /= m;
    const I = m3copy(m3(), this.m);
    const d2 = vlen2(c);
    // I_com = I_origin - m*((c·c)E - c c^T)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const cc = (i === j ? d2 : 0) - c[['x', 'y', 'z'][i]] * c[['x', 'y', 'z'][j]];
        I[i * 3 + j] += m * cc;
      }
    }
    return { I: I, mass: m, com: c };
  }
}

/* ------------------------------------------------------------ misc helpers */

export const fmt = {
  n(v, d = 2) { return Number.isFinite(v) ? v.toFixed(d) : '--'; },
  int(v) { return Number.isFinite(v) ? Math.round(v).toLocaleString() : '--'; },
  pct(v, d = 0) { return Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '--'; },
  time(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '--.--';
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return m + ':' + s.toFixed(2).padStart(5, '0');
  },
  timeMs(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '--.---';
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return m + ':' + s.toFixed(3).padStart(6, '0');
  },
  sig(v) { return (v >= 0 ? '+' : '') + v.toFixed(2); },
};
