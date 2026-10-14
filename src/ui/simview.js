// Simulator view: HUD, flight controls, VTX/RX/antenna configuration,
// telemetry gauges and the live link-budget panel.

import { el, clear, sliderRow, selectRow, segButtons, Scope, fmt } from './dom.js';
import { ANALOG_BANDS, ANALOG_MW, DIGITAL_SYSTEMS, RC_SYSTEMS } from '../data/radio.js';
import { drawLinkBar } from '../render/cameras.js';
import { WEATHER, WEATHER_ORDER } from '../data/weather.js';

// Local alias: selectRow is the DOM helper, and the weather picker reuses it.
const selRow = selectRow;

export class SimView {
  constructor(root, app) {
    this.app = app;
    this.root = root;
    this.hud = root.querySelector('#hud');
    this.hudFpv = root.querySelector('#hud-fpv');
    this.linkpanel = root.querySelector('#linkpanel');
    this.gauges = root.querySelector('#gauges');
    this.traces = root.querySelector('#traces');
    this.messages = root.querySelector('#messages');
    this.cams = root.querySelector('#cams');
    this.vtxcfg = root.querySelector('#vtxcfg');
    this.rxcfg = root.querySelector('#rxcfg');
    this.envcfg = root.querySelector('#envcfg');
    this.buildCameraSwitch();
    this.buildControls();
    this.buildVtxConfig();
    this.buildRxConfig();
    this.buildEnvConfig();
    this.buildGauges();
    this.buildTraces();
  }

  buildCameraSwitch() {
    clear(this.cams);
    this.camButtons = [
      ['fpv', 'FPV'], ['chase', 'Chase'], ['orbit', 'Orbit'], ['top', 'Top'], ['pit', 'Pilot'],
    ].map(([id, label]) => el('button', {
      class: id === this.app.rig.mode ? 'active' : '',
      text: label,
      onclick: () => { this.app.setCamera(id); this.syncCameras(); },
    }));
    this.camButtons.forEach((b) => this.cams.appendChild(b));
  }

  syncCameras() {
    const m = this.app.rig.mode;
    this.camButtons.forEach((b, i) => b.classList.toggle('active',
      ['fpv', 'chase', 'orbit', 'top', 'pit'][i] === m));
  }

  buildControls() {
    const sim = this.app.sim;
    this.armBtn = this.root.querySelector('#btn-arm');
    this.armBtn.onclick = () => { this.app.toggleArm(); };
    this.root.querySelector('#btn-reset').onclick = () => this.app.resetCraft();
    const pause = this.root.querySelector('#chk-pause');
    pause.onchange = () => { sim.paused = pause.checked; };
    const slow = this.root.querySelector('#chk-slow');
    slow.onchange = () => { sim.speedScale = slow.checked ? 0.15 : 1; this.root.querySelector('#rng-speed').value = sim.speedScale; };
    const sp = this.root.querySelector('#rng-speed');
    sp.oninput = () => {
      sim.speedScale = parseFloat(sp.value);
      this.root.querySelector('#val-speed').textContent = sim.speedScale.toFixed(2) + '×';
      slow.checked = false;
    };
    const stick = this.root.querySelector('#sel-stick');
    stick.onchange = (e) => {
      sim.setStickMode(parseInt(e.target.value, 10));
    };
    // The select already renders its default option, but nothing had told the
    // simulation about it, so the control claimed a mode the craft was not in.
    sim.setStickMode(parseInt(stick.value, 10));
    const modes = this.root.querySelector('#modes');
    this.modeSeg = segButtons([
      { value: 'acro', label: 'Acro' },
      { value: 'angle', label: 'Angle' },
      { value: 'horizon', label: 'Horizon' },
    ], sim.craft.fc.mode, (v) => {
      sim.craft.fc.mode = v;
      sim.craft.tune.mode = v;
      sim.input.centre();
    });
    modes.appendChild(this.modeSeg);
  }

  /* ------------------------------------------------------------------ VTX */
  buildVtxConfig() {
    const sim = this.app.sim;
    const c = this.vtxcfg;
    clear(c);

    const sysOptions = [
      { value: 'analog', label: 'Analog 5.8 GHz' },
      { value: 'hdzero', label: 'HDZero (digital)' },
      { value: 'dji', label: 'DJI O3 (digital)' },
      { value: 'walksnail', label: 'Walksnail (digital)' },
    ];
    c.appendChild(selectRow('System', sysOptions, sim.video.system, (v) => {
      sim.video.configure({ system: v, channel: 1 });
      this.buildVtxConfig();
    }));

    if (sim.video.system === 'analog') {
      c.appendChild(selectRow('Band', Object.keys(ANALOG_BANDS).map((k) => ({
        value: k, label: ANALOG_BANDS[k].label,
      })), sim.video.band, (v) => {
        sim.video.configure({ band: v });
        this.buildVtxConfig();
      }));
      c.appendChild(selectRow('Channel', [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
        value: String(n), label: `CH${n} - ${ANALOG_BANDS[sim.video.band].ch[n - 1]} MHz`,
      })), String(sim.video.channel), (v) => {
        sim.video.configure({ channel: parseInt(v, 10) });
      }));
      c.appendChild(selectRow('Power', ANALOG_MW.map((m) => ({
        value: String(m), label: m < 1000 ? `${m} mW` : '1 W',
      })), String(sim.video.powerMw), (v) => {
        sim.video.configure({ powerMw: parseInt(v, 10) });
      }));
      c.appendChild(el('div', { class: 'desc', text:
        'Analog has no channel lock. A neighbour on the same or an adjacent channel '
        + 'paints over your picture or beats against it; 1 W goes further but makes you '
        + 'the neighbour.' }));
    } else {
      const sys = DIGITAL_SYSTEMS[sim.video.system];
      const opts = [];
      for (let ch = 1; ch <= sys.maxCh; ch++) {
        opts.push({ value: String(ch), label: `CH${ch}  ${sys.channelName(ch)}` });
      }
      c.appendChild(selectRow('Channel', opts, String(sim.video.channel), (v) => {
        sim.video.configure({ channel: parseInt(v, 10) });
      }));
      c.appendChild(el('div', { class: 'desc', text:
        `${sys.label}: ${sys.count} channels, fixed 25 mW, immune to other channels but not `
        + `to someone on your exact channel. ${sys.channelName(sim.video.channel)}.` }));
    }

    c.appendChild(el('div', { class: 'desc', text:
      `Feed: ${sim.video.latencyBaseMs} ms base latency, ${sim.craft.vtx.fov__deg}° lens.` }));

    // Receiver antenna orientation: this is a real and very common mistake.
    c.appendChild(sliderRow('RX polarisation', {
      min: -90, max: 90, step: 5, value: this.app.rxPolAngle || 0, unit: '°',
      onInput: (v) => { this.app.rxPolAngle = v; this.app.updateRxPol(); },
      desc: 'Rotate the goggle antennas. Crossed polarisation costs up to 25 dB - '
        + 'flying with the duck antenna edge-on is the classic way to lose video.',
    }));
  }

  buildRxConfig() {
    const sim = this.app.sim;
    const c = this.rxcfg;
    clear(c);
    const opts = Object.entries(RC_SYSTEMS).map(([k, v]) => ({ value: k, label: v.label }));
    c.appendChild(selectRow('Protocol', opts, sim.radio.protocol, (v) => {
      const sys = RC_SYSTEMS[v];
      sim.radio.configure({ protocol: v, rateHz: sys.hopping ? 250 : 150, failsafeMs: sys.dutyOk > 0.99 ? 500 : 900 });
    }));
    c.appendChild(el('div', { class: 'desc', text: sim.radio.sys.note }));
  }

  buildEnvConfig() {
    const env = this.app.env;
    const c = this.envcfg;
    clear(c);
    const vp = this.app.viewport;

    // --- weather and lighting -------------------------------------------
    c.appendChild(selRow('Weather', WEATHER_ORDER.map((id) => ({
      value: id, label: WEATHER[id].label,
    })), this.app.weatherId || 'clear', (v) => {
      this.app.setWeather(v);
      this.buildEnvConfig();
    }));

    // Sun angle is read straight off the live weather state, so nudging a
    // slider and picking a preset both stay consistent.
    const w = vp.weather;
    const sunSet = () => vp.applyWeather(vp.weather);
    c.appendChild(sliderRow('Sun elevation', {
      min: -5, max: 90, step: 1, value: w.sunElev, unit: '°',
      onInput: (v) => { vp.weather.sunElev = v; sunSet(); },
      desc: 'Below the horizon the sun light fades out and only sky bounce is left.',
    }));
    c.appendChild(sliderRow('Sun bearing', {
      min: 0, max: 359, step: 5, value: w.sunAzim, unit: '°',
      onInput: (v) => { vp.weather.sunAzim = v; sunSet(); },
      desc: 'Compass bearing: 0 is north, 90 east.',
    }));
    c.appendChild(sliderRow('Exposure', {
      min: 0.5, max: 1.8, step: 0.05, value: w.exposure,
      onInput: (v) => { vp.weather.exposure = v; sunSet(); },
      desc: 'Tone-mapping exposure. Raise it for night flying, lower it for midday concrete.',
    }));
    if (w.rain > 0.02) {
      c.appendChild(sliderRow('Rain', {
        min: 0, max: 1, step: 0.05, value: w.rain,
        onInput: (v) => { vp.weather.rain = v; sunSet(); },
      }));
    }

    // --- wind ------------------------------------------------------------
    c.appendChild(sliderRow('Wind', {
      min: 0, max: 20, step: 0.5, value: this.app.windSpeed, unit: ' m/s',
      onInput: (v) => { this.app.windSpeed = v; this.app.applyWind(); },
    }));
    c.appendChild(sliderRow('Direction', {
      min: 0, max: 359, step: 5, value: this.app.windDir, unit: '°',
      onInput: (v) => { this.app.windDir = v; this.app.applyWind(); },
    }));
    c.appendChild(sliderRow('Gusts', {
      min: 0, max: 12, step: 0.5, value: this.app.gust, unit: ' m/s',
      onInput: (v) => { this.app.gust = v; this.app.applyWind(); },
    }));
    c.appendChild(sliderRow('Turbulence', {
      min: 0, max: 1, step: 0.05, value: env.turbulence,
      onInput: (v) => { env.turbulence = v; },
    }));
    c.appendChild(sliderRow('Temperature', {
      min: -10, max: 42, step: 1, value: env.tempC, unit: ' °C',
      onInput: (v) => { env.tempC = v; },
    }));
    c.appendChild(el('div', { class: 'desc', text:
      'Temperature changes air density, so the craft makes less thrust when it is hot. '
      + 'Gusts are band-limited noise, so they buffet rather than push.' }));
  }

  /* --------------------------------------------------------------- gauges */
  buildGauges() {
    const g = this.gauges;
    clear(g);
    this.gauge = {};
    const mk = (key, label, unit) => {
      const v = el('div', { class: 'gv', text: '--' });
      const bar = el('i');
      const node = el('div', { class: 'gauge' }, [
        el('div', { class: 'gk', text: label }), v,
        el('div', { class: 'gu', text: unit || '' }),
        el('div', { class: 'bar' }, [bar]),
      ]);
      this.gauge[key] = { v, bar, node };
      g.appendChild(node);
    };
    mk('throttle', 'Throttle', '');
    mk('current', 'Current', 'A');
    mk('voltage', 'Voltage', 'V');
    mk('sag', 'Sag', 'V');
    mk('cell', 'Min cell', 'V');
    mk('rpm', 'RPM', 'avg k');
    // Thrust and weight are both newtons, so this is a plain ratio - and it is
    // the number pilots actually quote. The old label said "N / kg" (the units
    // are not newtons over kilograms) while the bar quietly divided by six, so
    // neither the reading nor the scale matched what was written.
    mk('thrust', 'T/W', ': 1');
    mk('speed', 'Speed', 'm/s');
  }

  buildTraces() {
    const t = this.traces;
    clear(t);
    this.traceDefs = [
      ['throttle', 'Throttle'], ['current', 'Current A'], ['voltage', 'Voltage V'],
      ['gyro', 'Gyro roll deg/s'], ['speed', 'Speed m/s'],
      ['vtx', 'VTX quality'], ['rc', 'RC link quality'],
    ];
    this.traceEls = {};
    for (const [key, label] of this.traceDefs) {
      const v = el('span', { class: 'tv', text: '--' });
      const node = el('div', { class: 'trace' }, [
        el('div', { class: 'th' }, [el('span', { text: label }), v]),
      ]);
      this.traceEls[key] = { v, node };
      t.appendChild(node);
    }
  }

  /* ----------------------------------------------------------------- HUD */
  updateHud(h, fpvMode) {
    const lab = (t) => el('div', { class: 'lbl2', text: t });
    const num = (t, cls = '') => el('div', { class: `big ${cls}`, text: t });
    // Only one OSD at a time: the FPV overlay replaces the workshop one instead
    // of being drawn on top of it.
    const target = fpvMode ? this.hudFpv : this.hud;
    for (const hud of [this.hud, this.hudFpv]) {
      clear(hud);
      hud.classList.toggle('hidden', hud !== target);
    }
    {
      const hud = target;
      const armed = h.armed;
      const vq = h.vtx.quality;
      const batCls = h.voltage < 3.6 * this.app.sim.craft.battery.cells ? 'bad'
        : h.sag > 0.9 ? 'warn' : 'good';
      const surf = h.wash.surface;

      // A labelled readout: small caption over a big number.
      const cell = (label, value, cls) => el('div', {}, [
        el('div', { class: 'lbl2', text: label }),
        el('div', { class: 'big' + (cls ? ' ' + cls : ''), text: value }),
      ]);
      const box = (children) => el('div', { class: 'box' }, [el('div', { class: 'row2' }, children)]);
      const corner = (cls, children) => hud.appendChild(el('div', { class: cls }, children));

      // In FPV the feed gets the four essentials a real OSD shows; the workshop view
      // gets the full set, because there is room for it.
      corner('tl', [box(fpvMode ? [
        cell('Pack', h.voltage.toFixed(2) + ' V', batCls),
        cell('Cell', h.cellV.toFixed(2) + ' V', h.cellV < 3.5 ? 'bad' : ''),
      ] : [
        cell('Pack', h.voltage.toFixed(2) + ' V', batCls),
        cell('Current', h.current.toFixed(1) + ' A', h.current > 80 ? 'warn' : ''),
        cell('Sag', h.sag.toFixed(2) + ' V', h.sag > 0.9 ? 'warn' : ''),
        cell('Min cell', h.cellV.toFixed(2) + ' V', h.cellV < 3.5 ? 'bad' : ''),
      ])]);

      corner('tr', [box([
        cell('RSSI', (h.vtx.rssi || 0).toFixed(0) + ' dBm',
          vq > 0.6 ? 'good' : vq > 0.2 ? 'warn' : 'bad'),
        cell('Qual', (vq * 100).toFixed(0) + '%',
          vq > 0.6 ? 'good' : vq > 0.2 ? 'warn' : 'bad'),
        cell('Lat', (h.vtx.latency || 0).toFixed(1) + ' ms'),
      ])]);

      corner('bl', [box([
        cell('Alt', h.alt.toFixed(2) + ' m'),
        cell('Speed', h.speed.toFixed(1) + ' m/s'),
        cell('Vertical', h.vert.toFixed(1) + ' m/s', h.vert < -12 ? 'bad' : ''),
        cell('Roll / Pitch', h.roll.toFixed(0) + '\u00b0 / ' + h.pitch.toFixed(0) + '\u00b0'),
      ])]);

      const names = ['FL', 'FR', 'RL', 'RR'];
      corner('br', [box(fpvMode ? [
        cell('Temp', h.escTemp.toFixed(0) + ' \u00b0C', h.escTemp > 80 ? 'bad' : ''),
      ] : [
        ...h.rpm.map((r, i) => cell(names[i], (r / 1000).toFixed(1) + 'k',
          r > 34000 ? 'warn' : '')),
        cell('ESC', h.escTemp.toFixed(0) + ' \u00b0C',
          h.escTemp > 80 ? 'bad' : h.escTemp > 65 ? 'warn' : ''),
        cell('Batt', h.battTemp.toFixed(0) + ' \u00b0C', h.battTemp > 55 ? 'warn' : ''),
      ])]);

      // bottom-centre: state flags and what the propwash is doing
      const bits = [armed ? 'ARMED' : 'DISARMED'];
      if (h.failsafe) bits.push('FAILSAFE');
      if (h.brownout) bits.push('BROWNOUT');
      if (h.crashed) bits.push('CRASHED');
      let washText = 'PROPWASH ' + surf.toFixed(1) + ' m/s   GROUND EFFECT x'
        + h.wash.groundEffect.toFixed(2);
      if (h.wash.clearance != null) washText += '   SURFACE ' + h.wash.clearance.toFixed(2) + ' m';
      const flagCls = (h.failsafe || h.brownout || h.crashed) ? 'bad' : armed ? 'good' : '';
      if (fpvMode) {
        // On the feed, the flags and the wash line go in the bottom centre where
        // they do not cover the racing line.
        corner('bc', [el('div', { class: 'wash' }, [
          el('span', { class: flagCls, text: bits.join('   |   ') }),
          el('div', { text: washText }),
        ])]);
      } else {
        corner('bc', [
          el('div', { class: 'box' }, [el('span', { class: flagCls, text: bits.join('   |   ') })]),
          el('div', { class: 'lbl2', style: { marginTop: '4px' }, text: washText }),
        ]);
      }

      // artificial horizon, FPV only
      if (hud === this.hudFpv) {
        const ret = el('div', { class: 'reticle' });
        ret.innerHTML = `<svg viewBox="0 0 100 100" width="100%" height="100%">
          <path d="M18 50 h20 l6 -7 M82 50 h-20 l-6 -7" stroke="#7fe3a8" stroke-width="1.6" fill="none"/>
          <circle cx="50" cy="50" r="2.4" fill="none" stroke="#7fe3a8" stroke-width="1.2"/>
          <path d="M40 78 h20" stroke="#7fe3a8" stroke-width="1.2" opacity="0.6"/>
        </svg>`;
        // The reticle is fixed to the screen; a real OSD would be too, so the
        // horizon line is drawn separately from the attitude.
        hud.appendChild(ret);
        const hz = el('div', {
          style: {
            position: 'absolute', left: '50%', top: '50%', width: '190px',
            height: '2px', marginLeft: '-95px', background: '#7fe3a8', opacity: '0.5',
            transform: `rotate(${-h.roll}deg) translateY(${Math.tan(-h.pitch * Math.PI / 180) * 120}px)`,
          },
        });
        hud.appendChild(hz);
      }
    }
  }

  updateLinkPanel(h) {
    const c = this.linkpanel;
    clear(c);
    const v = h.vtx, rc = h.rc;

    c.appendChild(el('h3', { text: 'Video link' }));
    c.appendChild(el('div', { class: 'sig' }, [
      el('span', { class: 'ch', text: `${(v.rssi || 0).toFixed(0)} dBm` }),
      el('span', { style: { color: '#8695a4' }, text: `${v.quality > 0.6 ? 'good' : v.quality > 0.2 ? 'noisy' : 'lost'}` }),
      el('span', { style: { marginLeft: 'auto', color: '#8695a4' }, text: `${v.freq} MHz` }),
    ]));
    c.appendChild(el('div', { class: 'sig' }, [
      el('span', { style: { color: '#9fb0bd' }, text: v.channel }),
    ]));

    const cv = el('canvas');
    c.appendChild(cv);
    drawLinkBar(cv, v.budget, { rssi: v.rssi, margin: v.budget ? v.budget.margin : 0, txDbm: this.app.sim.video.txDbm });

    c.appendChild(el('div', { class: 'sep' }));
    c.appendChild(el('h3', { text: 'Control link' }));
    c.appendChild(el('div', { class: 'sig' }, [
      el('span', { class: rc.lq > 0.6 ? 'ch' : '', style: rc.lq > 0.6 ? {} : { color: '#eab463' },
        text: `${(rc.lq * 100).toFixed(0)}% LQ` }),
      el('span', { style: { marginLeft: 'auto', color: '#8695a4' }, text: `${rc.rssi.toFixed(0)} dBm` }),
    ]));
    c.appendChild(el('div', { class: 'sig' }, [
      el('span', { style: { color: '#9fb0bd' }, text: rc.protocol }),
      el('span', { style: { marginLeft: 'auto', color: '#8695a4' }, text: `${rc.latency.toFixed(1)} ms` }),
    ]));

    // Obstacles in the way, in plain language.
    const b = v.budget;
    if (b && b.segments && b.segments.length) {
      const mats = b.segments.map((s) => `${s.material}${s.grazing ? ' (grazing)' : ''} -${s.db.toFixed(0)}dB`);
      c.appendChild(el('div', { style: { marginTop: '5px', color: '#eab463', fontSize: '9.5px' },
        text: 'In the way: ' + mats.join(', ') }));
    } else if (b && b.diff > 2) {
      c.appendChild(el('div', { style: { marginTop: '5px', color: '#eab463', fontSize: '9.5px' },
        text: `NLoS: ${b.diff.toFixed(0)} dB of diffraction loss` }));
    }
    if (h.env.windSpeed > 0.5) {
      c.appendChild(el('div', { style: { marginTop: '4px', color: '#8695a4', fontSize: '9.5px' },
        text: `wind ${h.env.windSpeed.toFixed(1)} m/s ${h.env.windDir.toFixed(0)}°` }));
    }
  }

  updateGauges(h) {
    const g = this.gauge;
    const set = (k, txt, frac, cls) => {
      const e = g[k];
      e.v.textContent = txt;
      e.bar.style.width = Math.max(0, Math.min(100, frac * 100)) + '%';
      e.bar.parentElement.className = 'bar' + (cls ? ' ' + cls : '');
    };
    set('throttle', h.throttle.toFixed(0), h.throttle / 1000);
    set('current', h.current.toFixed(1), h.current / 120, h.current > 90 ? 'warn' : '');
    set('voltage', h.voltage.toFixed(2), h.voltage / (this.app.sim.craft.battSpec.cells * 4.2),
      // Per-cell brownout threshold against the pack's real cell count. It was
      // reading h.rpm.length (always 4 motors) as the cell count, so every 4S
      // and 6S pack was being judged against a 14.4 V floor and never warned.
      h.voltage < 3.6 * this.app.sim.craft.battery.cells ? 'bad' : 'good');
    set('sag', h.sag.toFixed(2), h.sag / 2, h.sag > 0.9 ? 'warn' : '');
    set('cell', h.cellV.toFixed(2), h.cellV / 4.2, h.cellV < 3.5 ? 'bad' : h.cellV < 3.65 ? 'warn' : '');
    set('rpm', (h.rpm.reduce((a, b) => a + b, 0) / 4 / 1000).toFixed(1),
      (h.rpm.reduce((a, b) => a + b, 0) / 4) / 40000,
      Math.max(...h.rpm) > 34000 ? 'warn' : '');
    // Thrust and weight are both newtons, so this is a plain ratio, and it is
    // the number pilots actually quote. Full scale is 16:1, which puts a race
    // build (10:1) at two thirds and leaves headroom for a lifter. The bar takes
    // a *fraction*, so the ratio has to be divided by that full scale - passing
    // 16 straight through pinned the bar at 100 % forever.
    const tw = h.thrust / h.weight;
    set('thrust', tw.toFixed(2), tw / 16, tw < 1 ? 'bad' : 'good');
    set('speed', h.speed.toFixed(1), h.speed / 40);

    const tr = this.app.sim.traces;
    const t = this.traceEls;
    t.throttle.v.textContent = tr.throttle.last.toFixed(0);
    t.current.v.textContent = tr.current.last.toFixed(1);
    t.voltage.v.textContent = tr.voltage.last.toFixed(2);
    t.gyro.v.textContent = tr.gyroRoll.last.toFixed(0);
    t.speed.v.textContent = tr.speed.last.toFixed(1);
    t.vtx.v.textContent = (tr.vtxQual.last * 100).toFixed(0) + '%';
    t.rc.v.textContent = (tr.rcLQ.last * 100).toFixed(0) + '%';
  }

  message(kind, text) {
    const d = el('div', { class: kind, text });
    this.messages.appendChild(d);
    setTimeout(() => d.remove(), 6000);
    while (this.messages.children.length > 6) this.messages.firstChild.remove();
  }
}
