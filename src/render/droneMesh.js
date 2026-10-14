// Drone model, built from the actual build spec.
//
// The geometry is derived from the parts, so swapping to a 10" frame really does
// give you a visibly different machine: longer swept arms, bigger motor bells, a
// fatter pack, duct rings, a camera cage. Props spin at their real rpm, motors
// glow when they are current-limited, and the antenna is where the RF model says
// it is.
//
// Everything is authored in the craft body frame: aerospace NED, +X forward
// (the nose), +Y right, +Z **down**. Two consequences run through the whole
// file and are the source of most of the historical unit bugs:
//
//   * "up" is negative Z. The bottom plate sits at z ~ 0 and the top plate at
//     z = -stackHeight__mm/1000.
//   * The prop discs lie in the body **XY** plane because the spin axis is Z.
//
// See the "The drone model" section of the README for the measured numbers.

import * as THREE from '../../vendor/three.module.js';
import { clamp } from '../core/math.js';

// Palette. Real carbon fibre and black anodising are very dark, and under a
// neutral studio light a literal rendering of those values is an unreadable
// silhouette. These are lifted into a range that still reads as dark technical
// hardware but keeps its form: carbon catches light along its weave, the
// aluminium arms separate from the plates, and props stay distinguishable.
const MAT = {
  carbon: 0x4a525d, carbonLight: 0x646e7a, alu: 0xa8b0ba, aluDark: 0x6f7781,
  black: 0x1e2226, pcb: 0x1d3b2c, motor: 0x8a929c, bell: 0x9aa3ae,
  propA: 0x3a4048, propB: 0xccd4dd, glow: 0x4fd18b,
  warn: 0xf0a04a, bad: 0xf05a4a, gold: 0xd8b45c,
  copper: 0xb9743f, glass: 0x0b1016, accent: 0x2f8fd0, duct: 0x39414a,
  strap: 0x262a30, led: 0xff4a33, shrink: 0x2b3441,
};

/**
 * The body->world rotation of a *level* craft, duplicated from `R_LEVEL` in
 * `src/sim/craft.js` so the render layer does not have to import the solver.
 * It is what makes the airframe lie flat instead of on its side: identity is
 * NOT level in a NED body frame.
 */
const Q_LEVEL_LOCAL = { x: 0.5, y: 0.5, z: -0.5, w: 0.5 };
const Q_IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Standard rather than Lambert: it gives the airframe real specular response,
 * so bevels and motor bells catch the key light and the machine reads as a
 * solid object rather than flat shaded panels.
 */
function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.55, metalness: opts.metalness ?? 0.25, ...opts,
  });
}

/* ------------------------------------------------------------ shape helpers */

/** Rounded rectangle centred on the origin, in the XY plane. */
function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = w / 2, y = h / 2;
  r = Math.min(r, x * 0.98, y * 0.98);
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y);
  s.quadraticCurveTo(x, -y, x, -y + r);
  s.lineTo(x, y - r);
  s.quadraticCurveTo(x, y, x - r, y);
  s.lineTo(-x + r, y);
  s.quadraticCurveTo(-x, y, -x, y - r);
  s.lineTo(-x, -y + r);
  s.quadraticCurveTo(-x, -y, -x + r, -y);
  s.closePath();
  return s;
}

/**
 * A plate that tapers from `wRear` wide at -X to `wFront` wide at +X. Real
 * unibody bottom plates are wider across the back and narrow towards the
 * camera, which is most of what makes a frame read as "designed" rather than
 * "a box with four sticks".
 */
function taperedPlate(len, wRear, wFront, r) {
  const s = new THREE.Shape();
  const hl = len / 2;
  const rr = Math.min(r, wRear / 2 * 0.95);
  const rf = Math.min(r, wFront / 2 * 0.95);
  s.moveTo(-hl + rr, -wRear / 2);
  s.quadraticCurveTo(-hl, -wRear / 2, -hl, -wRear / 2 + rr);
  s.lineTo(hl - rf, -wFront / 2);
  s.quadraticCurveTo(hl, -wFront / 2, hl, -wFront / 2 + rf);
  s.lineTo(hl, wFront / 2 - rf);
  s.quadraticCurveTo(hl, wFront / 2, hl - rf, wFront / 2);
  s.lineTo(-hl + rr, wRear / 2);
  s.quadraticCurveTo(-hl, wRear / 2, -hl, wRear / 2 - rr);
  s.closePath();
  return s;
}

/**
 * Extrude a shape along **Z** and centre it there. Z is the vertical axis in
 * the body frame, so a shape drawn in XY becomes a flat plate lying in the
 * prop-disc plane. `bevel` is trimmed off the extrusion depth so the finished
 * part comes out exactly `t` thick.
 */
function plate(shape, t, bevel = 0) {
  const b = Math.min(bevel, t * 0.3);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, t - 2 * b), curveSegments: 8, steps: 1,
    bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: 0, bevelSegments: 1,
  });
  geo.translate(0, 0, -t / 2);
  return geo;
}

/** Shear a geometry so its cross-section rises along +X: `dz/dx = k`. */
function rampZ(geo, k, x0 = 0) {
  if (!k) return geo;
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + k * (p.getX(i) - x0));
  p.needsUpdate = true;
  geo.computeVertexNormals();     // the shear invalidates the extrude normals
  return geo;
}

/** A slack cable between two points via an explicit midpoint, as a swept tube. */
function cable(a, mid, b, r) {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(a[0], a[1], a[2]),
    new THREE.Vector3(mid[0], mid[1], mid[2]),
    new THREE.Vector3(b[0], b[1], b[2]),
  ]);
  return new THREE.TubeGeometry(curve, 12, r, 6, false);
}

export class DroneModel {
  constructor() {
    this.group = new THREE.Group();
    this.props = [];
    this.motorLeds = [];
    this.built = null;
    // Per-instance caches. They MUST NOT be module-level: three.js owns
    // geometry lifetime, so a shared cache that one instance disposes would
    // pull the buffers out from under the other two (builder, sim, race).
    this._geo = new Map();
    this._mats = new Map();
  }

  /** Memoised geometry: one buffer, many meshes. */
  _g(key, make) {
    let g = this._geo.get(key);
    if (!g) { g = make(); this._geo.set(key, g); }
    return g;
  }

  /** Memoised material: one instance, many meshes. */
  _m(key, make) {
    let m = this._mats.get(key);
    if (!m) { m = make(); this._mats.set(key, m); }
    return m;
  }

  /** A unit cylinder with its axis on +Y, scaled per mesh: vertical hardware. */
  _cylZ(seg, r, len, material) {
    const m = new THREE.Mesh(this._g(`cyl${seg}`, () => new THREE.CylinderGeometry(1, 1, 1, seg)), material);
    m.rotation.x = Math.PI / 2;    // cylinder axis Y -> Z (the vertical axis)
    m.scale.set(r, len, r);
    return m;
  }

  /** A unit cylinder with its axis on +X, scaled per mesh: lens barrels, pins. */
  _cylX(seg, r, len, material) {
    const m = new THREE.Mesh(this._g(`cyl${seg}`, () => new THREE.CylinderGeometry(1, 1, 1, seg)), material);
    m.rotation.z = Math.PI / 2;    // cylinder axis Y -> X (out of the nose)
    m.scale.set(r, len, r);
    return m;
  }

  _unitBox() { return this._g('unitbox', () => new THREE.BoxGeometry(1, 1, 1)); }

  _box(w, h, d, material) {
    return new THREE.Mesh(
      this._g(`box${w.toFixed(5)}_${h.toFixed(5)}_${d.toFixed(5)}`,
        () => new THREE.BoxGeometry(w, h, d)), material);
  }

  /* ------------------------------------------------------------------ build */
  build(craft) {
    this.dispose();
    const g = this.group;
    const frame = craft.frame, motorS = craft.motor, propS = craft.prop;
    const battS = craft.battSpec, fcS = craft.fc;
    const hubs = craft.props.map((p) => p.propPos);

    /* ---------------------------------------------------- master dimensions */
    // cm^2 -> m^2 is /1e4. Dividing by 100 made a 190 cm2 plate 1.38 m across,
    // a ten-times oversize slab that swallowed the whole airframe: the props and
    // motors ended up as four bumps at the corners of a huge square, which read
    // as "the props are diagonal to the quad".
    const L = Math.sqrt(frame.plateArea__cm2 / 1e4);
    const plateT = clamp(L * 0.040, 0.0016, 0.010);   // bottom carbon, 1.6-10 mm
    const topT = clamp(L * 0.030, 0.0015, 0.006);     // canopy
    const topZ = -frame.stackHeight__mm / 1000;       // negative = up (+Z is down)
    const armLen = Math.hypot(hubs[0].x, hubs[0].y);
    const mR = motorS.stator / 1000 * 0.72;           // bell radius, as in craft.js
    const mH = motorS.height__mm / 1000;
    const propR = propS.D__mm / 2000;
    const gap = Math.abs(topZ) - plateT;              // clear height between plates
    const hubZ = hubs[0].z;                          // motor mounting plane
    const zTopSurf = topZ - topT / 2;                 // top face of the canopy

    // 30.5x30.5 or 20x20 mounting, read off the parts rather than guessed.
    const fcPat = /20\s?x\s?20/i.test(fcS.name) ? 0.020 : 0.0305;
    const pat = frame.stackOffset.y <= 6 ? 0.020 : 0.0305;

    /* ------------------------------------------------- fore/aft place plan */
    // Front to rear, like the real thing: camera, stack + VTX, pack, antenna.
    // Every station is bounded by the one in front of it, which is what stops a
    // small frame (an 79 mm toothpick plate) from growing parts that interpenetrate.
    const stackX = clamp(L * 0.10, 0.008, 0.030);
    const camX = clamp(L * 0.34, 0.030, 0.080);
    const camBodyW = clamp(L * 0.145, 0.014, 0.026);
    const camBodyH = clamp(L * 0.155, 0.015, 0.030);
    const camZ = zTopSurf - 0.0012 - 0.0115;
    const camBack = camX - (camBodyW * 0.55 + 0.004);  // rearmost camera hardware
    const vtxW = clamp(L * 0.17, 0.016, 0.040);
    const vtxH = clamp(L * 0.075, 0.007, 0.020);
    const vtxX = stackX;
    const vtxFront = vtxX + vtxW / 2 + 0.005;
    const plateRear = -L * 0.42;
    const battRoom = Math.max(0.018, Math.min(camBack, vtxFront) - plateRear - 0.004);
    const battLen = clamp(L * 0.55, 0.018, Math.min(0.175, battRoom));
    const battW = clamp(L * 0.28, 0.030, 0.075);
    const battH = Math.max(0.028, battS.cells * 0.0105);
    const battX = Math.min(camBack, vtxFront) - 0.004 - battLen / 2;
    const battZ = zTopSurf - 0.0016 - battH / 2;
    const antX = Math.min(-clamp(L * 0.40, 0.036, 0.100), battX - battLen / 2 - 0.005);

    /* ------------------------------------------------------------ materials */
    const carbon = this._m('carbon', () => mat(MAT.carbon, { roughness: 0.48, metalness: 0.2 }));
    const carbonL = this._m('carbonL', () => mat(MAT.carbonLight, { roughness: 0.42, metalness: 0.25 }));
    const alu = this._m('alu', () => mat(MAT.alu, { roughness: 0.32, metalness: 0.85 }));
    const aluD = this._m('aluD', () => mat(MAT.aluDark, { roughness: 0.4, metalness: 0.8 }));
    const black = this._m('black', () => mat(MAT.black, { roughness: 0.6, metalness: 0.15 }));
    const pcb = this._m('pcb', () => mat(MAT.pcb, { roughness: 0.65, metalness: 0.05 }));
    const gold = this._m('gold', () => mat(MAT.gold, { roughness: 0.3, metalness: 0.9 }));
    const copper = this._m('copper', () => mat(MAT.copper, { roughness: 0.45, metalness: 0.8 }));
    const accent = this._m('accent', () => mat(MAT.accent, { roughness: 0.45, metalness: 0.1 }));
    const glass = this._m('glass', () => mat(MAT.glass, { roughness: 0.06, metalness: 1.0 }));
    const ductMat = this._m('duct', () => mat(MAT.duct, {
      roughness: 0.7, metalness: 0.05, transparent: true, opacity: 0.62, side: THREE.DoubleSide,
    }));
    const ledOn = this._m('ledOn', () => new THREE.MeshBasicMaterial({ color: MAT.led }));

    /* -------------------------------------------------------- bottom plate */
    const bottom = new THREE.Mesh(
      plate(taperedPlate(L, L * 0.88, L * 0.72, L * 0.20), plateT, plateT * 0.18), carbon);
    bottom.position.set(0, 0, -plateT / 2);           // top face lands on z = 0
    g.add(bottom);
    // Silkscreen-ish accent inlay: free wayfinding on an otherwise dark airframe.
    const stripe = new THREE.Mesh(
      this._g('stripe', () => plate(roundedRect(L * 0.42, L * 0.05, L * 0.02), 0.0004)), accent);
    stripe.position.set(-L * 0.12, L * 0.26, -0.0003);
    g.add(stripe);

    /* --------------------------------------------------------------- arms */
    // One extruded tapered profile, rotated onto each hub. It is drawn in the XY
    // plane and extruded along Z, then *ramped* so the outboard end rises to the
    // motor mount plane (hubZ, which the stack offset puts above the bottom
    // plate). That sweep is what a raised-mount frame looks like, and it puts
    // the motor at exactly the height the physics uses.
    const padHalf = clamp(mR * 1.02, 0.006, 0.034);
    const armT = clamp(L * 0.036, 0.0018, 0.009);
    const armRoot = clamp(L * 0.085, 0.006, 0.020);
    const armMid = clamp(L * 0.050, 0.0035, 0.013);
    const armRamp = hubZ / armLen;
    // The profile is centred on the arm's own midpoint, because the mesh sits at
    // the *half* hub. Drawing it 0 -> armLen from there put every motor mount
    // 40 mm outboard of its own motor.
    const armX0 = -armLen / 2;
    const armGeo = rampZ(plate((() => {
      const s = new THREE.Shape();
      const capX = armX0 + armLen - padHalf;
      s.moveTo(armX0, -armRoot);
      s.lineTo(armX0 + armLen * 0.40, -armMid);
      s.lineTo(capX, -padHalf);
      s.absarc(capX, 0, padHalf, -Math.PI / 2, Math.PI / 2, false);
      s.lineTo(armX0 + armLen * 0.40, armMid);
      s.lineTo(armX0, armRoot);
      s.closePath();
      return s;
    })(), armT, armT * 0.2), armRamp, armX0);
    const armAccentGeo = rampZ(plate((() => {
      const s = new THREE.Shape();
      const a = armX0 + armLen * 0.34, b = armX0 + armLen * 0.86;
      s.moveTo(a, -armMid * 0.30);
      s.lineTo(b, -armMid * 0.36);
      s.lineTo(b, armMid * 0.36);
      s.lineTo(a, armMid * 0.30);
      s.closePath();
      return s;
    })(), 0.0004), armRamp, armX0);
    const padGeo = this._g('mpad', () => plate(roundedRect(padHalf * 2, padHalf * 2, padHalf * 0.7),
      armT * 0.6, armT * 0.12));
    for (let i = 0; i < 4; i++) {
      const h = hubs[i];
      // The profile runs along its local X, so +atan2(y, x) lays it from the
      // centre out to the motor. The sign matters: with -atan2 the left and
      // right arms mirrored onto each other and the frame drew as two crossed
      // sticks.
      const spin = Math.atan2(h.y, h.x);
      const arm = new THREE.Mesh(armGeo, carbonL);
      arm.rotation.z = spin;
      arm.position.set(h.x / 2, h.y / 2, armT / 2);
      g.add(arm);
      const inlay = new THREE.Mesh(armAccentGeo, accent);
      inlay.rotation.z = spin;
      inlay.position.set(h.x / 2, h.y / 2, -0.0002);
      g.add(inlay);
      const pad = new THREE.Mesh(padGeo, carbon);
      pad.rotation.z = spin;
      pad.position.set(h.x, h.y, hubZ + armT * 0.3);
      g.add(pad);
    }

    /* -------------------------------------------------- stack and canopy */
    const escT = 0.0018, fcT = 0.0016;
    const escZ = -plateT - gap * 0.34;
    const fcZ = -plateT - gap * 0.66;
    const holeR = pat / 2;
    const stack = new THREE.Group();
    stack.position.set(stackX, 0, 0);
    g.add(stack);
    // Standoffs: bottom plate -> ESC -> FC -> canopy. Real hardware, so the
    // boards read as stacked rather than floating.
    for (const [za, zb] of [
      [-plateT, escZ - escT / 2],
      [escZ + escT / 2, fcZ - fcT / 2],
      [fcZ + fcT / 2, topZ + topT / 2],
    ]) {
      const len = Math.abs(za - zb);
      if (len < 2e-4) continue;
      for (let sx = -1; sx <= 1; sx += 2) {
        for (let sy = -1; sy <= 1; sy += 2) {
          const p = this._cylZ(10, pat * 0.085, len, aluD);
          p.position.set(sx * holeR, sy * holeR, (za + zb) / 2);
          stack.add(p);
        }
      }
    }
    const esc = new THREE.Mesh(
      this._g('escboard', () => plate(roundedRect(pat + 0.002, pat + 0.002, 0.0018), escT)), pcb);
    esc.position.z = escZ;
    stack.add(esc);
    const fetGeo = this._g('fet', () => plate(roundedRect(0.0075, 0.0075, 0.0008), 0.0006));
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        const f = new THREE.Mesh(fetGeo, black);
        f.position.set(sx * holeR * 0.92, sy * holeR * 0.92, escZ + escT / 2 + 0.0003);
        stack.add(f);
      }
    }
    const fc = new THREE.Mesh(
      this._g('fcboard', () => plate(roundedRect(fcPat + 0.002, fcPat + 0.002, 0.0018), fcT)), black);
    fc.position.z = fcZ;
    stack.add(fc);
    const mcu = this._box(fcPat * 0.45, fcPat * 0.45, 0.0009, aluD);
    mcu.position.set(fcPat * 0.18, -fcPat * 0.12, fcZ - fcT / 2 - 0.0005);
    stack.add(mcu);
    const rxPad = this._box(fcPat * 0.5, fcPat * 0.3, 0.0008, gold);
    rxPad.position.set(-fcPat * 0.2, fcPat * 0.22, fcZ + fcT / 2 + 0.0005);
    stack.add(rxPad);

    const canopy = new THREE.Mesh(
      this._g('canopy', () => plate(taperedPlate(clamp(L * 0.78, 0.030, 0.30), L * 0.46, L * 0.34,
        L * 0.07), topT, topT * 0.2)), carbonL);
    canopy.position.set(-L * 0.02, 0, topZ);
    g.add(canopy);

    /* -------------------------------------------------- capacitor and leads */
    // A real 4-in-1 has a low-ESR electrolytic stuffed beside the ESC; without
    // it the airframe reads as four motors floating on a plate.
    const capR = clamp(L * 0.042, 0.0045, 0.011), capH = clamp(L * 0.085, 0.008, 0.020);
    const capX = stackX - pat / 2 - capR - 0.003, capY = pat * 0.42;
    const cap = this._cylZ(16, capR, capH, black);
    cap.position.set(capX, capY, -plateT - capH / 2);
    g.add(cap);
    const capTop = this._cylZ(16, capR * 1.03, 0.0012, alu);
    capTop.position.set(capX, capY, -plateT - capH - 0.0006);
    g.add(capTop);
    g.add(new THREE.Mesh(cable(
      [capX, capY, -plateT - capH],
      [(capX + stackX) / 2, (capY + pat / 2) / 2, (-plateT - capH + escZ) / 2 - 0.002],
      [stackX - pat / 2, pat / 2, escZ], 0.0009), black));

    /* -------------------------------------------------------------- motors */
    // Height budget: base + stator can + bell == motorS.height__mm exactly, so
    // the prop always sits on top of the shaft instead of inside the bell.
    const baseH = mH * 0.20, statorH = mH * 0.35, bellH = mH * 0.45;
    const baseR = mR * 0.96, bellR = mR * 1.04;
    const baseZ = hubZ - baseH / 2;
    const canZ = hubZ - baseH - statorH / 2;
    const bellZ = hubZ - baseH - statorH;
    const boltCircle = Math.max(frame.motorPattern__mm / 1000 * 0.5 * Math.SQRT2, baseR * 1.06);
    const boltR = frame.motorMount === 'M2' ? 0.0013 : frame.motorMount === 'M4' ? 0.0024 : 0.0018;
    const boltH = boltR * 0.9;
    const boltGeo = this._g('bolt', () => new THREE.CylinderGeometry(1, 0.92, 1, 8));
    const ventGeo = this._unitBox();
    const mBase = this._m('mbase', () => mat(MAT.motor, { roughness: 0.35, metalness: 0.9 }));
    const mBell = this._m('mbell', () => mat(MAT.bell, { roughness: 0.3, metalness: 0.9 }));
    const bellGeo = this._g('bell', () => {
      const p = (r, y) => new THREE.Vector2(r, y);
      return new THREE.LatheGeometry([
        p(mR * 0.86, 0), p(bellR * 1.06, 0), p(bellR * 1.06, bellH * 0.13),
        p(bellR, bellH * 0.22), p(bellR, bellH * 0.80), p(bellR * 0.9, bellH * 0.93),
        p(bellR * 0.5, bellH), p(0.0002, bellH),
      ], 24);
    });
    this.props = [];
    this.motorLeds = [];
    for (let i = 0; i < 4; i++) {
      const h = hubs[i];
      const base = this._cylZ(28, baseR, baseH, mBase);
      base.position.set(h.x, h.y, baseZ);
      g.add(base);
      const can = this._cylZ(24, mR * 0.9, statorH, copper);   // windings in the slots
      can.position.set(h.x, h.y, canZ);
      g.add(can);
      const bell = new THREE.Mesh(bellGeo, mBell);
      // LatheGeometry sweeps around +Y with the profile's y as the height;
      // the motor axis is Z and up is -Z, hence -pi/2 about X.
      bell.rotation.x = -Math.PI / 2;
      bell.position.set(h.x, h.y, bellZ);
      g.add(bell);
      // Vent slots around the bell.
      for (let v = 0; v < 10; v++) {
        const a = (v / 10) * Math.PI * 2 + 0.15;
        const slot = new THREE.Mesh(ventGeo, black);
        slot.scale.set(mR * 0.15, mR * 0.11, bellH * 0.44);
        slot.position.set(h.x + Math.cos(a) * bellR * 0.99, h.y + Math.sin(a) * bellR * 0.99,
          bellZ - bellH * 0.42);
        slot.rotation.z = a;
        g.add(slot);
      }
      const shaft = this._cylZ(10, mR * 0.16, 0.0062, alu);
      shaft.position.set(h.x, h.y, hubZ - mH - 0.003);
      g.add(shaft);
      for (let b = 0; b < 4; b++) {
        const a = Math.PI / 4 + (b / 4) * Math.PI * 2;
        const bolt = new THREE.Mesh(boltGeo, alu);
        bolt.rotation.x = Math.PI / 2;
        bolt.scale.set(boltR, boltH, boltR);
        bolt.position.set(h.x + Math.cos(a) * boltCircle, h.y + Math.sin(a) * boltCircle,
          hubZ + armT * 0.6 + boltH * 0.3);
        g.add(bolt);
      }

      // Status ring: green when clean, amber when current-limited, red on desync
      const led = new THREE.Mesh(
        this._g('mled', () => new THREE.TorusGeometry(1, 0.09, 6, 20)),
        // One material per motor: update() writes colour and opacity per ring,
        // and a shared material would make all four read the same motor.
        new THREE.MeshBasicMaterial({ color: MAT.glow, transparent: true, opacity: 1 }));
      led.scale.setScalar(bellR * 1.1);
      led.position.set(h.x, h.y, bellZ - bellH * 0.45);
      g.add(led);
      this.motorLeds.push(led);

      const prop = this._buildProp(propS);
      // The prop disc plane is the same one craft.js hangs the prop's inertia
      // off: hubZ - motorHeight - 4 mm.
      prop.position.set(h.x, h.y, hubZ - mH - 0.004);
      g.add(prop);
      this.props.push(prop);

      /* ---------------------------------------------------- cinewhoop duct */
      if (frame.ducts) {
        // The duct ring is sized so its *outer* edge lands exactly on the prop
        // tip circle - the same circle craft.collisionRadius is built from. A
        // real cinewhoop's guards sit just outside it, but overshooting means
        // driving visible plastic through walls.
        const ductLo = hubZ - mH * 0.35, ductHi = hubZ - mH - propR * 0.45;
        const wall = new THREE.Mesh(
          this._g('ductwall', () => new THREE.CylinderGeometry(1, 1, 1, 28, 1, true)), ductMat);
        wall.scale.set(propR, Math.abs(ductHi - ductLo), propR);
        wall.rotation.x = Math.PI / 2;
        wall.position.set(h.x, h.y, (ductLo + ductHi) / 2);
        g.add(wall);
        const rimGeo = this._g('ductrim', () => new THREE.TorusGeometry(1, 0.085, 6, 26));
        const rimScale = propR / 1.085;      // torus tube adds 0.085 of the scale
        for (const zz of [ductHi, ductLo]) {
          const rim = new THREE.Mesh(rimGeo, ductMat);
          rim.scale.setScalar(rimScale);
          rim.position.set(h.x, h.y, zz);
          g.add(rim);
        }
      }
    }

    /* ---------------------------------------------------------- camera pod */
    // Base plate and side brackets stay put; only the camera inside them tilts.
    const camBase = new THREE.Mesh(
      this._g('cambase', () => plate(roundedRect(L * 0.20, L * 0.26, L * 0.05), 0.0022, 0.0005)),
      carbon);
    camBase.position.set(camX - L * 0.03, 0, zTopSurf - 0.0011);
    g.add(camBase);
    for (let sy = -1; sy <= 1; sy += 2) {
      const br = new THREE.Mesh(
        this._g('cambrk', () => plate(roundedRect(L * 0.17, L * 0.19, L * 0.04), 0.0016, 0.0004)),
        carbonL);
      br.position.set(camX - L * 0.01, sy * (camBodyW / 2 + 0.0011), camZ);
      g.add(br);
      const pin = this._cylX(8, 0.0011, camBodyW + 0.005, alu);
      pin.position.set(camX, sy * (camBodyW / 2 + 0.0011), camZ);
      g.add(pin);
    }

    // The body frame is NED with +X out of the nose, so the lens points along +X
    // and the tilt is a rotation about the lateral (+Y) axis: nose-up tilt.
    const cam = new THREE.Group();
    cam.add(new THREE.Mesh(this._g('cambody',
      () => plate(roundedRect(camBodyW, camBodyH, camBodyW * 0.18), camBodyH * 0.92, 0.0008)), black));
    const barrel = this._cylX(20, camBodyW * 0.36, camBodyW * 0.42,
      this._m('lensbarrel', () => mat(0x14181c, { roughness: 0.45, metalness: 0.6 })));
    barrel.position.x = camBodyW * 0.55;
    cam.add(barrel);
    const eye = this._cylX(20, camBodyW * 0.26, 0.0012, glass);
    eye.position.x = camBodyW * 0.76 + 0.0006;
    cam.add(eye);
    // FPV camera status LED, just above the lens like the real one.
    const camLed = new THREE.Mesh(this._unitBox(), ledOn);
    camLed.scale.set(0.0022, 0.0016, 0.0016);
    camLed.position.set(camBodyW * 0.30, -camBodyH * 0.30, camBodyH * 0.47);
    cam.add(camLed);
    cam.position.set(camX, 0, camZ);
    cam.rotation.y = (frame.camTilt__deg || 20) * Math.PI / 180;
    g.add(cam);
    this.cameraPod = cam;

    /* -------------------------------------------- VTX, pigtail and antenna */
    const vtx = this._box(vtxW, vtxW, vtxH,
      this._m('vtx', () => mat(0x2a2f36, { roughness: 0.5, metalness: 0.6 })));
    vtx.position.set(vtxX, 0, zTopSurf - vtxH / 2);
    g.add(vtx);
    // Heat-sink fins: the giveaway that this is a transmitter and not a lump.
    const finGeo = this._unitBox();
    for (let f = 0; f < 7; f++) {
      const fin = new THREE.Mesh(finGeo, alu);
      fin.scale.set(vtxW * 0.94, vtxW * 0.055, vtxH * 0.85);
      fin.position.set(vtxX - vtxW * 0.42 + (f / 6) * vtxW * 0.84, 0,
        zTopSurf - vtxH - vtxH * 0.42);
      g.add(fin);
    }

    this.antennaPivot = new THREE.Group();
    this.antennaPivot.position.set(antX, 0, zTopSurf - 0.006);
    const antLen = clamp(L * 0.30, 0.030, 0.070);
    const antR = clamp(L * 0.016, 0.0018, 0.004);
    const antRod = new THREE.Mesh(
      this._g('antrod', () => new THREE.CylinderGeometry(1, 1, 1, 8)),
      this._m('antrodM', () => mat(0xd8dde2, { roughness: 0.35, metalness: 0.1 })));
    antRod.position.y = antLen / 2;
    antRod.scale.set(antR, antLen, antR);
    this.antennaPivot.add(antRod);
    const antSleeve = new THREE.Mesh(this._g('antslv', () => new THREE.CylinderGeometry(1, 1, 1, 10)), gold);
    antSleeve.position.y = antLen * 0.08;
    antSleeve.scale.set(antR * 2.0, antLen * 0.16, antR * 2.0);
    this.antennaPivot.add(antSleeve);
    const antBase = new THREE.Mesh(this._g('antbase', () => new THREE.SphereGeometry(1, 10, 8)), black);
    antBase.scale.setScalar(antR * 2.4);
    this.antennaPivot.add(antBase);
    // Lean the antenna back and up: the local axis the RF model uses is
    // (-0.55, 0, -0.83), i.e. back and up, so align the rod with it.
    const dir = new THREE.Vector3(-0.55, 0, -0.83).normalize();
    this.antennaPivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.add(this.antennaPivot);
    this.antenna = this.antennaPivot;
    // Coax pigtail: VTX up over the pack and back down to the antenna base, the
    // way it is actually dressed. The midpoint is deliberately *above* the pack
    // - the straight line from VTX to antenna runs straight through the cells.
    g.add(new THREE.Mesh(cable(
      [vtxX, 0, zTopSurf - vtxH * 1.5],
      [(vtxX + antX) / 2, 0.004, battZ - battH / 2 - 0.008],
      [antX, 0, zTopSurf - 0.010], 0.0011), black));

    /* ----------------------------------------------------------- battery */
    // Cell count gives the height, exactly as craft.js does it. It is strapped
    // **on top** of the canopy and pushed forward against the camera, with the
    // antenna sweeping up and back clear behind it, which is where a real pack
    // lives. craft.js models the pack's inertia *below* the bottom plate; that
    // is a discrepancy in the inertia model, not something a mesh can fix.
    const batt = this._box(battLen, battW, battH,
      this._m('batt', () => mat(MAT.shrink, { roughness: 0.38, metalness: 0.1 })));
    batt.position.set(battX, 0, battZ);
    g.add(batt);
    this.batteryMesh = batt;
    // Cell dividers: a LiPo is a stack of cells. They are barely proud of the
    // shrink on purpose - flush enough to read as a cell line at 300 px, not so
    // proud that the pack looks like a pile of plates.
    const divGeo = this._unitBox();
    for (let c = 1; c < battS.cells; c++) {
      const d = new THREE.Mesh(divGeo, black);
      d.scale.set(battLen * 1.001, battW * 1.001, 0.0002);
      d.position.set(battX, 0, battZ - battH / 2 + (c / battS.cells) * battH);
      g.add(d);
    }
    // Velcro strap over the top.
    const strap = new THREE.Mesh(
      this._g('strap', () => plate(roundedRect(battW * 1.12, battLen * 1.02, 0.0012), 0.0012)),
      this._m('strapM', () => mat(MAT.strap, { roughness: 0.95, metalness: 0 })));
    strap.rotation.y = Math.PI / 2;
    strap.position.set(battX - battLen * 0.10, 0, battZ - battH / 2 - 0.0007);
    g.add(strap);
    // XT60 lead off the front of the pack, plus the balance lead off the side.
    const plugMat = this._m('plug', () => mat(0x14181d, { roughness: 0.5, metalness: 0.3 }));
    const plugBody = this._box(0.010, 0.014, 0.008, plugMat);
    plugBody.position.set(battX + battLen / 2 - 0.003, 0, battZ - battH / 2 + 0.004);
    g.add(plugBody);
    for (let sy = -1; sy <= 1; sy += 2) {
      const pin = this._cylX(10, 0.0032, 0.0075, plugMat);
      pin.position.set(battX + battLen / 2 + 0.003, sy * 0.0042, battZ - battH / 2 + 0.004);
      g.add(pin);
    }
    // Balance lead: off the pack's rear quarter, down the *outside* of the pack
    // and onto the canopy beside it.
    g.add(new THREE.Mesh(cable(
      [battX - battLen * 0.28, battW * 0.5, battZ - battH * 0.30],
      [battX - battLen * 0.46, battW * 0.5 + 0.006, battZ + battH * 0.15],
      [battX - battLen * 0.50, battW * 0.5 + 0.007, zTopSurf - 0.0015], 0.0007), black));
    const balPlug = this._box(0.009, 0.005, 0.003, plugMat);
    balPlug.position.set(battX - battLen * 0.52, battW * 0.5 + 0.008, zTopSurf - 0.0015);
    g.add(balPlug);
    // Lit power LED on the front face of the pack.
    const pwrLed = this._cylX(10, 0.0018, 0.0012, ledOn);
    pwrLed.position.set(battX + battLen / 2 + 0.0004, battW * 0.32, battZ + battH * 0.28);
    g.add(pwrLed);

    /* ------------------------------------------------- GPS and bumper cage */
    if (frame.wheelbase__mm >= 360) {
      // Long-range frames carry a GPS puck; it lives on a short mast off the
      // strap, which is where it can always physically fit.
      const gx = battX - battLen * 0.10;
      const gTop = battZ - battH / 2 - 0.010;
      const puck = this._cylZ(20, clamp(L * 0.075, 0.008, 0.018), 0.004, black);
      puck.position.set(gx, 0, gTop);
      g.add(puck);
      const dome = new THREE.Mesh(
        this._g('dome', () => new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2)),
        this._m('domeM', () => mat(0xdfe4e9, { roughness: 0.3, metalness: 0.1 })));
      dome.scale.setScalar(clamp(L * 0.072, 0.007, 0.017));
      dome.rotation.x = -Math.PI / 2;    // hemisphere pole from +Y onto -Z (up)
      dome.position.set(gx, 0, gTop - 0.002);
      g.add(dome);
      const mast = this._cylZ(8, 0.0022, 0.008, aluD);
      mast.position.set(gx, 0, battZ - battH / 2 - 0.004);
      g.add(mast);
      g.add(new THREE.Mesh(cable(
        [gx, 0, gTop - 0.002],
        [(gx + vtxX) / 2, battW * 0.55, (gTop + zTopSurf) / 2],
        [vtxX, battW * 0.3, zTopSurf - vtxH], 0.0008), black));
    }
    if (!frame.ducts) {
      // A camera cage / bumper: two posts and a bar across the nose. Ducted
      // frames get their protection from the ducts instead.
      const postH = clamp(L * 0.16, 0.012, 0.040);
      for (let sy = -1; sy <= 1; sy += 2) {
        const post = this._box(0.0026, 0.0026, postH, carbonL);
        post.position.set(camX + camBodyW * 0.30, sy * (camBodyW * 0.62), zTopSurf - postH / 2);
        g.add(post);
      }
      const bar = this._box(0.0026, camBodyW * 1.3, 0.0026, carbonL);
      bar.position.set(camX + camBodyW * 0.30, 0, zTopSurf - postH);
      g.add(bar);
    }

    // The key has to be the *stringified* spec: `update` compares against a
    // string, and storing the object here made the test fail every frame, which
    // tore the whole model down and rebuilt it 60 times a second.
    this.built = JSON.stringify(craft.spec);
    return this;
  }

  /**
   * One prop: blades laid out in the disc plane, hub on the spin axis.
   *
   * The blade outline is drawn in the XY plane and extruded along Z, which is
   * exactly the disc plane of the airframe (the body frame is NED, so the spin
   * axis is Z). Rotating that geometry on to an edge instead stands the blades
   * up like fins: they then cannot spin about Z at all, because Z lies in their
   * plane, and the prop reads as a cross of standing paddles instead of a disc.
   */
  _buildProp(spec) {
    const D = spec.D__mm / 1000;
    const grp = new THREE.Group();
    const blades = spec.blades;
    const mProp = this._m('propBlade', () => mat(MAT.propA, { roughness: 0.38, metalness: 0.05 }));
    const r = D / 2;
    // Racing blade outline: swept leading edge, chord growing towards 0.75R,
    // rounded tip, then a straighter trailing edge back to the hub. The tip
    // curve is drawn so the tessellated outline reaches exactly `r` and no
    // further - the prop tips have to stay inside the collision sphere, which
    // is built from that same radius.
    const shape = new THREE.Shape();
    const rootX = r * 0.17;
    const cRoot = r * 0.30, cMid = r * 0.62, cTip = r * 0.42;
    const tipX = r * 0.985;
    shape.moveTo(rootX, -cRoot / 2);
    shape.bezierCurveTo(r * 0.42, -cRoot * 0.42, r * 0.74, -cMid * 0.44, tipX, -cTip * 0.26);
    shape.quadraticCurveTo(2 * r - tipX, 0, tipX, cTip * 0.26);
    shape.bezierCurveTo(r * 0.72, cMid * 0.46, r * 0.40, cRoot * 0.40, rootX, cRoot / 2);
    shape.closePath();
    // Blade *thickness*, scaled off the diameter: a 5" blade is ~1.5 mm.
    // `pitch__mm` is the prop's geometric pitch (109 mm for a 5x4.3), not a
    // thickness - extruding by it made each blade a 10 cm slab, as thick as the
    // whole airframe.
    const geo = plate(shape, Math.max(0.0012, D * 0.014));
    // Pitch angle from the real geometric pitch at the 0.75R station. That is
    // genuinely steep (~49 degrees on a 5x4.3), which on a model reads as a
    // blade standing on edge, so take a fraction of it: enough to see the
    // blade is pitched, little enough that the disc still reads as a disc.
    const pitchAngle = clamp(Math.atan2(spec.pitch__mm / 1000, 0.75 * D) * 0.35, 0.06, 0.30);
    for (let b = 0; b < blades; b++) {
      const blade = new THREE.Mesh(geo, mProp);
      // Spin about the hub axis first, then pitch about the blade's own radial
      // axis - which is X after the spin, so the pitch leans into the relative
      // wind rather than rolling the blade.
      blade.rotation.z = (b / blades) * Math.PI * 2;
      blade.rotation.x = pitchAngle;
      grp.add(blade);
    }
    const hubR = spec.hub__mm / 2000;
    const hub = this._cylZ(12, hubR * 0.62, 0.004,
      this._m('propHub', () => mat(MAT.propB, { roughness: 0.45, metalness: 0.05 })));
    grp.add(hub);
    const nut = this._cylZ(6, hubR * 0.45, 0.0022,
      this._m('propNut', () => mat(0x3c4148, { roughness: 0.4, metalness: 0.6 })));
    nut.position.z = -0.0026;          // on top of the hub: -Z is up in this frame
    grp.add(nut);
    return grp;
  }

  /**
   * @param craft  the simulation craft
   * @param dt     seconds
   * @param opts   { showWash }
   */
  update(craft, dt, opts = {}) {
    if (this.built !== JSON.stringify(craft.spec)) this.build(craft);
    // Props spin at their real speed, and are motion-smeared above ~1 rev/frame
    // so they do not strobe.
    for (let i = 0; i < 4; i++) {
      const omega = craft.motors[i].omega;
      const blur = Math.abs(omega) * dt / (Math.PI * 2);
      // The prop's own spin sign: +1 is counter-clockwise seen from above, which
      // in this frame (Z down) is a *negative* rotation about Z. Without it all
      // four props turned the same way and the model contradicted the physics.
      this.props[i].rotation.z -= omega * dt * (craft.props[i].axis || 1);
      const vis = blur > 0.35;
      this.props[i].children.forEach((c) => {
        if (c.material && c.material.transparent !== undefined) {
          c.material.transparent = vis;
          c.material.opacity = vis ? 0.35 : 1;
        }
      });
      // Motor status ring
      const m = craft.motors[i];
      const c = this.motorLeds[i].material;
      if (m.desync > 0.35) c.color.setHex(MAT.bad);
      else if (m.throttled || m.tempC > 90) c.color.setHex(MAT.warn);
      else c.color.setHex(MAT.glow);
      c.opacity = 0.35 + 0.65 * clamp(m.current / 25, 0, 1);
    }
  }

  /* --------------------------------------------------------- scale checking */
  /**
   * Measured world-space extents of the built group, so a test or QA script can
   * assert the airframe is the size it claims to be. Everything is measured
   * from real vertices rather than bounding boxes: the AABB of a *rotated* prop
   * blade reports corners at r*sqrt(2), which is 9 cm outside the prop on a 5"
   * and would read as a false "the model is bigger than the collider".
   *
   * `radius` is the furthest vertex from the group origin in body-frame metres -
   * the same origin `craft.collisionRadius` is measured from - so
   * `radius <= craft.collisionRadius` is literally "the visible model fits
   * inside the collider". The prop tips sweep out to exactly
   * `craft.propTipRadius` between blade angles; `body` below is the resting pose.
   */
  measureExtents(craft) {
    if (craft && this.built !== JSON.stringify(craft.spec)) this.build(craft);
    const prevQ = this.group.quaternion.clone();
    const out = {};
    this.group.quaternion.set(Q_LEVEL_LOCAL.x, Q_LEVEL_LOCAL.y, Q_LEVEL_LOCAL.z, Q_LEVEL_LOCAL.w);
    out.level = this._measure();
    this.group.quaternion.set(Q_IDENTITY.x, Q_IDENTITY.y, Q_IDENTITY.z, Q_IDENTITY.w);
    out.identity = this._measure();
    this.group.quaternion.copy(prevQ);          // main.js owns this
    this.group.updateWorldMatrix(true, true);
    if (craft) {
      out.collisionRadius = craft.collisionRadius;
      out.propTipRadius = craft.propTipRadius;
      out.fits = out.level.radius <= craft.collisionRadius + 1e-4;
    }
    return out;
  }

  /** Walk every vertex of every mesh and measure the resulting AABB + radius. */
  _measure() {
    this.group.updateWorldMatrix(true, true);
    const org = this.group.position;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let radius = 0;
    this.group.traverse((o) => {
      const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
      if (!pos || !o.matrixWorld) return;
      const e = o.matrixWorld.elements;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        // World position relative to the group origin: that is the body frame.
        const wx = e[0] * x + e[4] * y + e[8] * z + e[12] - org.x;
        const wy = e[1] * x + e[5] * y + e[9] * z + e[13] - org.y;
        const wz = e[2] * x + e[6] * y + e[10] * z + e[14] - org.z;
        if (wx < min[0]) min[0] = wx;
        if (wy < min[1]) min[1] = wy;
        if (wz < min[2]) min[2] = wz;
        if (wx > max[0]) max[0] = wx;
        if (wy > max[1]) max[1] = wy;
        if (wz > max[2]) max[2] = wz;
        const d = wx * wx + wy * wy + wz * wz;
        if (d > radius) radius = d;
      }
    });
    return {
      min: { x: min[0], y: min[1], z: min[2] },
      max: { x: max[0], y: max[1], z: max[2] },
      size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
      radius: Math.sqrt(radius),
    };
  }

  dispose() {
    while (this.group.children.length) {
      const c = this.group.children.pop();
      c.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
    }
    // Cached geometry/materials are shared by many meshes, so the traverse above
    // already disposes them several times over (harmless in three); this catches
    // anything that never made it into the graph.
    this._geo.forEach((g) => g.dispose());
    this._mats.forEach((m) => m.dispose());
    this._geo = new Map();
    this._mats = new Map();
    this.props = [];
    this.motorLeds = [];
    this.built = null;
  }
}
