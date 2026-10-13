// Drone model, built from the actual build spec.
//
// The geometry is derived from the parts, so swapping to a 10" frame really does
// give you a visibly different machine: longer arms, bigger props, a fatter
// pack, a different camera pod. Props spin at their real rpm, motors glow when
// they are current-limited, and the antenna is where the RF model says it is.

import * as THREE from '../../vendor/three.module.js';
import { clamp } from '../core/math.js';

// Palette. Real carbon fibre and black anodising are very dark, and under a
// neutral studio light a literal rendering of those values is an unreadable
// silhouette. These are lifted into a range that still reads as dark technical
// hardware but keeps its form: carbon catches light along its weave, the
// aluminium arms separate from the plates, and props stay distinguishable.
const MAT = {
  carbon: 0x4a525d, carbonLight: 0x646e7a, alu: 0xa8b0ba, black: 0x35393f,
  motor: 0x8a929c, propA: 0x3a4048, propB: 0xccd4dd, glow: 0x4fd18b,
  warn: 0xf0a04a, bad: 0xf05a4a, battery: 0x4c5a6e, gold: 0xd8b45c,
};

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

export class DroneModel {
  constructor() {
    this.group = new THREE.Group();
    this.props = [];
    this.motorLeds = [];
    this.built = null;
  }

  /** Rebuild when the spec changes. */
  build(craft) {
    this.dispose();
    const g = this.group;
    const frame = craft.frame, motorS = craft.motor, propS = craft.prop, battS = craft.battSpec;
    const hubs = craft.props.map((p) => p.propPos);
    const armLen = Math.hypot(hubs[0].x, hubs[0].y);

    const carbon = mat(MAT.carbon);
    const carbonL = mat(MAT.carbonLight);
    const alu = mat(MAT.alu);

    /* --- frame plates: bottom and top, sized from the real plate area */
    // cm^2 -> m^2 is /1e4. Dividing by 100 made a 190 cm2 plate 1.38 m across,
    // a ten-times oversize slab that swallowed the whole airframe: the props and
    // motors ended up as four bumps at the corners of a huge square, which read
    // as "the props are diagonal to the quad".
    const plateSide = Math.sqrt(frame.plateArea__cm2 / 1e4);
    const bottomZ = 0.0008;
    const topZ = -frame.stackHeight__mm / 1000;
    const plates = new THREE.Mesh(new THREE.BoxGeometry(plateSide, plateSide, 0.0018), carbon);
    plates.position.set(0, 0, bottomZ);
    g.add(plates);
    const top = new THREE.Mesh(new THREE.BoxGeometry(plateSide * 0.6, plateSide * 0.6, 0.0016), carbonL);
    top.position.set(0.02, 0, topZ);
    g.add(top);

    /* --- arms */
    // The box runs along its local X, and it is centred on the halfway point of
    // the hub offset, so a rotation of +atan2(y, x) lays it from the centre out
    // to the motor. The sign matters: with -atan2 the left and right arms
    // mirrored onto each other and the frame drew as two crossed sticks.
    const armGeo = new THREE.BoxGeometry(armLen * 2, 0.011, 0.016);
    for (let i = 0; i < 4; i++) {
      const h = hubs[i];
      const arm = new THREE.Mesh(armGeo, carbonL);
      arm.position.set(h.x / 2, h.y / 2, h.z * 0.5);
      arm.rotation.z = Math.atan2(h.y, h.x);
      g.add(arm);
    }

    /* --- stack */
    const stackH = 0.014;
    const esc = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.032, stackH), alu);
    esc.position.set(0.02, 0, topZ - stackH / 2 - 0.001);
    g.add(esc);
    const fc = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.024, 0.004), mat(MAT.black));
    fc.position.set(0.02, 0, topZ - stackH - 0.003);
    g.add(fc);

    /* --- battery, with a strap */
    const bh = Math.max(0.028, battS.cells * 0.0105);
    const batt = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.038, bh), mat(MAT.battery));
    batt.position.set(battS.cells >= 6 ? 0.010 : 0.004, 0, bh / 2 + 0.004);
    g.add(batt);
    this.batteryMesh = batt;
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.040, bh + 0.002), mat(MAT.gold));
    strap.position.set(batt.position.x - 0.01, 0, bh / 2 + 0.004);
    g.add(strap);

    /* --- camera pod, tilted like the real one */
    // The body frame is NED with +X out of the nose, so the lens points along +X
    // and the tilt is a rotation about the lateral (+Y) axis: nose-up tilt.
    const cam = new THREE.Group();
    const bodyC = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.019, 0.019), mat(MAT.black));
    cam.add(bodyC);
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.007, 0.008, 12), mat(0x101418));
    lens.rotation.z = -Math.PI / 2;          // cylinder axis Y -> X (the nose)
    lens.position.x = 0.013;
    cam.add(lens);
    cam.position.set(0.024, 0, topZ - 0.022);
    cam.rotation.y = (frame.camTilt__deg || 20) * Math.PI / 180;
    g.add(cam);
    this.cameraPod = cam;

    /* --- VTX + duck antenna, at the same place the RF model assumes */
    const vtx = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.016, 0.006), alu);
    vtx.position.set(-0.006, 0, topZ - 0.014);
    g.add(vtx);
    this.antennaPivot = new THREE.Group();
    this.antennaPivot.position.set(-0.048, 0, topZ - 0.045);
    const antRod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0022, 0.0022, 0.042, 8), mat(0xd8dde2));
    antRod.position.y = 0.021;
    this.antennaPivot.add(antRod);
    const antBase = new THREE.Mesh(new THREE.SphereGeometry(0.005, 10, 8), mat(MAT.gold));
    this.antennaPivot.add(antBase);
    // Lean the antenna back and up: the local axis the RF model uses is
    // (-0.55, 0, -0.83), i.e. back and up, so align the rod with it.
    const dir = new THREE.Vector3(-0.55, 0, -0.83).normalize();
    this.antennaPivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.add(this.antennaPivot);
    this.antenna = this.antennaPivot;

    /* --- motors and props */
    const mR = motorS.stator / 1000 * 0.72;
    const mH = motorS.height__mm / 1000;
    this.props = [];
    this.motorLeds = [];
    for (let i = 0; i < 4; i++) {
      const h = hubs[i];
      const motor = new THREE.Mesh(
        new THREE.CylinderGeometry(mR, mR, mH, 16), mat(MAT.motor));
      motor.rotation.x = Math.PI / 2;
      motor.position.set(h.x, h.y, h.z - mH / 2);
      g.add(motor);
      const bell = new THREE.Mesh(
        new THREE.CylinderGeometry(mR * 1.05, mR * 1.02, mH * 0.45, 16), mat(0x8f98a3));
      bell.rotation.x = Math.PI / 2;
      bell.position.set(h.x, h.y, h.z - mH * 0.78);
      g.add(bell);

      // status ring: green when clean, amber when current-limited, red on desync
      const led = new THREE.Mesh(
        new THREE.TorusGeometry(mR * 1.18, mR * 0.10, 6, 20),
        new THREE.MeshBasicMaterial({ color: MAT.glow }));
      led.position.set(h.x, h.y, h.z - mH * 0.5);
      g.add(led);
      this.motorLeds.push(led);

      const prop = this._buildProp(propS);
      prop.position.set(h.x, h.y, h.z - mH - 0.002);
      g.add(prop);
      this.props.push(prop);
    }

    // The key has to be the *stringified* spec: `update` compares against a string,
    // and storing the object here made the test fail every frame, which tore the
    // whole model down and rebuilt it 60 times a second.
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
    const mProp = mat(MAT.propA);
    const shape = new THREE.Shape();
    // Simple aerofoil-ish blade outline: root, sweep, rounded tip.
    const r = D / 2;
    shape.moveTo(r * 0.14, -r * 0.09);
    shape.bezierCurveTo(r * 0.45, -r * 0.16, r * 0.8, -r * 0.12, r, -r * 0.035);
    shape.quadraticCurveTo(r * 1.01, 0, r, r * 0.035);
    shape.bezierCurveTo(r * 0.8, r * 0.12, r * 0.45, r * 0.16, r * 0.14, r * 0.09);
    shape.closePath();
    // Blade *thickness*, scaled off the diameter: a 5" blade is ~1.5 mm.
    // `pitch__mm` is the prop's geometric pitch (109 mm for a 5x4.3), not a
    // thickness - extruding by it made each blade a 10 cm slab, as thick as the
    // whole airframe.
    const depth = Math.max(0.0012, D * 0.014);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: false, curveSegments: 8,
    });
    geo.translate(0, 0, -depth / 2);      // centre the blade on the disc plane
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
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.hub__mm / 2000, spec.hub__mm / 2000, 0.004, 12),
      mat(MAT.propB));
    hub.rotation.x = Math.PI / 2;      // cylinder axis Y -> Z (the spin axis)
    grp.add(hub);
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
    this.props = [];
    this.motorLeds = [];
    this.built = null;
  }
}
