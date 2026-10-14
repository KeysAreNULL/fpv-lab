// Regression check: the flat-plate aero model must actually contribute.
//
// `applyAero` gates every surface on `s.active`, and nothing in the codebase
// used to set that flag. `undefined` is falsy, so every surface was skipped and
// craft.aeroDrag stayed at exactly 0 forever - with no error anywhere. This
// asserts the surfaces are live AND that they respond to incidence, so a future
// re-introduction of the silent gate fails here rather than in the physics.
import { buildCraft, analyseBuild } from '../src/sim/craft.js';

let fails = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`);
  else { console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); fails++; }
};

const spec = { frame: 'f-5-race', motor: 'm-2207', prop: 'p-hq43', esc: 'e-4a45',
  fc: 'fc-f7', rx: 'rx-elrs2', vtx: 'vt-caddx-hd', battery: 'b-6s1300-100' };

const craft = buildCraft(spec);

ok(craft.surfaces.length > 0, 'the build has aerodynamic surfaces', `${craft.surfaces.length}`);
ok(craft.surfaces.every((s) => s.active === true),
  'every surface is active (no undefined flag silently skipping it)',
  `${craft.surfaces.filter((s) => s.active).length}/${craft.surfaces.length}`);

console.log('\n--- the surfaces do real work ---');

// Directly exercise applyAero's output rather than inferring it from a flight.
const { RigidBody, applyAero } = await import('../src/sim/body.js');
const { Q_LEVEL } = await import('../src/sim/craft.js');
const RHO = 1.225;

// A body has to be posed with Q_LEVEL, not the identity quaternion: the frame is
// NED, so identity leaves the airframe rolled on its side and every flat plate
// broadside to the flow. That reads as enormous drag from nothing but the pose.
const levelBody = () => {
  const b = new RigidBody();
  b.quat = { x: Q_LEVEL.x, y: Q_LEVEL.y, z: Q_LEVEL.z, w: Q_LEVEL.w };
  // R is a *cached* matrix: toBody() reads R, not quat, so setting the
  // quaternion alone silently leaves the body in whatever pose R was built for.
  b.updateRotation();
  return b;
};

const aeroAt = (vel, pitchDeg = 0) => {
  const body = levelBody();
  if (pitchDeg) {
    // Yaw-free pitch about the world X axis, applied after levelling.
    const h = (pitchDeg * Math.PI) / 180 / 2;
    const s = Math.sin(h), c = Math.cos(h);
    const q = body.quat;
    body.quat = { x: q.w * s + q.x * c, y: q.y * c - q.z * s,
      z: q.z * c + q.y * s, w: q.w * c - q.x * s };
    body.updateRotation();
  }
  return applyAero(body, craft.surfaces, vel, RHO);
};

const still = aeroAt({ x: 0, y: 0, z: 0 });
ok(still.drag === 0, 'no airflow means no aero force', `drag ${still.drag.toFixed(4)} N`);

// Sideways at 20 m/s, level: the plates are edge-on, so this is the low case.
const level = aeroAt({ x: 0, y: 0, z: -20 });
ok(level.drag > 0, 'a level craft in a 20 m/s airflow feels drag',
  `drag ${level.drag.toFixed(2)} N`);
ok(level.drag < 6, 'that drag is plausible for a 5" quad at 20 m/s',
  `drag ${level.drag.toFixed(2)} N`);
ok(level.drag < 4, 'edge-on plates plus four prop discs stay under a few newtons',
  `drag ${level.drag.toFixed(2)} N`);

// Nose-up 45 deg: the plates turn broadside to the flow and drag climbs hard.
const noseUp = aeroAt({ x: 0, y: 0, z: -20 }, 45);
ok(noseUp.drag > level.drag * 1.4,
  'presenting the plate at 45 deg drags far more than edge-on',
  `${level.drag.toFixed(2)} N -> ${noseUp.drag.toFixed(2)} N`);

// Double the airspeed, roughly quadruple the force (q = 0.5*rho*v^2*A).
const fast = aeroAt({ x: 0, y: 0, z: -40 });
const ratio = fast.drag / level.drag;
ok(ratio > 3.4 && ratio < 4.6, 'drag scales with v^2', `x${ratio.toFixed(2)} for 2x airspeed`);

// Direction. A level craft's nose points along world -Z (frame.test.mjs asserts
// it). So air flowing toward -Z is a TAILWIND - it pushes the craft the way it
// is already pointing - and air flowing toward +Z is a HEADWIND that pushes back.
const tail = levelBody();
applyAero(tail, craft.surfaces, { x: 0, y: 0, z: -20 }, RHO);
ok(tail.force.z < 0, 'a tailwind pushes the craft forward, along its nose',
  `Fz ${tail.force.z.toFixed(2)} N (nose is -Z)`);
const head = levelBody();
applyAero(head, craft.surfaces, { x: 0, y: 0, z: 20 }, RHO);
ok(head.force.z > 0, 'a headwind pushes the craft back',
  `Fz ${head.force.z.toFixed(2)} N`);
ok(Math.abs(tail.force.z + head.force.z) < 1e-6, 'and they are equal and opposite', '');

// The regression that matters most: a falling craft must be slowed, not driven
// into the ground. Both the drag vector and the plate normal force used to point
// the wrong way, which gave a falling craft ~6x its own weight of downward force
// and sent it into an exponential blowup rather than a landing.
const faller = levelBody();
applyAero(faller, craft.surfaces, { x: 0, y: 20, z: 0 }, RHO);
const weight = craft.mass * 9.81;
ok(faller.force.y > 0, 'a falling craft is pushed UP by the airflow',
  `Fy ${faller.force.y.toFixed(2)} N vs weight ${weight.toFixed(2)} N`);

// The physical statement that actually constrains the model: a quad falling from
// a great height must reach a terminal velocity, not accelerate without bound.
// With the force directions inverted this reached several hundred m/s and then
// produced NaN.
{
  const { stepCraft } = await import('../src/sim/craft.js');
  const { Environment } = await import('../src/sim/environment.js');
  const { PHYSICS_HZ } = await import('../src/sim/sim.js');
  const env = new Environment({ tempC: 22, turbulence: 0 });
  env.windSpeed = 0; env.gust = 0;
  const dt = 1 / PHYSICS_HZ;
  const c = buildCraft(spec);
  c.body.pos.y = 3000;
  c.body.quat = { x: Q_LEVEL.x, y: Q_LEVEL.y, z: Q_LEVEL.z, w: Q_LEVEL.w };
  c.body.updateRotation();
  c.colliders = [];
  let v = 0;
  for (let i = 0; i < PHYSICS_HZ * 12; i++) {
    stepCraft(c, dt, env, { x: 0, y: 0, z: 0, throttle: 0 }, { runPID: (i % 2) === 0 });
    v = Math.abs(c.body.vel.y);
    if (!Number.isFinite(v)) break;
  }
  ok(Number.isFinite(v), 'a long fall never produces NaN', `v ${v.toFixed(1)} m/s`);
  ok(v > 3 && v < 30, 'and settles at a plausible terminal velocity',
    `${v.toFixed(1)} m/s`);
}

// A tilted plate under flow from below it must lift.
const tilt = (() => {
  const b = levelBody();
  const h = 20 * Math.PI / 180 / 2;
  const s = Math.sin(h), c = Math.cos(h);
  const q = b.quat;
  b.quat = { x: q.w * s + q.x * c, y: q.y * c - q.z * s,
    z: q.z * c + q.y * s, w: q.w * c - q.x * s };
  b.updateRotation();
  return b;
})();
applyAero(tilt, craft.surfaces, { x: 0, y: 14.14, z: -14.14 }, RHO);
ok(tilt.force.y > 0, 'a plate under flow from below it lifts',
  `Fy ${tilt.force.y.toFixed(2)} N`);

console.log(`\n${fails === 0 ? 'all aero checks passed' : fails + ' aero check(s) FAILED'}`);
process.exit(fails ? 1 : 0);