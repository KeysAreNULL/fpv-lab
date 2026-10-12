// Air: density, wind and turbulence.
//
// Density follows the standard atmosphere and is used everywhere (thrust,
// drag, propwash), which means a 3000 m launch really does climb out on a hot
// day. Wind is a steady component plus band-limited gusts; turbulence adds
// band-limited spatial and temporal noise, so the propwash solver sees a
// slightly different inflow on each prop the way it does in reality.

import { fbm1, valueNoise3, clamp, v3, lerp } from '../core/math.js';

export class Environment {
  constructor(opts = {}) {
    this.altitudeM = opts.altitude || 0;
    this.tempC = opts.tempC != null ? opts.tempC : 22;
    this.qnh = opts.qnh || 1013.25;       // hPa
    this.wind = v3();
    this.windSteady = v3();
    this.gustSpeed = 0;                   // m/s of gust amplitude
    this.gustDir = 0;
    this.turbulence = opts.turbulence != null ? opts.turbulence : 0.25;
    this.time = 0;
    this.groundY = 0;
    this.rfWorld = null;                  // shared obstacle set for propagation
  }

  /** Air density in kg/m^3 (ISA with temperature offset). */
  get density() {
    const h = this.altitudeM;
    const T = this.tempC + 273.15;
    const T0 = 288.15;
    const L = 0.0065;
    const p = this.qnh * Math.exp((-L * h) / (T0 + L * h + (this.tempC - 15) * 0.0)) * 100;
    const rho = p / (287.058 * T);
    return clamp(rho, 0.25, 1.6);
  }

  get isaDensity() { return 1.225 * Math.pow(1 - 0.0065 * this.altitudeM / 288.15, 4.256); }

  /** Wind velocity in world frame at a point, including gusts and turbulence. */
  windAt(pos, t, out = {}) {
    const g = this.gustSpeed;
    // Gusts: two decorrelated noise fields, low frequency, mean-reverting.
    const g1 = fbm1(t * 0.55 + this.gustDir * 13.1, 3);
    const g2 = fbm1(t * 0.48 + 91.7 + this.gustDir * 7.3, 3);
    const steadyX = this.windSteady.x + g * g1 * Math.cos(this.gustDir);
    const steadyZ = this.windSteady.z + g * g1 * Math.sin(this.gustDir);
    const steadyY = this.windSteady.y + g * g2 * 0.4;

    // Turbulence: spatial noise advected downwind, plus a temporal component.
    const s = this.turbulence;
    if (s > 0.001) {
      const ax = pos.x * 0.09 + t * 0.7;
      const ay = pos.y * 0.11 - t * 0.5;
      const az = pos.z * 0.09 + t * 0.63;
      const n = 0.9 * s;
      out.x = steadyX + n * valueNoise3(ax, ay, az);
      out.y = steadyY + n * valueNoise3(ay + 31.2, az + 7.7, ax + 3.3);
      out.z = steadyZ + n * valueNoise3(az + 55.1, ax + 19.4, ay + 11.9);
    } else {
      out.x = steadyX; out.y = steadyY; out.z = steadyZ;
    }
    return out;
  }

  setWind(speed, dirDeg, gust = 0) {
    const r = (dirDeg || 0) * Math.PI / 180;
    this.windSteady.x = speed * Math.cos(r);
    this.windSteady.z = speed * Math.sin(r);
    this.windSteady.y = 0;
    this.gustSpeed = gust;
    this.gustDir = r;
  }

  step(dt) { this.time += dt; }

  /** Summary for the HUD. */
  info() {
    const w = this.windAt({ x: 0, y: 2, z: 0 }, this.time, {});
    return {
      density: this.density, tempC: this.tempC, altitude: this.altitudeM,
      windSpeed: Math.hypot(this.windSteady.x, this.windSteady.z),
      windDir: (Math.atan2(this.windSteady.z, this.windSteady.x) * 180 / Math.PI + 360) % 360,
      gust: this.gustSpeed, turbulence: this.turbulence,
      local: w,
    };
  }

  /**
   * Distance from a point to the nearest surface along `dir` and along its
   * reverse. The propwash solver needs both: the ground below a quad is what
   * produces ground effect, and a ceiling or an overhang above it bounces the
   * downwash straight back into the disc, which is exactly why a race line
   * that hugs a wall or a roof is so much faster.
   */
  clearanceAt(pos, dir) {
    const fwd = this._rayDistance(pos, dir);
    const back = this._rayDistance(pos, { x: -dir.x, y: -dir.y, z: -dir.z });
    const min = Math.min(fwd, back);
    return { down: back, up: fwd, min };
  }

  _rayDistance(pos, dir) {
    let best = Infinity;
    // Ground plane.
    if (this.hasGround !== false && dir.y < -1e-6) {
      const t = (this.groundY - pos.y) / dir.y;
      if (t > 0) best = Math.min(best, t);
    }
    const boxes = this.rfWorld ? this.rfWorld.obstacles : null;
    if (!boxes) return best;
    const o = [pos.x, pos.y, pos.z];
    const d = [dir.x, dir.y, dir.z];
    for (const b of boxes) {
      if (b.noCollide) continue;
      let tmin = 0, tmax = Infinity, ok = true;
      const lo = [b.min.x, b.min.y, b.min.z];
      const hi = [b.max.x, b.max.y, b.max.z];
      for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-9) {
          if (o[i] < lo[i] || o[i] > hi[i]) { ok = false; break; }
          continue;
        }
        let t1 = (lo[i] - o[i]) / d[i];
        let t2 = (hi[i] - o[i]) / d[i];
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { ok = false; break; }
      }
      if (ok && tmax > 1e-6) best = Math.min(best, Math.max(0, tmin));
    }
    return best;
  }
}
