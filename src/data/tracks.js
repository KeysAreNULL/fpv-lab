// Tracks.
//
// A track is a race line, a set of gates to fly through, and a set of solid
// boxes with *material tags*. The material is not decorative: it is what the RF
// solver attenuates against, so the same geometry that blocks your quad also
// eats your video, and a timber-stud wall really is see-through to a 900 MHz
// link while killing 5.8 GHz.
//
// Solid obstacles are marked `collide: false` where the drone should pass
// through (netting, flags, foliage) but the signal still passes through them.

import { curveEval } from '../core/math.js';

function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
  }
  return d;
}

// Catmull-Rom resample of a waypoint list into a smooth centre line.
function resample(pts, step = 2) {
  const out = [];
  const ext = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < ext.length - 2; i++) {
    const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
    const seg = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
    const n = Math.max(2, Math.round(seg / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
          + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
          + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        z: 0.5 * ((2 * p1.z) + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2
          + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  out.push({ ...pts[pts.length - 1] });
  return out;
}

/**
 * Turn a resampled centre line into gates, aiming each gate across the line and
 * dropping any that would sit inside a solid.
 */
function makeGates(line, { spacing = 14, radius = 1.5, startGate = true } = {}) {
  const gates = [];
  let acc = 0, next = 0;
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    if (i > 0) acc += Math.hypot(p.x - line[i - 1].x, p.z - line[i - 1].z);
    if (acc >= next) {
      gates.push({
        x: p.x, y: p.y, z: p.z,
        // Gate plane normal is the track direction.
        nx: dx / len, nz: dz / len,
        r: radius,
        type: (startGate && gates.length === 0) ? 'start' : 'normal',
        index: gates.length,
      });
      next += spacing;
    }
  }
  if (startGate && gates.length) {
    gates[0].type = 'start';
    gates[gates.length - 1].type = 'finish';
  }
  return gates;
}

const box = (x, y, z, sx, sy, sz, material, extra = {}) => ({
  x, y, z, sx, sy, sz, material, ...extra,
});

/* ------------------------------------------------------------------ tracks */

export const TRACKS = [
  {
    id: 't-hangar',
    name: 'Hangar Sprint',
    location: 'Old aircraft hangar, converted',
    tier: 0,
    brief: 'Short indoor sprint through a steel hangar. Short lines, hard walls, '
      + 'and a lot of multipath. Learn how fast 5.8 GHz falls apart indoors.',
    ground: 'concrete',
    weather: 'overcast',   // indoors: the sky is only ever seen past the doors
    interior: true,
    fog: { color: '#2b3038', near: 18, far: 190 },
    ambient: 0.55,
    key: { dir: [0.4, 0.9, 0.2], color: 0xfff2e0, intensity: 1.1 },
    fill: { color: 0x6f7d94, intensity: 0.5 },
    roof: { y: 9.5, material: 'metal' },
    // The shell is fully modelled as obstacles, and those colliders are
    // authoritative: the roof slab rests a craft at 9.50 + radius. The soft
    // bound is only a backstop for anything that escapes, so it must sit
    // *outside* the steel. Put it inside and the two fight - collideWorld
    // ejects a craft onto the roof and containInBounds drags it back through
    // the slab, straight through to the floor.
    bounds: { half: 83.2, ceiling: 10.0 },
    start: { x: -46, y: 1.3, z: 34 },
    pilot: { x: -52, y: 1.7, z: 44 },
    waypoints: [
      { x: -46, y: 1.3, z: 34 }, { x: -20, y: 2.2, z: 40 }, { x: 6, y: 3.4, z: 26 },
      { x: 24, y: 2.0, z: -4 }, { x: 8, y: 4.6, z: -32 }, { x: -22, y: 5.6, z: -20 },
      { x: -34, y: 2.4, z: 12 },
    ],
    obstacles: [
      box(0, 9.3, 0, 170, 0.4, 150, 'metal'),                       // roof slab (underside 9.1)
      box(-84, 4.6, 0, 1.6, 9.2, 150, 'metal'),                      // west wall
      box(84, 4.6, 0, 1.6, 9.2, 150, 'metal'),                       // east wall
      box(0, 4.6, -74, 170, 9.2, 1.6, 'metal'),                      // north wall
      box(0, 4.6, 74, 170, 9.2, 1.6, 'metal'),                       // south wall
      // internal partitions: drywall with a doorway gap
      box(-30, 2.6, 6, 1.2, 5.2, 44, 'drywall'),
      box(18, 2.6, 10, 1.2, 5.2, 40, 'drywall'),
      box(36, 1.6, -30, 30, 3.2, 1.2, 'plywood'),
      // crane rail and a stack of crates
      box(0, 7.6, -20, 168, 0.8, 0.8, 'metal'),
      box(-56, 1.0, -44, 6, 2.0, 6, 'plywood'),
      box(-49, 1.2, -46, 5, 2.4, 5, 'plywood'),
      box(-58, 0.9, -38, 4, 1.8, 4, 'plywood'),
    ],
    gates: { spacing: 15, radius: 1.6 },
  },
  {
    id: 't-rooftops',
    name: 'Rooftop Rush',
    location: 'City block, 14 storeys',
    tier: 1,
    brief: 'Gap-and-gap racing over rooftops. Concrete and brick everywhere, so '
      + 'your link lives or dies on how you fly the corners. Classic analog track.',
    ground: 'asphalt',
    weather: 'clear',
    fog: { color: '#9fb2c8', near: 60, far: 520 },
    ambient: 0.7,
    key: { dir: [0.5, 0.75, 0.42], color: 0xfff4e2, intensity: 1.5 },
    fill: { color: 0x9ab4d8, intensity: 0.7 },
    roof: null,
    bounds: { half: 190, ceiling: 90 },
    start: { x: 0, y: 34, z: 60 },
    pilot: { x: -6, y: 36, z: 72 },
    waypoints: [
      { x: 0, y: 34, z: 60 }, { x: 34, y: 40, z: 30 }, { x: 52, y: 46, z: -14 },
      { x: 26, y: 52, z: -52 }, { x: -18, y: 48, z: -60 }, { x: -48, y: 44, z: -22 },
      { x: -30, y: 38, z: 16 },
    ],
    obstacles: (() => {
      const o = [];
      // A grid of buildings with roofs at various heights. Gaps are the race.
      const blocks = [
        [-60, -60, 30, 12, 26], [-20, -70, 34, 16, 30], [20, -66, 28, 14, 24],
        [56, -46, 26, 12, 20], [62, -6, 24, 10, 22], [58, 30, 30, 14, 26],
        [16, 44, 34, 16, 30], [-26, 48, 30, 12, 28], [-56, 34, 26, 10, 24],
        [-64, -8, 28, 12, 24],
      ];
      for (const [x, z, w, d, h] of blocks) {
        const mats = ['brick', 'concrete', 'reinforced'];
        o.push(box(x, h / 2, z, w, h, d, mats[(x + z) % 3 | 0]));
        o.push(box(x, h + 0.3, z, w + 0.6, 0.6, d + 0.6, 'concrete'));   // parapet
      }
      // A water tower and a rooftop AC plant for landmark interest
      o.push(box(52, 54, -14, 5, 8, 5, 'metal'));
      o.push(box(26, 54.5, -52, 7, 3, 6, 'metal'));
      // Antenna mast: thin, metal, a real RF shadow caster
      o.push(box(-48, 30, -22, 0.6, 60, 0.6, 'metal'));
      return o;
    })(),
    gates: { spacing: 17, radius: 1.7 },
  },
  {
    id: 't-suburb',
    name: 'Suburb Scramble',
    location: 'Residential street',
    tier: 2,
    brief: 'Timber-frame houses with plasterboard walls and glass windows. The '
      + 'link budget exercise: 900 MHz punches through where 5.8 GHz dies, and '
      + 'the trees eat everything.',
    ground: 'grass',
    weather: 'hazy',
    fog: { color: '#a8bcd0', near: 50, far: 320 },
    ambient: 0.75,
    key: { dir: [0.3, 0.85, 0.45], color: 0xfff0d8, intensity: 1.3 },
    fill: { color: 0xa8c4e0, intensity: 0.65 },
    roof: null,
    bounds: { half: 140, ceiling: 40 },
    start: { x: -70, y: 2.0, z: 6 },
    pilot: { x: -78, y: 1.7, z: 14 },
    waypoints: [
      { x: -70, y: 2.0, z: 6 }, { x: -40, y: 3.4, z: -18 }, { x: -6, y: 4.6, z: -30 },
      { x: 30, y: 3.0, z: -16 }, { x: 44, y: 5.2, z: 18 }, { x: 12, y: 6.4, z: 34 },
      { x: -30, y: 4.0, z: 26 },
    ],
    obstacles: (() => {
      const o = [];
      const houses = [
        [-58, -6, 12, 10], [-30, -14, 11, 12], [-2, -20, 13, 10], [26, -8, 11, 11],
        [38, 12, 12, 10], [18, 28, 10, 12], [-8, 30, 12, 11], [-38, 20, 11, 10],
        [-66, 12, 12, 12], [58, -24, 12, 12],
      ];
      for (const [x, z, w, d] of houses) {
        o.push(box(x, 1.6, z, w, 3.2, d, 'woodStud'));            // timber frame
        o.push(box(x, 3.45, z, w + 1.0, 0.5, d + 1.0, 'plywood')); // roof
        o.push(box(x + w / 2 - 0.3, 1.9, z, 0.3, 1.2, d * 0.5, 'glass')); // window
      }
      // Trees: foliage attenuates badly and is solid to the drone
      for (let i = 0; i < 26; i++) {
        const a = i * 2.399, r = 26 + (i % 7) * 12;
        const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.8;
        if (Math.abs(x) > 120 || Math.abs(z) > 120) continue;
        o.push(box(x, 4, z, 5, 8, 5, 'foliage'));
        o.push(box(x, 1.6, z, 0.6, 3.2, 0.6, 'wood'));
      }
      // A couple of solid brick landmarks
      o.push(box(-20, 3.0, 4, 6, 6, 6, 'brick'));
      o.push(box(50, 2.4, 34, 10, 4.8, 8, 'brick'));
      // Chain-link fence: solid to the drone, mostly transparent to RF
      o.push(box(0, 1.4, -40, 150, 2.8, 0.2, 'mesh'));
      return o;
    })(),
    gates: { spacing: 15, radius: 1.5 },
  },
  {
    id: 't-forest',
    name: 'Forest Run',
    location: 'Pine forest, 200 m field of view',
    tier: 2,
    brief: 'Big trees, narrow gaps, dappled canopy. Deep foliage is brutal on '
      + 'video: expect snow the moment the canopy closes over you.',
    ground: 'dirt',
    weather: 'overcast',
    fog: { color: '#9db2a6', near: 30, far: 260 },
    ambient: 0.7,
    key: { dir: [0.25, 0.9, 0.35], color: 0xe8f4d8, intensity: 1.35 },
    fill: { color: 0x8fa890, intensity: 0.6 },
    roof: null,
    bounds: { half: 170, ceiling: 60 },
    start: { x: -90, y: 2.2, z: 10 },
    pilot: { x: -100, y: 1.8, z: 18 },
    waypoints: [
      { x: -90, y: 2.2, z: 10 }, { x: -56, y: 5.0, z: -26 }, { x: -18, y: 7.5, z: -46 },
      { x: 22, y: 5.5, z: -30 }, { x: 34, y: 8.5, z: 8 }, { x: 4, y: 11.0, z: 34 },
      { x: -40, y: 6.0, z: 30 },
    ],
    obstacles: (() => {
      const o = [];
      let seed = 12345;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let i = 0; i < 150; i++) {
        const x = (rnd() - 0.5) * 300, z = (rnd() - 0.5) * 300;
        // leave the race corridor roughly clear
        const h = 12 + rnd() * 14;
        o.push(box(x, h / 2, z, 1.1, h, 1.1, 'wood'));
        o.push(box(x, h + 2.4, z, 9 + rnd() * 5, 6.5, 9 + rnd() * 5, 'foliage'));
      }
      // A wooden cabin and a watchtower
      o.push(box(-30, 1.8, 4, 8, 3.6, 7, 'woodStud'));
      o.push(box(58, 5, 20, 4, 10, 4, 'wood'));
      o.push(box(58, 10.4, 20, 5, 0.6, 5, 'plywood'));
      return o;
    })(),
    gates: { spacing: 16, radius: 1.6 },
  },
  {
    id: 't-tower',
    name: 'Desert Tower',
    location: 'Dry riverbed, 1.2 km line of sight',
    tier: 4,
    brief: 'A long-range line across open desert. Nothing attenuates, so this is '
      + 'where a 25 mW digital link and a 1 W analog link behave completely '
      + 'differently - and where a big pack finally makes sense.',
    ground: 'sand',
    weather: 'dusk',
    fog: { color: '#d8c8a8', near: 180, far: 1400 },
    ambient: 0.85,
    key: { dir: [0.2, 0.6, 0.75], color: 0xfff2d0, intensity: 1.7 },
    fill: { color: 0xd8c8a8, intensity: 0.8 },
    roof: null,
    bounds: { half: 420, ceiling: 220 },
    start: { x: -320, y: 2.0, z: 0 },
    pilot: { x: -336, y: 2.2, z: 8 },
    waypoints: [
      { x: -320, y: 2.0, z: 0 }, { x: -220, y: 14, z: -40 }, { x: -100, y: 26, z: -20 },
      { x: 20, y: 34, z: -50 }, { x: 110, y: 22, z: -10 }, { x: 60, y: 12, z: 40 },
      { x: -80, y: 18, z: 46 }, { x: -230, y: 10, z: 30 },
    ],
    obstacles: (() => {
      const o = [];
      // a rock tower: the landmark, and a real shadow caster
      o.push(box(20, 40, -50, 26, 80, 26, 'concrete'));
      o.push(box(20, 84, -50, 16, 8, 16, 'concrete'));
      o.push(box(20, 96, -50, 2, 16, 2, 'metal'));
      // scattered boulders
      for (let i = 0; i < 40; i++) {
        const a = i * 2.399, r = 60 + (i % 9) * 34;
        o.push(box(Math.cos(a) * r, 2, Math.sin(a) * r, 5 + (i % 5) * 3, 4, 5 + (i % 4) * 3, 'concrete'));
      }
      // an old farm shed
      o.push(box(-140, 2, 24, 14, 4, 10, 'brick'));
      return o;
    })(),
    gates: { spacing: 46, radius: 4.0 },
  },
];

// Precompute the racing lines so the UI and physics do not rebuild them.
for (const t of TRACKS) {
  t.line = resample(t.waypoints, 2);
  t.lengthM = pathLength(t.line);
  t.gateList = makeGates(t.line, t.gates);
  t.collision = t.obstacles.filter((o) => o.material !== 'mesh' && o.material !== 'foliage' && o.material !== 'rubber');
}

export function getTrack(id) { return TRACKS.find((t) => t.id === id) || TRACKS[0]; }

/** Shortest distance from a point to the racing line, and the index. */
export function distanceToLine(track, x, y, z) {
  let best = Infinity, bi = 0;
  const line = track.line;
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    const d = (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2;
    if (d < best) { best = d; bi = i; }
  }
  return { dist: Math.sqrt(best), index: bi };
}

/** Progress along the line, 0..1. */
export function lineProgress(track, index) {
  return track.line.length ? index / (track.line.length - 1) : 0;
}
