// Does the flight controller actually use the rate profile?
//
// The panel edits `fc.rates` and the curve module is separately tested; what is
// not covered is the wiring between them. These assert the path end to end -
// stick -> setpoint - and catch the failure where rates are computed correctly
// but never read, which is invisible except as "my rates do nothing".
import { FlightController, DEFAULT_TUNE, TUNE_LIBRARY, cloneTune } from '../src/sim/fc.js';
import { defaultRates } from '../src/sim/rates.js';

let fails = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`);
  else { console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); fails++; }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const SPEC = { frame: 'f-5-race', motor: 'm-2207', prop: 'p-hq43', esc: 'e-4a45',
  fc: 'fc-f7', rx: 'rx-elrs2', vtx: 'vt-caddx-hd', battery: 'b-6s1300-100' };
const fc = new FlightController(SPEC, cloneTune());

console.log('--- the FC reads its rates ---');
ok(!!fc.rates, 'the FC has a rates block');
ok(fc.rates === fc.tune.rates, 'rates is a live reference to the tune, not a copy', '');

fc.rates.deadzone = 0;
fc.rates.type = 'actual';
fc.rates.axes.roll.maxRate = 800;
fc.rates.axes.roll.centerSensitivity = 100;
fc.rates.axes.roll.expo = 0;
ok(near(fc.stickToRate(1, 'roll'), 800), 'full roll stick -> max rate',
  fc.stickToRate(1, 'roll').toFixed(1) + ' deg/s');
ok(near(fc.stickToRate(0.5, 'roll'), 400), 'half roll stick -> half of max',
  fc.stickToRate(0.5, 'roll').toFixed(1) + ' deg/s');

console.log('\n--- per axis is actually per axis ---');
fc.rates.axes.pitch.maxRate = 1200;
ok(near(fc.stickToRate(1, 'roll'), 800), 'roll keeps its own max rate');
ok(near(fc.stickToRate(1, 'pitch'), 1200), 'pitch uses its own max rate');
ok(fc.stickToRate(1, 'yaw') !== fc.stickToRate(1, 'roll'), 'yaw differs from roll', '');

console.log('\n--- the profile switch reaches the FC ---');
const r = fc.rates;
const rollActual = fc.stickToRate(0.5, 'roll');
r.type = 'kiss';
r.axes.roll.rcRate = 100; r.axes.roll.superRate = 200;
const rollKiss = fc.stickToRate(0.5, 'roll');
ok(rollKiss !== rollActual, 'switching profile changes the result',
  `${rollActual.toFixed(1)} -> ${rollKiss.toFixed(1)} deg/s`);
r.type = 'actual';
ok(near(fc.stickToRate(0.5, 'roll'), rollActual), 'switching back restores it', '');

console.log('\n--- setpoints go through the curve ---');
fc.rates.deadzone = 0;
fc.mode = 'acro';
const sp = fc.computeAngleModeSetpoint({ x: 1, y: 0, z: 0 }, null,
  { roll: 0, pitch: 0 }, 1 / 8000);
ok(near(sp.x, fc.stickToRate(1, 'roll')), 'the roll setpoint is the rate curve output',
  sp.x.toFixed(1) + ' deg/s');

console.log('\n--- swapping to a library preset re-points the rates ---');
const fresh = new FlightController(SPEC, cloneTune(TUNE_LIBRARY[2]));  // Race / sharp
const raceMax = fresh.rates.axes.roll.maxRate;
ok(raceMax > 0, 'the Race preset carries its own max rate', String(raceMax));
ok(fresh.stickToRate(1, 'roll') === raceMax,
  'and the FC uses it', fresh.stickToRate(1, 'roll').toFixed(0) + ' deg/s');

// apply a different tune in place, as the Tune view does when you pick a preset
fresh.tune = cloneTune(DEFAULT_TUNE);
fresh.applyTune();
ok(fresh.rates === fresh.tune.rates, 'applyTune re-points rates at the new tune', '');
ok(fresh.stickToRate(1, 'roll') === defaultRates().axes.roll.maxRate,
  'the new tune\'s rates are the ones in force', fresh.stickToRate(1, 'roll').toFixed(0));

console.log('\n--- every library preset is well formed ---');
for (const p of TUNE_LIBRARY) {
  const f = new FlightController(SPEC, cloneTune(p));
  const roll = f.stickToRate(1, 'roll');
  const yaw = f.stickToRate(1, 'yaw');
  ok(Number.isFinite(roll) && roll > 0 && roll < 2000 && yaw > 0,
    `"${p.name}" produces sane rates`, `roll ${roll.toFixed(0)}, yaw ${yaw.toFixed(0)}`);
}

console.log(`\n${fails === 0 ? 'all rates wiring checks passed' : fails + ' rates wiring check(s) FAILED'}`);
process.exit(fails ? 1 : 0);