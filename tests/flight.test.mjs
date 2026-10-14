// End-to-end flight check through the app's real Simulation path.
//
// This is the check that would have caught the reported symptom: arm the craft,
// fly it, and confirm it holds attitude and does not tumble or drift on its own.
import { Simulation, PHYSICS_HZ } from '../src/sim/sim.js';
import { Environment } from '../src/sim/environment.js';
import { RFWorld } from '../src/sim/rf.js';
import { attitudeOf } from '../src/sim/craft.js';
import { analyseBuild } from '../src/sim/craft.js';

const SPEC = { frame: 'f-5-race', motor: 'm-2207', prop: 'p-hq43', esc: 'e-4a45',
  fc: 'fc-f7', rx: 'rx-elrs2', vtx: 'vt-caddx-hd', battery: 'b-6s1300-100' };
const HOVER = analyseBuild(SPEC).hoverThrottle;
const DT = 1 / PHYSICS_HZ;

let fails = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`);
  else { console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); fails++; }
};

function makeSim(env) {
  const sim = new Simulation({ spec: SPEC, env });
  // An empty RF world rather than null: the radio link traces against it every
  // frame, so null is not a "no obstacles" option.
  sim.rfWorld = new RFWorld();
  sim.colliders = [];
  sim.craft.colliders = [];
  sim.reset({ x: 0, y: 40, z: 0 });
  sim.pilotPos = { x: 0, y: 40, z: 0 };
  return sim;
}

function fly(env, seconds, sticks) {
  const sim = makeSim(env);
  sim.craft.fc.armed = true;
  for (let i = 0; i < PHYSICS_HZ * seconds; i++) {
    Object.assign(sim.input.raw, sticks(i * DT));
    sim.step(DT);
    if (!Number.isFinite(sim.craft.body.pos.y)) break;
  }
  return sim;
}

const still = new Environment({ tempC: 22, turbulence: 0 });
still.windSpeed = 0; still.gust = 0;
const windy = new Environment({ tempC: 22, turbulence: 0.2 });
windy.windSpeed = 2; windy.gust = 1.5;

console.log('--- hands off, hovering, no stick input ---');
{
  const sim = fly(still, 5, () => ({ x: 0, y: 0, z: 0, throttle: HOVER }));
  const a = attitudeOf(sim.craft.body.quat);
  const b = sim.craft.body;
  ok(Number.isFinite(b.pos.y), '5 s of hover never goes NaN', `alt ${b.pos.y.toFixed(1)} m`);
  ok(Math.abs(a.roll) < 5, 'roll stays level with no input', `${a.roll.toFixed(2)} deg`);
  ok(Math.abs(a.pitch) < 5, 'pitch stays level with no input', `${a.pitch.toFixed(2)} deg`);
  ok(Math.abs(b.vel.x) < 0.5 && Math.abs(b.vel.z) < 0.5,
    'and it does not wander', `v ${b.vel.x.toFixed(2)}, ${b.vel.z.toFixed(2)} m/s`);
  ok(Math.abs(b.vel.y) < 1.0, 'altitude holds', `vy ${b.vel.y.toFixed(2)} m/s`);
}

console.log('\n--- hands off in the app default wind ---');
{
  const sim = fly(windy, 5, () => ({ x: 0, y: 0, z: 0, throttle: HOVER }));
  const a = attitudeOf(sim.craft.body.quat);
  ok(Math.abs(a.roll) < 8 && Math.abs(a.pitch) < 8,
    'attitude holds in 2 m/s of wind with gusts',
    `roll ${a.roll.toFixed(1)}, pitch ${a.pitch.toFixed(1)} deg`);
}

console.log('\n--- a roll command is tracked, not runaway ---');
{
  const sim = fly(still, 1.0, () => ({ x: 0.5, y: 0, z: 0, throttle: HOVER }));
  const g = sim.craft.body.omega.x * 180 / Math.PI;
  const sp = sim.craft.fc.setpoint.x;
  ok(Number.isFinite(g), 'roll rate stays finite', `${g.toFixed(0)} deg/s`);
  ok(Math.abs(g) < 2000, 'and does not run away', `${g.toFixed(0)} deg/s`);
  ok(Math.sign(g) === Math.sign(sp), 'rolls the way the stick asks', '');
}

console.log('\n--- free fall terminates instead of diverging ---');
{
  const sim = makeSim(still);
  sim.craft.fc.armed = false;
  sim.craft.body.pos.y = 3000;
  for (let i = 0; i < PHYSICS_HZ * 12; i++) {
    sim.input.raw.throttle = 0;
    sim.step(DT);
    if (!Number.isFinite(sim.craft.body.vel.y)) break;
  }
  const v = Math.abs(sim.craft.body.vel.y);
  ok(Number.isFinite(v), '12 s of fall never goes NaN', `${v.toFixed(1)} m/s`);
  ok(v < 40, 'and it reaches terminal velocity', `${v.toFixed(1)} m/s`);
}

console.log(`\n${fails === 0 ? 'the craft flies straight' : fails + ' flight check(s) FAILED'}`);
process.exit(fails ? 1 : 0);