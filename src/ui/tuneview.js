// Tune view: rates, PID, filters, plus the scopes that show whether a tune works.
//
// The step test is the important one. A tune can look fine in a hover and fall
// apart when you move; a real step response (stick step, watch overshoot, settling
// time and the D-term spike on the leading edge) tells you far more than the
// gains alone.

import { el, clear, sliderRow, selectRow, segButtons, Scope } from './dom.js';
import { TUNE_LIBRARY, cloneTune, DEFAULT_TUNE } from '../sim/fc.js';
import { RATE_PROFILES, PROFILE_LABELS, sampleCurve } from '../sim/rates.js';

// One line explaining each profile, the way the Betaflight page does.
const RATE_PROFILE_NOTES = {
  actual: 'Actual: deg/s at centre, expo to max rate. This is what almost '
    + 'everyone means by "my rates".',
  betaflight: 'Betaflight: the legacy rc-rate / super-rate curve, kept so an old '
    + 'tune still means what it meant.',
  kiss: 'Kiss: centre rate plus super rate, no expo. Maximum control, minimum '
    + 'forgiveness.',
};

const AXES = [
  { key: 0, label: 'Roll' },
  { key: 1, label: 'Pitch' },
  { key: 2, label: 'Yaw' },
];

export class TuneView {
  constructor(root, app) {
    this.app = app;
    this.lib = root.querySelector('#tune-lib');
    this.modeWrap = root.querySelector('#tune-mode');
    this.pidEl = root.querySelector('#pid');
    this.filtersEl = root.querySelector('#filters');
    this.looprateEl = root.querySelector('#looprate');
    this.gyroScope = new Scope(root.querySelector('#gyroscope'));
    this.motorScope = new Scope(root.querySelector('#motorscope'));
    this.stepScope = new Scope(root.querySelector('#stepscope'));
    root.querySelector('#btn-step').onclick = () => this.runStepTest();
    this.buildLib();
    this.buildMode();
    this.buildLoopRate();
    this.render();
  }

  buildLib() {
    clear(this.lib);
    this.libButtons = TUNE_LIBRARY.map((t) => el('button', {
      onclick: () => {
        this.app.setTune(cloneTune(t));
        this.render();
      },
    }, [
      el('span', { class: 'pn', text: t.name }),
      el('span', { class: 'pb',
        text: `P ${t.p.join('/')} · D ${t.d.join('/')} · ${PROFILE_LABELS[(t.rates || {}).type] || 'Actual'} rates` }),
    ]));
    this.libButtons.forEach((b) => this.lib.appendChild(b));
  }

  buildMode() {
    this.modeSeg = segButtons([
      { value: 'acro', label: 'Acro' },
      { value: 'angle', label: 'Angle' },
      { value: 'horizon', label: 'Horizon' },
    ], this.app.tune.mode, (v) => {
      this.app.tune.mode = v;
      this.app.sim.craft.fc.mode = v;
    });
    this.modeWrap.appendChild(this.modeSeg);
  }

  buildLoopRate() {
    clear(this.looprateEl);
    const sim = this.app.sim;
    const opts = [
      { value: '2000', label: '1 kHz' }, { value: '4000', label: '2 kHz' },
      { value: '8000', label: '4 kHz' }, { value: '16000', label: '8 kHz' },
    ];
    this.looprateEl.appendChild(selectRow('PID loop', opts,
      String(sim.physicsHz / sim.craft.fc.pidDivisor),
      (v) => {
        const target = parseInt(v, 10);
        sim.craft.fc.pidDivisor = Math.max(1, Math.round(sim.physicsHz / target));
        sim.craft.fc.pidHz = target;
      }));
    this.looprateEl.appendChild(el('div', { class: 'desc', text:
      'Real Betaflight builds run the PID loop at 2-8 kHz. Below about 1 kHz the loop '
      + 'cannot reject the motor\'s own electrical lag and everything starts to wobble.' }));
  }

  render() {
    const t = this.app.tune;
    clear(this.pidEl);

    // Rates card: Betaflight's Rates page - profile switch, per-axis knobs, live
    // curve. The FC owns the rates object, so edits write straight through it.
    const rates = el('div', { class: 'pidcard rates-card' });
    rates.appendChild(el('h3', { text: 'Rates' }));
    const R = this.app.sim.craft.fc.rates;
    const push = () => {
      this.app.pushTune();
      this.drawRateCurve();
      this.updateRatePrediction();
    };
    rates.appendChild(segButtons(
      RATE_PROFILES.map((p) => ({ value: p, label: PROFILE_LABELS[p] })),
      R.type,
      (v) => {
        R.type = v;
        push();
        this.buildRates();      // the sliders differ per profile
      }));
    rates.appendChild(el('div', { class: 'desc', text: RATE_PROFILE_NOTES[R.type] }));
    rates.appendChild(sliderRow('Deadzone', {
      min: 0, max: 0.2, step: 0.01, value: R.deadzone,
      onInput: (v) => { R.deadzone = v; push(); },
      desc: 'Stick travel ignored at centre, then rescaled so full deflection '
        + 'still reaches max rate.',
    }));
    this.rateAxesEl = el('div', { class: 'rate-axes' });
    rates.appendChild(this.rateAxesEl);
    this.rateCanvas = el('canvas', { class: 'rate-curve', width: 260, height: 120 });
    rates.appendChild(this.rateCanvas);
    rates.appendChild(el('div', { class: 'rate-legend' }, [
      el('span', { class: 'rl rl-roll', text: 'roll' }),
      el('span', { class: 'rl rl-pitch', text: 'pitch' }),
      el('span', { class: 'rl rl-yaw', text: 'yaw' }),
    ]));
    this.pidEl.appendChild(rates);
    this.buildRates();
    this.drawRateCurve();

    // PID cards
    for (const ax of AXES) {
      const card = el('div', { class: 'pidcard' });
      card.appendChild(el('h3', { text: ax.label + ' PID' }));
      const g = (label, arr, min, max, step, unit, desc) => {
        card.appendChild(sliderRow(label, {
          min, max, step, value: arr[ax.key], unit,
          onInput: (v) => { arr[ax.key] = v; this.app.pushTune(); },
          desc,
        }));
      };
      g('P', t.p, 0, 120, 1, '', 'how hard it corrects for rate error');
      g('I', t.i, 0, 120, 1, '', 'kills steady lean; too much winds up');
      g('D', t.d, 0, 80, 1, '', 'damps rate; main source of oscillation');
      g('F', t.f, 0, 250, 1, '', 'feedforward: anticipates stick movement');
      card.appendChild(el('div', { class: 'foot',
        text: `I limit ${t.itermLimit} · D max ${t.dMax}` }));
      this.pidEl.appendChild(card);
    }

    // Filters
    clear(this.filtersEl);
    const mk = (title, rows) => {
      const card = el('div', { class: 'pidcard' });
      card.appendChild(el('h3', { text: title }));
      for (const [label, key, min, max, step, unit, desc] of rows) {
        card.appendChild(sliderRow(label, {
          min, max, step, value: t[key], unit,
          onInput: (v) => { t[key] = v; this.app.pushTune(); },
          desc,
        }));
      }
      this.filtersEl.appendChild(card);
    };
    mk('Gyro filters', [
      ['LPF1', 'gyroLpf1', 60, 1000, 10, ' Hz', 'first PT1 stage on the gyro'],
      ['LPF2', 'gyroLpf2', 60, 1000, 10, ' Hz', 'biquad; lower means less noise, more lag'],
    ]);
    mk('D-term', [
      ['LPF', 'dtermLpf', 30, 250, 5, ' Hz', 'the D term amplifies noise, so it is filtered hard'],
      ['Notch', 'dtermNotchCenter', 80, 400, 5, ' Hz', 'notch at the rotor frequency'],
      ['D max', 'dMax', 100, 1000, 10, '', 'caps total D authority'],
    ]);
    mk('Dynamic notch', [
      ['Q', 'dynNotchQ', 1, 15, 0.5, '', 'narrow notch removes less noise, more control'],
      ['Min', 'dynNotchMinHz', 40, 200, 5, ' Hz'],
      ['Max', 'dynNotchMaxHz', 200, 900, 10, ' Hz'],
    ]);
    mk('Dynamics', [
      ['I relax', 'itermRelax', 0, 40, 1, '', 'slows I accumulation during fast moves'],
      ['I limit', 'itermLimit', 0, 500, 10, '', 'hard clamp on the I term'],
      ['P smooth', 'pSmoothTau', 0, 100, 1, ' ms', 'P output smoothing; too much adds lag'],
      ['FF smooth', 'ffSmoothTau', 0, 20, 0.5, ' ms', 'feedforward smoothing'],
    ]);

    const misc = el('div', { class: 'pidcard' });
    misc.appendChild(el('h3', { text: 'Mixer' }));
    misc.appendChild(sliderRow('Idle', {
      min: 0, max: 15, step: 0.5, value: t.idlePercent, unit: '%',
      onInput: (v) => { t.idlePercent = v; this.app.pushTune(); },
      desc: 'disarmed idle. Too high and the motors touch on arm.',
    }));
    misc.appendChild(sliderRow('Throttle limit', {
      min: 50, max: 100, step: 1, value: t.throttlelimit, unit: '%',
      onInput: (v) => { t.throttlelimit = v; this.app.pushTune(); },
    }));
    const airRow = segButtons([{ value: true, label: 'Airmode' }, { value: false, label: 'No airmode' }],
      t.airmode, (v) => { t.airmode = v; this.app.pushTune(); });
    misc.appendChild(el('div', { class: 'cfg-row' }, [el('label', { class: 'lbl', text: 'Airmode' }), airRow, el('span')]));
    misc.appendChild(el('div', { class: 'desc', text:
      'Airmode lets the mixer sacrifice throttle to keep control authority at full '
      + 'throttle. Without it, the sticks go soft near the stops.' }));
    this.filtersEl.appendChild(misc);

    // Live predicted rates, so the effect of a rates change is visible immediately.
    const pred = el('div', { class: 'pidcard' });
    pred.appendChild(el('h3', { text: 'Resulting rate curve' }));
    this.ratePred = el('div', { class: 'desc', text: '' });
    pred.appendChild(this.ratePred);
    this.filtersEl.appendChild(pred);
    this.updateRatePrediction();

    // Summary of what the current tune should feel like, from its own numbers.
    const feel = el('div', { class: 'pidcard' });
    feel.appendChild(el('h3', { text: 'Read of this tune' }));
    this.tuneFeel = el('div', { class: 'desc', text: '' });
    feel.appendChild(this.tuneFeel);
    this.filtersEl.appendChild(feel);
  }

  /**
   * Per-axis rate sliders. Which knobs appear depends on the active profile,
   * exactly as in Betaflight: Actual shows Centre sens / Max rate / Expo,
   * Betaflight shows Rc rate / Super rate / Expo / Rc expo, Kiss shows only
   * Rc rate / Super rate.
   */
  buildRates() {
    if (!this.rateAxesEl) return;
    const R = this.app.sim.craft.fc.rates;
    clear(this.rateAxesEl);

    for (const ax of [{ key: 'roll', label: 'Roll' },
      { key: 'pitch', label: 'Pitch' }, { key: 'yaw', label: 'Yaw' }]) {
      const cfg = R.axes[ax.key];
      const card = el('div', { class: 'rate-axis' });
      card.appendChild(el('h4', { text: ax.label }));
      const s = (label, key, min, max, step, unit, desc) => {
        card.appendChild(sliderRow(label, {
          min, max, step, value: cfg[key], unit,
          onInput: (v) => {
            cfg[key] = v;
            this.app.pushTune();
            this.drawRateCurve();
            this.updateRatePrediction();
          },
          desc,
        }));
      };

      if (R.type === 'kiss') {
        s('Rc rate', 'rcRate', 50, 600, 5, '', 'deg/s at stick centre');
        s('Super rate', 'superRate', 0, 400, 5, '°/s', 'added at full stick');
      } else if (R.type === 'betaflight') {
        s('Rc rate', 'rcRate', 50, 600, 5, '', 'deg/s at stick centre');
        s('Super rate', 'superRate', 0, 400, 5, '°/s', 'added at full stick');
        s('Expo', 'expo', 0, 100, 1, '', 'curves the super-rate term');
        s('Rc expo', 'rcExpo', 0, 100, 1, '', 'shapes the stick before the rate');
      } else {
        s('Centre sens', 'centerSensitivity', 10, 300, 1, '°/s',
          'rate at the first degree of stick');
        s('Max rate', 'maxRate', 100, 1800, 10, '°/s', 'rate at full stick');
        s('Expo', 'expo', 0, 100, 1, '', '0 is linear, higher is flatter at centre');
      }
      this.rateAxesEl.appendChild(card);
    }
  }

  /**
   * Draw the three rate curves. Recomputed on every slider move so the effect of
   * a change is visible immediately rather than described.
   */
  drawRateCurve() {
    const cv = this.rateCanvas;
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    const R = this.app.sim.craft.fc.rates;
    const W = cv.width, H = cv.height;
    const pad = { l: 32, r: 6, t: 8, b: 14 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10,13,17,0.55)';
    ctx.fillRect(0, 0, W, H);

    // One shared full scale across all three axes, so they are comparable.
    let maxRate = 1;
    for (const a of ['roll', 'pitch', 'yaw']) {
      const c = R.axes[a];
      maxRate = Math.max(maxRate, c.maxRate ?? (c.rcRate + (c.superRate || 0)));
    }
    maxRate = Math.ceil(maxRate / 200) * 200;

    ctx.strokeStyle = 'rgba(140,160,180,0.18)';
    ctx.lineWidth = 1;
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(140,160,180,0.7)';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + ih - (i / 4) * ih;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + iw, y);
      ctx.stroke();
      ctx.fillText(String(Math.round((i / 4) * maxRate)), pad.l - 3, y + 3);
    }
    ctx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
      const x = pad.l + (i / 4) * iw;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + ih);
      ctx.stroke();
    }
    ctx.fillText('0%', pad.l, H - 3);
    ctx.fillText('100%', pad.l + iw, H - 3);
    ctx.textAlign = 'left';

    const COLOURS = { roll: '#58b7e8', pitch: '#e0a04a', yaw: '#7fd6a8' };
    for (const a of ['roll', 'pitch', 'yaw']) {
      ctx.strokeStyle = COLOURS[a];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      sampleCurve(a, R, 64).forEach((p, i) => {
        const x = pad.l + p.stick * iw;
        const y = pad.t + ih - (p.rate / maxRate) * ih;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  updateRatePrediction() {
    if (!this.ratePred) return;
    const fc = this.app.sim.craft.fc;
    const out = [];
    for (const s of [0.25, 0.5, 0.75, 1.0]) {
      out.push(`${(s * 100).toFixed(0)}% = ${fc.stickToRate(s, 'roll').toFixed(0)}°/s`);
    }
    this.ratePred.textContent = 'Stick ' + out.join('  ·  ');
    if (!this.tuneFeel) return;
    const t = this.tune;
    const p = t.p[0], d = t.d[0], f = t.f[0], i = t.i[0];
    const notes = [];
    // Damping estimate: compare D authority to P authority at a realistic
    // rate error, which is what actually decides how it feels.
    const pAt = p * 300 * 0.032;      // motor units for a 300 deg/s error
    const dAt = d * 60000 * 1e-4;     // motor units for a fast 60k deg/s^2 slew
    notes.push(dAt > pAt * 0.9 ? 'D is high relative to P: expect it to feel locked up and possibly oscillate'
      : dAt > pAt * 0.45 ? 'balanced: D is doing real work without dominating'
        : 'light on D: fast and smooth, but propwash and bumps will get through');
    notes.push(f > p * 1.1 ? 'feedforward is strong: sharp stick response, but it amplifies gyro noise'
      : f > p * 0.5 ? 'moderate feedforward' : 'minimal feedforward: you will be fighting the stick a little');
    notes.push(i > p * 0.9 ? 'high I: will hold attitude against a bent frame, and wind up on impacts'
      : 'moderate I');
    if (t.gyroLpf2 > 500) notes.push('heavy gyro filtering: clean trace, more phase lag');
    if (t.dMax > 800) notes.push('high D limit: more chances to oscillate on a hot motor');
    this.tuneFeel.textContent = notes.join('. ') + '.';
  }

  /* -------------------------------------------------------------- scopes */
  update() {
    const sim = this.app.sim;
    const fc = sim.craft.fc;
    // The prediction is text, so recompute it a few times a second rather than
    // rebuilding strings on every frame.
    this._predAcc = (this._predAcc || 0) + 1;
    if (this._predAcc > 20) { this._predAcc = 0; this.updateRatePrediction(); }
    const g = [];
    g.push({ data: traceData(sim.traces.gyroRoll), color: '#58b7e8', width: 1.2 });
    g.push({ data: traceData(sim.traces.setRoll), color: '#7fd6a8', width: 1 });
    g.push({ data: traceData(sim.traces.gyroPitch), color: '#e0a04a', width: 1 });
    g.push({ data: traceData(sim.traces.setPitch), color: '#c0d060', width: 1 });
    // Gyro against setpoint, per axis. Shading the setpoint makes it obvious at
    // a glance whether the craft is tracking or lagging behind.
    this.gyroScope.plot([
      { data: traceData(sim.traces.setRoll), color: '#7fd6a8', width: 1, fill: 'rgba(127,214,168,0.10)' },
      { data: traceData(sim.traces.gyroRoll), color: '#58b7e8', width: 1.4, dot: true },
      { data: traceData(sim.traces.setPitch), color: '#c0d060', width: 1 },
      { data: traceData(sim.traces.gyroPitch), color: '#e0a04a', width: 1.2 },
    ], {
      cols: 8, rows: 4,
      labels: [['setpoint roll', '#7fd6a8'], ['gyro roll', '#58b7e8'],
        ['setpoint pitch', '#c0d060'], ['gyro pitch', '#e0a04a']],
    });

    this.motorScope.drawBars(fc.motors, {
      max: 2000, color: '#58b7e8',
    });

    if (this.stepData) {
      this.stepScope.plot([
        { data: this.stepData.setpoint, color: '#7fd6a8', width: 1, fill: 'rgba(127,214,168,0.10)' },
        { data: this.stepData.gyro, color: '#58b7e8', width: 1.5, dot: true },
        { data: this.stepData.dTerm, color: '#e0a04a', width: 1 },
      ], {
        cols: 8, rows: 4,
        labels: [['setpoint', '#7fd6a8'], ['gyro', '#58b7e8'], ['D term', '#e0a04a']],
      });
    }
  }

  /** Roll stick 0 -> 0.6 -> 0, sampled at 200 Hz, so the step shape is visible. */
  runStepTest() {
    const sim = this.app.sim;
    const craft = sim.craft;
    const sampleHz = 200;
    const dur = 2.2;
    const total = Math.round(dur * sampleHz);
    const out = { t: [], gyro: [], setpoint: [], dTerm: [], peaks: [] };
    const dt = 1 / 5000;
    const savedThrottle = sim.input.raw.throttle;
    const wasPaused = sim.paused;
    sim.paused = true;

    let peakSp = 0, peakGyro = 0, peakD = 0;
    for (let i = 0; i < total * 25; i++) {
      const t = i * dt;
      // 0 for 0.2 s, +0.6 for 0.8 s, back to 0 for the rest
      const stick = t < 0.2 ? 0 : t < 1.0 ? 0.6 : 0;
      stepDirect(sim, craft, dt, { x: stick, y: 0, z: 0, throttle: savedThrottle });
      if (i % 25 === 0) {
        out.t.push(t);
        out.gyro.push(craft.fc.gyro.x);
        out.setpoint.push(craft.fc.setpoint.x);
        out.dTerm.push(craft.fc.axis[0].dOut);
        peakSp = Math.max(peakSp, Math.abs(craft.fc.setpoint.x));
        peakGyro = Math.max(peakGyro, Math.abs(craft.fc.gyro.x));
        peakD = Math.max(peakD, Math.abs(craft.fc.axis[0].dOut));
      }
    }
    sim.paused = wasPaused;
    // Settling time: how long after the stick returns does the rate stay within
    // 10 % of zero.
    let settle = -1;
    const releaseIdx = out.t.findIndex((t) => t >= 1.0);
    if (releaseIdx >= 0) {
      const tol = peakGyro * 0.1;
      for (let i = out.t.length - 1; i >= releaseIdx; i--) {
        if (Math.abs(out.gyro[i]) > tol) { settle = out.t[i] - 1.0; break; }
      }
    }
    this.stepData = out;
    this.stepResult = {
      peakGyro, peakSp, peakD, settle,
      overshoot: peakSp > 0 ? (peakGyro / peakSp - 1) * 100 : 0,
    };
    this.app.simview.message('ok',
      `Step: peak ${peakGyro.toFixed(0)}°/s, overshoot ${this.stepResult.overshoot.toFixed(0)}%, `
      + `settle ${settle < 0 ? '>1.2' : settle.toFixed(2)}s, D spike ${peakD.toFixed(0)}`);
    return this.stepResult;
  }
}

// Run the craft directly without the radio transport, for repeatable tests.
import { stepCraft } from '../sim/craft.js';
function stepDirect(sim, craft, dt, sticks) {
  stepCraft(craft, dt, sim.env, sticks, { runPID: true });
}

function traceData(trace) {
  const out = [];
  trace.forEach((v) => out.push(v));
  return out;
}
