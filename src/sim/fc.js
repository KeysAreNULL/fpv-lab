// Flight controller: gyro -> filters -> PID -> mixer -> motor commands.
//
// This follows Betaflight's structure closely enough that tune numbers transfer:
// PT1/biquad gyro filters with RPM-tracking dynamic notches, P on setpoint error
// with a smoothed P output, D on the *measurement* derivative (so a setpoint
// step cannot kick the D term), feedforward, I-term anti-windup and relax, and a
// mixer that only scales the axis demands when there is not enough headroom
// (airmode).
//
// Units: gyro and setpoints are in degrees/second, PID sums are in "motor units"
// where 1000 is full authority. The scale factors below were chosen so a tune
// with kP ~ 47, kD ~ 30 and kF ~ 60 lands in the right place.

import {
  clamp, DEG, RAD, sign, lag, smoothstep, approach,
} from '../core/math.js';

/* --------------------------------------------------------------- filters */

// First-order low pass with a time constant.
export class PT1 {
  constructor(tau = 1 / 100) { this.tau = tau; this.state = 0; }
  update(x, dt) {
    if (this.tau <= 0) { this.state = x; return x; }
    const a = 1 - Math.exp(-dt / this.tau);
    this.state += (x - this.state) * a;
    return this.state;
  }
  reset(x = 0) { this.state = x; }
  get cutoff() { return this.tau > 0 ? 1 / (2 * Math.PI * this.tau) : 1e9; }
}

// Second-order Butterworth low pass, direct-form.
export class BiquadLP {
  constructor(cutoff = 200, q = 0.7071, fs = 8000) {
    this.fs = fs;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
    this.set(cutoff, q);
  }
  set(cutoff, q = 0.7071) {
    const w = 2 * Math.PI * Math.min(Math.max(1, cutoff), this.fs * 0.45) / this.fs;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * q);
    const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
    const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  update(x, dt) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
}

// Biquad notch, used for the RPM-tracking dynamic notch and the D-term notch.
export class BiquadNotch {
  constructor(center = 200, cutoff = 100, q = 5, fs = 8000) {
    this.fs = fs;
    this.set(center, cutoff, q);
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  set(center, cutoff, q = 5) {
    const fs = this.fs;
    const fc = clamp(cutoff, 1, fs * 0.45);
    const Q = clamp(q, 0.5, 30);
    const w0 = 2 * Math.PI * clamp(center, 1, fs * 0.45) / fs;
    const alpha = Math.sin(w0) / (2 * Q);
    const b0 = 1 + alpha, b1 = -2 * Math.cos(w0), b2 = 1 - alpha;
    const a0 = 1 + alpha * (fc / center), a1 = -2 * Math.cos(w0), a2 = 1 - alpha * (fc / center);
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  update(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
}

/* -------------------------------------------------------------------- tunes */

export const DEFAULT_TUNE = {
  name: 'Stock 5"',
  // rates (deg/s, BF "actual" convention)
  rcRate: 280, expo: 40, centerSens: 50, maxRate: 850,
  // P / I / D / F per axis: roll, pitch, yaw
  p: [47, 50, 45], i: [44, 46, 45], d: [35, 38, 0], f: [60, 60, 60],
  // filters
  gyroLpf1: 250, gyroLpf2: 300, dtermLpf: 80, dtermNotchCenter: 200,
  dtermNotchCutoff: 250, dynNotchQ: 5, dynNotchDepth: 100,
  dynNotchMinHz: 80, dynNotchMaxHz: 600,
  // dynamics
  itermRelax: 8, itermLimit: 250, pSmoothTau: 0.030, ffSmoothTau: 0.004,
  dMax: 700, iMax: 400,
  // mixer / motor
  airmode: true, antiGravity: true, dynamicIdle: false,
  minThrottle: 1000, maxThrottle: 2000, idlePercent: 6.5,
  throttlelimit: 92, throttleExpo: 0.0,
  dynIdleMin: 15, dynIdleMax: 30,
  // mode
  mode: 'acro',
};

export function cloneTune(t = DEFAULT_TUNE) { return JSON.parse(JSON.stringify(t)); }

// Preset library. Values are the kind of tunes people actually publish.
export const TUNE_LIBRARY = [
  DEFAULT_TUNE,
  { ...cloneTune(), name: 'Smooth / cinematic', rcRate: 200, expo: 30, p: [38, 42, 40],
    i: [35, 38, 38], d: [28, 30, 0], f: [40, 42, 40], gyroLpf2: 200, dtermLpf: 60,
    itermRelax: 12, maxRate: 620 },
  { ...cloneTune(), name: 'Race / sharp', rcRate: 360, expo: 50, centerSens: 55,
    p: [58, 62, 55], i: [55, 58, 52], d: [42, 45, 0], f: [95, 98, 95],
    gyroLpf2: 420, dtermLpf: 110, maxRate: 1100, dMax: 800 },
  { ...cloneTune(), name: 'Freestyle / soft', rcRate: 250, expo: 45, p: [42, 45, 42],
    i: [40, 42, 40], d: [30, 32, 0], f: [50, 52, 50], dtermLpf: 70, iMax: 300 },
  { ...cloneTune(), name: 'Freestyle / filthy', rcRate: 330, expo: 55, p: [52, 56, 50],
    i: [50, 53, 48], d: [34, 36, 0], f: [65, 68, 65], gyroLpf2: 180, dtermLpf: 55,
    itermRelax: 5, dynNotchDepth: 130 },
  { ...cloneTune(), name: 'Long range / efficient', rcRate: 190, expo: 35, p: [35, 38, 36],
    i: [42, 45, 42], d: [26, 28, 0], f: [38, 40, 38], gyroLpf2: 160, dtermLpf: 60,
    dynNotchDepth: 80, maxRate: 520 },
];

/* --------------------------------------------------------------- PID axis */

class PIDAxis {
  constructor() {
    this.p = 47; this.i = 45; this.d = 35; this.f = 60;
    this.iTerm = 0; this.pSmoothed = 0; this.prevGyro = 0; this.dTerm = 0;
    this.prevSetpoint = 0; this.ffSmoothed = 0;
    this.pTerm = 0; this.iOut = 0; this.dOut = 0; this.fOut = 0; this.sum = 0;
  }
  reset(gyro = 0) {
    this.iTerm = 0; this.prevGyro = gyro; this.dTerm = 0;
    this.pSmoothed = 0; this.ffSmoothed = 0; this.sum = 0;
  }
}

/* ------------------------------------------------------------------- FC */

export class FlightController {
  constructor(spec, tune = cloneTune(), opts = {}) {
    this.spec = spec;
    this.tune = tune;
    this.gyroHz = opts.gyroRate || 8000;   // rate the gyro filter chain assumes
    this.pidDivisor = opts.pidDivisor || 2;  // physics ticks between PID runs
    this.pidHz = opts.pidHz || (this.gyroHz / this.pidDivisor);
    this.mode = tune.mode || 'acro';
    this.armed = false;
    this.armedLockout = false;

    // gyro
    this.gyroBias = { x: 0, y: 0, z: 0 };
    this.gyroRaw = { x: 0, y: 0, z: 0 };
    this.gyro = { x: 0, y: 0, z: 0 };
    this.gyroFiltered = { x: 0, y: 0, z: 0 };
    this.gyroTrue = { x: 0, y: 0, z: 0 };
    this.accel = v3Accel();
    this.prevGyro = { x: 0, y: 0, z: 0 };
    this.desyncImpulse = 0;

    // filters
    this.lpf1 = [0, 1, 2].map(() => new PT1());
    this.lpf2 = [0, 1, 2].map(() => new BiquadLP(tune.gyroLpf2, 0.7071, this.gyroHz));
    this.notches = [new BiquadNotch(180, 60, 5, this.gyroHz), new BiquadNotch(300, 60, 5, this.gyroHz)];
    this.dLpf = [0, 1, 2].map(() => new PT1());
    this.dNotch = [new BiquadNotch(tune.dtermNotchCenter, tune.dtermNotchCutoff, 5, this.pidHz),
                   new BiquadNotch(tune.dtermNotchCenter * 2.5, tune.dtermNotchCutoff * 2, 5, this.pidHz)];
    this.ffSmooth = [0, 1, 2].map(() => new PT1(tune.ffSmoothTau));
    this.pSmooth = [0, 1, 2].map(() => new PT1(tune.pSmoothTau));

    // pid state
    this.axis = [new PIDAxis(), new PIDAxis(), new PIDAxis()];
    this.setpoint = { x: 0, y: 0, z: 0 };
    this.prevSetpoint = { x: 0, y: 0, z: 0 };
    this.rc = { x: 0, y: 0, z: 0, throttle: 0 };
    this.throttleOut = 0;
    this.motors = [0, 0, 0, 0];
    this.motorRPM = [0, 0, 0, 0];
    this.axisDemand = { x: 0, y: 0, z: 0 };

    // health
    this.voltage = 0; this.currentA = 0; this.batterySag = 0;
    this.brownout = false; this.brownoutCount = 0;
    this.failsafe = false; this.failsafeStage = 0;
    this.rcLost = false;
    this.crashDetected = false;
    this.crashFlip = false;
    this.turtle = false;
    this.gyroCalibrating = 0;
    this.accelCalibrated = false;
    this.armedAt = 0;
    this.armBlockedReason = '';
    this.attitude = { roll: 0, pitch: 0, yaw: 0 };
    this.antiGravityGain = 0;   // driven by impact detection in craft.js
    this.betaflightish = true;

    this.applyTune();
  }

  applyTune() {
    const t = this.tune;
    const names = ['p', 'i', 'd', 'f'];
    for (let a = 0; a < 3; a++) {
      for (const n of names) this.axis[a][n] = t[n][a];
    }
    this.lpf1.forEach((f) => { f.tau = 1 / (2 * Math.PI * Math.max(1, t.gyroLpf1)); });
    this.lpf2.forEach((f) => f.set(t.gyroLpf2, 0.7071));
    this.dLpf.forEach((f) => { f.tau = 1 / (2 * Math.PI * Math.max(1, t.dtermLpf)); });
    this.dNotch.forEach((f) => f.set(t.dtermNotchCenter, t.dtermNotchCutoff, t.dynNotchQ));
    this.dNotch[1].set(t.dtermNotchCenter * 2.5, t.dtermNotchCutoff * 2, t.dynNotchQ);
    this.ffSmooth.forEach((f) => { f.tau = t.ffSmoothTau; });
    this.pSmooth.forEach((f) => { f.tau = t.pSmoothTau; });
    this.mode = t.mode || 'acro';
  }

  /* -------------------------------------------------------------- gyro */

  /**
   * Sample the gyro at the physics rate. `omega` is body angular velocity in
   * rad/s; `accelWorld` in m/s^2; `dt` seconds.
   */
  sampleGyro(dt, omega, accelWorld, desync) {
    const noise = this.spec.gyroNoise * (1 + desync * 5);
    const rng = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.577 * noise;
    this.gyroTrue.x = omega.x * RAD;
    this.gyroTrue.y = omega.y * RAD;
    this.gyroTrue.z = omega.z * RAD;
    this.gyroRaw.x = this.gyroTrue.x + this.gyroBias.x + rng();
    this.gyroRaw.y = this.gyroTrue.y + this.gyroBias.y + rng();
    this.gyroRaw.z = this.gyroTrue.z + this.gyroBias.z + rng();
    // Desync artefacts are not noise: they are short violent spikes, which is
    // exactly what makes a bad tune oscillate on a bad build.
    if (desync > 0.05 && Math.random() < desync * 0.06) {
      this.desyncImpulse = (Math.random() * 2 - 1) * 900 * desync;
    } else {
      this.desyncImpulse = this.desyncImpulse * 0.6;
    }
    // Low-frequency vibration aliases into the gyro band; the notch chain eats
    // most of it, the rest is the reason filters exist.
    const vib = 40 * desync;
    this.gyroRaw.x += Math.sin(performanceNow() * 0.004) * vib;
    this.gyroRaw.z += Math.cos(performanceNow() * 0.0061) * vib;

    const r = [this.gyroRaw.x, this.gyroRaw.y, this.gyroRaw.z];
    filtAxis(0, r[0], dt, this, t0);
    filtAxis(1, r[1], dt, this, t1);
    filtAxis(2, r[2], dt, this, t2);
    this.gyroFiltered.x = t0.v;
    this.gyroFiltered.y = t1.v;
    this.gyroFiltered.z = t2.v;
    this.gyro.x = this.gyroFiltered.x + this.desyncImpulse;
    this.gyro.y = this.gyroFiltered.y;
    this.gyro.z = this.gyroFiltered.z;

    // accelerometer, used for impact detection and attitude
    this.accel.x = accelWorld.x / 9.80665;
    this.accel.y = accelWorld.y / 9.80665;
    this.accel.z = accelWorld.z / 9.80665;
  }

  /* ------------------------------------------------------------- rates */

  /** Betaflight "actual" rate curve for a stick position in -1..1. */
  stickToRate(stick, t = this.tune) {
    const rc = clamp(stick, -1, 1);
    const acExpo = clamp(t.expo, 0, 100) / 100;
    const centerActual = t.centerSens * (1 - acExpo) + acExpo * 10;
    const a = Math.abs(rc);
    if (a < 1e-4) return 0;
    // pure expo near centre, then a power curve to max rate
    const shaped = a * (1 - acExpo) + acExpo * a * a * a;
    const powered = Math.pow(shaped, 1 / (1 + acExpo * 1.5));
    const rate = centerActual + (t.maxRate - centerActual) * powered;
    return sign(rc) * rate;
  }

  /* --------------------------------------------------------- angle mode */

  computeAngleModeSetpoint(sticks, quat, euler, dt) {
    const t = this.tune;
    const maxAngle = 55;
    // Stick -> desired tilt. Stick right = roll right, stick forward = nose up.
    const dRoll = sticks.x * maxAngle;
    const dPitch = sticks.y * maxAngle;
    const sp = { x: 0, y: 0, z: 0 };
    if (this.mode === 'angle' || this.mode === 'horizon') {
      const blend = this.mode === 'horizon'
        ? clamp(Math.abs(sticks.x) + Math.abs(sticks.y), 0, 1) : 1;
      const kp = 9.0;
      sp.x = clamp((dRoll - euler.roll * DEG) * kp, -520, 520) * blend;
      sp.y = clamp((dPitch - euler.pitch * DEG) * kp, -520, 520) * blend;
      sp.z = this.stickToRate(sticks.z, t);
    } else {
      sp.x = this.stickToRate(sticks.x, t);
      sp.y = this.stickToRate(sticks.y, t);
      sp.z = this.stickToRate(sticks.z, t);
    }
    return sp;
  }

  /* ------------------------------------------------------------- PID */

  /**
   * One PID iteration.
   * @param dt        PID loop period (s)
   * @param sticks    {x,y,z,throttle} in -1..1 / 0..1
   * @param euler     {roll,pitch,yaw} radians
   * @param mixInfo   from the mixer: {throttleLimited}
   */
  runPID(dt, sticks, euler, extra = {}) {
    const t = this.tune;
    const sp = extra.setpoint || this.computeAngleModeSetpoint(sticks, null, euler, dt);
    this.setpoint.x = sp.x; this.setpoint.y = sp.y; this.setpoint.z = sp.z;

    const gyro = [this.gyro.x, this.gyro.y, this.gyro.z];
    const sps = [sp.x, sp.y, sp.z];
    const prevs = [this.prevSetpoint.x, this.prevSetpoint.y, this.prevSetpoint.z];
    const prevsG = [this.prevGyro.x, this.prevGyro.y, this.prevGyro.z];

    const demands = { x: 0, y: 0, z: 0 };
    const throttle = sticks.throttle;

    // Antiwindup: hold the I-term when the mixer was saturated on the previous
    // iteration. Betaflight does the same thing - it can only know about
    // saturation after mixing, so the decision is one iteration late.
    const saturated = (this.mixScale != null && this.mixScale < 0.999)
      || this.throttleOut >= t.maxThrottle - 1
      || this.throttleOut <= t.minThrottle + 1;
    this.saturated = saturated;
    const relax = t.itermRelax / 100;
    const rateSetpoint = Math.abs(sps[0]) + Math.abs(sps[1]) + Math.abs(sps[2]);

    for (let a = 0; a < 3; a++) {
      const ax = this.axis[a];
      const spv = sps[a];
      const gv = gyro[a];
      const err = spv - gv;

      // --- P (on error, output smoothed like Betaflight's pterm PT1)
      const pRaw = ax.p * err * 0.032;
      this.pSmooth[a].tau = t.pSmoothTau;
      ax.pSmoothed = this.pSmooth[a].update(pRaw, dt);
      ax.pTerm = ax.pSmoothed;

      // --- D on measurement derivative, filtered and limited
      const dGyro = (gv - prevsG[a]) / dt;
      let dRaw = ax.d * dGyro * 1e-4;
      if (ax.d > 0) {
        dRaw = this.dNotch[0].update(dRaw);
        dRaw = this.dLpf[a].update(dRaw, dt);
        // D-max: the total authority D is allowed to use.
        const maxD = t.dMax;
        const otherD = Math.abs(this.axis[1].dOut) + Math.abs(this.axis[2].dOut);
        ax.dOut = clamp(dRaw, -(maxD - otherD) * 0.5, (maxD - otherD) * 0.5);
      } else {
        ax.dOut = 0;
      }

      // --- Feedforward on the setpoint derivative, smoothed
      const dSp = (spv - prevs[a]) / dt;
      let ff = ax.f * dSp * 1e-4;
      ff = this.ffSmooth[a].update(ff, dt);
      ax.fOut = clamp(ff, -250, 250);

      // --- I with anti-windup, relax and a hard clamp
      if (!this.armed) {
        ax.iTerm *= 0.9;   // decay towards zero while disarmed
      } else if (!saturated) {
        const relaxFactor = 1 - clamp((rateSetpoint - Math.abs(gv)) / 40, 0, 1) * relax;
        ax.iTerm += err * dt * (1 / 50) * relaxFactor;
      }
      const iLimit = t.itermLimit;
      ax.iTerm = clamp(ax.iTerm, -iLimit, iLimit);
      ax.iOut = ax.i * ax.iTerm * 0.032;

      ax.sum = ax.pTerm + ax.iOut + ax.dOut + ax.fOut;

      // --- anti-gravity: an impact dumps iTerm into the motors to help recover
      if (t.antiGravity && this.armed) {
        ax.sum += this.antiGravityGain * ax.iTerm * 0.02;
      }
      demands[a === 0 ? 'x' : a === 1 ? 'y' : 'z'] = ax.sum;

      this.prevGyro[a === 0 ? 'x' : a === 1 ? 'y' : 'z'] = gv;
    }
    this.prevSetpoint.x = sps[0]; this.prevSetpoint.y = sps[1]; this.prevSetpoint.z = sps[2];
    this.axisDemand = demands;

    /* ------------------------------------------------------------ mixer */
    const m = MIX_TABLE;
    const out = [0, 0, 0, 0];
    const range = (t.maxThrottle - t.minThrottle);
    const idle = t.minThrottle + range * (t.idlePercent / 100);
    const th = clamp(throttle, 0, 1);
    const thOut = idle + range * clamp((th - t.idlePercent / 100) / (1 - t.idlePercent / 100), 0, t.throttlelimit / 100);

    let scale = 1;
    // Airmode: shrink the axis demands to fit rather than clipping.
    let maxNeed = 0;
    for (let i = 0; i < 4; i++) {
      let need = 0;
      for (let a = 0; a < 3; a++) {
        const wgt = m[a][i];
        if (wgt) need += (wgt / 100) * this.axis[a].sum;
      }
      if (Math.abs(need) > maxNeed) maxNeed = Math.abs(need);
    }
    const headroomUp = t.maxThrottle - thOut;
    const headroomDown = thOut - t.minThrottle;
    if (maxNeed > headroomUp) scale = headroomUp / maxNeed;
    if (maxNeed > headroomDown) scale = Math.min(scale, headroomDown / maxNeed);
    if (!t.airmode && scale < 1) {
      // Without airmode, throttle wins and the axis demands are clipped.
      scale = 1;
    }
    this.mixScale = scale;

    for (let i = 0; i < 4; i++) {
      let v = thOut;
      v += (m[0][i] / 100) * this.axis[0].sum * scale;
      v += (m[1][i] / 100) * this.axis[1].sum * scale;
      v += (m[2][i] / 100) * this.axis[2].sum * scale;
      out[i] = clamp(v, t.minThrottle, t.maxThrottle);
    }
    this.throttleOut = thOut;
    this.motors = out;
    this.axisSaturated = scale < 0.999;
    this.mixThrottleLimited = thOut >= t.maxThrottle - 1;

    // Disarmed: motors at minimum (or idle for a bench test).
    if (!this.armed) {
      for (let i = 0; i < 4; i++) this.motors[i] = this.tune.minThrottle;
    }
    return out;
  }

  /* ----------------------------------------------------------- health */

  setBattery(voltage, current, sag) {
    this.voltage = voltage; this.currentA = current; this.batterySag = sag;
    // Regulator brownout threshold scales with the FC spec.
    const minCell = this.spec.name === 'H743 30.5x30.5' ? 3.05 : 3.35;
    const vMin = minCell * 4.0;
    if (voltage < vMin) {
      this.brownout = true;
      this.brownoutCount++;
      this.armed = false;
    } else if (voltage > vMin + 0.35) {
      this.brownout = false;
    }
  }

  updateFailsafe(dt, linkOk) {
    if (!linkOk) {
      this.rcLost = true;
      this.failsafeStage = 1;
    } else if (this.failsafeStage === 1 && linkOk) {
      this.failsafeStage = 0;
      this.rcLost = false;
    }
    this.failsafe = this.failsafeStage > 0;
  }

  calibrateGyro(samples = 200) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < samples; i++) {
      x += this.gyroTrue.x; y += this.gyroTrue.y; z += this.gyroTrue.z;
    }
    this.gyroBias.x = -x / samples; this.gyroBias.y = -y / samples; this.gyroBias.z = -z / samples;
    for (const ax of this.axis) ax.reset(0);
  }

  reset() {
    this.armed = false;
    this.brownoutCount = 0;
    this.failsafeStage = 0;
    this.failsafe = false;
    this.crashDetected = false;
    this.crashFlip = false;
    for (const ax of this.axis) ax.reset(0);
    this.lpf1.forEach((f) => f.reset(0));
    this.lpf2.forEach((f) => f.reset());
    this.notches.forEach((f) => f.reset());
    this.dNotch.forEach((f) => f.reset());
  }

  /** Dynamic notch tuning from measured motor RPM. */
  updateDynamicNotch(rpmHz, dt) {
    const t = this.tune;
    const target = clamp(rpmHz, t.dynNotchMinHz, t.dynNotchMaxHz);
    if (!this.notchFreq) this.notchFreq = target;
    // The notch tracks the rotor RPM with a little lag, like the real filter.
    this.notchFreq = lag(this.notchFreq, target, 0.02, dt);
    this.notches[0].set(this.notchFreq, this.notchFreq * 0.6, t.dynNotchQ);
    this.notches[1].set(this.notchFreq * 1.9, this.notchFreq * 0.6, t.dynNotchQ);
  }
}

// Motor order: 0=FL 1=FR 2=RL 3=RR. Rows: roll, pitch, yaw.
//
// These follow from torque = r x F with thrust along body -Z (up) in an NED
// body frame, so they are easy to get backwards:
//   roll  right   -> more thrust on the LEFT motors  (push the left wing up)
//   pitch nose-up -> more thrust on the FRONT motors
//   yaw   right   -> more thrust from the counter-clockwise props (FL, RR),
//                    whose reaction torque on the airframe is nose-right
export const MIX_TABLE = [
  [100, -100, 100, -100],
  [100, 100, -100, -100],
  [100, -100, -100, 100],
];

function v3Accel() { return { x: 0, y: 0, z: 0 }; }
const t0 = { v: 0 }, t1 = { v: 0 }, t2 = { v: 0 };

// Gyro filter chain: dynamic notch -> PT1 -> biquad.
function filtAxis(i, x, dt, fc, out) {
  let v = x;
  for (const n of fc.notches) v = n.update(v);
  v = fc.lpf1[i].update(v, dt);
  v = fc.lpf2[i].update(v, dt);
  out.v = v;
  return v;
}

function performanceNow() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
