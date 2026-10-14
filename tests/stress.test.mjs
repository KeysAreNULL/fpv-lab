// Can the craft actually be flown for more than a couple of seconds?
//
// Report: after a few seconds of flying it goes to infinity - the camera follows
// it, so the map and the quad both disappear - and Reset then does nothing.
// Headless hover was already covered by flight.test.mjs; this drives the sticks.
import { Simulation, PHYSICS_HZ } from '../src/sim/sim.js';
import { Environment } from '../src/sim/environment.js';
import { RFWorld } from '../src/sim/rf.js';
import { attitudeOf, analyseBuild } from '../src/sim/craft.js';
import { getTrack } from '../src/data/tracks.js';

const SPEC = { frame: 'f-5-race', motor: 'm-2207', prop: 'p-hq43', esc: 'e-4a45',
  fc: 'fc-f7', rx: 'rx-elrs2', vtx: 'vt-caddx-hd', battery: 'b-6s1300-100' };
const HOVER = analyseBuild(SPEC).hoverThrottle;
const DT = 1 / PHYSICS_HZ;

const env = new Environment({ tempC: 22, turbulence: 0.2 });
env.windSpeed = 2; env.windDir = 90; env.gust = 1.5;

function sim(trackId) {
  const s = new Simulation({ spec: SPEC, env });
  const world = new RFWorld();
  const colliders = [];
  let bounds = null;
  if (trackId) {
    const track = getTrack(trackId);
    for (const o of track.obstacles) {
      const b = world.addBox(o.x, o.y, o.z, o.sx, o.sy, o.sz, o.material);
      if (track.collision.indexOf(o) >= 0) colliders.push(b);
      else b.noCollide = true;
    }
    bounds = track.bounds;
  }
  s.rfWorld = world;
  s.colliders = colliders;
  s.craft.colliders = colliders;
  s.craft.bounds = bounds;
  s.reset({ x: 0, y: 40, z: 0 });
  s.pilotPos = { x: 0, y: 40, z: 0 };
  s.craft.fc.armed = true;
  return s;
}

// Drive the real input path: hold keys, let input.poll() ramp them. Injecting
// `input.raw` directly does nothing, because poll() overwrites it every step -
// which is how an earlier version of this test "passed" while the craft was
// simply falling to the ground with the throttle at zero.
function fly(name, keys, seconds = 12, trackId = null, startY = 40) {
  const s = sim(trackId);
  s.reset({ x: 0, y: startY, z: 0 });
  s.pilotPos = { x: 0, y: startY, z: 0 };
  // After the reset: reset() disarms, so arming in sim() would be undone.
  s.craft.fc.armed = true;
  let maxAlt = -1e9, minAlt = 1e9, maxSpeed = 0, maxR = 0;
  let divergedAt = -1;
  const rows = [];
  for (const k of keys) s.input.key(k, true);
  for (let i = 0; i < PHYSICS_HZ * seconds; i++) {
    const t = i * DT;
    for (const [code, down] of (keys.when ? keys.when(t) : [])) {
      s.input.key(code, down);
    }
    s.step(DT);
    const b = s.craft.body;
    if (!Number.isFinite(b.pos.x) || !Number.isFinite(b.pos.y)
      || !Number.isFinite(b.pos.z) || !Number.isFinite(b.vel.y)) {
      divergedAt = t;
      break;
    }
    maxAlt = Math.max(maxAlt, b.pos.y);
    minAlt = Math.min(minAlt, b.pos.y);
    maxSpeed = Math.max(maxSpeed, Math.hypot(b.vel.x, b.vel.y, b.vel.z));
    maxR = Math.max(maxR, Math.hypot(b.pos.x, b.pos.z));
    if (i % Math.round(PHYSICS_HZ) === 0) {
      rows.push(`    t=${t.toFixed(0)}s alt ${b.pos.y.toFixed(1).padStart(8)} `
        + `spd ${Math.hypot(b.vel.x, b.vel.y, b.vel.z).toFixed(1).padStart(7)} m/s `
        + `range ${Math.hypot(b.pos.x, b.pos.z).toFixed(0).padStart(6)} m `
        + `roll ${attitudeOf(b.quat).roll.toFixed(1).padStart(7)}`);
    }
  }
  const bad = divergedAt >= 0
    ? `DIVERGED at t=${divergedAt.toFixed(2)}s`
    : `alt ${minAlt.toFixed(0)}..${maxAlt.toFixed(0)} m, peak ${maxSpeed.toFixed(0)} m/s, `
      + `range ${maxR.toFixed(0)} m`;
  console.log(`\n${name}: ${bad}`);
  rows.forEach((r) => console.log(r));
  return divergedAt >= 0;
}

let fails = 0;

console.log('=== flying, real key input ===');
// Centre-release throttle: holding Space ramps to FULL throttle.
if (fly('hold Space (full throttle)', ['Space'])) fails++;
if (fly('Space + pitch up', ['Space', 'ArrowUp'])) fails++;
if (fly('Space + pitch down', ['Space', 'ArrowDown'])) fails++;
if (fly('Space + roll right', ['Space', 'ArrowRight'])) fails++;
if (fly('Space + yaw', ['Space', 'KeyE'])) fails++;
if (fly('Space + roll + pitch', ['Space', 'ArrowRight', 'ArrowDown'])) fails++;
if (fly('pulsed throttle', Object.assign(['Space'], {
  when: (t) => [['Space', (t % 1) < 0.35]],
}))) fails++;
if (fly('stick flapping', Object.assign([], {
  when: (t) => [
    ['ArrowRight', Math.sin(t * 6) > 0],
    ['ArrowUp', Math.sin(t * 7) > 0],
  ],
}))) fails++;

console.log('\n=== the same, through real track geometry and bounds, from the ground ===');
for (const id of ['t-hangar', 't-rooftops', 't-suburb', 't-forest', 't-tower']) {
  if (fly(id + ' hold Space', ['Space'], 15, id, 0.08)) fails++;
}
if (fly('rooftops Space + pitch down',
  ['Space', 'ArrowDown'], 15, 't-rooftops', 0.08)) fails++;
if (fly('rooftops Space + roll into buildings',
  ['Space', 'ArrowRight'], 15, 't-rooftops', 0.08)) fails++;

console.log(`\n${fails === 0 ? 'every input held it together' : fails + ' input(s) diverged'}`);
process.exit(fails ? 1 : 0);