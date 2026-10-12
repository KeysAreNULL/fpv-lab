// Surface materials for the track geometry.
//
// Textures are CC0 scans from ambientCG, vendored under assets/textures so the
// app still runs with no network. Each material gets a colour, a normal and a
// roughness map, which is what makes flat boxes read as real surfaces under a
// directional light instead of as flat colour.
//
// Everything degrades gracefully: if a map is missing the material still builds
// from its tint alone, so a partial download cannot produce a black scene.

import * as THREE from '../../vendor/three.module.js';

/**
 * Track material name -> vendored texture set.
 * `scale` is texture repeats per metre, tuned so a 170 m hangar wall and a 5 m
 * crate show roughly the same grain size.
 */
const SETS = {
  concrete: { maps: 'Concrete034', scale: 0.35, roughness: 0.92, metalness: 0.0, color: 0x8b8f94 },
  reinforced: { maps: 'Concrete034', scale: 0.3, roughness: 0.88, metalness: 0.0, color: 0x92969b },
  metal: { maps: 'MetalPlates006', scale: 0.22, roughness: 0.46, metalness: 0.75, color: 0x9aa3ad },
  drywall: { maps: 'Plaster007', scale: 0.4, roughness: 0.95, metalness: 0.0, color: 0xa8acb2 },
  plywood: { maps: 'Wood062', scale: 0.5, roughness: 0.78, metalness: 0.0, color: 0xa8825a },
  wood: { maps: 'Wood062', scale: 0.45, roughness: 0.8, metalness: 0.0, color: 0x946f4c },
  woodStud: { maps: 'Wood062', scale: 0.8, roughness: 0.8, metalness: 0.0, color: 0x9c7852 },
  brick: { maps: 'Bricks105', scale: 0.3, roughness: 0.9, metalness: 0.0, color: 0x9c8074 },
  asphalt: { maps: 'Asphalt033', scale: 0.25, roughness: 0.96, metalness: 0.0, color: 0x7e8085 },
  grass: { maps: 'Grass001', scale: 0.5, roughness: 0.95, metalness: 0.0, color: 0x7d9468 },
  foliage: { maps: 'Grass001', scale: 0.8, roughness: 0.95, metalness: 0.0, color: 0x6f8a5c },
  glass: { maps: null, scale: 1, roughness: 0.08, metalness: 0.0, color: 0x9fc4d8, opacity: 0.25 },
  mesh: { maps: null, scale: 1, roughness: 0.6, metalness: 0.4, color: 0x6a7078, opacity: 0.35 },
  rubber: { maps: null, scale: 1, roughness: 0.98, metalness: 0.0, color: 0x4a4d52 },
  dirt: { maps: 'Concrete034', scale: 0.3, roughness: 0.98, metalness: 0.0, color: 0x7a644c },
  sand: { maps: 'Concrete034', scale: 0.28, roughness: 0.97, metalness: 0.0, color: 0xa08e68 },
};

/** Ground surfaces are single large planes rather than boxes. */
const GROUND_SETS = {
  concrete: { maps: 'Concrete034', scale: 0.12, roughness: 0.93, color: 0x6e7276 },
  asphalt: { maps: 'Asphalt033', scale: 0.1, roughness: 0.96, color: 0x5f6268 },
  grass: { maps: 'Grass001', scale: 0.22, roughness: 0.95, color: 0x63784f },
  dirt: { maps: 'Concrete034', scale: 0.11, roughness: 0.98, color: 0x6f5c46 },
  sand: { maps: 'Concrete034', scale: 0.1, roughness: 0.97, color: 0x8d7f5e },
};

// A single manager gives correct global accounting. Attaching load listeners to
// each texture after requesting it races the loader - a cached texture can
// finish before the listener exists, and the count silently never moves.
const manager = new THREE.LoadingManager();
const loader = new THREE.TextureLoader(manager);
const texCache = new Map();
const matCache = new Map();
const basePath = 'assets/textures/';

export const TEXTURES_READY = { done: false, loaded: 0, failed: 0, total: 0 };

manager.onProgress = (_url, loaded, total) => {
  TEXTURES_READY.loaded = loaded;
  TEXTURES_READY.total = total;
};
manager.onLoad = () => { TEXTURES_READY.done = true; };
manager.onError = () => { TEXTURES_READY.failed++; };

function loadTex(name, slot) {
  const key = `${name}_${slot}`;
  if (texCache.has(key)) return texCache.get(key);
  const t = loader.load(`${basePath}${name}_${slot}.jpg`);
  // Repeats and wrapping are set per use site via clone(), so the cached
  // texture itself stays unmodified.
  t.colorSpace = slot === 'Color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  texCache.set(key, t);
  return t;
}

/** Kick off every map we might need. Safe to call repeatedly. */
export function preloadTextures(onProgress) {
  const names = new Set();
  for (const s of Object.values(SETS)) if (s.maps) names.add(s.maps);
  for (const s of Object.values(GROUND_SETS)) if (s.maps) names.add(s.maps);
  for (const n of names) for (const slot of ['Color', 'NormalGL', 'Roughness']) loadTex(n, slot);
  if (onProgress) manager.onProgress = (u, l, t) => { TEXTURES_READY.loaded = l; TEXTURES_READY.total = t; onProgress(TEXTURES_READY); };
  return TEXTURES_READY;
}

/**
 * Rescales a box geometry's UVs so texel density is constant in world space.
 * BoxGeometry gives every face a 0..1 UV, so without this a 170 m wall and a
 * 0.4 m crate would show identical texture size. Face order is +X -X +Y -Y
 * +Z -Z, four vertices each for a single segment.
 */
export function scaleBoxUV(geo, sx, sy, sz, perMetre) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  // Per-face u/v extents in metres, in BoxGeometry face order.
  const spans = [
    [sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy],
  ];
  for (let f = 0; f < 6; f++) {
    const [uSpan, vSpan] = spans[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * uSpan * perMetre, uv.getY(k) * vSpan * perMetre);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

function applyMaps(set, repeat) {
  const out = {};
  if (!set.maps) return out;
  const color = loadTex(set.maps, 'Color');
  const normal = loadTex(set.maps, 'NormalGL');
  const rough = loadTex(set.maps, 'Roughness');
  // Cloning is required: repeat differs between a big ground plane and a small
  // crate, and the cached texture is shared.
  for (const [k, t] of [['map', color], ['normalMap', normal], ['roughnessMap', rough]]) {
    const c = t.clone();
    c.needsUpdate = true;
    c.wrapS = c.wrapT = THREE.RepeatWrapping;
    if (repeat) c.repeat.set(repeat[0], repeat[1]);
    out[k] = c;
  }
  return out;
}

/** Shared material for a track surface. Cached - one draw setup per material. */
export function surfaceMaterial(name) {
  if (matCache.has(name)) return matCache.get(name);
  const set = SETS[name] || SETS.concrete;
  const m = new THREE.MeshStandardMaterial({
    color: set.color,
    roughness: set.roughness,
    metalness: set.metalness,
    ...applyMaps(set, null),
  });
  if (set.opacity != null) { m.transparent = true; m.opacity = set.opacity; }
  matCache.set(name, m);
  return m;
}

/** Ground plane material. Separate cache: different tiling and much larger. */
export function groundMaterial(kind) {
  const key = `ground:${kind}`;
  if (matCache.has(key)) return matCache.get(key);
  const set = GROUND_SETS[kind] || GROUND_SETS.concrete;
  const m = new THREE.MeshStandardMaterial({
    color: set.color,
    roughness: set.roughness,
    metalness: 0,
    ...applyMaps(set, [1, 1]),
  });
  matCache.set(key, m);
  return m;
}

export const SURFACE_NAMES = Object.keys(SETS);
