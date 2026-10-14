// Control-surface bindings: which physical input drives which flight channel,
// and how that raw signal is shaped before it reaches the FC.
//
// Kept deliberately free of DOM so the simulation can consume it headless and
// so the binding model can be unit-tested in Node. The UI in
// ui/controlsview.js only edits the data this module owns.
//
// Why this exists: the simulator used to hard-code gamepad axes 0/1 and triggers
// 6/7. That works for exactly one controller in exactly one orientation, which
// is no use to anyone flying with a real transmitter. A RadioMaster Pocket
// plugged into USB enumerates as a gamepad, but its sticks land on whatever
// axes the radio's USB joystick driver picked, so the mapping has to be
// bindable rather than assumed.

/** Flight channels, in the order the receiver presents them. */
export const CHANNELS = [
  { id: 'throttle', label: 'Throttle', key: 'throttle' },
  { id: 'roll', label: 'Roll', key: 'x' },
  { id: 'pitch', label: 'Pitch', key: 'y' },
  { id: 'yaw', label: 'Yaw', key: 'z' },
];

/**
 * The keyboard fallback. This is the mapping that existed before bindings were
 * configurable, kept as the default so a fresh install behaves exactly as it
 * always has.
 */
export const DEFAULT_KEY_BINDINGS = {
  throttle: { kind: 'key', key: 'Space', invert: false, deadzone: 0, expo: 0 },
  roll: { kind: 'key', key: 'ArrowRight', invert: false, deadzone: 0, expo: 0 },
  pitch: { kind: 'key', key: 'ArrowUp', invert: false, deadzone: 0, expo: 0 },
  yaw: { kind: 'key', key: 'KeyE', invert: false, deadzone: 0, expo: 0 },
};

/** A fresh, all-keyboard binding set. */
export function defaultBindings() {
  const out = {};
  for (const c of CHANNELS) {
    out[c.id] = { ...DEFAULT_KEY_BINDINGS[c.id] };
  }
  return out;
}

/** Human-readable name for a bound surface, e.g. "Gamepad 0 · Axis 2". */
export function describeBinding(b, padLabel) {
  if (!b) return 'unbound';
  if (b.kind === 'key') return `Key ${prettyKey(b.key)}`;
  if (b.kind === 'axis') return `${padLabel || 'Gamepad'} · Axis ${b.index}`;
  if (b.kind === 'button') return `${padLabel || 'Gamepad'} · Button ${b.index}`;
  return 'unbound';
}

const KEY_NAMES = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', KeyX: 'X',
  KeyQ: 'Q', KeyE: 'E', KeyW: 'W', KeyS: 'S', KeyA: 'A', KeyD: 'D',
  KeyR: 'R', KeyF: 'F', Enter: 'Enter', Tab: 'Tab',
};
function prettyKey(code) {
  if (!code) return '?';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  return code.replace(/^Key/, '').replace(/^Digit/, '');
}

/**
 * Shape a raw axis reading into a channel value.
 *
 * `expo` keeps the centre of the stick usable. At expo 0 this is linear, which
 * feels twitchy on a real gimbal; at expo 1 it is cubic, so fine hover trim is
 * easy while full deflection is still reachable. Most FPV rates presets are
 * somewhere in between.
 */
export function shapeAxis(raw, { invert = false, deadzone = 0, expo = 0 } = {}) {
  let v = Number.isFinite(raw) ? raw : 0;
  if (invert) v = -v;
  v = clamp(v, -1, 1);
  const dz = clamp(deadzone, 0, 0.9);
  if (dz > 0) {
    const a = Math.abs(v);
    if (a <= dz) v = 0;
    else v = Math.sign(v) * ((a - dz) / (1 - dz));
  }
  const e = clamp(expo, 0, 1);
  if (e > 0) {
    // Blend linear and cubic. `sign(v) * (|v| * (1-e) + |v|^3 * e)`
    const a = Math.abs(v);
    v = Math.sign(v) * (a * (1 - e) + a * a * a * e);
  }
  return clamp(v, -1, 1);
}

/** A button is digital: it reads as full deflection while held, else centre. */
export function shapeButton(pressed, { invert = false } = {}) {
  const v = pressed ? 1 : 0;
  return invert ? -v : v;
}

/**
 * Resolve one channel from a binding and a snapshot of the current input state.
 * Returns null when the channel is unbound or its device is absent, which the
 * caller treats as "fall back to the keyboard".
 */
export function resolveChannel(binding, state, opts = {}) {
  if (!binding) return null;
  if (binding.kind === 'key') return null;          // keyboard is handled by the ramp
  const pad = state.pads[binding.device ?? 0];
  if (!pad) return null;
  if (binding.kind === 'axis') {
    const raw = pad.axes[binding.index];
    if (raw === undefined) return null;
    return shapeAxis(raw, binding);
  }
  if (binding.kind === 'button') {
    const b = pad.buttons[binding.index];
    if (!b) return null;
    return shapeButton(b.pressed || b.value > 0.5, binding);
  }
  return null;
}

/**
 * One poll of every bound gamepad channel, plus a report of which surface moved
 * last. The UI uses `lastMoved` to implement click-to-bind: the pilot arms a
 * channel, then moves whatever they want assigned to it.
 */
export function readBindings(bindings) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const list = [];
  for (let i = 0; i < pads.length; i++) if (pads[i]) list.push(pads[i]);
  const state = { pads: list };

  const values = {};
  const surfaces = [];
  for (const c of CHANNELS) {
    const b = bindings[c.id];
    const v = resolveChannel(b, state);
    values[c.id] = v;
    if (v === null) continue;
    surfaces.push({ channel: c.id, binding: b, value: v });
  }
  return { values, surfaces, pads: list };
}

/**
 * Find the surface the pilot just moved, so a click-to-bind panel can say "you
 * moved Axis 2 - assign it to Pitch?". Deliberately picks the *largest*
 * movement so a resting transmitter does not bind a jittery axis.
 */
export function detectMovedSurface(bindings, lastRaw, threshold = 0.35) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let best = null;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p) continue;
    for (let a = 0; a < p.axes.length; a++) {
      const v = p.axes[a] || 0;
      const prev = lastRaw.axes.get(`${i}:${a}`) ?? 0;
      const delta = Math.abs(v - prev);
      lastRaw.axes.set(`${i}:${a}`, v);
      if (Math.abs(v) > threshold && delta > Math.abs(best?.value ?? 0)) {
        best = { kind: 'axis', device: i, index: a, value: v };
      }
    }
    for (let b = 0; b < p.buttons.length; b++) {
      const btn = p.buttons[b];
      const v = btn && (btn.pressed || btn.value > 0.5) ? 1 : 0;
      const key = `${i}:b${b}`;
      const prev = lastRaw.buttons.get(key) ?? 0;
      lastRaw.buttons.set(key, v);
      if (v && !prev) best = { kind: 'button', device: i, index: b, value: 1 };
    }
  }
  return best;
}

export function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }