// Simulation orchestrator.
//
// Owns the fixed-step clock, the pilot's sticks, the two radio links and the
// craft's lifecycle. Everything downstream of this file is pure physics.
//
// Time is deliberately decoupled from the frame rate: physics runs at a fixed
// rate (8 kHz by default) and the renderer just reads whatever state the last
// physics tick produced. That is the only way a 6-DOF model with 5 kHz propwash
// iteration can behave the same on a laptop and on a fast machine.

import { clamp, lerp, RAD, DEG } from '../core/math.js';
import { buildCraft, stepCraft, analyseBuild, attitudeOf, GEAR_HEIGHT, Q_LEVEL } from './craft.js';
import { Environment } from './environment.js';
import { VideoLink, RadioLink, RFWorld } from './rf.js';
import { Telemetry, makeTraces } from './telemetry.js';
import { DEFAULT_TUNE, cloneTune } from './fc.js';

export const PHYSICS_HZ = 8000;
const MAX_SUBSTEPS = 400;          // cap so a long stall cannot lock the page

/* ------------------------------------------------------------------- input */

// Keyboard + gamepad stick handling, plus an RC override for tuning.
export class RCInput {
  constructor() {
    this.sticks = { x: 0, y: 0, z: 0, throttle: 0 };
    this.raw = { x: 0, y: 0, z: 0, throttle: 0 };
    this.keys = new Set();
    this.throttleMode = 0;    // 0 = spring return to centre, 1 = hold
    this.gamepadIndex = null;
    this.armed = false;
    this.onArmToggle = null;
    this.enabled = true;
    this.gamepadDeadzone = 0.04;
    this.invertThrottle = false;
  }

  key(code, down) {
    if (down) this.keys.add(code); else this.keys.delete(code);
  }

  poll(dt, mode = 'acro') {
    const r = this.raw;
    const k = this.keys;
    // Digital keys drive a ramp; a real thumbstick is analogue, so the ramp
    // stands in for the pilot's stick travel and the spring for finger tension.
    const rate = 4.0, centre = 5.5;
    const axis = (pos, neg, cur) => {
      let v = cur;
      if (k.has(pos)) v += rate * dt;
      if (k.has(neg)) v -= rate * dt;
      if (!k.has(pos) && !k.has(neg) && mode === 'acro') {
        // stick self-centres to the trim point; acro means it springs back
        const d = centre * dt - v;
        v += clamp(d, -centre * dt, centre * dt);
      } else if (!k.has(pos) && !k.has(neg) && mode === 'angle') {
        // angle mode needs the stick held, so bleed slowly to centre
        v *= Math.max(0, 1 - 1.6 * dt);
      }
      return clamp(v, -1, 1);
    };
    r.x = axis('ArrowRight', 'ArrowLeft', r.x);
    r.y = axis('ArrowUp', 'ArrowDown', r.y);
    r.z = axis('KeyE', 'KeyQ', r.z);

    // throttle
    let t = r.throttle;
    if (k.has('ShiftLeft') || k.has('ShiftRight')) t -= 1.6 * dt;
    if (k.has('Space')) t += 1.6 * dt;
    if (this.throttleMode === 0) {
      // centre-release throttle stick: hold space to climb, release to sink
      const target = k.has('Space') ? 1 : 0;
      t += clamp(target - t, -2.4 * dt, 2.4 * dt);
    }
    if (!this.invertThrottle && k.has('KeyX')) t = 0;
    r.throttle = clamp(t, 0, 1);

    // gamepad overrides when it has real deflection
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const dz = this.gamepadDeadzone;
      const ax = (v) => (Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz));
      const gx = ax(p.axes[0] || 0), gy = ax(p.axes[1] || 0);
      const gz = (p.buttons[6] ? -1 : 0) + (p.buttons[7] ? 1 : 0);
      const gt = p.buttons[7] ? 1 : p.buttons[6] ? 0 : -1;
      if (Math.abs(gx) > 0.02) r.x = gx;
      if (Math.abs(gy) > 0.02) r.y = -gy;
      if (gz !== 0) r.z = gz;
      if (gt >= 0) r.throttle = gt;
      // button 0 = arm toggle
      if (p.buttons[0] && p.buttons[0].pressed && !this._padArm) {
        this._padArm = true;
        if (this.onArmToggle) this.onArmToggle();
      }
      if (p.buttons[0] && !p.buttons[0].pressed) this._padArm = false;
      break;
    }
    return r;
  }

  centre() {
    this.raw.x = 0; this.raw.y = 0; this.raw.z = 0;
  }
  reset() {
    this.raw.x = 0; this.raw.y = 0; this.raw.z = 0; this.raw.throttle = 0;
    this.keys.clear();
  }
}

/* ---------------------------------------------------- RC link with latency */

// Sticks do not reach the FC instantly: they travel over the radio, are decoded
// at the link's frame rate, and can be lost. This is what makes a bad link feel
// bad - you lose sticks for a frame or two and the quad keeps doing what it was
// told a moment ago.
export class RCTransport {
  constructor() {
    this.queue = [];
    this.maxDelayMs = 260;
    this.last = null;      // the frame the FC is currently acting on
    this.fresh = false;    // true on the tick a new frame arrives
    this.age = 0;
  }
  push(sticks, latencyMs, periodMs) {
    const f = { x: sticks.x, y: sticks.y, z: sticks.z, throttle: sticks.throttle };
    // Frames arrive in order, so a simple FIFO is correct at these rates; guard
    // against a pathological backlog.
    const delay = clamp(latencyMs + periodMs * 0.5, 0, this.maxDelayMs);
    this.queue.push({ at: delay / 1000, f });
    if (this.queue.length > 64) this.queue.splice(0, this.queue.length - 64);
  }
  step(dt) {
    this.fresh = false;
    let out = null;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      this.queue[i].at -= dt;
      if (this.queue[i].at <= 0) {
        // Prefer the oldest matured frame: later ones are still in flight.
        if (!out || this.queue[i].at <= out.at) out = { f: this.queue[i].f, at: this.queue[i].at };
        this.queue.splice(i, 1);
      }
    }
    if (out) {
      this.last = out.f;
      this.fresh = true;
      this.age = 0;
    } else {
      this.age += dt;
    }
    // A real flight controller acts on the last frame it received until a new
    // one arrives. With a 250 Hz link feeding an 8 kHz loop that means the same
    // stick position is read 32 times - returning null here and zeroing the
    // sticks would make the craft twitch 32 times a second.
    return this.last;
  }
  clear() { this.queue.length = 0; this.last = null; this.age = 0; }
}

/* ------------------------------------------------------------------- sim */

export class Simulation {
  constructor(opts = {}) {
    this.physicsHz = opts.physicsHz || PHYSICS_HZ;
    this.dt = 1 / this.physicsHz;
    this.env = opts.env || new Environment();
    this.rfWorld = opts.rfWorld || new RFWorld();
    this.env.rfWorld = this.rfWorld;
    this.colliders = opts.colliders || [];
    this.pilotPos = opts.pilotPos || { x: 0, y: 1.6, z: 0 };
    this.pilotMode = opts.pilotMode || 'follow';
    // Goggle patch antennas are vertically polarised by default; rotating them is
    // a real way to quietly lose your picture, so the UI exposes the angle.
    this.rxPol = { x: 0, y: 1, z: 0 };
    this.spec = opts.spec;
    this.tune = opts.tune || cloneTune(DEFAULT_TUNE);
    this.input = new RCInput();
    this.rc = new RCTransport();
    this.radio = new RadioLink(this.radioCfg(opts.spec));
    this.video = new VideoLink(this.videoCfg(opts.spec));
    this.telemetry = new Telemetry(opts.logSeconds || 120, opts.logRate || 1000,
      ['vtxRSSI', 'vtxQual', 'rcLQ', 'wash', 'clearance']);
    this.traces = makeTraces(220);
    this.interferers = [];
    this.time = 0;
    this.paused = false;
    this.running = false;
    this.speedScale = 1;
    this.events = [];
    this.lastEvent = {};
    this.armAttempts = 0;
    this.buildTime = 0;
    this.crashTime = 0;
    this.crashed = false;
    this.rebuild(opts.spec);
  }

  radioCfg(spec) {
    const map = {
      'rx-elrs2': 'elrs2', 'rx-elrs900': 'elrs900', 'rx-crsf': 'crsf', 'rx-ghost': 'ghost',
    };
    return { protocol: map[spec.rx] || 'elrs2' };
  }
  videoCfg(spec) {
    return { system: 'analog', band: 'R', channel: 3, powerMw: 200 };
  }

  /** Build (or rebuild) the craft from a spec. Keeps the environment. */
  rebuild(spec) {
    const keepBatt = this.craft && this.craft.battSpec.id === spec.battery
      ? {
        soc: this.craft.battery.soc,
        tempC: this.craft.battery.ambientC,
        cycles: this.craft.battery.cyclesUsed || 0,
        condition: this.craft.battery.condition,
        spread: Math.max(...this.craft.battery.offsets) - Math.min(...this.craft.battery.offsets),
      }
      : { soc: 1, cycles: (spec.cycles || 0) };
    this.spec = { ...spec };
    this.craft = buildCraft(this.spec, {
      env: this.env, tune: this.tune, physicsHz: this.physicsHz, pidDivisor: 1,
      batteryState: keepBatt, colliders: this.colliders,
    });
    this.craft.body.pos.y = 0.09;
    this.analysis = analyseBuild(this.spec, { env: this.env });
    this.craft.hoverCurrentA = this.analysis.hoverCurrent;
    this.craft.maxCurrentA = this.analysis.maxCurrent;
    this.telemetry.start();
    this.buildTime = this.time;
    this.crashed = false;
    this.crashTime = 0;
    this.log('build', `Built ${this.craft.frame.name} / ${this.craft.motor.name}`
      + ` ${this.craft.motors[0].kv} KV / ${this.craft.prop.name} / ${this.craft.battSpec.name}`);
    return this.craft;
  }

  setTune(tune) {
    this.tune = tune;
    this.craft.fc.tune = tune;
    this.craft.fc.applyTune();
    this.craft.fc.mode = tune.mode;
  }

  /** Try to arm. The FC will refuse if the gyro is not settled or the link is down. */
  arm() {
    const fc = this.craft.fc;
    this.armAttempts++;
    if (fc.brownout) { this.log('warn', 'Cannot arm: board is browned out'); return false; }
    if (this.radio.failsafe) { this.log('warn', 'Cannot arm: control link is down'); return false; }
    fc.armed = true;
    fc.crashDetected = false;
    this.log('ok', 'Armed');
    return true;
  }
  disarm() {
    this.craft.fc.armed = false;
    this.log('info', 'Disarmed');
  }
  toggleArm() { if (this.craft.fc.armed) this.disarm(); else this.arm(); }

  log(kind, text) {
    const t = this.time - this.buildTime;
    this.events.push({ t, kind, text });
    if (this.events.length > 120) this.events.shift();
    // Only announce state transitions, not every tick.
    const key = kind + text;
    if (this.lastEvent[key] !== undefined && this.time - this.lastEvent[key] < 3) return;
    this.lastEvent[key] = this.time;
    if (this.onEvent) this.onEvent(kind, text);
  }

  /** Place the craft on the start pad, disarmed, with a fresh-ish pack. */
  reset(opts = {}) {
    const c = this.craft;
    c.body.pos = { x: opts.x != null ? opts.x : 0, y: opts.y != null ? opts.y : GEAR_HEIGHT, z: opts.z != null ? opts.z : 0 };
    c.body.vel = { x: 0, y: 0, z: 0 };
    c.body.omega = { x: 0, y: 0, z: 0 };
    // Level is Q_LEVEL, not the identity quaternion. The body frame is
    // aerospace NED and the world is Y-up, so identity means nose-down 90
    // degrees: the airframe spawns on its side and the HUD reads -90 deg pitch.
    c.body.quat = { x: Q_LEVEL.x, y: Q_LEVEL.y, z: Q_LEVEL.z, w: Q_LEVEL.w };
    c.body.updateRotation();
    c.fc.armed = false;
    c.fc.reset();
    c.propStrike = 0;
    this.propStrikeAt = null;
    if (opts.rebuildBattery) c.battery.usableAh = c.battery.capacityAh;
    this.input.reset();
    this.rc.clear();
    this.radio.reset();
    this.crashed = false;
    this.crashTime = 0;
    this.log('info', 'Reset');
  }

  setStickMode(mode) {
    this.input.throttleMode = mode;
  }

  /* ------------------------------------------------------------------ step */

  /**
   * Advance the simulation by `wallDt` seconds of real time.
   * @returns {number} number of physics ticks run
   */
  step(wallDt) {
    if (this.paused) return 0;
    const dt = this.dt;
    const scaled = Math.min(0.25, wallDt) * this.speedScale;
    this._acc = (this._acc || 0) + scaled;
    let n = 0;
    let runPID = !this.previewMode;
    while (this._acc >= dt && n < MAX_SUBSTEPS) {
      this._acc -= dt;
      n++;
      if (this.previewMode) this.previewMotors(this.craft);
      this.tick(dt, runPID);
      // The flight controller runs at a divisor of the physics rate, like real
      // hardware running a PID loop slower than the gyro sampler.
      runPID = !runPID;
    }
    if (n >= MAX_SUBSTEPS) this._acc = 0;
    if (n) this.postStep(scaled);
    return n;
  }

  /** Roll the goggle polarisation axis; a rotated patch antenna costs real dB. */
  updateRxPolarisation(angleRad) {
    this.rxPol = { x: 0, y: Math.cos(angleRad), z: Math.sin(angleRad) };
  }

  /** Builder preview: spin the props at hover rpm without running the FC. */
  previewMotors(craft) {
    const hover = craft.hoverThrottle || craft.analysis?.hoverThrottle || 0.25;
    const m = 1000 + 1000 * Math.max(0.1, hover);
    craft.fc.motors = [m, m, m, m];
    craft.fc.throttleOut = m;
    // Hold the craft still so the model reads as a drawing.
    craft.body.pos.y = 0.30;
    craft.body.vel = { x: 0, y: 0, z: 0 };
    craft.body.omega = { x: 0, y: 0, z: 0 };
    craft.body.quat = { x: Q_LEVEL.x, y: Q_LEVEL.y, z: Q_LEVEL.z, w: Q_LEVEL.w };
    craft.body.updateRotation();
  }

  tick(dt, runPID) {
    this.time += dt;
    this.env.step(dt);
    const craft = this.craft;

    const mode = craft.fc.mode;
    const raw = this.input.poll(dt, mode);

    // --- Radio link. This runs at the *link's* frame rate, not the physics
    // rate: a 250 Hz ELRS link delivers 250 frames a second no matter how fast
    // the physics steps, and that frame rate is what sets the worst-case
    // control latency.
    this._linkAcc = (this._linkAcc || 0) + dt;
    const period = this.radio.periodMs / 1000;
    if (this._linkAcc >= period) {
      // Antenna geometry: the VTX duck antenna leans back at 45 degrees in the
      // body frame, which is why turning your back on the pilot costs signal.
      const antAxis = craft.body.toWorld(ANT_LOCAL, { x: 0, y: 0, z: 0 });
      this.radio.update(this.rfWorld, this.pilotPos,
        craft.body.pointToWorld(ANT_LOCAL, { x: 0, y: 0, z: 0 }), this.rxPol, period);
      if (this.radio.delivered) {
        this.rc.push(raw, this.radio.latencyMs, this.radio.periodMs);
      }
      this._linkAcc = 0;
    }

    let cmd = this.rc.step(dt);
    if (this.radio.failsafe) {
      // Real dropsafe: the FC holds the last command for the signal-loss window,
      // then cuts to idle. Betaflight freezes the setpoints and drops throttle.
      craft.fc.updateFailsafe(dt, false);
      this.log('warn', 'Failsafe: link lost');
      cmd = null;
    } else {
      craft.fc.updateFailsafe(dt, true);
    }
    const sticks = cmd || { x: 0, y: 0, z: 0, throttle: 0 };

    /* --- physics */
    stepCraft(craft, dt, this.env, sticks, { runPID });

    /* --- video link: a 5.8 GHz video receiver only needs a frame-rate update */
    this._videoAcc = (this._videoAcc || 0) + dt;
    if (this._videoAcc >= 1 / 60) {
      if (this.pilotMode === 'follow') {
        // A real pilot stays roughly with the quad rather than standing still.
        const k = clamp(this._videoAcc * 0.6, 0, 1);
        this.pilotPos.x = lerp(this.pilotPos.x, craft.body.pos.x, k);
        this.pilotPos.y = lerp(this.pilotPos.y, Math.max(1.2, craft.body.pos.y), k);
        this.pilotPos.z = lerp(this.pilotPos.z, craft.body.pos.z, k);
      }
      this.video.update(this.rfWorld,
        craft.body.pointToWorld(ANT_LOCAL, { x: 0, y: 0, z: 0 }),
        craft.body.toWorld(ANT_LOCAL, { x: 0, y: 0, z: 0 }),
        this.pilotPos, this.rxPol, this.interferers);
      this._videoAcc = 0;
    }

    /* --- events worth telling the pilot about */
    if (craft.fc.brownout && !this._brown) {
      this._brown = true;
      this.log('error', `BROWNOUT at ${craft.battery.voltage.toFixed(2)} V - disarmed`);
    } else if (!craft.fc.brownout && craft.battery.voltage > 4 * 3.6) {
      this._brown = false;
    }
    if (craft.esc.overTemp && !this._escHot) {
      this._escHot = true;
      this.log('warn', `ESC over temperature (${craft.esc.tempC.toFixed(0)} C) - derating`);
    }
    if (craft.battery.minCellV < craft.battery.cutoffV + 0.12 && !this._lowCell) {
      this._lowCell = true;
      this.log('warn', `Cell low: ${craft.battery.minCellV.toFixed(2)} V`);
    }
    if (craft.motors.some((m) => m.tempC > 110) && !this._motHot) {
      this._motHot = true;
      this.log('warn', 'Motor over 110 C - it will not survive this');
    }
    if (craft.battery.crashed && !this._crashedCell) {
      this._crashedCell = true;
      this.log('error', 'Pack finished - change it');
    }
    if (craft.propStrike > 3) {
      this.propStrikeAt = this.propStrikeAt || {};
      if (!this.propStrikeAt.key) {
        this.propStrikeAt.key = true;
        this.log('warn', `Prop strike at ${craft.propStrike.toFixed(0)} m/s`);
      }
    } else if (craft.propStrike < 0.2) {
      this.propStrikeAt = null;
    }
    // A momentary sag past cutoff on a healthy pack is just a hard punchout.
    if (craft.battery.underVoltage && !this._sagWarn) {
      this._sagWarn = true;
      this.log('warn', `Sagged to ${craft.battery.minCellV.toFixed(2)} V/cell - big punch`);
    } else if (!craft.battery.underVoltage) {
      this._sagWarn = false;
    }
    if (craft.fc.overTemp) { /* handled by FC */ }

    // Crash detection: on the ground, upside down, spinning.
    if (craft.body.onGround && !craft.fc.armed) {
      this.crashed = false;
      this.crashTime = 0;
    } else if (craft.fc.armed) {
      const e = attitudeOf(craft.body.quat);
      const inverted = Math.abs(e.roll * RAD) > 100 || Math.abs(e.pitch * RAD) > 100;
      const hard = Math.hypot(craft.body.omega.x, craft.body.omega.y, craft.body.omega.z) > 22
        || craft.body.onGround;
      if (inverted || (hard && craft.body.onGround && Math.hypot(craft.body.vel.x, craft.body.vel.z) > 4)) {
        this.crashTime += dt;
        if (this.crashTime > 0.6 && !this.crashed) {
          this.crashed = true;
          this.log('error', 'Crashed');
        }
      } else {
        this.crashTime = Math.max(0, this.crashTime - dt * 2);
      }
    }
  }

  /** Once-per-frame work: telemetry, traces, dynamic notch. */
  postStep(dt) {
    const craft = this.craft;
    const t = this.traces;
    t.throttle.push(craft.fc.throttleOut);
    t.current.push(craft.currentA);
    t.voltage.push(craft.battery.voltage);
    t.sag.push(craft.battery.sagVolts);
    t.rpm.push(craft.motors.reduce((a, m) => a + m.RPM, 0) / 4);
    t.gyroRoll.push(craft.fc.gyro.x); t.gyroPitch.push(craft.fc.gyro.y); t.gyroYaw.push(craft.fc.gyro.z);
    t.setRoll.push(craft.fc.setpoint.x); t.setPitch.push(craft.fc.setpoint.y); t.setYaw.push(craft.fc.setpoint.z);
    t.speed.push(Math.hypot(craft.body.vel.x, craft.body.vel.y, craft.body.vel.z));
    t.alt.push(craft.body.pos.y);
    t.thrust.push(craft.thrust);
    t.vtxQual.push(this.video.quality);
    t.rcLQ.push(this.radio.lq);
    t.wash.push(craft.surfaceWash || 0);

    // Dynamic notch tracks the measured rotor frequency, which is what stops a
    // tune from ringing on a build with a different motor and prop.
    const rpmHz = craft.motors.reduce((a, m) => a + m.RPM, 0) / 4 / 60;
    if (rpmHz > 20) craft.fc.updateDynamicNotch(rpmHz, dt);

    this.telemetry.sample(dt, craft, {
      vtxRSSI: this.video.rssi || 0,
      vtxQual: this.video.quality || 0,
      rcLQ: this.radio.lq || 0,
      wash: craft.surfaceWash || 0,
      clearance: craft.clearance || 0,
    });
  }

  /* ------------------------------------------------------------ telemetry */

  hud() {
    const c = this.craft;
    const b = c.body;
    const e = attitudeOf(b.quat);
    return {
      alt: b.pos.y,
      agl: b.pos.y,
      speed: Math.hypot(b.vel.x, b.vel.y, b.vel.z),
      horizontal: Math.hypot(b.vel.x, b.vel.z),
      vert: b.vel.y,
      roll: e.roll * RAD, pitch: e.pitch * RAD, yaw: e.yaw * RAD,
      rpm: c.motors.map((m) => m.RPM),
      motorTemp: c.motors.map((m) => m.tempC),
      motorOut: c.fc.motors,
      throttle: c.fc.throttleOut,
      current: c.currentA,
      voltage: c.battery.voltage,
      cellV: c.battery.minCellV,
      sag: c.battery.sagVolts,
      soc: c.battery.soc,
      battTemp: c.battery.tempAvg,
      escTemp: c.esc.tempC,
      thrust: c.thrust,
      weight: c.mass * 9.80665,
      gyro: c.fc.gyro,
      setpoint: c.fc.setpoint,
      pid: c.fc.axis.map((a) => ({ p: a.pTerm, i: a.iOut, d: a.dOut, f: a.fOut, sum: a.sum })),
      mixScale: c.fc.mixScale,
      armed: c.fc.armed,
      failsafe: c.fc.failsafe,
      brownout: c.fc.brownout,
      crashed: this.crashed,
      vtx: {
        rssi: this.video.rssi, quality: this.video.quality, latency: this.video.latencyMs,
        snow: this.video.snow, dropout: this.video.dropout, static: this.video.static,
        locked: this.video.locked, channel: this.video.channelLabel(),
        freq: this.video.freqMHz, budget: this.video.budget,
      },
      rc: {
        lq: this.radio.lq, rssi: this.radio.rssi, latency: this.radio.latencyMs,
        protocol: this.radio.sys.label, failsafe: this.radio.failsafe,
      },
      wash: {
        surface: c.surfaceWash || 0,
        mutual: c.washIntensity || 0,
        groundEffect: c.groundEffect || 1,
        clearance: c.clearance === Infinity ? null : c.clearance,
      },
      env: this.env.info(),
      time: this.time - this.buildTime,
    };
  }
}

// Body-frame duck-antenna direction: leans back and up at roughly 45 degrees.
const ANT_LOCAL = { x: -0.55, y: 0, z: -0.83 };
// Goggle patch antennas: vertically polarised by default. Rotating them is a
