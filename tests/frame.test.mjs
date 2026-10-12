// Frame and sign conventions. If these are wrong the craft flies in mirrors, so
// they are asserted explicitly rather than inferred from a screenshot.
//
// Run: node tests/frame.test.mjs

import { buildCraft, stepCraft, analyseBuild, MOTOR_SPIN, THRUST_AXIS, Q_LEVEL, attitudeOf } from '../src/sim/craft.js';
import { DEFAULTS } from '../src/data/catalog.js';
import { Environment } from '../src/sim/environment.js';
import { qToEuler, qFromAxisAngle, RAD, DEG } from '../src/core/math.js';

let pass = 0, fail = 0;
const lines = [];
function check(name, cond, info = '') {
  if (cond) { pass++; lines.push(`  ok   ${name} ${info}`); }
  else { fail++; lines.push(`  FAIL ${name} ${info}`); }
}

const env = new Environment({ turbulence: 0 });
const SPEC = { ...DEFAULTS, motorKvIndex: 0 };
const HOVER = analyseBuild(SPEC).hoverThrottle;

function fresh() {
  const craft = buildCraft(SPEC, { env, physicsHz: 8000, pidDivisor: 1 });
  craft.body.pos.y = 30;
  craft.body.quat = { x: Q_LEVEL.x, y: Q_LEVEL.y, z: Q_LEVEL.z, w: Q_LEVEL.w };
  craft.body.vel = { x: 0, y: 0, z: 0 };
  craft.body.omega = { x: 0, y: 0, z: 0 };
  craft.fc.armed = true;
  craft.body.updateRotation();
  return craft;
}
function run(craft, sticks, seconds) {
  const dt = 1 / 8000;
  const n = Math.round(seconds * 8000);
  for (let i = 0; i < n; i++) {
    stepCraft(craft, dt, env, { x: 0, y: 0, z: 0, throttle: HOVER, ...sticks },
      { runPID: (i % craft.pidDivisorEffective) === 0 });
  }
  return craft;
}

/* ------------------------------------------------ 1. quaternion / Euler map */
console.log('\n--- Quaternion to Euler signs (NED body, X fwd, Y right, Z down) ---');
{
  const e1 = qToEuler(qFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2, {}));
  check('+90 deg about body X reads as +90 roll', Math.abs(e1.roll * RAD - 90) < 0.5,
    `roll ${(e1.roll * RAD).toFixed(2)}`);
  const e2 = qToEuler(qFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2, {}));
  check('+90 deg about body Y reads as +90 pitch', Math.abs(e2.pitch * RAD - 90) < 0.5,
    `pitch ${(e2.pitch * RAD).toFixed(2)}`);
  const e3 = qToEuler(qFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2, {}));
  check('+90 deg about body Z reads as +90 yaw', Math.abs(e3.yaw * RAD - 90) < 0.5,
    `yaw ${(e3.yaw * RAD).toFixed(2)}`);

  const c = fresh();
  const up = c.body.toWorld(THRUST_AXIS, {});
  check('level craft maps body up (-Z) to world up (+Y)',
    Math.abs(up.x) < 1e-9 && Math.abs(up.y - 1) < 1e-9 && Math.abs(up.z) < 1e-9,
    `body -Z -> world (${up.x.toFixed(3)}, ${up.y.toFixed(3)}, ${up.z.toFixed(3)})`);
  const fwd = c.body.toWorld({ x: 1, y: 0, z: 0 }, {});
  check('level craft nose (+X) points along world +Z or -Z consistently',
    Math.abs(Math.abs(fwd.z) - 1) < 1e-9, `nose -> world (${fwd.x.toFixed(2)}, ${fwd.y.toFixed(2)}, ${fwd.z.toFixed(2)})`);
}

/* ------------------------------------------------------- 2. thrust is up */
console.log('\n--- Thrust direction ---');
{
  const c = fresh();
  c.fc.armed = false;
  c.fc.motors = [1500, 1500, 1500, 1500];
  for (let i = 0; i < 1000; i++) {
    stepCraft(c, 1 / 8000, env, { x: 0, y: 0, z: 0, throttle: 0 }, { runPID: false });
    c.fc.motors = [1500, 1500, 1500, 1500];
  }
  check('thrust pushes the craft up', c.body.vel.y > 0.5,
    `vy ${c.body.vel.y.toFixed(2)} m/s, thrust ${c.thrust.toFixed(1)} N, weight ${(c.mass * 9.80665).toFixed(1)} N`);
  check('thrust beats weight at 50% throttle', c.thrust > c.mass * 9.80665,
    `${c.thrust.toFixed(1)} N vs ${(c.mass * 9.80665).toFixed(1)} N`);
  check('no roll/pitch drift from raw thrust',
    Math.abs(c.body.omega.x) < 0.05 && Math.abs(c.body.omega.y) < 0.05,
    `wx ${c.body.omega.x.toFixed(4)} wy ${c.body.omega.y.toFixed(4)} rad/s`);
  check('no yaw drift from raw thrust', Math.abs(c.body.omega.z) < 0.05,
    `wz ${c.body.omega.z.toFixed(4)} rad/s`);
}

/* ------------------------------------------------ 3. closed-loop signs */
console.log('\n--- Closed loop: stick direction produces matching body rate ---');
{
  let c = fresh();
  run(c, {}, 0.06);   // settle in hover
  run(c, { x: 0.8 }, 0.20);
  check('roll stick right -> positive roll rate', c.body.omega.x * RAD > 300,
    `wx ${(c.body.omega.x * RAD).toFixed(0)} deg/s, setpoint ${c.fc.setpoint.x.toFixed(0)}`);
  check('roll setpoint positive for a right stick', c.fc.setpoint.x > 100,
    `${c.fc.setpoint.x.toFixed(0)} deg/s`);

  c = fresh();
  run(c, {}, 0.06);
  run(c, { y: 0.8 }, 0.20);
  check('pitch stick forward -> positive pitch rate (nose up)', c.body.omega.y * RAD > 300,
    `wy ${(c.body.omega.y * RAD).toFixed(0)} deg/s, setpoint ${c.fc.setpoint.y.toFixed(0)}`);

  c = fresh();
  run(c, {}, 0.06);
  run(c, { z: 0.8 }, 0.30);
  check('yaw stick right -> positive yaw rate (nose right)', c.body.omega.z * RAD > 150,
    `wz ${(c.body.omega.z * RAD).toFixed(0)} deg/s, setpoint ${c.fc.setpoint.z.toFixed(0)}`);

  c = fresh();
  run(c, {}, 0.06);
  run(c, { x: 0.9 }, 0.09);
  const bank = attitudeOf(c.body.quat).roll * RAD;
  check('roll stick right banks right (right wing down)', bank > 6,
    `bank ${bank.toFixed(1)} deg`);

  c = fresh();
  run(c, {}, 0.06);
  run(c, { y: -0.9 }, 0.09);
  const noseDn = attitudeOf(c.body.quat).pitch * RAD;
  check('pitch stick back pitches nose down', noseDn < -6,
    `pitch ${noseDn.toFixed(1)} deg`);
}

/* --------------------------------------------------- 4. rotor momentum */
console.log('\n--- Rotor spin pattern ---');
{
  const spins = MOTOR_SPIN.slice();
  check('spin pattern is FL/RR CCW, FR/RL CW',
    spins[0] === 1 && spins[1] === -1 && spins[2] === -1 && spins[3] === 1,
    spins.join(', '));
  const c = fresh();
  const L = c.props.reduce((s, p) => s + p.Irotor * p.n * p.axis, 0);
  check('balanced motors have zero net rotor momentum at rest', Math.abs(L) < 1e-12,
    `L ${L.toExponential(2)}`);
  // Equal RPM on all four must not produce a net yaw torque.
  c.fc.armed = false;
  c.fc.motors = [1500, 1500, 1500, 1500];
  for (let i = 0; i < 1000; i++) {
    stepCraft(c, 1 / 8000, env, { x: 0, y: 0, z: 0, throttle: 0 }, { runPID: false });
    c.fc.motors = [1500, 1500, 1500, 1500];
  }
  check('equal motor loads produce no yaw acceleration', Math.abs(c.body.omega.z) < 0.05,
    `wz ${c.body.omega.z.toFixed(4)} rad/s`);
}

/* ------------------------------------------------------------ 5. hover */
console.log('\n--- Closed loop hover ---');
{
  const c = fresh();
  run(c, {}, 1.5);
  check('holds altitude within 1 m after 1.5 s', Math.abs(c.body.pos.y - 30) < 1.0,
    `alt ${c.body.pos.y.toFixed(2)} m, vy ${c.body.vel.y.toFixed(2)} m/s`);
  check('does not spin while hovering',
    Math.abs(c.body.omega.x * RAD) < 40 && Math.abs(c.body.omega.y * RAD) < 40
    && Math.abs(c.body.omega.z * RAD) < 40,
    `w = ${(c.body.omega.x * RAD).toFixed(0)}, ${(c.body.omega.y * RAD).toFixed(0)}, ${(c.body.omega.z * RAD).toFixed(0)} deg/s`);
  check('hover current is plausible for a 5"', c.currentA > 8 && c.currentA < 45,
    `${c.currentA.toFixed(1)} A at ${c.battery.voltage.toFixed(1)} V`);
}

console.log(lines.join('\n'));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
