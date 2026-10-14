// Can Reset rescue a craft that has already gone to infinity?
//
// Report: once the craft reaches that state, Reset stops working.
import { Simulation, PHYSICS_HZ } from '../src/sim/sim.js';
import { Environment } from '../src/sim/environment.js';
import { RFWorld } from '../src/sim/rf.js';

const SPEC = { frame: 'f-5-race', motor: 'm-2207', prop: 'p-hq43', esc: 'e-4a45',
  fc: 'fc-f7', rx: 'rx-elrs2', vtx: 'vt-caddx-hd', battery: 'b-6s1300-100' };
const DT = 1 / PHYSICS_HZ;

let fails = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`);
  else { console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); fails++; }
};

const env = new Environment({ tempC: 22, turbulence: 0.2 });
env.windSpeed = 2; env.gust = 1.5;
env.bounds = { half: 190, ceiling: 90 };

function fresh() {
  const s = new Simulation({ spec: SPEC, env });
  s.rfWorld = new RFWorld();
  s.colliders = [];
  s.craft.colliders = [];
  s.reset({ x: 0, y: 0.08, z: 0 });
  s.pilotPos = { x: 0, y: 1.6, z: 0 };
  return s;
}

console.log('--- reset from a diverged state ---');
{
  const s = fresh();
  // Exactly the reported end state: position and velocity at astronomical
  // values, attitude destroyed.
  const b = s.craft.body;
  b.pos = { x: 1.6e164, y: 2.1e164, z: -2.7e164 };
  b.vel = { x: -2.6e168, y: 1.7e168, z: -2.1e168 };
  b.omega = { x: 2.1e171, y: 3.4e171, z: 1.8e171 };
  b.quat = { x: NaN, y: NaN, z: NaN, w: NaN };
  s.craft.propStrike = 49;

  s.reset();
  ok(Number.isFinite(s.craft.body.pos.x), 'reset restores a finite position',
    `${s.craft.body.pos.x}`);
  ok(Number.isFinite(s.craft.body.vel.y), 'and a finite velocity',
    `${s.craft.body.vel.y}`);
  ok(Number.isFinite(s.craft.body.omega.x), 'and finite angular rate',
    `${s.craft.body.omega.x}`);
  ok(Number.isFinite(s.craft.body.quat.w), 'and a finite attitude',
    `q = ${s.craft.body.quat.w}`);
  ok(s.craft.propStrike === 0, 'and clears the prop-strike severity', '');

  // Can it actually be flown afterwards?
  s.craft.fc.armed = true;
  for (let i = 0; i < PHYSICS_HZ; i++) s.step(DT);
  const p = s.craft.body.pos;
  ok(Number.isFinite(p.y) && Math.abs(p.y) < 200,
    'and it flies normally afterwards', `alt ${p.y.toFixed(2)} m`);
}

console.log('\n--- reset from a plain NaN ---');
{
  const s = fresh();
  s.craft.body.pos = { x: NaN, y: NaN, z: NaN };
  s.craft.body.quat = { x: NaN, y: NaN, z: NaN, w: NaN };
  s.reset();
  ok(Number.isFinite(s.craft.body.pos.y), 'reset rescues a NaN position',
    `${s.craft.body.pos.y}`);
}

console.log('\n--- is there a watchdog for a diverged craft? ---');
{
  const s = fresh();
  s.craft.fc.armed = true;
  s.input.key('Space', true);
  // Something goes catastrophically wrong mid-flight.
  for (let i = 0; i < PHYSICS_HZ; i++) s.step(DT);
  s.craft.body.vel = { x: 1e6, y: 1e6, z: 1e6 };
  s.craft.body.pos = { x: 1e12, y: 1e12, z: 1e12 };
  for (let i = 0; i < PHYSICS_HZ * 3; i++) s.step(DT);
  const p = s.craft.body.pos;
  const r = Math.hypot(p.x, p.z);
  ok(Number.isFinite(p.y), 'the craft stays finite', `y ${p.y}`);
  ok(r < 1e6, 'and is pulled back inside the world', `range ${r.toFixed(0)} m`
    + (r > 1e6 ? '  <-- LOST' : ''));
  ok(Math.abs(p.x) < 1000 && Math.abs(p.z) < 1000,
    'and lands back on its spawn point', `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`);
}

console.log('\n--- the watchdog does not fire on ordinary flight ---');
{
  const s = fresh();
  s.craft.fc.armed = true;
  s.input.key('Space', true);
  let recovered = 0;
  for (let i = 0; i < PHYSICS_HZ * 10; i++) {
    if (s.watchdog()) recovered++;
  }
  ok(recovered === 0, 'a normal 10 s flight never trips the watchdog',
    `${recovered} recoveries`);
}

console.log(`\n${fails === 0 ? 'reset and the world bounds hold' : fails + ' reset check(s) FAILED'}`);
process.exit(fails ? 1 : 0);