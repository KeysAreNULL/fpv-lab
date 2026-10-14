// Controls panel: bind a physical control surface to each flight channel.
//
// The panel is click-to-bind rather than a dropdown of every possible axis,
// because the point of it is to work with hardware you cannot enumerate ahead of
// time. A RadioMaster Pocket on USB shows up as a gamepad, but which axis its
// gimbals land on depends on the radio's joystick driver and on how you have it
// configured - so the pilot arms a channel, moves the stick they want on it, and
// the panel assigns whatever moved.
//
// Keyboard bindings are bindable through the same flow, so there is one model
// for every input rather than a gamepad special case.

import { el, clear, sliderRow } from './dom.js';
import {
  CHANNELS, defaultBindings, describeBinding, detectMovedSurface,
} from '../sim/controls.js';

export class ControlsView {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.input = app.sim.input;
    this.bindings = this.input.bindings;
    this.armed = null;          // channel id awaiting a surface, or null
    this.lastRaw = { axes: new Map(), buttons: new Map() };
    this.padIdentity = 0;       // set when the panel mounts
    this.rowEls = {};

    this.root.querySelector('#btn-controls-reset').onclick = () => this.resetDefaults();
    this.root.querySelector('#btn-controls-clear').onclick = () => this.clearAll();

    this.buildRows();
    this.bindKeyCapture();

    // The pilot can plug a transmitter in at any time, so listen for the device
    // appearing rather than scanning once on mount.
    window.addEventListener('gamepadconnected', () => this.refreshPads());
    window.addEventListener('gamepaddisconnected', () => this.refreshPads());

    this.padSignature = '';
    this.tick();
  }

  /* ------------------------------------------------------------- rendering */

  buildRows() {
    const box = this.root.querySelector('#controls-channels');
    clear(box);

    for (const c of CHANNELS) {
      const valueEl = el('span', { class: 'ctl-val', text: '--' });
      const bar = el('div', { class: 'ctl-bar-fill' });
      const bindBtn = el('button', { class: 'ghost ctl-bind', text: 'Bind' });
      const nameEl = el('div', { class: 'ctl-name', text: describeBinding(this.bindings[c.id]) });

      // Invert sits on the row itself, not in the shaping block: a transmitter
      // whose yaw axis reads backwards is the single most common thing to get
      // wrong when binding, and it should be one click away rather than hidden
      // behind selecting the channel first.
      const inv = el('input', { type: 'checkbox', class: 'ctl-inv' });
      inv.checked = !!this.bindings[c.id].invert;
      inv.title = `Invert ${c.label.toLowerCase()}`;
      inv.onchange = () => {
        this.bindings[c.id].invert = inv.checked;
        this.changed();
      };

      bindBtn.onclick = () => {
        this.armed = this.armed === c.id ? null : c.id;
        this.message();
        this.renderNames();
      };

      const row = el('div', { class: 'ctl-row' }, [
        el('div', { class: 'ctl-head' }, [
          el('span', { class: 'ctl-label', text: c.label }),
          nameEl,
          el('label', { class: 'ctl-inv-wrap', title: `Invert ${c.label.toLowerCase()}` }, [
            inv, el('span', { text: 'inv' }),
          ]),
          bindBtn,
        ]),
        el('div', { class: 'ctl-bar' }, [bar]),
        valueEl,
      ]);

      const cfgRow = el('div', { class: 'ctl-config-row' }, [row]);
      row.onclick = (e) => {
        // Clicking a channel's body selects it for the shaping block, without
        // hijacking the Bind button or the sliders inside it.
        if (e.target.closest('button') || e.target.closest('input')) return;
        this.selectChannel(c.id);
      };

      this.rowEls[c.id] = { valueEl, bar, bindBtn, nameEl, row: cfgRow, inv };
      box.append(cfgRow);
      this.selected = this.selected || c.id;
    }

    this.buildShaping();
  }

  /** The shaping block follows whichever channel is selected. */
  selectChannel(id) {
    this.selected = id;
    for (const c of CHANNELS) {
      const r = this.rowEls[c.id];
      if (r && r.row) r.row.classList.toggle('sel', c.id === id);
    }
    this.buildShaping();
  }

  buildShaping() {
    const id = this.selected;
    const b = this.bindings[id];
    const c = CHANNELS.find((x) => x.id === id);
    const cfg = this.root.querySelector('#controls-config');
    clear(cfg);
    cfg.append(
      el('div', { class: 'panel-head' }, [el('h2', { text: `${c.label} shaping` })]),
      this.invertToggle(c),
      sliderRow('Deadzone', {
        min: 0, max: 0.4, step: 0.01, value: b.deadzone ?? 0,
        onInput: (v) => { b.deadzone = v; this.changed(); },
        desc: 'Stick travel ignored at centre. Real gimbals rarely return to exactly zero.',
      }),
      sliderRow('Expo', {
        min: 0, max: 1, step: 0.05, value: b.expo ?? 0,
        onInput: (v) => { b.expo = v; this.changed(); },
        desc: '0 is linear, 1 is cubic. Expo softens the centre so hover trim is usable.',
      }),
      el('div', { class: 'row' }, [
        el('button', { class: 'ghost wide', text: `Calibrate centre (${c.label})`,
          onclick: () => this.calibrate(id) }),
        el('button', { class: 'ghost wide', text: `Bind keyboard to ${c.label}`,
          onclick: () => { this.armed = id; this.keyArmed = id; this.message(); } }),
      ]),
    );
  }

  invertToggle(c) {
    const b = this.bindings[c.id];
    const input = el('input', { type: 'checkbox' });
    input.checked = !!b.invert;
    input.onchange = () => { b.invert = input.checked; this.changed(); };
    return el('label', { class: 'chk' }, [input,
      el('span', { text: `Invert ${c.label.toLowerCase()}` })]);
  }

  /** Keyboard surfaces are captured through the same arm flow as gamepads. */
  bindKeyCapture() {
    window.addEventListener('keydown', (e) => {
      if (!this.keyArmed) return;
      // Ignore the modifier-ish keys that would make the panel unusable.
      if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      e.preventDefault();
      const id = this.keyArmed;
      this.bindings[id] = { ...this.bindings[id], kind: 'key', key: e.code, device: 0 };
      this.keyArmed = null;
      this.armed = null;
      this.changed();
      this.renderNames();
      this.app.message('ok', `${id} bound to ${e.code}`);
    }, { capture: true });
  }

  calibrate(id) {
    // Record the current value as centre so a transmitter with a non-centred
    // gimbal (or a drift-prone one) still reads zero at rest.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const b = this.bindings[id];
    if (b.kind === 'key') { this.app.message('warn', 'Keyboard channels centre by themselves.'); return; }
    const pad = pads[b.device];
    if (!pad) { this.app.message('warn', 'That gamepad is not connected.'); return; }
    const v = b.kind === 'axis' ? (pad.axes[b.index] ?? 0) : (pad.buttons[b.index]?.value ?? 0);
    b.offset = v;
    this.changed();
    this.app.message('ok', `${id} centre set to ${v.toFixed(3)}`);
  }

  resetDefaults() {
    this.bindings = defaultBindings();
    this.input.bindings = this.bindings;
    this.armed = null;
    this.changed();
    this.renderNames();
    this.buildShaping();
    this.app.message('ok', 'Controls reset to keyboard defaults');
  }

  clearAll() {
    for (const c of CHANNELS) {
      this.bindings[c.id] = { kind: 'none', invert: false, deadzone: 0, expo: 0 };
    }
    this.changed();
    this.renderNames();
    this.buildShaping();
    this.app.message('ok', 'All channels unbound');
  }

  changed() {
    this.app.persist();
  }

  renderNames() {
    for (const c of CHANNELS) {
      const e = this.rowEls[c.id];
      if (!e) continue;
      e.nameEl.textContent = describeBinding(this.bindings[c.id], this.padName());
      e.bindBtn.textContent = this.armed === c.id ? 'Move a stick...' : 'Bind';
      e.bindBtn.classList.toggle('armed', this.armed === c.id);
    }
  }

  padName() {
    const pads = this.input.padsConnected;
    if (!pads.length) return null;
    const first = pads[this.padIdentity] || pads[0];
    return first && first.id ? first.id.slice(0, 28) : 'Gamepad';
  }

  refreshPads() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    const box = this.root.querySelector('#controls-devices');
    clear(box);
    if (!pads.length) {
      box.appendChild(el('div', { class: 'warn-row info',
        text: 'No controller detected. Plug one in, or fly with the keyboard.' }));
      return;
    }
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      const active = i === this.padIdentity;
      box.appendChild(el('div', { class: 'ctl-device' + (active ? ' active' : '') }, [
        el('span', { class: 'ctl-device-name', text: p.id.slice(0, 40) }),
        el('span', { class: 'ctl-device-meta',
          text: `${p.axes.length} axes, ${p.buttons.length} buttons` }),
        el('button', { class: 'ghost', text: active ? 'In use' : 'Use',
          disabled: active,
          onclick: () => { this.padIdentity = i; this.refreshPads(); this.renderNames(); } }),
      ]));
    }
  }

  message() {
    if (this.armed) {
      this.app.message('info',
        `Move the control surface you want on ${this.armed.toUpperCase()}.`);
    }
  }

  /* ----------------------------------------------------------------- tick */

  tick() {
    // Live values, and click-to-bind capture. Runs on rAF but only touches the
    // DOM when a value actually moved, so an idle panel costs nothing.
    const moved = detectMovedSurface(this.bindings, this.lastRaw);
    if (moved && this.armed) {
      const id = this.armed;
      this.bindings[id] = {
        ...this.bindings[id], kind: moved.kind, device: moved.device, index: moved.index,
      };
      this.armed = null;
      this.changed();
      this.renderNames();
      this.buildShaping();
      this.app.message('ok', `${id} bound to ${describeBinding(this.bindings[id])}`);
    }

    const vals = this.input.padValues || {};
    for (const c of CHANNELS) {
      const e = this.rowEls[c.id];
      if (!e) continue;
      const v = vals[c.id];
      if (v === null || v === undefined) {
        e.valueEl.textContent = 'key';
        e.bar.style.width = '0%';
        continue;
      }
      const shown = c.id === 'throttle' ? Math.round(v * 100) : v.toFixed(2);
      if (e.valueEl.textContent !== String(shown)) e.valueEl.textContent = String(shown);
      const pct = c.id === 'throttle' ? v * 100 : (v + 1) / 2 * 100;
      e.bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }

    const sig = (this.input.padsConnected || []).map((p) => p.id).join('|');
    if (sig !== this.padSignature) { this.padSignature = sig; this.refreshPads(); }

    requestAnimationFrame(() => this.tick());
  }

  /** Serialise for the save file. */
  toJSON() {
    return JSON.parse(JSON.stringify(this.bindings));
  }

  load(state) {
    if (!state) return;
    const d = defaultBindings();
    for (const c of CHANNELS) if (state[c.id]) d[c.id] = { ...d[c.id], ...state[c.id] };
    this.bindings = d;
    this.input.bindings = d;
    // The rows were already built in the constructor, from the defaults. Updating
    // only the model leaves the DOM showing the old values, so a restored
    // binding looked like it had been lost even though it had loaded - and the
    // invert checkbox in particular would silently read the wrong way.
    for (const c of CHANNELS) {
      const e = this.rowEls[c.id];
      if (e && e.inv) e.inv.checked = !!d[c.id].invert;
    }
    this.renderNames();
    this.buildShaping();
  }
}