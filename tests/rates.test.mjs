// Betaflight rate profile tests.
//
// These check the *actual formulas*, not just that the curves look plausible.
// The reason this module exists is that a tune has to mean the same thing here
// as it does in the Betaflight configurator, so the numbers are asserted against
// values worked out from Betaflight's published formulas.
import {
  RATE_PROFILES, DEFAULT_RATES, defaultRates, applyDeadzone,
  actualRate, betaflightRate, kissRate, stickToRate, sampleCurve, normaliseRates,
} from '../src/sim/rates.js';

let fails = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`);
  else { console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); fails++; }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('--- Actual profile (Betaflight applyActualRates) ---');

// With expo 0, actualExpo = 10^0 = 1, so the curve is exactly linear to max rate.
const lin = { centerSensitivity: 100, maxRate: 800, expo: 0 };
ok(near(actualRate(0, lin), 0), 'centred stick is zero rate');
ok(near(actualRate(0.5, lin), 400), 'expo 0 is linear to max rate', actualRate(0.5, lin).toFixed(1));
ok(near(actualRate(1, lin), 800), 'full stick is max rate', actualRate(1, lin).toFixed(1));
ok(near(actualRate(-1, lin), -800), 'the curve is symmetric', '');

// actualExpo = 10^(expo/100). At expo 50 -> 10^0.5 = 3.1623.
const expo50 = { centerSensitivity: 100, maxRate: 800, expo: 50 };
const expect50 = 0.5 * 100 + Math.pow(0.5, Math.pow(10, 0.5)) * (800 - 100);
ok(near(actualRate(0.5, expo50), expect50, 1e-6),
  'expo 50 matches the published formula', actualRate(0.5, expo50).toFixed(2));
ok(actualRate(0.5, expo50) < actualRate(0.5, lin),
  'higher expo makes the centre slower', `${actualRate(0.5, expo50).toFixed(0)} < ${actualRate(0.5, lin).toFixed(0)}`);
ok(actualRate(0.9, expo50) > actualRate(0.5, expo50),
  'but the curve still climbs to max', '');
ok(near(actualRate(1, expo50), 800), 'expo never changes the rate at full stick', '');

console.log('\n--- deadzone ---');
ok(applyDeadzone(0.5, 0) === 0.5, 'no deadzone passes the stick through');
ok(applyDeadzone(0.02, 0.1) === 0, 'inside the deadzone reads zero');
ok(near(applyDeadzone(1, 0.1), 1), 'full deflection survives the deadzone', applyDeadzone(1, 0.1).toFixed(4));
ok(near(applyDeadzone(0.55, 0.1), 0.5), 'travel is rescaled past the deadzone',
  applyDeadzone(0.55, 0.1).toFixed(4));
ok(applyDeadzone(-0.05, 0.1) === 0, 'the deadzone is symmetric', '');
ok(applyDeadzone(5, 0) === 1, 'out-of-range input is clamped', '');

console.log('\n--- Betaflight and Kiss profiles exist and differ ---');
const bf = betaflightRate(1, { rcRate: 280, superRate: 50, expo: 0, rcExpo: 100 });
ok(near(bf, 280 + 50), 'BF profile at expo 0 is rc + super', bf.toFixed(1));
const kiss = kissRate(1, { rcRate: 280, superRate: 50 });
ok(near(kiss, 330), 'Kiss at full stick is rc + super', kiss.toFixed(1));
ok(bf !== actualRate(1, { centerSensitivity: 100, maxRate: 800, expo: 0 }),
  'the three profiles are genuinely different formulas', '');

for (const p of RATE_PROFILES) {
  const r = defaultRates();
  r.type = p;
  const v = stickToRate(1, 'roll', r);
  ok(Number.isFinite(v) && v > 0, `profile "${p}" produces a usable rate`, v.toFixed(0) + ' deg/s');
}

console.log('\n--- per-axis independence ---');
const r = defaultRates();
r.axes.roll.maxRate = 600;
r.axes.pitch.maxRate = 1200;
r.axes.yaw.maxRate = 400;
ok(near(stickToRate(1, 'roll', r), 600), 'roll uses its own max rate');
ok(near(stickToRate(1, 'pitch', r), 1200), 'pitch uses its own max rate');
ok(near(stickToRate(1, 'yaw', r), 400), 'yaw uses its own max rate');

console.log('\n--- the defaults are sane ---');
const d = defaultRates();
ok(d.type === 'actual', 'Actual is the default profile', d.type);
ok(d.axes.yaw.maxRate < d.axes.roll.maxRate, 'yaw is slower than roll by default',
  `${d.axes.yaw.maxRate} vs ${d.axes.roll.maxRate}`);
ok(d.axes.yaw.expo < d.axes.roll.expo, 'yaw is flatter than roll by default', '');
const c = sampleCurve('roll', d, 32);
ok(c.length === 33, 'the curve samples the full range', '');
ok(c.every((p) => p.rate >= 0), 'the positive half of the curve is monotonic in rate', '');
let mono = true;
for (let i = 1; i < c.length; i++) if (c[i].rate < c[i - 1].rate - 1e-9) mono = false;
ok(mono, 'the curve never goes backwards', '');

console.log('\n--- migration from the old flat tune fields ---');
const migrated = normaliseRates(undefined, { rcRate: 280, expo: 40, centerSens: 50, maxRate: 850 });
ok(near(migrated.axes.roll.maxRate, 850), 'old maxRate carries onto roll');
ok(near(migrated.axes.roll.expo, 40), 'old expo carries onto roll');
ok(near(migrated.axes.pitch.maxRate, 850), 'and onto pitch');
ok(near(migrated.type === 'actual' ? 1 : 0, 1), 'migrated tunes land on Actual');

const stored = { type: 'kiss', deadzone: 0.1, axes: { yaw: { maxRate: 300 } } };
const merged = normaliseRates(stored, null);
ok(merged.type === 'kiss', 'a stored profile type survives', merged.type);
ok(merged.deadzone === 0.1, 'a stored deadzone survives', String(merged.deadzone));
ok(merged.axes.yaw.maxRate === 300, 'a stored per-axis value survives', '');
ok(merged.axes.roll.maxRate === defaultRates().axes.roll.maxRate,
  'unstored axes keep their defaults', String(merged.axes.roll.maxRate));

console.log(`\n${fails === 0 ? 'all rates checks passed' : fails + ' rates check(s) FAILED'}`);
process.exit(fails ? 1 : 0);