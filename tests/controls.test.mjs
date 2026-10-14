// Control-surface binding tests. Headless: no navigator, no DOM.
//
// The binding model is the whole point of the controls panel, and the failure
// it has to avoid is silent - a channel that resolves to null just quietly falls
// back to the keyboard and the pilot concludes the panel is broken.
import {
  CHANNELS, defaultBindings, shapeAxis, shapeButton, resolveChannel, describeBinding,
} from '../src/sim/controls.js';

let fails = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`);
  else { console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); fails++; }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

console.log('--- shaping ---');

ok(near(shapeAxis(0.5), 0.5), 'expo 0 is linear', shapeAxis(0.5).toFixed(3));
ok(near(shapeAxis(0.5, { expo: 1 }), 0.125), 'expo 1 is cubic', shapeAxis(0.5, { expo: 1 }).toFixed(3));
ok(near(shapeAxis(-0.5, { expo: 1 }), -0.125), 'expo is symmetric', '');
ok(near(shapeAxis(0.5, { invert: true }), -0.5), 'invert flips sign', '');
ok(near(shapeAxis(1, { expo: 1 }), 1), 'full deflection is reachable at any expo', '');
ok(near(shapeAxis(0.2, { deadzone: 0.2 }), 0), 'inside the deadzone reads centre', '');
ok(shapeAxis(0.6, { deadzone: 0.2 }) > 0.4, 'outside the deadzone keeps its travel',
  shapeAxis(0.6, { deadzone: 0.2 }).toFixed(3));
ok(near(shapeAxis(5), 1) && near(shapeAxis(-5), -1), 'out-of-range input is clamped', '');
ok(near(shapeAxis(NaN), 0), 'NaN reads as centre rather than poisoning the craft', '');

ok(shapeButton(true) === 1, 'a held button is full deflection', '');
ok(shapeButton(false) === 0, 'a released button is centre', '');
ok(shapeButton(true, { invert: true }) === -1, 'a button can be inverted', '');

console.log('\n--- resolution against a fake gamepad ---');

// A RadioMaster-style pad: 6 axes, and the sticks are NOT on 0/1.
const pocket = {
  id: 'RadioMaster Pocket',
  axes: [0, 0, 0, 0.9, -0.4, 0],
  buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
};
const state = { pads: [pocket] };

ok(resolveChannel({ kind: 'axis', device: 0, index: 9 }, state) === null,
  'an axis the pad does not have reads null and falls back to the keyboard', '');
ok(resolveChannel({ kind: 'axis', device: 0, index: 2 }, state) === 0,
  'a bound axis resting at centre resolves to 0, not null', '');
ok(resolveChannel({ kind: 'axis', device: 3, index: 0 }, state) === null,
  'a missing device reads null', '');
ok(resolveChannel(null, state) === null, 'an unbound channel reads null', '');
ok(resolveChannel({ kind: 'key', key: 'KeyE' }, state) === null,
  'a keyboard binding is handled by the ramp, not by resolveChannel', '');

ok(near(resolveChannel({ kind: 'axis', device: 0, index: 3 }, state), 0.9),
  'axis 3 resolves to its travel',
  resolveChannel({ kind: 'axis', device: 0, index: 3 }, state).toFixed(2));
ok(near(resolveChannel({ kind: 'axis', device: 0, index: 4 }, state), -0.4),
  'axis 4 resolves to its travel', '');

// Buttons.
pocket.buttons[2] = { pressed: true, value: 1 };
ok(resolveChannel({ kind: 'button', device: 0, index: 2 }, state) === 1,
  'a pressed button resolves to +1', '');
pocket.buttons[2] = { pressed: false, value: 0 };
ok(resolveChannel({ kind: 'button', device: 0, index: 2 }, state) === 0,
  'a released button resolves to 0', '');

console.log('\n--- defaults are the keyboard mapping that shipped before ---');
const d = defaultBindings();
ok(d.roll.key === 'ArrowRight' && d.pitch.key === 'ArrowUp'
  && d.yaw.key === 'KeyE' && d.throttle.key === 'Space',
  'defaults reproduce the original keyboard controls',
  `${d.roll.key}/${d.pitch.key}/${d.yaw.key}/${d.throttle.key}`);
ok(CHANNELS.length === 4, 'four flight channels', '');
ok(CHANNELS.every((c) => d[c.id]), 'every channel has a default binding', '');

console.log('\n--- labels ---');
ok(describeBinding({ kind: 'axis', device: 0, index: 3 }, 'RadioMaster Pocket')
  === 'RadioMaster Pocket · Axis 3', 'axis labels name the device', describeBinding({ kind: 'axis', device: 0, index: 3 }, 'RadioMaster Pocket'));
ok(describeBinding({ kind: 'key', key: 'ArrowRight' }) === 'Key Right',
  'key labels are readable', describeBinding({ kind: 'key', key: 'ArrowRight' }));
ok(describeBinding(null) === 'unbound', 'an unbound channel says so', '');

console.log(`\n${fails === 0 ? 'all controls checks passed' : fails + ' controls check(s) FAILED'}`);
process.exit(fails ? 1 : 0);