// Does the PID loop actually damp?
//
// The D term had the opposite sign to what the mixer needs. `sum` drives the
// motors in the same sense as P, so D must subtract when the gyro is already
// accelerating. With the sign the other way D was anti-damping: sweeping D from
// 42 to 90 made step overshoot climb from 50% to 68%, the exact opposite of what
// D is for. No existing test caught it because they all assert closed-loop
// tracking, which a destabilising D can still satisfy.
//
// These assert the *direction* of each term's effect.
import { buildCraft, stepCraft, Q_LEVEL, analyseBuild } from '../src/sim/craft.js';
import { Environment } from '../src/sim/environment.js';
import { DEFAULT_TUNE, cloneTune } from '../src/sim/fc.js';
import { PHYSICS_HZ } from '../src/sim/sim.js';

let fails = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`);
  else { console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); fails++; }
};

const SPEC = { frame: 'f-5-race', motor: 'm-2207', prop: 'p-hq43', esc: 'e-4a45',
  fc: 'fc-f7', rx: 'rx-elrs2', vtx: 'vt-caddx-hd', battery: 'b-6s1300-100' };
const HOVER = analyseBuild(SPEC).hoverThrottle;
const DT = 1 / PHYSICS_HZ;

function overshoot(dGain, pGain = 50) {
  const env = new Environment({ tempC: 22, turbulence: 0 });
  env.windSpeed = 0; env.gust = 0;
  const tune = cloneTune(DEFAULT_TUNE);
  tune.p = [pGain, pGain, pGain];
  tune.d = [dGain, dGain, 0];
  tune.f = [0, 0, 0];
  tune.i = [0, 0, 0];
  const c = buildCraft(SPEC, { env, physicsHz: PHYSICS_HZ, pidDivisor: 2, tune });
  c.body.pos.y = 30;
  c.body.quat = { x: Q_LEVEL.x, y: Q_LEVEL.y, z: Q_LEVEL.z, w: Q_LEVEL.w };
  c.body.updateRotation();
  c.fc.armed = true;
  const sp = Math.abs(c.fc.stickToRate(0.5, 'roll'));

  let peak = 0;
  // Settle first, then step. The divisor must match the runPID alternation:
  // claiming a shorter period than the loop actually runs makes D's derivative
  // come out too large, which is a second, quieter version of the same bug.
  for (let i = 0; i < PHYSICS_HZ * 0.3; i++) {
    stepCraft(c, DT, env, { x: 0, y: 0, z: 0, throttle: HOVER }, { runPID: i % 2 === 0 });
  }
  for (let i = 0; i < PHYSICS_HZ; i++) {
    stepCraft(c, DT, env, { x: 0.5, y: 0, z: 0, throttle: HOVER }, { runPID: i % 2 === 0 });
    peak = Math.max(peak, Math.abs(c.body.omega.x * 180 / Math.PI));
  }
  return (peak / sp - 1) * 100;
}

console.log('--- D must damp, not drive ---');
const d0 = overshoot(0);
const d30 = overshoot(30);
const d70 = overshoot(70);
console.log(`  D=0 ${d0.toFixed(0)}%   D=30 ${d30.toFixed(0)}%   D=70 ${d70.toFixed(0)}%`);
ok(d70 < d30, 'more D reduces overshoot', `${d30.toFixed(0)}% -> ${d70.toFixed(0)}%`);
ok(d70 < d0, 'D damps relative to no D at all', `${d0.toFixed(0)}% -> ${d70.toFixed(0)}%`);
ok(d70 > -5, 'and does not send the craft the other way', `${d70.toFixed(0)}%`);

console.log('\n--- P must stiffen the loop ---');
const p20 = overshoot(20, 20);
const p70 = overshoot(70, 70);
console.log(`  P=20 ${p20.toFixed(0)}%   P=70 ${p70.toFixed(0)}%`);
ok(p70 > p20, 'more P increases overshoot', `${p20.toFixed(0)}% -> ${p70.toFixed(0)}%`);

console.log(`\n${fails === 0 ? 'the PID loop damps as it should' : fails + ' PID check(s) FAILED'}`);
process.exit(fails ? 1 : 0);