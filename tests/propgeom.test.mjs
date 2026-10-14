// Prop blade geometry: are the blades coplanar, and do they push the right way?
//
// Both of these were wrong at once and neither is visible from any single angle:
// every blade was pitched about a fixed world axis instead of its own radial
// axis, so the four blades came out -9.2 / 0.0 / +9.2 / 0.0 degrees - an 18.4 deg
// spread - and the sign was backwards, making a reverse-pitch prop.
import * as THREE from '../vendor/three.module.js';

let fails = 0;
const ok = (cond, label, detail) => {
  if (cond) console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`);
  else { console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); fails++; }
};

const DEG = Math.PI / 180;

/**
 * Build one prop the way droneMesh._buildProp does, from a spec.
 * Mirrors the source deliberately: if the source changes, this test is the
 * thing that has to be updated with it, and it is the thing that catches it.
 */
function buildPropBlades(spec) {
  const D = spec.D__mm / 1000;
  const r = D / 2;
  const shape = new THREE.Shape();
  const rootX = r * 0.17;
  const cRoot = r * 0.30, cMid = r * 0.62, cTip = r * 0.42;
  const tipX = r * 0.985;
  shape.moveTo(rootX, -cRoot / 2);
  shape.bezierCurveTo(r * 0.42, -cRoot * 0.42, r * 0.74, -cMid * 0.44, tipX, -cTip * 0.26);
  shape.quadraticCurveTo(2 * r - tipX, 0, tipX, cTip * 0.26);
  shape.bezierCurveTo(r * 0.72, cMid * 0.46, r * 0.40, cRoot * 0.40, rootX, cRoot / 2);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.0012, D * 0.014), bevelEnabled: false });

  const pitchAngle = Math.min(0.30, Math.max(0.06,
    Math.atan2(spec.pitch__mm / 1000, 0.75 * D) * 0.35));

  const capIdx = [];
  const n = geo.attributes.normal;
  for (let i = 0; i < n.count; i++) if (n.getZ(i) > 0.9) capIdx.push(i);

  const out = [];
  for (let b = 0; b < spec.blades; b++) {
    const t = (b / spec.blades) * Math.PI * 2;
    const arm = new THREE.Group();
    arm.rotation.z = t;
    const blade = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    blade.rotation.x = -pitchAngle;      // as fixed in droneMesh.js
    arm.add(blade);
    arm.updateMatrixWorld(true);

    const nm = new THREE.Matrix3().setFromMatrix4(blade.matrixWorld).invert().transpose();
    const acc = new THREE.Vector3(), tmp = new THREE.Vector3();
    for (const i of capIdx) {
      tmp.set(n.getX(i), n.getY(i), n.getZ(i)).applyMatrix3(nm);
      acc.add(tmp);
    }
    acc.normalize();
    if (acc.z > 0) acc.negate();          // point it "up" (-Z is up in NED)

    const u = new THREE.Vector3(Math.cos(t), Math.sin(t), 0);
    const d = new THREE.Vector3().crossVectors(u, new THREE.Vector3(0, 0, 1));
    out.push({
      angle: t,
      pitch: Math.asin(Math.max(-1, Math.min(1, acc.dot(d)))) / DEG,
      tilt: Math.acos(Math.min(1, Math.abs(acc.z))) / DEG,
    });
  }
  return { blades: out, pitchAngle: pitchAngle / DEG };
}

const SPECS = [
  { name: '5x4.3x3 (2 blade)', D__mm: 127, pitch__mm: 109, blades: 2 },
  { name: '5x3.5x3 (3 blade)', D__mm: 127, pitch__mm: 89, blades: 3 },
  { name: '3-blade cinewhoop', D__mm: 81, pitch__mm: 58, blades: 3 },
  { name: '7x4 (2 blade)', D__mm: 178, pitch__mm: 119, blades: 2 },
  { name: '10x4.5 (5 blade)', D__mm: 254, pitch__mm: 133, blades: 5 },
];

console.log('--- the blades must be coplanar ---');
for (const s of SPECS) {
  const { blades, pitchAngle } = buildPropBlades(s);
  const pitches = blades.map((b) => b.pitch);
  const spread = Math.max(...pitches) - Math.min(...pitches);
  ok(spread < 0.5, `${s.name}: every blade pitched the same`,
    `spread ${spread.toFixed(3)} deg across ${blades.length} blades`
    + ` (asked ${pitchAngle.toFixed(1)} deg)`);
}

console.log('\n--- and they must push the craft UP ---');
// The props spin with rotation.z decreasing, so the relative airflow on a blade
// runs along u x Z. A correct blade leans into it, giving a positive pitch about
// its own radial axis. Negative means a reverse-pitch prop.
for (const s of SPECS) {
  const { blades } = buildPropBlades(s);
  ok(blades.every((b) => b.pitch > 0),
    `${s.name}: pitch sign produces upward thrust`,
    `${blades[0].pitch.toFixed(1)} deg about own axis`);
}

console.log('\n--- the pitch is actually there, and bounded ---');
for (const s of SPECS) {
  const { blades, pitchAngle } = buildPropBlades(s);
  const p = blades[0].pitch;
  // The source clamps the pitch angle to [0.06, 0.30] RADIANS (0.6 - 17.2 deg).
  const maxDeg = 0.31 * 180 / Math.PI;
  ok(p > 0.5 && p <= maxDeg,
    `${s.name}: pitch is visible but the disc still reads as a disc`,
    `${p.toFixed(1)} deg, max ${maxDeg.toFixed(1)}`);
  const tilt = blades[0].tilt;
  ok(Math.abs(tilt - p) < 0.5, `${s.name}: tilt from the disc plane matches the pitch`,
    `${tilt.toFixed(1)} deg`);
}

console.log(`\n${fails === 0 ? 'all prop geometry checks passed' : fails + ' prop geometry check(s) FAILED'}`);
process.exit(fails ? 1 : 0);