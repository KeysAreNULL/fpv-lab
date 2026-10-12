// Physics sanity tests. Run: node tests/physics.test.mjs
//
// These check the numbers a pilot would actually measure against published
// figures for the same hardware, so a regression in the prop, motor or battery
// model shows up as a failed number rather than as a build that quietly flies
// badly. Bounds are deliberately wide where real hardware varies a lot.

import { buildCraft, stepCraft, analyseBuild, attitudeOf } from '../src/sim/craft.js';
import { Environment } from '../src/sim/environment.js';
import { Battery } from '../src/sim/battery.js';
import { Prop } from '../src/sim/prop.js';
import { getPart, DEFAULTS } from '../src/data/catalog.js';
import { TRACKS } from '../src/data/tracks.js';
import { collideWorld } from '../src/sim/body.js';
import { RAD } from '../src/core/math.js';

let pass = 0, fail = 0;
const results = [];
function check(name, cond, info = '') {
  if (cond) { pass++; results.push(`  ok   ${name} ${info}`); }
  else { fail++; results.push(`  FAIL ${name} ${info}`); }
}
const freshProp = (id) => new Prop(getPart('prop', id));

/* ------------------------------------------------------------ prop sanity */
console.log('\n--- Prop aerodynamics ---');
{
  const p = freshProp('p-hq43');                    // 5x4.3x3
  p.solve(466, 0, 1.225, { aoa: 0, height: 99, speed: 0 });   // 27,960 rpm
  const T = p.thrust, P = p.power;
  // Published 5-inch figures at ~28k rpm: 1.2-1.5 kg static, 3.0-4.5 g/W.
  check('5x4.3x3 static thrust 1.0-1.7 kg', T > 9.8 && T < 16.7, `${(T / 9.80665).toFixed(2)} kg`);
  const gW = (T / 9.80665 * 1000) / P;
  check('5x4.3x3 efficiency 3.0-4.6 g/W', gW > 3.0 && gW < 4.6, `${gW.toFixed(2)} g/W, ${P.toFixed(0)} W`);

  p.solve(300, 0, 1.225, {});
  check('thrust rises with rpm', T > p.thrust * 2, `${p.thrust.toFixed(1)} N @18k -> ${T.toFixed(1)} N @28k`);

  // Density: a clean solve with no memory of the VRS test.
  const pd = freshProp('p-hq43');
  pd.solve(466, 0, 1.225, {});
  const ref = pd.thrust;
  pd.solve(466, 0, 0.9, {});
  check('thrust scales linearly with air density', Math.abs(pd.thrust / ref - 0.9 / 1.225) < 0.01,
    `ratio ${(pd.thrust / ref).toFixed(3)} vs expected ${(0.9 / 1.225).toFixed(3)}`);

  // Advance ratio: 20 m/s of air arriving at the disc (descending fast).
  pd.solve(466, 20, 1.225, {});
  check('advance ratio reduces thrust', pd.thrust < ref * 0.80,
    `static ${ref.toFixed(1)} N -> advancing ${pd.thrust.toFixed(1)} N`);
  check('advance ratio reduces power', pd.power < P, `static ${P.toFixed(0)} W -> advancing ${pd.power.toFixed(0)} W`);
  check('induced velocity rises with inflow', pd.Vdisc > pd.w,
    `disc ${pd.Vdisc.toFixed(2)} m/s vs induced ${pd.w.toFixed(2)} m/s`);

  // Ground effect.
  pd.solve(466, 0, 1.225, { height: 0.04 });
  check('ground effect adds thrust at 40 mm', pd.thrust > ref * 1.2,
    `${(ref / 9.80665).toFixed(2)} kg -> ${(pd.thrust / 9.80665).toFixed(2)} kg`);
  pd.solve(466, 0, 1.225, { height: 99 });
  check('ground effect vanishes far up', Math.abs(pd.thrust - ref) / ref < 1e-9);

  // Vortex ring state, on a fresh prop so no hysteresis carries over.
  const pv = freshProp('p-hq43');
  pv.solve(466, 0, 1.225, { aoa: 1.2, speed: 0.5, ring: 0.3 });
  check('vortex ring state collapses thrust', pv.thrust < ref * 0.6,
    `${(pv.thrust / 9.80665).toFixed(2)} kg vs static ${(ref / 9.80665).toFixed(2)} kg`);

  // Bigger props are more efficient per watt.
  const p10 = freshProp('p-10');
  p10.solve(70, 0, 1.225, {});
  const gW10 = (p10.thrust / 9.80665 * 1000) / p10.power;
  check('10" prop beats a 5" on g/W', gW10 > gW, `10" ${gW10.toFixed(2)} g/W vs 5" ${gW.toFixed(2)} g/W`);
}

/* --------------------------------------------------------- battery sanity */
console.log('\n--- Battery ---');
{
  const b = new Battery(getPart('battery', 'b-6s1300-100'), { soc: 1 });
  for (let i = 0; i < 400; i++) b.step(0.002, 60);
  check('60 A sag is 0.4-1.8 V on a 6S LiPo', b.sagVolts > 0.4 && b.sagVolts < 1.8,
    `${b.sagVolts.toFixed(2)} V sag, pack ${b.voltage.toFixed(2)} V, ${b.minCellV.toFixed(2)} V/cell`);
  check('heats under load', b.tempAvg > 24, `${b.tempAvg.toFixed(1)} C`);
  const vLoaded = b.voltage;
  for (let i = 0; i < 600; i++) b.step(0.002, 0);
  check('voltage recovers after the load is removed', b.voltage > vLoaded + 0.15,
    `${vLoaded.toFixed(2)} V -> ${b.voltage.toFixed(2)} V`);

  // LiPo cells have lower internal resistance than Li-ion, so a LiPo pack sags
  // less per amp. Li-ion buys cycle life and capacity retention instead.
  const li = new Battery(getPart('battery', 'b-6s1500-li'), { soc: 1 });
  const lipo = new Battery(getPart('battery', 'b-6s1300-100'), { soc: 1 });
  for (let i = 0; i < 300; i++) { li.step(0.002, 50); lipo.step(0.002, 50); }
  check('Li-po sags less than Li-ion at the same current', lipo.sagVolts < li.sagVolts,
    `Li-po ${lipo.sagVolts.toFixed(2)} V vs Li-ion ${li.sagVolts.toFixed(2)} V`);

  const liAged = new Battery(getPart('battery', 'b-6s2200-80'), { cycles: 300 });
  const liFresh = new Battery(getPart('battery', 'b-6s2200-80'), { cycles: 0 });
  check('Li-ion retains capacity at 300 cycles', liAged.usableAh / liFresh.usableAh > 0.75,
    `${(liAged.usableAh / liFresh.usableAh * 100).toFixed(0)} % left`);
  check('aged pack has higher ESR',
    liAged.cellResistance(0.5, 25) > liFresh.cellResistance(0.5, 25) * 1.3,
    `${(liAged.cellResistance(0.5, 25) / liFresh.cellResistance(0.5, 25)).toFixed(2)}x`);
  check('cold cells have much higher ESR',
    liFresh.cellResistance(0.5, -5) > liFresh.cellResistance(0.5, 25) * 1.3,
    `${(liFresh.cellResistance(0.5, -5) / liFresh.cellResistance(0.5, 25)).toFixed(2)}x at -5 C`);
  const lp = new Battery(getPart('battery', 'b-6s1300-100'), { soc: 0.5 });
  check('hot Li-po cells have higher ESR', lp.cellResistance(0.5, 75) > lp.cellResistance(0.5, 25),
    `${(lp.cellResistance(0.5, 75) / lp.cellResistance(0.5, 25)).toFixed(2)}x at 75 C`);

  const imb = new Battery(getPart('battery', 'b-6s1300-100'), { soc: 0.5 });
  for (let i = 0; i < 60; i++) imb.step(0.002, 30);
  check('pack reports a minimum cell below the average', imb.minCellV < imb.voltage / imb.cells,
    `min ${imb.minCellV.toFixed(2)} V vs avg ${(imb.voltage / imb.cells).toFixed(2)} V/cell`);

  const small = new Battery(getPart('battery', 'b-4s1500-100'), { soc: 1 });
  for (let i = 0; i < 50; i++) small.step(0.002, 400);
  check('an over-C request is refused, not served', small.currentLimited > 0.3,
    `limiter engaged at ${(small.currentLimited * 100).toFixed(0)} %`);
}

/* ------------------------------------------------------------ build stats */
console.log('\n--- Build analysis (stock 5" race, 6S 1300) ---');
const SPEC = { ...DEFAULTS, motorKvIndex: 0 };
// The prop hubs sit this far above the centre of mass on a 5-inch racer.
const SPEC_HUB_Z = -(getPart('frame', SPEC.frame).stackOffset.y / 1000 + getPart('motor', SPEC.motor).height__mm / 1000);
{
  const r = analyseBuild(SPEC);
  results.push(`  AUW ${(r.mass * 1000).toFixed(0)} g, T/W ${r.thrustRatio.toFixed(2)}:1,`
    + ` hover ${(r.hoverThrottle * 100).toFixed(0)}% @ ${r.hoverCurrent.toFixed(1)} A,`
    + ` ${r.hoverPowerW.toFixed(0)} W, ${r.gPerW.toFixed(2)} g/W,`
    + ` max ${r.maxCurrent.toFixed(0)} A, ${r.mixTime.toFixed(2)} min`);
  check('AUW 400-750 g for a 5" racer', r.mass * 1000 > 400 && r.mass * 1000 < 750,
    `${(r.mass * 1000).toFixed(0)} g`);
  check('thrust-to-weight 5-14', r.thrustRatio > 5 && r.thrustRatio < 14,
    `${r.thrustRatio.toFixed(2)}:1`);
  check('hover throttle 18-45%', r.hoverThrottle > 0.18 && r.hoverThrottle < 0.45,
    `${(r.hoverThrottle * 100).toFixed(0)} %`);
  check('hover current 10-30 A', r.hoverCurrent > 10 && r.hoverCurrent < 30,
    `${r.hoverCurrent.toFixed(1)} A`);
  check('hover efficiency 1.4-2.6 g/W', r.gPerW > 1.4 && r.gPerW < 2.6, `${r.gPerW.toFixed(2)} g/W`);
  check('mixed-throttle flight time 1.5-6 min', r.mixTime > 1.5 && r.mixTime < 6,
    `${r.mixTime.toFixed(2)} min`);
  check('no blocking warnings on a sane build', !r.warnings.some((w) => w.level === 'error'),
    r.warnings.map((w) => w.text).join(' | ') || 'none');
}

/* ------------------------------------------------ matching: KV and prop */
console.log('\n--- Motor / prop / pack matching ---');
{
  // Too much KV: hovers so low there is no throttle resolution left.
  const hot = analyseBuild({ ...SPEC, motorKvIndex: 2 });  // 2800 KV
  check('an over-KV motor warns about throttle resolution',
    hot.warnings.some((w) => /throttle/i.test(w.text)),
    hot.warnings.map((w) => w.text).join(' | ').slice(0, 110));
  check('higher KV hovers lower', hot.hoverThrottle < analyseBuild(SPEC).hoverThrottle * 0.75,
    `2800 KV hovers at ${(hot.hoverThrottle * 100).toFixed(1)} %`);
  // Bigger props: more thrust, more current, lower hover throttle.
  const big = analyseBuild({ ...SPEC, prop: 'p-hq55' });
  const small = analyseBuild({ ...SPEC, prop: 'p-racer5' });
  check('a steeper prop out-thrusts a shallow one', big.thrustRatio > small.thrustRatio,
    `5.5x3.5 ${big.thrustRatio.toFixed(2)}:1 vs 3.6 pitch ${small.thrustRatio.toFixed(2)}:1`);
  check('a steeper prop hovers lower', big.hoverThrottle < small.hoverThrottle,
    `${(big.hoverThrottle * 100).toFixed(0)} % vs ${(small.hoverThrottle * 100).toFixed(0)} %`);
  check('a shallow race prop is more efficient', small.gPerW > big.gPerW,
    `${small.gPerW.toFixed(2)} vs ${big.gPerW.toFixed(2)} g/W`);
  // Mismatched frame/motor mount must be caught.
  const bad = analyseBuild({ ...SPEC, frame: 'f-5-race', prop: 'p-7' });
  check('a 3" frame with 5" props is rejected',
    bad.warnings.some((w) => w.level === 'error' && /fit/i.test(w.text)),
    bad.warnings.filter((w) => w.level === 'error').map((w) => w.text).join(' | ').slice(0, 110));
}

/* ------------------------------------------------------------ propwash */
console.log('\n--- Propwash: surfaces, and why a flat quad has none of its own ---');
{
  const { RFWorld } = await import('../src/sim/rf.js');
  const dt = 1 / 8000;
  const hov = analyseBuild(SPEC).hoverThrottle;
  // The prop hubs sit this far above the centre of mass on a 5" racer.
  const hubAbove = -SPEC_HUB_Z;

  // Hold the craft at a fixed height with its attitude and velocity pinned, so
  // the only thing being measured is the effect of the nearby surface.
  const probe = (hubHeight, world) => {
    const env = new Environment({ turbulence: 0 });
    env.rfWorld = world || null;
    const c = buildCraft(SPEC, { env, physicsHz: 8000, pidDivisor: 1 });
    c.body.pos.y = hubHeight - hubAbove;
    c.fc.armed = true;
    const m = 1000 + 1000 * hov;
    for (let i = 0; i < 8000 * 0.7; i++) {
      c.body.vel = { x: 0, y: 0, z: 0 };
      c.body.omega = { x: 0, y: 0, z: 0 };
      c.body.updateRotation();
      c.fc.motors = [m, m, m, m];
      stepCraft(c, dt, env, { x: 0, y: 0, z: 0, throttle: hov }, { runPID: false });
    }
    return c;
  };

  const far = probe(40, null);
  results.push(`  open air: thrust ${far.thrust.toFixed(2)} N,`
    + ` ground effect x${far.groundEffect.toFixed(3)}, disturbed flow ${far.surfaceWash.toFixed(3)} m/s,`
    + ` mutual wash ${far.washIntensity.toFixed(5)} m/s`);
  check('mutual propwash is negligible on a coplanar quad', far.washIntensity < 0.02,
    `${far.washIntensity.toFixed(5)} m/s - and it must be: the offset between two coplanar`
    + ' props lies in the disc plane, so it stays perpendicular to the disc normal'
    + ' under any rigid rotation of the frame');
  check('no ground effect in open air', far.groundEffect < 1.01, `x${far.groundEffect.toFixed(3)}`);
  check('no disturbed flow in open air', far.surfaceWash < 0.05, `${far.surfaceWash.toFixed(4)} m/s`);

  // 3.5 cm of clearance under the props is roughly a quad sitting on its feet.
  const low = probe(0.035, null);
  const pct = (low.thrust / far.thrust - 1) * 100;
  results.push(`  3.5 cm off the deck: thrust ${low.thrust.toFixed(2)} N (+${pct.toFixed(0)} %),`
    + ` ground effect x${low.groundEffect.toFixed(2)}, disturbed flow ${low.surfaceWash.toFixed(2)} m/s`);
  check('ground effect is strong at 3.5 cm', low.groundEffect > 1.25, `x${low.groundEffect.toFixed(2)}`);
  check('bounced downwash produces disturbed flow', low.surfaceWash > 1.0,
    `${low.surfaceWash.toFixed(2)} m/s`);
  check('deck proximity adds 12-150 % thrust at the same throttle',
    pct > 12 && pct < 150, `+${pct.toFixed(0)} %`);

  // A ceiling is an image surface exactly like the ground: riding a roof line is
  // fast because the wake cannot expand downwards into it.
  const w = new RFWorld();
  w.addBox(0, 6, 0, 80, 0.4, 80, 'concrete');   // slab underside at y = 5.8
  const under = probe(5.77, w);
  results.push(`  3 cm under a concrete slab: clearance ${under.clearance.toFixed(2)} m,`
    + ` disturbed flow ${under.surfaceWash.toFixed(2)} m/s, ground effect x${under.groundEffect.toFixed(2)}`);
  check('the slab is detected as a nearby surface', under.clearance < 0.1,
    `${under.clearance.toFixed(3)} m to the slab`);
  check('a ceiling produces disturbed flow', under.surfaceWash > 1.0,
    `${under.surfaceWash.toFixed(2)} m/s`);
  check('a ceiling produces the same image ground effect as the deck',
    under.groundEffect > 1.25, `x${under.groundEffect.toFixed(2)}`);
  check('thrust under the ceiling is up', under.thrust > far.thrust * 1.25,
    `${under.thrust.toFixed(2)} N vs ${far.thrust.toFixed(2)} N open air`);
}

/* --------------------------------------------- closed-loop rate tracking */
console.log('\n--- Closed-loop rate tracking ---');
{
  const env = new Environment({ turbulence: 0 });
  const craft = buildCraft(SPEC, { env, physicsHz: 8000, pidDivisor: 1 });
  craft.body.pos.y = 10;
  craft.fc.armed = true;
  const hov = analyseBuild(SPEC).hoverThrottle;
  const dt = 1 / 8000;
  const run = (sec, sticks = {}) => {
    for (let i = 0; i < sec * 8000; i++) {
      stepCraft(craft, dt, env, { x: 0, y: 0, z: 0, throttle: hov, ...sticks }, { runPID: true });
    }
  };
  run(0.6);
  const sp0 = craft.fc.setpoint.x;
  run(0.15, { x: 0.6 });
  const sp1 = craft.fc.setpoint.x;
  const gr = craft.body.omega.x * RAD;
  results.push(`  roll stick 0.6 -> setpoint ${sp0.toFixed(0)} -> ${sp1.toFixed(0)} deg/s, gyro ${gr.toFixed(0)} deg/s`);
  check('roll setpoint scales with the stick', sp1 > sp0 * 2 && sp1 > 200, `${sp0.toFixed(0)} -> ${sp1.toFixed(0)}`);
  check('roll rate tracks the setpoint within 45 %',
    Math.abs(gr - sp1) < sp1 * 0.45, `gyro ${gr.toFixed(0)} vs sp ${sp1.toFixed(0)} deg/s`);
  check('craft is still airborne and sane', craft.body.pos.y > 5 && Number.isFinite(gr),
    `alt ${craft.body.pos.y.toFixed(1)} m`);
  check('hover current stays in a sane band', craft.currentA > 5 && craft.currentA < 80,
    `${craft.currentA.toFixed(1)} A at ${craft.battery.voltage.toFixed(1)} V`);

  // Voltage sag must be visible under load.
  const sag = craft.battery.sagVolts;
  check('pack sags under load', sag > 0.05, `${sag.toFixed(2)} V sag`);
}

/* --------------------------------------------------------- voltage sag */
console.log('\n--- Voltage sag and brownout ---');
{
  const env = new Environment({ turbulence: 0 });
  const craft = buildCraft({ ...SPEC, battery: 'b-4s1500-100' }, { env, physicsHz: 8000, pidDivisor: 1 });
  craft.body.pos.y = 10;
  craft.fc.armed = true;
  const hov = analyseBuild({ ...SPEC, battery: 'b-4s1500-100' }).hoverThrottle;
  const dt = 1 / 8000;
  for (let i = 0; i < 8000 * 2.5; i++) {
    stepCraft(craft, dt, env, { x: 0, y: 0, z: 0, throttle: hov }, { runPID: true });
  }
  check('4S pack under hover load sags measurably', craft.battery.sagVolts > 0.1,
    `${craft.battery.sagVolts.toFixed(2)} V, pack ${craft.battery.voltage.toFixed(2)} V`);
  check('4S hover is stable', Math.abs(craft.body.vel.y) < 2.0,
    `vy ${craft.body.vel.y.toFixed(2)} m/s, alt ${craft.body.pos.y.toFixed(1)} m`);
}

/* ------------------------------------------------------- world collision */
console.log('\n--- World collision ---');
{
  const mkBody = (x, y, z, vx, vy, vz) => ({
    pos: { x, y, z }, vel: { x: vx, y: vy, z: vz },
    omega: { x: 0, y: 0, z: 0 }, quat: { x: 0, y: 0, z: 0, w: 1 },
  });
  const R = 0.138;                    // collision radius of a 5" build

  // A thin slab is the hard case: the craft ends up *inside* the box, and a
  // naive shallowest-face push-out can fire it out through the far side. This
  // is exactly the hangar roof, and getting it wrong drops the craft through
  // the ceiling to the floor.
  const slab = { min: { x: -85, y: 9.10, z: -75 }, max: { x: 85, y: 9.50, z: 75 } };
  for (const vy of [-20, -3, -1, -0.5]) {
    const b = mkBody(0, 9.30, 0, 0, vy, 0);
    collideWorld(b, [slab], R, 0.3, 0.6);
    check(`falling into a thin slab ejects upward (vy ${vy})`,
      b.pos.y > slab.max.y, `y ${b.pos.y.toFixed(3)}, rest ${(slab.max.y + R).toFixed(3)}`);
  }
  const still = mkBody(0, 9.30, 0, 0, 0, 0);
  collideWorld(still, [slab], R, 0.3, 0.6);
  check('a stationary craft embedded in a slab rests on top of it',
    still.pos.y > slab.max.y, `y ${still.pos.y.toFixed(3)}`);
  const rising = mkBody(0, 9.30, 0, 0, 4, 0);
  collideWorld(rising, [slab], R, 0.3, 0.6);
  check('a craft moving up inside a slab is not launched out the bottom',
    rising.pos.y < slab.min.y, `y ${rising.pos.y.toFixed(3)}`);

  // A wall stops the craft at radius distance and reports the impact speed.
  const wall = { min: { x: -84.8, y: 0, z: -75 }, max: { x: -83.2, y: 9.2, z: 75 } };
  for (const v of [-4, -22, -60]) {
    const b = mkBody(wall.max.x + 0.05, 4, 0, v, 0, 0);
    const hit = collideWorld(b, [wall], R, 0.3, 0.6);
    check(`wall stops the craft dead at ${v} m/s`,
      Math.abs(b.pos.x - (wall.max.x + R)) < 1e-6 && b.vel.x > 0,
      `x ${b.pos.x.toFixed(3)}, rebound ${b.vel.x.toFixed(2)} m/s`);
    check(`wall records the impact speed at ${v} m/s`,
      hit != null && Math.abs(hit.impact - Math.abs(v)) < 1e-6, `${hit ? hit.impact.toFixed(1) : 'none'} m/s`);
  }

  // containInBounds is only a backstop. Where a track models its shell as
  // obstacles, the soft bound must sit outside that geometry - otherwise the
  // clamp drags a craft off the roof and back through the slab.
  for (const t of TRACKS) {
    if (!t.obstacles) continue;
    const roof = t.obstacles.find((o) => o.sy != null && o.y - o.sy / 2 > 6
      && o.sx > 100 && o.sz > 100);
    if (t.bounds.ceiling != null && roof) {
      const top = roof.y + roof.sy / 2;
      check(`${t.name}: soft ceiling clears the roof slab`,
        t.bounds.ceiling >= top, `ceiling ${t.bounds.ceiling}, slab top ${top.toFixed(2)}`);
    }
  }
}

/* ------------------------------------------------------------------ report */
console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
