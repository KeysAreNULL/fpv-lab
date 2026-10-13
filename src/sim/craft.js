// Craft assembly and the coupled physics solve.
//
// Body frame convention: aerospace NED, right-handed.
//   +X forward   +Y right   +Z down
//   omega.x = roll rate  (right wing down positive)
//   omega.y = pitch rate (nose up positive)
//   omega.z = yaw rate   (nose right positive)
// Thrust acts along -Z (up). Motor order is [FL, FR, RL, RR]; FL and RR turn
// counter-clockwise seen from above, FR and RL clockwise.
//
// Mixer signs fall out of r x F on this frame:
//   roll  right   -> more thrust on the LEFT motors
//   pitch nose-up -> more thrust on the FRONT motors
//   yaw   right   -> more thrust from the CCW props (FL, RR)
// (The intuitive "roll right = speed up the right motors" is wrong, and getting
// it backwards is the classic way to hand-fly a quad upside down.)
//
// One physics tick, in order:
//   1. wind, density
//   2. gyro sample, PID at the configured rate -> motor commands
//   3. prop wash iteration: each prop solves its own induced velocity and feeds
//      the others (2 passes, enough to converge the 4-body coupling)
//   4. motor electrical solve against the prop load
//   5. thrust, disc tilt, reaction torque, gyroscopic coupling
//   6. aerodynamic surfaces, ground contact
//   7. integrate

import {
  v3, clamp, qToEuler, RAD, DEG, InertiaBuilder, smoothstep, sign, approach,
  vdot, vcross, vnorm, m3mulVec, m3, m3set, m3ToQuat, qmul, qconj, q4,
} from '../core/math.js';
import { RigidBody, AeroSurface, applyAero, applyGroundContact, collideWorld, containInBounds }
  from './body.js';
import { Prop } from './prop.js';
import { Motor, ESC } from './motor.js';
import { FlightController, cloneTune, DEFAULT_TUNE } from './fc.js';
import { Battery, estimateFlightTime } from './battery.js';
import { getPart } from '../data/catalog.js';

export const MOTOR_POSITIONS = ['FL', 'FR', 'RL', 'RR'];
// +1 = counter-clockwise seen from above (angular momentum along body -Z)
export const MOTOR_SPIN = [1, -1, -1, 1];
// Body-frame thrust axis: "up" is -Z in this frame.
export const THRUST_AXIS = { x: 0, y: 0, z: -1 };
// Resting height of the centre of mass above the ground, in metres.
export const GEAR_HEIGHT = 0.052;

// The body frame is aerospace NED while the world is Y-up (the renderer
// convention), so identity is NOT level. R_LEVEL is the body->world rotation of
// a level craft: nose along world -Z, right along world +X, down along world -Y.
// Everything attitude-related is expressed relative to this, so a level craft has
// zero roll/pitch/yaw and body up maps to world up.
export const R_LEVEL = m3set(m3(), 0, 1, 0, 0, 0, -1, -1, 0, 0);
export const Q_LEVEL = m3ToQuat(R_LEVEL);
const QTMP = q4(), QTMP2 = q4();

/** Roll/pitch/yaw of the craft relative to level, in radians. */
export function attitudeOf(quat, out = {}) {
  // R_att = R_LEVEL^T * R  ->  q_att = conj(Q_LEVEL) * q
  qconj(Q_LEVEL, QTMP);
  qmul(QTMP, quat, QTMP2);
  return qToEuler(QTMP2, out);
}

/**
 * Build a craft from a spec.
 * @param {object} spec {frame, motor, prop, esc, fc, rx, vtx, battery, motorKvIndex}
 * @param {object} opts {tune, batteryState, env, rc}
 */
export function buildCraft(spec, opts = {}) {
  const frame = getPart('frame', spec.frame);
  const motorSpec = getPart('motor', spec.motor);
  const propSpec = getPart('prop', spec.prop);
  const escSpec = getPart('esc', spec.esc);
  const fcSpec = getPart('fc', spec.fc);
  const rxSpec = getPart('rx', spec.rx);
  const vtxSpec = getPart('vtx', spec.vtx);
  const battSpec = getPart('battery', spec.battery);

  const body = new RigidBody();
  const builder = new InertiaBuilder();
  const rho = 1.225;

  /* ------------------------------------------------------------ geometry */
  // True-X: motors at 45 degrees to the flight axes. FL/FR are forward (+X),
  // FL/RL are left (-Y).
  const a = frame.wheelbase__mm / 1000 / (2 * Math.SQRT2); // 45-degree arm offset
  const hubZ = -(frame.stackOffset.y / 1000 + frame.motorHeight__mm / 1000);
  const hubs = [
    { x: a, y: -a, z: hubZ },   // FL
    { x: a, y: a, z: hubZ },    // FR
    { x: -a, y: -a, z: hubZ },  // RL
    { x: -a, y: a, z: hubZ },   // RR
  ];

  /* --------------------------------------------------------------- mass */
  const parts = [];
  const addPart = (name, massG, pos, type = 'box', dims = null, axis = 'y') => {
    parts.push({ name, mass: massG / 1000, pos });
    builder.add(massG / 1000, pos, type, dims, axis);
  };

  // Frame plates: bottom + top, separated by the stack height.
  const plateArea = frame.plateArea__cm2 / 1e4;   // m^2
  const plateSide = Math.sqrt(plateArea);
  const bottomZ = 0;
  const topZ = -frame.stackHeight__mm / 1000;   // negative = above, since +Z is down
  addPart('frame plates', frame.mass__m * 0.62, { x: 0, y: 0, z: (bottomZ + topZ) / 2 }, 'box',
    [plateSide, plateSide, Math.abs(topZ - bottomZ)]);

  // Arms: from the centre out to each motor.
  const armLen = frame.armLength__mm / 1000;
  const armW = 0.010;
  for (let i = 0; i < 4; i++) {
    const h = hubs[i];
    const r = Math.hypot(h.x, h.y);
    addPart('arm', frame.mass__m * 0.38 / 4,
      { x: h.x / 2, y: h.y / 2, z: hubZ * 0.55 }, 'box', [r * 1.0, armW, armW]);
  }

  // Stack: ESC + FC + RX, sitting on top of the bottom plate.
  const stackMass = escSpec.mass__m + fcSpec.mass__m + rxSpec.mass__m;
  addPart('stack', stackMass, { x: 0.02, y: 0, z: topZ - 0.006 }, 'box', [0.032, 0.032, 0.014]);

  // Camera / VTX at the front
  addPart('camera', vtxSpec.mass__m, { x: 0.024, y: 0, z: topZ - 0.022 }, 'box', [0.016, 0.019, 0.019]);
  // Antenna: a duck antenna leaning back at 45 degrees.
  addPart('antenna', 1.4, { x: -0.048, y: 0, z: topZ - 0.045 }, 'box', [0.030, 0.006, 0.042]);

  // Motors
  const mR = motorSpec.stator / 1000 * 0.72;
  const mH = motorSpec.height__mm / 1000;
  for (let i = 0; i < 4; i++) {
    addPart('motor', motorSpec.mass__m,
      { x: hubs[i].x, y: hubs[i].y, z: hubs[i].z - mH / 2 }, 'cyl', [mR, mH], 'z');
  }
  // Props
  for (let i = 0; i < 4; i++) {
    addPart('prop', propSpec.mass__m,
      { x: hubs[i].x, y: hubs[i].y, z: hubs[i].z - mH - 0.004 }, 'box',
      [propSpec.D__mm / 1000, propSpec.D__mm / 1000, 0.003]);
  }
  // Battery, strapped on top of the bottom plate (z is positive downwards from
  // the frame, so the pack sits at +z relative to the plates).
  const battLen = 0.075, battW = 0.038, battH = Math.max(0.028, battSpec.cells * 0.0105);
  addPart('battery', battSpec.mass__m,
    { x: battSpec.cells >= 6 ? 0.010 : 0.004, y: 0, z: battH / 2 + 0.004 }, 'box',
    [battLen, battW, battH]);

  const { I, mass, com } = builder.aboutCOM();
  body.setMassProperties(mass, I);
  body.pos.y = 0.08;
  body.quat = { x: Q_LEVEL.x, y: Q_LEVEL.y, z: Q_LEVEL.z, w: Q_LEVEL.w };

  /* ----------------------------------------------------------- subsystems */
  const kvIndex = spec.motorKvIndex || 0;
  const motors = [0, 1, 2, 3].map(() => new Motor(motorSpec, kvIndex, { bidirectional: true }));
  const props = [0, 1, 2, 3].map(() => new Prop(propSpec));
  const esc = new ESC(escSpec);
  const physicsHz = opts.physicsHz || 5000;
  const pidDivisor = opts.pidDivisor || 2;
  const fc = new FlightController(fcSpec, cloneTune(opts.tune || DEFAULT_TUNE), {
    pidDivisor, gyroRate: physicsHz, pidHz: physicsHz / pidDivisor,
  });
  const battery = new Battery(battSpec, opts.batteryState || {});
  const rc = { x: 0, y: 0, z: 0, throttle: 0 };

  for (let i = 0; i < 4; i++) {
    props[i].axis = MOTOR_SPIN[i];
    motors[i].setPropInertia(props[i].Irotor);
    props[i].propPos = hubs[i];
    props[i].discArea = props[i].A;
    props[i].motorIndex = i;
  }

  /* ---------------------------------------------------------- aero surfaces */
  const surfaces = [];
  const DOWN = THRUST_AXIS;   // plate normal points down, i.e. -Z
  // bottom plate (the big one)
  surfaces.push(new AeroSurface({
    pos: { x: 0, y: 0, z: bottomZ }, normal: { ...DOWN },
    area: plateArea, cd0: 0.035, clSlope: 1.55, type: 'plate', name: 'plate',
  }));
  // top plate / canopy
  surfaces.push(new AeroSurface({
    pos: { x: 0, y: 0, z: topZ }, normal: { ...DOWN },
    area: plateArea * 0.55, cd0: 0.05, clSlope: 1.1, type: 'plate', name: 'top plate',
  }));
  // arms
  for (let i = 0; i < 4; i++) {
    surfaces.push(new AeroSurface({
      pos: { x: hubs[i].x / 2, y: hubs[i].y / 2, z: hubZ * 0.55 },
      normal: { ...DOWN },
      area: armLen * armW * 1.5, cd0: 0.02, clSlope: 0.9, type: 'arm', name: 'arm',
    }));
  }
  // prop discs
  for (let i = 0; i < 4; i++) {
    surfaces.push(new AeroSurface({
      pos: hubs[i], normal: { ...DOWN },
      area: props[i].A, cd0: 0.10, clSlope: 1.5, type: 'disc', name: `disc${i}`,
    }));
  }
  // stack / camera bump
  surfaces.push(new AeroSurface({
    pos: { x: 0.01, y: 0, z: topZ - 0.02 }, normal: { ...DOWN },
    area: 0.0016, cd0: 0.5, clSlope: 0.8, type: 'canopy', name: 'stack',
  }));

  const craft = {
    spec: { ...spec },
    frame, motor: motorSpec, prop: propSpec, esc: escSpec, fc: fcSpec, rx: rxSpec,
    vtx: vtxSpec, battSpec,
    body, motors, props, esc, fc, battery, surfaces, rc,
    env: opts.env || null,
    tune: fc.tune,
    // cached analysis, refreshed by analyse()
    auw: mass, thrustRatio: 0, hoverThrottle: 0, hoverCurrentA: 0,
    maxThrust: 0, maxCurrentA: 0, flightTime: 0,
    // telemetry
    thrust: 0, torqueTotal: 0, aeroDrag: 0, aoa: 0, washIntensity: 0,
    vtxConfig: opts.vtxConfig || null, rxConfig: opts.rxConfig || null,
    events: [],
  };
  craft.mass = mass;
  craft.com = com;
  craft.pidDivisorEffective = pidDivisor;
  craft.physicsHz = physicsHz;
  craft.currentA = 0;
  craft.thrustVector = v3();
  // Collision: the props reach out to the hub distance plus a prop radius, and
  // the hub distance is the full diagonal offset (hubs sit at 45 degrees, so it
  // is the offset times sqrt(2), not the offset itself). Using the offset alone
  // made the sphere 3-4 cm smaller than the airframe, so a craft visibly drove
  // its props through a wall before anything stopped it - which is the opposite
  // of what the prop-strike model claims.
  craft.propTipRadius = Math.hypot(hubs[0].x, hubs[0].y) + propSpec.D__mm / 2000;
  craft.collisionRadius = craft.propTipRadius;
  craft.colliders = opts.colliders || [];
  craft.propStrike = 0;
  body.updateRotation();
  return craft;
}

/* ---------------------------------------------------------------- the solve */

/**
 * Advance the craft by one physics tick.
 * @param dt      seconds
 * @param env     Environment
 * @param sticks  {x,y,z,throttle}
 * @param opts    {runPID, desyncScale}
 */
export function stepCraft(craft, dt, env, sticks, opts = {}) {
  const body = craft.body;
  const { motors, props, fc, esc, battery } = craft;
  const rho = env ? env.density : 1.225;
  const time = env ? env.time : 0;
  const windPos = v3();

  /* ---------------------------------------------------- 1. wind and density */
  const wind = env
    ? env.windAt(body.pos, time, windPos)
    : { x: 0, y: 0, z: 0 };
  const windB = body.toBody(wind, { x: 0, y: 0, z: 0 });

  /* ------------------------------------------------ 2. gyro sample and PID */
  // Gyro runs at the physics rate; the PID loop divides it down.
  // Bounced downwash also adds gyro noise, on top of any ESC desync.
  const buffetNoise = Math.min(0.6, (craft.surfaceWash || 0) * 0.055);
  const desync = Math.min(1.4, Math.max(...motors.map((m) => m.desync)) * (opts.desyncScale || 1)
    + buffetNoise);
  fc.sampleGyro(dt, body.omega, body.accel, desync);

  if (opts.runPID) {
    const euler = attitudeOf(body.quat);
    fc.attitude = euler;
    const throttle = fc.brownout ? 0 : clamp(sticks.throttle, 0, 1);
    const s = fc.armed
      ? { x: clamp(sticks.x, -1, 1), y: clamp(sticks.y, -1, 1), z: clamp(sticks.z, -1, 1), throttle }
      : { x: 0, y: 0, z: 0, throttle: 0 };
    const out = fc.runPID(dt * craft.pidDivisorEffective, s, euler, {});
    // Impact detection drives anti-gravity.
    const g = Math.hypot(fc.accel.x, fc.accel.y, fc.accel.z);
    const impact = clamp((g - 2.2) / 6, 0, 1);
    fc.antiGravityGain = approach(fc.antiGravityGain, fc.tune.antiGravity ? impact : 0, dt * 10);
    craft.throttleOut = fc.throttleOut / 1000;
  } else {
    craft.throttleOut = (opts.motorCommands || motors.map(() => 0));
  }

  // Motor commands (1000..2000) -> duty 0..1
  const commands = fc.motors;
  const tRange = fc.tune.maxThrottle - fc.tune.minThrottle;
  const duties = [0, 0, 0, 0].map((_, i) => clamp((commands[i] - fc.tune.minThrottle) / tRange, 0, 1));

  /* --------------------------------------------- 3. prop hub kinematics */
  const hubWorld = props.map((p) => body.pointVelocityWorld(p.propPos, { x: 0, y: 0, z: 0 }));
  const hubPos = props.map((p) => body.pointToWorld(p.propPos, { x: 0, y: 0, z: 0 }));
  const speed = Math.hypot(body.vel.x - wind.x, body.vel.y - wind.y, body.vel.z - wind.z);
  // Angle of attack of the disc plane relative to the relative wind.
  const aoa = Math.abs(Math.asin(clamp(
    (body.vel.x - wind.x) * body.R[2] + (body.vel.y - wind.y) * body.R[5]
    + (body.vel.z - wind.z) * body.R[8], -1, 1)));

  // Airflow seen by each hub, in the body frame: hub velocity minus wind.
  // The disc axis is body -Z, so axial inflow is minus the z component:
  // descending (body -Z velocity) gives u > 0, as it must.
  const relBody = hubWorld.map((v) => body.toBody(
    { x: v.x - wind.x, y: v.y - wind.y, z: v.z - wind.z }, { x: 0, y: 0, z: 0 }));
  const baseU = relBody.map((v) => -v.z);

  /* ---------------------------------------------------- 4. wash iteration */
  const axisW = body.toWorld(THRUST_AXIS, { x: 0, y: 0, z: 0 });
  const wash = props.map(() => ({ u: 0, t: 0, from: 0 }));
  let washIntensity = 0;
  let surfaceWash = 0;
  let groundEffect = 0;
  const altitudeFactor = clamp(1 + (env ? env.altitudeM : 0) / 8500, 0.6, 1.3);

  // Clearance to the nearest surface above and below each prop. This is the
  // propwash that actually matters in FPV: the wake cannot expand near a deck,
  // a wall or a ceiling, so the same rotor makes more thrust - and the bounced
  // flow arrives turbulent, so the craft gets buffeted while it does it.
  const clr = [0, 0, 0, 0].map((_, i) =>
    (env ? env.clearanceAt(hubPos[i], axisW) : { down: -hubPos[i].y, up: Infinity, min: -hubPos[i].y }));
  const clearDown = clr.map((c) => Number.isFinite(c.down) ? c.down : 99);
  const clearMin = clr.map((c) => Number.isFinite(c.min) ? c.min : 99);

  for (let pass = 0; pass < 3; pass++) {
    // solve each prop with the current wake estimate. Ground effect uses the
    // nearest surface on either side, because a ceiling is an image surface
    // exactly like the ground is.
    for (let i = 0; i < 4; i++) {
      const p = props[i];
      const u = baseU[i] + wash[i].u;
      p.solve(motors[i].omega / (2 * Math.PI), u, rho,
        { aoa, height: clearMin[i], speed, altitudeFactor });
    }
    // recompute wake contributions for the next pass
    for (let i = 0; i < 4; i++) wash[i] = { u: 0, t: 0, from: 0 };
    for (let j = 0; j < 4; j++) {
      const src = props[j];
      if (src.n < 1) continue;
      for (let i = 0; i < 4; i++) {
        if (i === j) continue;
        const off = {
          x: hubPos[i].x - hubPos[j].x,
          y: hubPos[i].y - hubPos[j].y,
          z: hubPos[i].z - hubPos[j].z,
        };
        const w = src.wakeAt(off, axisW, rho, WKTMP);
        if (!w.hit) continue;
        const inc = w.axial + w.tangential;
        wash[i].u += inc;
        wash[i].from++;
        if (inc > washIntensity) washIntensity = inc;
      }
    }
  }
  craft.washIntensity = washIntensity;
  // Disturbed-flow intensity from bounced downwash: this drives the buffet, not
  // a steady thrust gain. Ground effect already provides the thrust gain.
  for (let i = 0; i < 4; i++) {
    props[i].washFrom = wash[i].from;
    surfaceWash = Math.max(surfaceWash,
      props[i].w * Math.exp(-clearMin[i] / (props[i].D * 1.1)));
    groundEffect += props[i].geFactor;
  }
  craft.surfaceWash = surfaceWash;
  craft.groundEffect = groundEffect / 4;
  craft.clearance = Math.min(...clearMin);

  /* ------------------------------------------------ 5. motor electrical solve */
  const vBatt = battery.voltage;
  esc.step(dt, Math.max(...motors.map((m) => m.current)) * 4);
  let totalCurrent = 0;
  const prevOmega = motors.map((m) => m.omega);
  for (let i = 0; i < 4; i++) {
    const p = props[i];
    const u = baseU[i] + wash[i].u;
    const idx = i;
    const torqueAt = (n) => {
      p.solve(n, u, rho, { aoa, height: clearMin[i], speed, altitudeFactor });
      return p.torque;
    };
    motors[i].step(dt, duties[i], vBatt, torqueAt, esc);
    totalCurrent += motors[i].current;
  }
  // one more prop pass so the reported thrust matches the final RPM
  for (let i = 0; i < 4; i++) {
    const p = props[i];
    p.solve(motors[i].omega / (2 * Math.PI), baseU[i] + wash[i].u, rho,
      { aoa, height: clearMin[i], speed, altitudeFactor });
    props[i].axis = MOTOR_SPIN[i];
  }

  /* ------------------------------------------ 6. forces and torques */
  let thrust = 0;
  const axisBody = THRUST_AXIS;
  let washSum = 0;
  for (let i = 0; i < 4; i++) {
    const p = props[i];
    thrust += p.thrust;
    washSum += p.washFrom > 0 ? 1 : 0;

    // Disc tilt from blade flapping: the disc turns to present a lower angle of
    // attack to the relative wind, which is what makes a quad want to align
    // with the airflow (and what makes it draggy when it is tilted).
    const rel = relBody[i];
    const tang = Math.hypot(rel.x, rel.y);
    const vTip = Math.max(1, p.tipSpeed);
    const tilt = clamp(Math.atan2(tang, vTip), 0, 0.30);
    // Base thrust axis is body -Z (up); tilt it in the direction of the
    // tangential flow so the leading edge drops into the relative wind.
    const tiltX = tang > 1e-6 ? rel.x / tang * tilt : 0;
    const tiltY = tang > 1e-6 ? rel.y / tang * tilt : 0;
    const thrustAxis = { x: tiltX, y: tiltY, z: -1 };
    const tn = Math.hypot(thrustAxis.x, thrustAxis.y, thrustAxis.z);
    thrustAxis.x /= tn; thrustAxis.y /= tn; thrustAxis.z /= tn;
    p.thrustAxis = thrustAxis;

    // Thrust along the tilted axis, applied at the hub.
    const T = p.thrust;
    body.addForceAtBody({ x: thrustAxis.x * T, y: thrustAxis.y * T, z: thrustAxis.z * T }, p.propPos);
    // Axial profile drag along the relative flow (small, but real).
    const relLen = Math.hypot(rel.x, rel.y, rel.z);
    if (relLen > 1e-4 && p.power > 0) {
      const pd = p.power / (2 * Math.PI * Math.max(1, p.n) * p.D * 0.5);
      body.addForceAtBody(
        { x: -rel.x / relLen * pd, y: -rel.y / relLen * pd, z: -rel.z / relLen * pd }, p.propPos);
    }
    p.thrustAxisWorld = body.toWorld(thrustAxis, { x: 0, y: 0, z: 0 });

    // Reaction torque from the prop shaft, about the spin axis (body -Z for a
    // counter-clockwise prop, so the frame feels +axis * Q about +Z).
    body.addTorqueBody({ x: 0, y: 0, z: p.axis * p.torque });
    // Gyroscopic coupling: torque = -omega x L, with L along body -axis*Z.
    const L = p.Irotor * p.n * p.axis;
    body.addTorqueBody({ x: -body.omega.y * L, y: body.omega.x * L, z: 0 });
  }
  craft.thrust = thrust;
  craft.thrustVector.x = 0; craft.thrustVector.y = 0; craft.thrustVector.z = -thrust;

  /* ------------------------------------- 7. aerodynamic surfaces */
  const relWind = { x: wind.x - body.vel.x, y: wind.y - body.vel.y, z: wind.z - body.vel.z };
  const aero = applyAero(body, craft.surfaces, relWind, rho);
  craft.aeroDrag = aero.drag;
  craft.aoa = aero.aoa;

  // --- surface buffet: bounced downwash and its wake turbulence shake the craft
  // when it flies close to a deck, a wall or a roof. This is the reason a fast
  // low line feels nervous, and it feeds the gyro noise the PID has to filter.
  if (surfaceWash > 0.15) {
    const amp = surfaceWash * 0.055;
    const t = time;
    body.addForceBody({
      x: amp * Math.sin(t * 61.3) + amp * 0.6 * Math.sin(t * 143.7),
      y: amp * 0.7 * Math.sin(t * 83.1),
      z: amp * Math.sin(t * 52.7) + amp * 0.5 * Math.sin(t * 167.3),
    });
    body.addTorqueBody({
      x: amp * 0.09 * Math.sin(t * 97.3),
      y: amp * 0.09 * Math.sin(t * 71.9),
      z: amp * 0.06 * Math.sin(t * 113.1),
    });
  }

  /* ------------------------------------- 8. battery */
  battery.step(dt, totalCurrent);
  fc.setBattery(battery.voltage, totalCurrent, battery.sagVolts);
  craft.currentA = totalCurrent;

  /* ------------------------------------- 9. ground, walls and integrate */
  // A quad rests on its legs with the centre of mass a few centimetres up, so
  // the effective contact plane sits above the origin by the gear height.
  applyGroundContact(body, (env ? env.groundY : 0) + GEAR_HEIGHT, 0.12, 0.8, 1400, 60);
  body.step(dt, true);

  // --- walls: the props stick out, so the collision radius is the frame's own
  // half-span plus the prop. Hitting a wall at speed is how most races end.
  craft.impact = null;
  const hit = collideWorld(body, craft.colliders, craft.collisionRadius, 0.3, 0.6);
  if (hit) {
    craft.impact = hit;
    // A prop strike above about 6 m/s is a broken arm and a hole in the frame.
    const severity = hit.impact;
    craft.propStrike = Math.max(severity, (craft.propStrike || 0) - dt * 8);
    if (severity > 6) {
      body.omega.x += (Math.random() - 0.5) * severity * 0.9;
      body.omega.z += (Math.random() - 0.5) * severity * 0.9;
      if (craft.onImpact) craft.onImpact(severity);
    }
  } else {
    // Fade the last strike instead of keeping it for the rest of the session:
    // it is only ever read as "how bad was the last one", and a value that
    // never decays re-reports a single crash for ever.
    craft.propStrike = Math.max(0, (craft.propStrike || 0) - dt * 8);
  }
  const wall = containInBounds(body, env && env.bounds, craft.collisionRadius * 0.6);
  if (wall > 3) craft.propStrike = Math.max(craft.propStrike || 0, wall * 0.6);

  craft.stats = {
    rpm: motors.map((m) => m.RPM),
    current: totalCurrent,
    voltage: battery.voltage,
    thrust,
    motorTemp: motors.map((m) => m.tempC),
    escTemp: esc.tempC,
    battTemp: battery.tempAvg,
    sag: battery.sagVolts,
    soc: battery.soc,
    minCell: battery.minCellV,
    wash: washIntensity,
    surfaceWash,
    clearance: craft.clearance,
    groundEffect: craft.groundEffect,
  };
  craft.failsafe = fc.failsafe;
  craft.brownout = fc.brownout;
  return craft;
}
const WKTMP = {};

/* -------------------------------------------------- static build analysis */

/**
 * Work out the numbers a pilot actually cares about: AUW, thrust to weight,
 * hover throttle, hover and max current, flight time, and whether the build
 * makes sense (props too big for the frame, ESC too small, motor too weak).
 */
export function analyseBuild(spec, opts = {}) {
  const craft = buildCraft(spec, opts);
  const { props, motors, battery, esc } = craft;
  const rho = opts.density || 1.225;
  const battV = battery.cells * (battery.chemistry === 'LiPo' ? 3.85 : 3.70);
  const mm = craft.mass;
  const g = 9.80665;

  const torqueAt = (p) => (n) => { p.solve(n, 0, rho, { aoa: 0, height: 99, speed: 0 }); return p.torque; };

  // Full throttle
  const full = motors.map((m, i) =>
    m.steadyState(1, battV, torqueAt(props[i]), { resistance: esc.resistance, maxContA: esc.maxContA }));

  // Find the duty that holds the AUW up (bisect on total thrust).
  // NB: steadyState reports both rpm and rev/s; the prop solver wants rev/s.
  const thrustAt = (duty) => {
    let T = 0, I = 0;
    for (let i = 0; i < 4; i++) {
      const r = motors[i].steadyState(duty, battV, torqueAt(props[i]),
        { resistance: esc.resistance, maxContA: esc.maxContA });
      props[i].solve(r.rps, 0, rho, { aoa: 0, height: 99, speed: 0 });
      T += props[i].thrust; I += r.current;
    }
    return { T, I };
  };
  let lo = 0, hi = 1, hover = null;
  for (let k = 0; k < 26; k++) {
    const mid = (lo + hi) / 2;
    const r = thrustAt(mid);
    if (r.T < mm * g) lo = mid; else { hi = mid; hover = r; }
  }
  if (!hover) hover = thrustAt(1);

  const hoverPowerW = hover.I * battV;
  const maxCurrent = full.reduce((a, r) => a + r.current, 0);
  const fullThrust = (() => {
    let T = 0;
    for (let i = 0; i < 4; i++) { props[i].solve(full[i].rps, 0, rho, {}); T += props[i].thrust; }
    return T;
  })();

  const packWh = battery.ratedWh;
  const hoverTime = hoverPowerW > 0 ? (packWh / hoverPowerW) * 60 : 0;
  // Publish the currents before estimating flight time, because the estimate
  // mixes hover and punch current rather than using hover alone.
  craft.hoverCurrentA = hover.I;
  craft.maxCurrentA = maxCurrent;
  const mixTime = estimateFlightTime(craft,
    { avgV: battV / battery.cells, aggression: 0.75 });
  // Thrust to power at hover: the number that decides how long a pack lasts.
  // Mass is in kg, so multiply by 1000 to get grams per watt.
  const gPerW = hoverPowerW > 0 ? (mm * 1000) / hoverPowerW : 0;

  const result = {
    mass: mm,
    auwOz: mm * 1000 * 0.035274,
    thrustRatio: fullThrust / (mm * g),
    hoverThrottle: hi,
    hoverCurrent: hover.I,
    hoverPowerW,
    hoverRPM: [0, 1, 2, 3].map((i) => motors[i].steadyState(hi, battV, torqueAt(props[i]),
      { resistance: esc.resistance, maxContA: esc.maxContA }).rpm),
    maxCurrent,
    maxThrust: fullThrust,
    maxPowerW: maxCurrent * battV,
    gPerW,
    packWh,
    hoverTime,
    mixTime: mixTime.time,
    mixCurrent: mixTime.avgCurrent,
    motorLoading: motors.map((m, i) => (full[i].power / motors[i].maxPowerW)),
    propTipSpeed: props.map((p) => p.solve(full[0].rps, 0, rho, {}).tipSpeed),
    eff: props[0].solve(full[0].rps * 0.75, 0, rho, {}).eff,
    result: { full, hover },
  };
  result.warnings = analyseWarnings(spec, craft, result);
  craft.analysis = result;
  craft.hoverCurrentA = hover.I;
  craft.maxCurrentA = maxCurrent;
  craft.thrustRatio = result.thrustRatio;
  craft.hoverThrottle = hi;
  craft.flightTime = mixTime.time;
  return result;
}

function analyseWarnings(spec, craft, m) {
  const w = [];
  const { frame, prop, motor, esc, battery, fc } = craft;
  const motorList = craft.motors;

  if (prop.D__mm > frame.propMax__mm) {
    w.push({ level: 'error', text: `${prop.name} (${prop.D__mm} mm) does not fit the ${frame.name} arms (max ${frame.propMax__mm} mm).` });
  } else if (prop.D__mm > frame.propMax__mm * 0.97) {
    w.push({ level: 'warn', text: `${prop.name} is at the absolute limit for this frame. No propwash margin.` });
  } else if (prop.D__mm < frame.propMax__mm * 0.55) {
    // Legal, but almost nobody flies a 3" prop on a 10" frame, and the numbers
    // below will show it immediately. Worth saying out loud.
    w.push({ level: 'warn', text: `${prop.name} is very small for the ${frame.name}. `
      + `Check the thrust-to-weight: it is the props, not the frame, that are short of thrust.` });
  }
  if (motor.mount !== frame.motorMount) {
    w.push({ level: 'error', text: `Motor mount mismatch: ${motor.name} is ${motor.mount}, frame is ${frame.motorMount}.` });
  }
  if (battery.cells < esc.vMin || battery.cells > esc.vMax) {
    w.push({ level: 'error', text: `Battery is ${battery.cells}S, ESC supports ${esc.vMin}-${esc.vMax}S.` });
  }
  if (m.maxCurrent > esc.maxContA * 4) {
    w.push({ level: 'warn', text: `Full throttle draws ~${m.maxCurrent.toFixed(0)} A across four ESCs,` 
      + ` over the ${esc.maxContA} A per-channel rating. Punches will be current-limited.` });
  }
  if (m.maxCurrent > battery.maxCurrentA) {
    w.push({ level: 'warn', text: `Pack C-rating caps at ${battery.maxCurrentA.toFixed(0)} A; the build wants ~${m.maxCurrent.toFixed(0)} A.` });
  }
  if (m.result && motorList.some((mo, i) => (m.result.full[i].power / mo.maxPowerW) > 1)) {
    w.push({ level: 'error', text: 'Motor is over its rated power at full throttle. It will overheat within seconds.' });
  }
  if (m.thrustRatio < 1.9) {
    // Below about 1.6:1 a quad cannot hold itself up in any useful sense.
    w.push({ level: m.thrustRatio < 1.6 ? 'error' : 'warn',
      text: m.thrustRatio < 1.6
        ? `Thrust-to-weight is ${m.thrustRatio.toFixed(2)}:1 - this cannot fly. `
          + `It needs a bigger prop, a lower-KV motor or a lighter frame.`
        : `Thrust-to-weight is only ${m.thrustRatio.toFixed(2)}:1. Sluggish in a punch.` });
  } else if (m.thrustRatio > 13) {
    w.push({ level: 'info', text: `Very high thrust-to-weight (${m.thrustRatio.toFixed(1)}:1).`
      + ` Plenty of headroom, but you are only using a fraction of it - it will be fast and cheap to fly.` });
  }
  // Hover throttle outside 15-60 % means the motor/prop/pack combination is
  // mismatched: too little resolution at the bottom, or no headroom at the top.
  if (m.hoverThrottle > 0.985) {
    w.push({ level: 'error', text: `Cannot hover even at full throttle: the motors cannot turn `
      + `these props against this frame. More KV, a bigger prop, or a lighter build.` });
  } else if (m.hoverThrottle > 0.62) {
    w.push({ level: 'warn', text: `Hovers above 62% throttle: the pack is oversized for the props. Check motor KV or prop pitch.` });
  } else if (m.hoverThrottle < 0.14) {
    w.push({ level: 'warn', text: `Hovers below 14% throttle: too much KV or too little prop. No resolution and no throttle headroom.` });
  }
  if (m.gPerW < 1.2) {
    w.push({ level: 'warn', text: `Only ${m.gPerW.toFixed(2)} g/W. Poor efficiency - check prop diameter and pitch.` });
  }
  if (battery.cells >= 8 && fc.gyroHz >= 16000) {
    w.push({ level: 'info', text: 'High-RPM stack on 8S: watch motor and ESC temperature on long flights.' });
  }
  return w;
}
