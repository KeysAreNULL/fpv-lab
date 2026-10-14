// Centre of gravity, and the attitude singularity that made angle mode oscillate.
//
// Two failures, both silent:
//
// 1. The CG sat 6.5 mm FORWARD of the motor axis. Thrust acts on the motor axis
//    while the body rotates about the CG, so that offset is a real nose-up
//    moment - the craft pitched back on its own with the sticks centred. The
//    pack position is now solved from the other parts' forward bias so the CG
//    lands on the thrust axis for every frame.
//
// 2. `qToEuler` is the standard ZYX extraction, which is gimbal-locked at
//    pitch = +-90. Crossing that attitude flips the reported pitch by 180 deg in
//    one step (measured: 289 deg during a slow roll). Angle mode differenced
//    those angles, saturated, slammed the craft over, hit the singularity again
//    and oscillated through the full 360 deg. It now uses a rotation-vector
//    error, which has no singularity.
import { buildCraft, stepCraft, Q_LEVEL, analyseBuild, attitudeOf, attitudeErrorRate, levelAttitudeQuat }
  from '../src/sim/craft.js';
import '../src/sim/body.js';
import { Environment } from '../src/sim/environment.js';
import { DEFAULTS } from '../src/data/catalog.js';
import { DEFAULT_TUNE, cloneTune } from '../src/sim/fc.js';
import { PHYSICS_HZ } from '../src/sim/sim.js';

let fails = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`);
  else { console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); fails++; }
};

const SPECS = [
  ['stock 5"', { ...DEFAULTS, motorKvIndex: 0 }],
  ['cinewhoop 3"', { frame: 'f-cinewhoop-3', motor: 'm-1906', motorKvIndex: 1,
    prop: 'p-3tri', esc: 'e-4a35', fc: 'fc-f4', rx: 'rx-elrs2',
    vtx: 'vt-caddx-hd', battery: 'b-4s850-100' }],
  ['long range 7"', { frame: 'f-7-lr', motor: 'm-2812', motorKvIndex: 1,
    prop: 'p-7', esc: 'e-4a60', fc: 'fc-f7', rx: 'rx-elrs900',
    vtx: 'vt-caddx-hd', battery: 'b-6s1500-100' }],
  ['toothpick 3"', { frame: 'f-toothpick-3', motor: 'm-1404', motorKvIndex: 1,
    prop: 'p-2.5tri', esc: 'e-4a25', fc: 'fc-f4', rx: 'rx-elrs2',
    vtx: 'vt-caddx-hd', battery: 'b-4s450-75' }],
];

console.log('--- the CG sits on the thrust axis, on every frame ---');
for (const [name, spec] of SPECS) {
  const c = buildCraft(spec);
  const hubs = c.hubs || c.props.map((p) => p.propPos);
  let mx = 0;
  for (const h of hubs) mx += h.x;
  mx /= hubs.length;
  const offMm = (c.com.x - mx) * 1000;
  ok(Math.abs(offMm) < 0.5, `${name}: CG within 0.5 mm of the motor axis`,
    `${offMm.toFixed(3)} mm`);
}

console.log('\n--- and it sits BELOW the thrust plane, which is what self-levels ---');
for (const [name, spec] of SPECS) {
  const c = buildCraft(spec);
  const hubs = c.hubs || c.props.map((p) => p.propPos);
  const mz = hubs.reduce((a, h) => a + h.z, 0) / hubs.length;
  // Body +Z is down, so a more negative CG z than the motors means "lower".
  ok(c.com.z > mz, `${name}: CG below the motor plane`,
    `CG z ${(c.com.z * 1000).toFixed(1)} mm vs motors ${(mz * 1000).toFixed(1)} mm`);
}

console.log('\n--- equal thrust produces no pitching moment ---');
for (const [name, spec] of SPECS) {
  const c = buildCraft(spec);
  c.body.quat = { x: Q_LEVEL.x, y: Q_LEVEL.y, z: Q_LEVEL.z, w: Q_LEVEL.w };
  c.body.updateRotation();
  c.fc.armed = true;
  c.colliders = [];
  const env = new Environment({ tempC: 22, turbulence: 0 });
  env.windSpeed = 0; env.gust = 0;
  for (let i = 0; i < PHYSICS_HZ * 0.4; i++) {
    stepCraft(c, 1 / PHYSICS_HZ, env, { x: 0, y: 0, z: 0, throttle: 0.3 },
      { runPID: false });
  }
  const drift = Math.abs(c.body.omega.y * 180 / Math.PI);
  ok(drift < 1, `${name}: level thrust does not pitch the craft`,
    `${drift.toFixed(2)} deg/s`);
}

console.log('\n--- the rotation-vector attitude error has no singularity ---');
{
  // A level craft wanting nose-up must get a POSITIVE pitch rate and nothing on
  // the roll axis. A wrong axis mapping here is invisible in the craft's
  // behaviour but is exactly the bug that stopped angle mode working.
  const id = { x: 0, y: 0, z: 0, w: 1 };
  const r = attitudeErrorRate(id, { roll: 0, pitch: (20 * Math.PI) / 180, yaw: 0 }, 9, 9.1);
  ok(r.y > 0.5, 'wanting pitch gives a positive pitch rate', `${r.y.toFixed(2)} rad/s`);
  ok(Math.abs(r.x) < 1e-9 && Math.abs(r.z) < 1e-9,
    'and nothing on the other axes', `x ${r.x}, z ${r.z}`);
  const rr = attitudeErrorRate(id, { roll: (20 * Math.PI) / 180, pitch: 0, yaw: 0 }, 9, 9.1);
  ok(rr.x > 0.5 && Math.abs(rr.y) < 1e-9, 'wanting roll gives roll and nothing else', '');

  // Upside down: the Euler extraction is meaningless here, the rotation vector
  // is not. From inverted, asking for level must still give a finite rate.
  const inv = { x: 1, y: 0, z: 0, w: 0 };      // 180 deg about X
  const back = attitudeErrorRate(inv, { roll: 0, pitch: 0, yaw: 0 }, 9, 9.1);
  const m = Math.hypot(back.x, back.y, back.z);
  ok(Number.isFinite(m) && m > 1, 'recovering from inverted gives a finite rate', `${m.toFixed(2)} rad/s`);
}

console.log('\n--- angle mode holds its attitude instead of tumbling ---');
{
  const env = new Environment({ tempC: 22, turbulence: 0 });
  env.windSpeed = 0; env.gust = 0;
  const c = buildCraft({ ...DEFAULTS, motorKvIndex: 0 },
    { env, physicsHz: PHYSICS_HZ, pidDivisor: 2, tune: cloneTune(DEFAULT_TUNE) });
  c.body.pos.y = 400;
  c.body.quat = { x: Q_LEVEL.x, y: Q_LEVEL.y, z: Q_LEVEL.z, w: Q_LEVEL.w };
  c.body.updateRotation();
  c.fc.armed = true;
  c.fc.mode = 'angle';
  c.colliders = [];
  for (const [label, stick] of [['nose up', 0.25], ['nose down', -0.25], ['roll right', 0.3]]) {
    const pitches = [];
    const rolls = [];
    for (let i = 0; i < PHYSICS_HZ * 6; i++) {
      const st = label === 'roll right'
        ? { x: stick, y: 0, z: 0, throttle: 0.26 }
        : { x: 0, y: stick, z: 0, throttle: 0.26 };
      stepCraft(c, 1 / PHYSICS_HZ, env, st, { runPID: i % 2 === 0 });
      if (i > PHYSICS_HZ * 3) {
        pitches.push(c.fc.attitude.pitch * 180 / Math.PI);
        rolls.push(c.fc.attitude.roll * 180 / Math.PI);
      }
    }
    const span = Math.max(...(label === 'roll right' ? rolls : pitches))
      - Math.min(...(label === 'roll right' ? rolls : pitches));
    const mean = (label === 'roll right' ? rolls : pitches)
      .reduce((a, b) => a + b, 0) / (label === 'roll right' ? rolls : pitches).length;
    const want = (label === 'roll right' ? stick : stick) * 55;
    ok(span < 8, `angle mode "${label}" is steady, not oscillating`,
      `${span.toFixed(1)} deg peak-to-peak, holding ${mean.toFixed(1)} of ${want.toFixed(1)} deg`);
  }
}

console.log(`\n${fails === 0 ? 'the craft is trimmed and angle mode holds' : fails + ' attitude check(s) FAILED'}`);
process.exit(fails ? 1 : 0);