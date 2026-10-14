// Scenery: real geometry for the track obstacles.
//
// The obstacle list in `data/tracks.js` is authoritative - it is what the RF
// solver attenuates against and what the collider list is built from - and none
// of it is changed here. Every model below is fitted INSIDE (or flush with) the
// collision box its obstacle describes, because a visual that runs on past its
// collider is a lie a pilot can crash on. The one exception the data explicitly
// buys us is a roof overhang: a house's roof obstacle is wider than its wall
// obstacle, and the eave is only allowed to project into that wider box.
//
// Three rules shape this file:
//
// 1. **Determinism.** Every per-object random choice comes from `rng(seed)` with
//    the seed hashed out of the obstacle's own position, so two sessions build a
//    byte-identical world. `Math.random()` appears nowhere in this module.
// 2. **Shared geometry.** 150 conifers built as 150 unique meshes with 900
//    unique cone geometries is 900 draw calls. Instead every scatter type is
//    driven by one `InstancedMesh` per material, and per-tree variation comes
//    from rotation / scale / position / instance colour. A forest costs ~2.
// 3. **Lifetime.** Materials and geometries are created per build and reached
//    from the group that goes into `trackGroup`, which is exactly what
//    `Viewport.clearTrack()` walks and disposes. Only the downloaded asset
//    templates are cached, and those are immutable shared source data.
//
// A note on the downloaded assets: `vendor/GLTFLoader.js` CANNOT be imported.
// Lines 72-73 of that file re-declare `TriangleFanDrawMode` and
// `TriangleStripDrawMode`, which lines 60-61 already import from three.js, so
// the module is a hard `SyntaxError` and takes the whole module graph with it -
// importing it stops the whole app booting. `vendor/**` is out of scope here, so
// the ~90 lines of glTF reader below read these particular files directly. They
// are all the same shape: one external `.bin`, primitives carrying
// POSITION / NORMAL / TEXCOORD_0 (plus COLOR_0 on the rocks) with SCALAR
// indices, and one PBR material pointing at three JPEGs.

import * as THREE from '../../vendor/three.module.js';
import { rng } from '../core/math.js';
import { surfaceMaterial, scaleBoxUV } from './materials.js';

/* ========================================================== small utilities */

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

/**
 * Stable per-obstacle seed. The obstacle's own numbers are the entropy, so the
 * same tree is the same tree in every session and in every viewport - the sim
 * and race viewports each build the same track independently.
 */
function obsSeed(o, salt = 0) {
  let h = 2166136261 >>> 0;
  const parts = [o.x * 7.31, o.y * 3.17, o.z * 5.73, o.sx * 1.19, o.sy * 2.37, o.sz * 0.97, salt * 0.733];
  for (const v of parts) {
    h ^= (Math.round(v * 1000) | 0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Compose a TRS matrix. Returns a fresh matrix; the scratch objects are reused. */
function trs(px, py, pz, ex, ey, ez, sx, sy, sz) {
  _e.set(ex || 0, ey || 0, ez || 0);
  _q.setFromEuler(_e);
  _v.set(px, py, pz);
  _s.set(sx, sy == null ? sx : sy, sz == null ? sx : sz);
  return _m.compose(_v, _q, _s).clone();
}

/** Matrix for a unit-Y shape whose axis runs from (px,py,pz) towards d. */
function aim(px, py, pz, dx, dy, dz, sx, sy, sz) {
  _v.set(dx, dy, dz).normalize();
  _q.setFromUnitVectors(_up, _v);
  _e.set(0, 0, 0);
  _s.set(sx, sy, sz);
  _v.set(px, py, pz);
  return _m.compose(_v, _q, _s).clone();
}

function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

/**
 * Concatenate geometries into one buffer. `BufferGeometryUtils` is not
 * vendored and there is no build step, so the merge is done by hand. Every input
 * must carry position / normal / uv, which everything here does.
 */
function mergeGeos(list) {
  const geos = list.filter(Boolean);
  if (!geos.length) return null;
  if (geos.length === 1) return geos[0];
  let vc = 0, ic = 0;
  for (const g of geos) {
    vc += g.attributes.position.count;
    ic += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vc * 3);
  const nrm = new Float32Array(vc * 3);
  const uv = new Float32Array(vc * 2);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    pos.set(p.array.subarray(0, p.count * 3), vo * 3);
    if (g.attributes.normal) nrm.set(g.attributes.normal.array.subarray(0, p.count * 3), vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, p.count * 2), vo * 2);
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = i + vo;
      io += p.count;
    }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** Merge and immediately throw the inputs away - they were only staging. */
function bake(list) {
  const merged = mergeGeos(list);
  for (const g of list) if (g && g !== merged) g.dispose();
  return merged;
}

/** A translated / rotated box with world-scaled UVs (constant texel density). */
function boxGeo(w, h, d, x, y, z, ry = 0, per = 0.35) {
  const g = new THREE.BoxGeometry(w, h, d);
  scaleBoxUV(g, w, h, d, per);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/** A box expressed as (min corner -> max corner) in local space. */
function spanGeo(x0, y0, z0, x1, y1, z1, per = 0.35) {
  return boxGeo(x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, 0, per);
}

const axis = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * A wall panel standing in the local XY plane with rectangular holes punched in
 * it. The cut lines are collected from the opening edges, so N openings cost
 * one box per empty grid cell. Used for every opening in the project.
 */
function wallGeo(w, h, t, openings, per = 0.4) {
  const op = openings || [];
  const xs = new Set([-w / 2, w / 2]);
  const ys = new Set([-h / 2, h / 2]);
  for (const o of op) {
    xs.add(axis(o.x - o.w / 2, -w / 2, w / 2));
    xs.add(axis(o.x + o.w / 2, -w / 2, w / 2));
    ys.add(axis(o.y - o.h / 2, -h / 2, h / 2));
    ys.add(axis(o.y + o.h / 2, -h / 2, h / 2));
  }
  const X = [...xs].sort((a, b) => a - b);
  const Y = [...ys].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < X.length - 1; i++) {
    for (let j = 0; j < Y.length - 1; j++) {
      const cx = (X[i] + X[i + 1]) / 2;
      const cy = (Y[j] + Y[j + 1]) / 2;
      let solid = true;
      for (const o of op) {
        if (Math.abs(cx - o.x) < o.w / 2 - 1e-6 && Math.abs(cy - o.y) < o.h / 2 - 1e-6) { solid = false; break; }
      }
      if (!solid) continue;
      parts.push(boxGeo(X[i + 1] - X[i], Y[j + 1] - Y[j], t, cx, cy, 0, 0, per));
    }
  }
  return parts.length ? bake(parts) : null;
}

/** A right-triangle prism (a gable), extruded along Z, sitting on y = 0. */
function gableGeo(w, h, t, per = 0.4) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
  g.translate(0, 0, -t / 2);
  const uv = g.attributes.uv;
  if (uv) { for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * per, uv.getY(i) * per); }
  return g;
}

/**
 * Frame, transom and recessed pane for one opening, in the local frame of a
 * wall panel of thickness `t`. The pane sits behind the face, the frame proud
 * of it, which is what makes an opening read as a hole rather than a sticker.
 */
function windowGeo(o, t, opts = {}) {
  const f = opts.frame || 0.07;
  const zf = t / 2 - f * 0.5;
  const out = [
    spanGeo(o.x - o.w / 2, o.y - o.h / 2, zf - f, o.x + o.w / 2, o.y - o.h / 2 + f, zf, 1),
    spanGeo(o.x - o.w / 2, o.y + o.h / 2 - f, zf - f, o.x + o.w / 2, o.y + o.h / 2, zf, 1),
    spanGeo(o.x - o.w / 2, o.y - o.h / 2, zf - f, o.x - o.w / 2 + f, o.y + o.h / 2, zf, 1),
    spanGeo(o.x + o.w / 2 - f, o.y - o.h / 2, zf - f, o.x + o.w / 2, o.y + o.h / 2, zf, 1),
  ];
  if (opts.transom !== false) {
    out.push(spanGeo(o.x - o.w / 2, o.y - f * 0.35, zf - f, o.x + o.w / 2, o.y + f * 0.65, zf, 1));
  }
  const pane = new THREE.BoxGeometry(o.w - f * 1.8, o.h - f * 1.8, 0.02);
  pane.translate(o.x, o.y, -t / 2 + (opts.recess == null ? 0.07 : opts.recess));
  return { frame: bake(out), pane };
}

/* =============================================================== materials */

/**
 * Scenery-only materials. These follow the shape of `surfaceMaterial` in
 * materials.js - named, cached, degrading to a plain tint - but the cache is
 * PER BUILD rather than module scope, because `Viewport.clearTrack()` disposes
 * everything it walks and a module-level cache would hand the next track a
 * material that has already been through `dispose()`.
 *
 * `base` borrows the already-downloaded ambientCG maps from that same cache
 * instead of shipping a second texture system: every scenery box has its UVs
 * scaled to world size (see `scaleBoxUV`) and the cached clones use repeat 1,
 * so they drop straight in.
 */
const SCENERY_SETS = {
  siding:   { color: 0xb9b3a4, roughness: 0.86, base: 'drywall' },
  sidingB:  { color: 0x9aa2a8, roughness: 0.86, base: 'concrete' },
  trim:     { color: 0xdcd8cd, roughness: 0.72, base: 'drywall' },
  shingle:  { color: 0x4a4b4e, roughness: 0.90, base: 'concrete' },
  rust:     { color: 0x8a6a4e, roughness: 0.62, metalness: 0.55, base: 'metal' },
  steel:    { color: 0x9aa3ad, roughness: 0.45, metalness: 0.80, base: 'metal' },
  darkSteel:{ color: 0x62686f, roughness: 0.55, metalness: 0.70, base: 'metal' },
  concreteTrim: { color: 0x8d9096, roughness: 0.92, base: 'concrete' },
  reveal:   { color: 0x1d2126, roughness: 0.95 },
  glassWin: { color: 0x2a3b47, roughness: 0.12, metalness: 0.10 },
  needle:   { color: 0x33502c, roughness: 0.95, flat: true },
  leaf:     { color: 0x4a7036, roughness: 0.93, flat: true },
  bark:     { color: 0x4a3a28, roughness: 0.97 },
  rock:     { color: 0x9a8f80, roughness: 0.95, flat: true },
  plank:    { color: 0x8a6f4a, roughness: 0.88, base: 'wood' },
  dirtRock: { color: 0x8d7a62, roughness: 0.97, flat: true },
};

/* ======================================================= downloaded assets */

// Poly Haven, CC0, vendored. Uncompressed multi-file gltf bundles: the loader
// resolves `rock_07.bin` and `textures/*.jpg` relative to the .gltf, so the
// plain relative URL resolves correctly against the static server.
const ASSETS = {
  rockA: { url: 'assets/models/rock_07/rock_07_1k.gltf', verts: 1500 },
  rockB: { url: 'assets/models/rock_09/rock_09_1k.gltf', verts: 1400 },
  shrub: { url: 'assets/models/shrub_02/shrub_02_1k.gltf', verts: 4000 },
  snag:  { url: 'assets/models/dead_tree_trunk/dead_tree_trunk_1k.gltf', verts: 3000 },
};
export const SCENERY_ASSET_STATE = { loaded: [], failed: [], verts: {}, errors: {} };

function startAssets(self) {
  for (const [key, def] of Object.entries(ASSETS)) {
    if (self.assets.has(key) || self.requested.has(key)) continue;
    self.requested.add(key);
    loadTemplate(def.url, def.verts).then((tpl) => {
      self.assets.set(key, tpl);
      if (!SCENERY_ASSET_STATE.loaded.includes(key)) SCENERY_ASSET_STATE.loaded.push(key);
      SCENERY_ASSET_STATE.verts[key] = `${tpl.verts}v/${tpl.tris}t`;
      // Anything placed before the file arrived gets its real geometry now.
      for (const p of self.pending) {
        if (p.key !== key) continue;
        if (p.placeholder) p.placeholder.dispose();
        p.mesh.geometry = tpl.geometry;
        p.mesh.material = tpl.material;
      }
    }, (err) => {
      if (!SCENERY_ASSET_STATE.failed.includes(key)) SCENERY_ASSET_STATE.failed.push(key);
      SCENERY_ASSET_STATE.errors[key] = String((err && err.message) || err).slice(0, 200);
      console.warn(`[scenery] asset failed: ${def.url}`, err);
    });
  }
}

/* ------------------------------------------------------- minimal glTF read */

const GL_COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const GL_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const GL_ITEMS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/**
 * Read one accessor out of the loaded buffers. Byte stride is honoured; the
 * interleaving is not needed by these files but it costs four lines and stops a
 * future asset from silently producing garbage.
 */
function readAccessor(json, buffers, index) {
  const acc = json.accessors[index];
  const n = GL_ITEMS[acc.type];
  const csize = GL_SIZE[acc.componentType];
  const view = json.bufferViews[acc.bufferView];
  const base = buffers[view.buffer];
  const stride = view.byteStride || n * csize;
  const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
  if (stride === n * csize) {
    // Note the third argument is an ELEMENT count, not a byte count.
    try {
      return {
        array: new GL_COMP[acc.componentType](base, start, acc.count * n),
        n, count: acc.count, normalized: !!acc.normalized,
      };
    } catch (e) {
      throw new Error(`accessor ${index} ct=${acc.componentType} start=${start} `
        + `len=${acc.count * n} buf=${base.byteLength}`);
    }
  }
  const out = new GL_COMP[acc.componentType](acc.count * n);
  const src = new DataView(base);
  const put = (dv, o, i) => {
    if (acc.componentType === 5126) dv.setFloat32(o, src.getFloat32(start + i * stride, true));
    else if (acc.componentType === 5123) dv.setUint16(o, src.getUint16(start + i * stride, true));
    else if (acc.componentType === 5121) dv.setUint8(o, src.getUint8(start + i * stride));
  };
  for (let i = 0; i < acc.count; i++) for (let k = 0; k < n; k++) put(out, i * n + k, i * n + k);
  return { array: out, n, count: acc.count, normalized: !!acc.normalized };
}

function nodeMatrix(node) {
  if (node.matrix) return new THREE.Matrix4().fromArray(node.matrix);
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return new THREE.Matrix4().compose(
    new THREE.Vector3(t[0], t[1], t[2]),
    new THREE.Quaternion(r[0], r[1], r[2], r[3]),
    new THREE.Vector3(s[0], s[1], s[2]));
}

/** Everything a primitive contributes, merged into one indexed geometry. */
function primitivesToGeometry(json, buffers) {
  const pos = [], nrm = [], uv = [], col = [];
  const idx = [];
  let hasColor = false;
  const scene = (json.scenes && json.scenes[json.scene != null ? json.scene : 0]) || { nodes: [] };
  const walk = (nodeIdx, parent) => {
    const node = json.nodes[nodeIdx];
    const world = parent.clone().multiply(nodeMatrix(node));
    if (node.mesh != null) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if (prim.mode != null && prim.mode !== 4) continue;   // only triangles
        const P = readAccessor(json, buffers, prim.attributes.POSITION);
        const N = prim.attributes.NORMAL != null ? readAccessor(json, buffers, prim.attributes.NORMAL) : null;
        const U = prim.attributes.TEXCOORD_0 != null ? readAccessor(json, buffers, prim.attributes.TEXCOORD_0) : null;
        const C = prim.attributes.COLOR_0 != null ? readAccessor(json, buffers, prim.attributes.COLOR_0) : null;
        const I = prim.indices != null ? readAccessor(json, buffers, prim.indices) : null;
        const base = pos.length / 3;
        const v = new THREE.Vector3();
        for (let i = 0; i < P.count; i++) {
          v.set(P.array[i * P.n], P.array[i * P.n + 1], P.array[i * P.n + 2]).applyMatrix4(world);
          pos.push(v.x, v.y, v.z);
          if (N) {
            v.set(N.array[i * N.n], N.array[i * N.n + 1], N.array[i * N.n + 2])
              .applyMatrix4(new THREE.Matrix4().extractRotation(world)).normalize();
            nrm.push(v.x, v.y, v.z);
          } else nrm.push(0, 1, 0);
          if (U) uv.push(U.array[i * U.n], U.array[i * U.n + 1]); else uv.push(0, 0);
          if (C) { col.push(C.array[i * C.n], C.array[i * C.n + 1], C.array[i * C.n + 2]); hasColor = true; }
          else col.push(1, 1, 1);
        }
        const count = I ? I.count : P.count;
        for (let i = 0; i < count; i++) idx.push(base + (I ? I.array[i] : i));
      }
    }
    for (const c of node.children || []) walk(c, world);
  };
  for (const n of scene.nodes) walk(n, new THREE.Matrix4());

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (hasColor) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx.length > 65535
    ? new THREE.BufferAttribute(new Uint32Array(idx), 1)
    : new THREE.BufferAttribute(new Uint16Array(idx), 1));
  return g;
}

/**
 * Fetch binary data, and survive a poisoned cache entry.
 *
 * A `.bin` that returns a cached `204 No Content` fetches cleanly - `ok` is
 * true - and then hands back a zero-length ArrayBuffer, which surfaces much
 * later as "Invalid typed array length: 0" inside the accessor reader. If the
 * body comes back empty, retry once with a cache-busting query.
 */
async function fetchBinary(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const src = attempt === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}r=${attempt}`;
    const r = await fetch(src, { cache: 'no-store' });
    if (!r.ok) throw new Error(`fetch ${r.status} ${src}`);
    const buf = await r.arrayBuffer();
    if (buf.byteLength) return buf;
  }
  throw new Error(`empty body ${url}`);
}

const texLoader = new THREE.TextureLoader();
function loadTexture(url) {
  return new Promise((resolve) => {
    texLoader.load(url, resolve, undefined, () => resolve(null));
  });
}

/** Fetch a glTF, build a template from it, and cache it on the Scenery. */
async function loadTemplate(url, targetVerts) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`gltf ${res.status} ${url}`);
  const json = await res.json();
  const base = url.slice(0, url.lastIndexOf('/') + 1);
  const buffers = [];
  for (const b of json.buffers || []) {
    if (b.uri == null) throw new Error('GLB-embedded buffer is not supported');
    buffers.push(await fetchBinary(base + b.uri));
  }
  const geo = primitivesToGeometry(json, buffers);
  const welded = weldDecimate(geo, targetVerts);
  if (welded !== geo) geo.dispose();
  welded.computeBoundingBox();
  const bb = welded.boundingBox;
  welded.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  welded.computeBoundingBox();
  welded.computeBoundingSphere();
  welded.userData = {
    height: welded.boundingBox.max.y || 1,
    radius: Math.max(
      Math.abs(welded.boundingBox.min.x), Math.abs(welded.boundingBox.max.x),
      Math.abs(welded.boundingBox.min.z), Math.abs(welded.boundingBox.max.z)) || 1,
  };

  // Colour + normal maps off the file's own PBR material, so the rock reads as
  // the CC0 scan it is instead of a flat tinted blob.
  const mi = (json.meshes[0].primitives[0] || {}).material;
  const matDef = mi != null ? json.materials[mi] : null;
  const img = (texIndex) => {
    const t = json.textures && json.textures[texIndex];
    const im = t && (t.source != null ? t.source : t.extensions && t.extensions.EXT_textureWebp && t.extensions.EXT_textureWebp.source);
    return im != null && json.images[im] ? json.images[im].uri : null;
  };
  const maps = {};
  const set = async (slot, texIndex, srgb) => {
    const u = img(texIndex);
    if (!u) return;
    const t = await loadTexture(base + u);
    if (!t) return;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    maps[slot] = t;
  };
  await Promise.all([
    matDef && matDef.pbrMetallicRoughness && matDef.pbrMetallicRoughness.baseColorTexture
      ? set('map', matDef.pbrMetallicRoughness.baseColorTexture.index, true) : Promise.resolve(),
    matDef && matDef.normalTexture ? set('normalMap', matDef.normalTexture.index, false) : Promise.resolve(),
  ]);

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
    vertexColors: !!welded.attributes.color,
    normalScale: new THREE.Vector2(1, 1),
    ...maps,
  });
  return {
    geometry: welded,
    material,
    radius: welded.userData.radius,
    height: welded.userData.height,
    verts: welded.attributes.position.count,
    tris: (welded.index ? welded.index.count : 0) / 3,
  };
}

/**
 * Vertex welding by 3D cell, with a binary search on the cell size that lands
 * near `targetVerts`. Position, normal and UV are averaged inside a cell - the
 * Poly Haven rocks use a projection atlas, so UVs inside one cell are coherent
 * and averaging keeps the texture readable instead of scrambling it.
 */
function weldDecimate(geo, targetVerts) {
  const idx = geo.index;
  const nTri = (idx ? idx.count : geo.attributes.position.count) / 3;
  if (nTri * 3 <= targetVerts) return geo;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const ext = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;

  // Geometric bisection on the cell size. The count falls roughly with
  // (ext/cell)^2 over a surface, so the useful range of `cell` spans three
  // orders of magnitude - arithmetic bisection from a 1:4096 bracket never gets
  // anywhere near it and silently returns the mesh unwelded.
  let lo = ext / 8192, hi = ext;
  let best = null, bestErr = Infinity;
  for (let iter = 0; iter < 18; iter++) {
    const cell = Math.sqrt(lo * hi);
    const r = weldOnce(cell);
    if (!r) { lo = cell; continue; }     // nothing collapsed: cell too small
    const n = r.userData.count;          // NOT `r.count` - a geometry has none
    const err = Math.abs(n - targetVerts);
    if (err < bestErr) { best = r; bestErr = err; }
    if (n > targetVerts) lo = cell; else hi = cell;
    if (bestErr === 0) break;
  }
  if (best) { geo.dispose(); return best; }
  return geo;

  function weldOnce(cell) {
    if (!(cell > 0)) return null;
    const P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv, I = idx;
    const map = new Map();
    const ap = [], an = [], au = [];
    const key = (x, y, z) =>
      `${Math.round((x - bb.min.x) / cell)},${Math.round((y - bb.min.y) / cell)},${Math.round((z - bb.min.z) / cell)}`;
    const acc = (x, y, z, vi) => {
      const k = key(x, y, z);
      let i = map.get(k);
      if (i === undefined) {
        i = ap.length / 3;
        map.set(k, i);
        ap.push(0, 0, 0); an.push(0, 0, 0); au.push(0, 0);
      }
      ap[i * 3] += x; ap[i * 3 + 1] += y; ap[i * 3 + 2] += z;
      if (N) { an[i * 3] += N.getX(vi); an[i * 3 + 1] += N.getY(vi); an[i * 3 + 2] += N.getZ(vi); }
      if (U) { au[i * 2] += U.getX(vi); au[i * 2 + 1] += U.getY(vi); }
      return i;
    };
    const out = [];
    const tri = (I ? I.count : P.count) / 3;
    for (let t = 0; t < tri; t++) {
      const a = I ? I.getX(t * 3) : t * 3;
      const b = I ? I.getX(t * 3 + 1) : t * 3 + 1;
      const c = I ? I.getX(t * 3 + 2) : t * 3 + 2;
      const ia = acc(P.getX(a), P.getY(a), P.getZ(a), a);
      const ib = acc(P.getX(b), P.getY(b), P.getZ(b), b);
      const ic = acc(P.getX(c), P.getY(c), P.getZ(c), c);
      if (ia === ib || ib === ic || ia === ic) continue;   // collapsed by welding
      out.push(ia, ib, ic);
    }
    const count = ap.length / 3;
    if (count >= P.count && out.length >= (I ? I.count : P.count)) return null;
    // Weight each cell's average by how many surviving triangles touch it.
    const wts = new Float32Array(count);
    const P2 = new Float32Array(count * 3), N2 = new Float32Array(count * 3), U2 = new Float32Array(count * 2);
    for (let i = 0; i < out.length; i++) wts[out[i]]++;
    for (let i = 0; i < count; i++) {
      const d = wts[i] || 1;
      P2[i * 3] = ap[i * 3] / d; P2[i * 3 + 1] = ap[i * 3 + 1] / d; P2[i * 3 + 2] = ap[i * 3 + 2] / d;
      U2[i * 2] = au[i * 2] / d; U2[i * 2 + 1] = au[i * 2 + 1] / d;
    }
    for (let t = 0; t < out.length; t += 3) {
      const a = out[t], b = out[t + 1], c = out[t + 2];
      const ux = P2[b * 3] - P2[a * 3], uy = P2[b * 3 + 1] - P2[a * 3 + 1], uz = P2[b * 3 + 2] - P2[a * 3 + 2];
      const vx = P2[c * 3] - P2[a * 3], vy = P2[c * 3 + 1] - P2[a * 3 + 1], vz = P2[c * 3 + 2] - P2[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) { N2[i * 3] += nx; N2[i * 3 + 1] += ny; N2[i * 3 + 2] += nz; }
    }
    for (let i = 0; i < count; i++) {
      const l = Math.hypot(N2[i * 3], N2[i * 3 + 1], N2[i * 3 + 2]) || 1;
      N2[i * 3] /= l; N2[i * 3 + 1] /= l; N2[i * 3 + 2] /= l;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P2, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N2, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(U2, 2));
    g.setIndex(out.length > 65535
      ? new THREE.BufferAttribute(new Uint32Array(out), 1)
      : new THREE.BufferAttribute(new Uint16Array(out), 1));
    g.userData = { count, tris: out.length / 3 };
    return g;
  }
}

/** Stand-in used until a glTF arrives, so a rock is never a hole in the track. */
function placeholderRock(seed, mat) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  const r = rng(seed);
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let j = seen.get(k);
    if (j === undefined) { j = 0.62 + r() * 0.55; seen.set(k, j); }
    p.setXYZ(i, p.getX(i) * j, p.getY(i) * j * 0.78, p.getZ(i) * j);
  }
  g.computeVertexNormals();
  g.userData = { height: 0.78, radius: 1.1 };
  return g;
}

/**
 * Put a normalised asset template onto a collision box: base flush with the
 * bottom of the box, uniform scale limited by BOTH the width and the height so
 * the widest part can never exceed the box.
 */
function placeAsset(self, key, x, yBottom, z, sx, sy, sz, yaw, seed) {
  const tpl = self.assets.get(key);
  const leafLike = key === 'shrub' || key === 'snag';
  let geo = tpl ? tpl.geometry : placeholderRock(seed, null);
  const mat = tpl && tpl.material ? tpl.material : self.mat(leafLike ? 'leaf' : 'rock');
  const rh = (geo.userData && geo.userData.height) || 1;
  const rr = (geo.userData && geo.userData.radius) || 1;
  const k = Math.min((Math.min(sx, sz) * 0.5) / rr, sy / rh);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(k);
  mesh.rotation.y = yaw;
  mesh.position.set(x, yBottom, z);
  mesh.name = `asset:${key}`;
  mesh.userData.asset = key;
  if (!tpl) {
    self.pending.push({ key, mesh, placeholder: geo });
  }
  return mesh;
}

/* ============================================================== instancing */

function inst(ctx, key, geo, mat) {
  let b = ctx.inst.get(key);
  if (!b) { b = { geo, mat, list: [] }; ctx.inst.set(key, b); }
  return b;
}

function push(ctx, key, matrix, colorHex) {
  ctx.inst.get(key).list.push({ m: matrix, c: colorHex });
}

function finishInstanced(ctx) {
  for (const [, b] of ctx.inst) {
    if (!b.list.length) continue;
    const mesh = new THREE.InstancedMesh(b.geo, b.mat, b.list.length);
    let anyColor = false;
    for (let i = 0; i < b.list.length; i++) if (b.list[i].c != null) { anyColor = true; break; }
    for (let i = 0; i < b.list.length; i++) {
      mesh.setMatrixAt(i, b.list[i].m);
      // `setColorAt` allocates a zero-filled buffer, so anything left unset
      // would come out black. Fill the whole array when one colour is used.
      mesh.setColorAt(i, _c.set(b.list[i].c != null ? b.list[i].c : 0xffffff));
    }
    if (!anyColor) mesh.instanceColor = null;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // A bounding sphere over ALL instances: without it three.js culls the whole
    // batch against the first instance's bounds and the far end of the forest
    // disappears.
    mesh.computeBoundingSphere();
    ctx.meshes.push(mesh);
  }
}

/* ------------------------------------------------------------- edge lines */

function buildEdges(obstacles) {
  const pos = [];
  for (const o of obstacles) {
    const x0 = o.x - o.sx * 0.5, x1 = o.x + o.sx * 0.5;
    const y0 = o.y - o.sy * 0.5, y1 = o.y + o.sy * 0.5;
    const z0 = o.z - o.sz * 0.5, z1 = o.z + o.sz * 0.5;
    const c = [
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
      [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
    ];
    for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7]]) pos.push(...c[a], ...c[b]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color: 0x9fb6cc, transparent: true, opacity: 0.22,
  }));
  lines.name = 'edges';
  return lines;
}

/* ================================================================== Scenery */

export class Scenery {
  constructor() {
    this.mats = new Map();
    this.pending = [];
    this.assets = new Map();   // key -> template { geometry, material, radius, height }
    this.requested = new Set();
    this.stats = null;
    this._tierGeo = null;
  }

  /** Cached per build; see the note above on material lifetime. */
  mat(name) {
    if (this.mats.has(name)) return this.mats.get(name);
    const set = SCENERY_SETS[name] || SCENERY_SETS.steel;
    const m = new THREE.MeshStandardMaterial({
      color: set.color, roughness: set.roughness, metalness: set.metalness || 0,
      flatShading: !!set.flat,
    });
    if (set.base) {
      const src = surfaceMaterial(set.base);
      m.map = src.map || null;
      m.normalMap = src.normalMap || null;
      m.roughnessMap = src.roughnessMap || null;
    }
    this.mats.set(name, m);
    return m;
  }

  /** Called by `Viewport.buildTrack` right after `clearTrack()`. */
  beginBuild() {
    this.pending.length = 0;
    this.mats.clear();
  }

  /**
   * Turn one track into a group of scenery objects. Everything ends up inside
   * the returned group, which is what `clearTrack()` disposes.
   */
  build(track) {
    this.beginBuild();
    startAssets(this);

    const ctx = {
      scenery: this,
      track,
      meshes: [],
      boxes: new Map(),     // material -> staged box geometries, merged at the end
      inst: new Map(),      // bucket key -> { geo, mat, list }
      edges: [],            // obstacles that keep the blueprint outline
      roofOf: new Map(),    // wall obstacle -> roof slab
      deckOf: new Map(),    // tower obstacle -> deck slab
      houseWindow: new Map(), // house obstacle -> window panels in its wall
      windows: [],          // unclaimed window obstacles
      claimed: new Set(),
    };
    linkAttachments(track, ctx);

    for (const o of track.obstacles) {
      // Roof slabs, tower decks and hosted window panels are drawn as part of
      // the object they belong to, so they are not built a second time here.
      if (ctx.claimed.has(o)) continue;
      const fn = BUILDERS[o.kind] || buildBox;
      const out = fn(ctx, o);
      if (Array.isArray(out)) {
        for (const x of out) if (x) ctx.meshes.push(x);
      } else if (out) {
        ctx.meshes.push(out);
      }
    }

    finishInstanced(ctx);
    for (const [material, geos] of ctx.boxes) {
      const g = bake(geos);
      if (!g) continue;
      const mesh = new THREE.Mesh(g, surfaceMaterial(material));
      mesh.name = `box:${material}`;
      ctx.meshes.push(mesh);
    }
    if (ctx.edges.length) ctx.meshes.push(buildEdges(ctx.edges));

    const group = new THREE.Group();
    group.name = 'scenery';
    let tris = 0, meshes = 0, instanced = 0;
    for (const m of ctx.meshes) {
      group.add(m);
      if (m.isInstancedMesh) instanced++;
      meshes++;
      m.traverse((o) => {
        const g = o.geometry;
        if (!g || !g.attributes.position) return;
        const n = o.isMesh
          ? (g.index ? g.index.count : g.attributes.position.count) / 3
          : (g.index ? g.index.count : g.attributes.position.count) / 2;
        tris += o.isInstancedMesh ? n * o.count : n;
      });
    }
    this.stats = {
      obstacles: track.obstacles.length, meshes, instanced,
      triangles: Math.round(tris),
      assets: {
        loaded: SCENERY_ASSET_STATE.loaded.slice(),
        failed: SCENERY_ASSET_STATE.failed.slice(),
        verts: { ...SCENERY_ASSET_STATE.verts },
        placeholders: this.pending.length,
        errors: { ...SCENERY_ASSET_STATE.errors },
      },
    };
    return group;
  }
}

/**
 * Some scenery arrives as two or three obstacles that belong to one object: a
 * house and its roof slab, a watchtower and its deck, a house and the glass
 * panel sitting in its wall. Pair them here, geometrically and without relying
 * on list order.
 */
function linkAttachments(track, ctx) {
  const roofs = track.obstacles.filter((o) => o.material === 'plywood' || o.material === 'wood');
  const claimed = new Set();
  for (const o of track.obstacles) {
    if (o.kind === 'house' || o.kind === 'shed') {
      const top = o.y + o.sy / 2;
      let best = null, bestErr = Infinity;
      for (const r of roofs) {
        if (claimed.has(r)) continue;
        if (r.sx < o.sx - 1e-6 || r.sz < o.sz - 1e-6) continue;
        const err = Math.abs(r.y - r.sy / 2 - top) + Math.hypot(r.x - o.x, r.z - o.z);
        if (err < bestErr) { best = r; bestErr = err; }
      }
      if (best) { ctx.roofOf.set(o, best); claimed.add(best); }
    } else if (o.kind === 'watchtower') {
      const top = o.y + o.sy / 2;
      let best = null, bestErr = Infinity;
      for (const r of track.obstacles) {
        if (claimed.has(r) || r === o) continue;
        if (r.sx < o.sx - 1e-6 || r.sz < o.sz - 1e-6) continue;
        if (Math.abs(r.y - r.sy / 2 - top) > 0.5) continue;
        const err = Math.abs(r.y - r.sy / 2 - top) + Math.hypot(r.x - o.x, r.z - o.z);
        if (err < bestErr) { best = r; bestErr = err; }
      }
      if (best) { ctx.deckOf.set(o, best); claimed.add(best); }
    }
  }
  ctx.claimed = claimed;

  // Window panels are assigned to the house whose +X face they sit in, and are
  // then drawn as part of that house rather than as their own box.
  const houses = track.obstacles.filter((o) => o.kind === 'house');
  for (const w of track.obstacles) {
    if (w.kind !== 'window') continue;
    let host = null, bestErr = Infinity;
    for (const h of houses) {
      const dx = w.x - h.x;
      if (Math.abs(w.z - h.z) > h.sz / 2 + 0.2) continue;
      const err = Math.abs(Math.abs(dx) - (h.sx / 2 - 0.3));
      if (err < 0.6 && err < bestErr) { host = h; bestErr = err; }
    }
    if (!host) { ctx.windows.push(w); continue; }
    if (!ctx.houseWindow.has(host)) ctx.houseWindow.set(host, []);
    ctx.houseWindow.get(host).push(w);
    claimed.add(w);
  }
}

/* ============================================================== builders  */

/** Fallback: an untagged obstacle stays a textured box, merged per material. */
function buildBox(ctx, o) {
  let list = ctx.boxes.get(o.material);
  if (!list) { list = []; ctx.boxes.set(o.material, list); }
  list.push(boxGeo(o.sx, o.sy, o.sz, o.x, o.y, o.z));
  ctx.edges.push(o);
  return null;
}

/* ------------------------------------------------------------------ conifer */

function tierGeometry() {
  // A lathe profile that flares faster than it rises, so each tier skirts out and
  // droops instead of reading as a party hat. Radius 1 at y=-1, tip at y=0.
  const pts = [
    new THREE.Vector2(0.02, 0.00),
    new THREE.Vector2(0.26, -0.14),
    new THREE.Vector2(0.55, -0.34),
    new THREE.Vector2(0.80, -0.62),
    new THREE.Vector2(0.94, -0.84),
    new THREE.Vector2(1.00, -1.00),
  ];
  const g = new THREE.LatheGeometry(pts, 9);
  g.computeVertexNormals();
  return g;
}

function buildPineTrunk(ctx, o) {
  if (!ctx.inst.has('pineTrunk')) {
    const g = new THREE.CylinderGeometry(0.32, 0.46, 1, 7, 1, false);
    scaleUV(g, 2, 2);
    inst(ctx, 'pineTrunk', g, ctx.scenery.mat('bark'));
  }
  const r = rng(obsSeed(o, 1));
  const bottom = o.y - o.sy / 2;
  push(ctx, 'pineTrunk', trs(o.x, bottom + o.sy / 2, o.z, 0, r() * 6.283, 0, o.sx, o.sy, o.sz), null);
  return null;
}

function buildPineCrown(ctx, o) {
  // The tier geometry is created per build so `clearTrack()` owns its lifetime.
  if (!ctx.inst.has('pineTier')) inst(ctx, 'pineTier', tierGeometry(), ctx.scenery.mat('needle'));
  const rnd = rng(obsSeed(o, 2));
  const N = 5;
  const bottom = o.y - o.sy / 2;
  const CH = o.sy;                             // canopy height == foliage box
  const R = Math.min(o.sx, o.sz) * 0.5;
  const yaw0 = rnd() * 6.283;
  // Roughly one snag in eleven: same box, same collider, bare branches.
  const dead = ((obsSeed(o, 3) >>> 8) % 11) === 0;
  const green = 0x9fb08a, brown = 0x6d5b45;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const radius = R * (1 - 0.86 * t) * (0.94 + rnd() * 0.1);
    const tierH = CH * (0.40 + rnd() * 0.05);
    // Tip height runs from 45% of the canopy to its very top, so the lowest
    // tier's skirt still lands inside the foliage box.
    const tipY = bottom + CH * (0.45 + 0.55 * t);
    const jx = (rnd() - 0.5) * R * 0.09;
    const jz = (rnd() - 0.5) * R * 0.09;
    push(ctx, 'pineTier',
      trs(o.x + jx, tipY, o.z + jz, 0, yaw0 + i * 0.83 + rnd() * 0.4, 0, radius, tierH, radius),
      (dead && i > 1) ? brown : green);
  }
  // Leader spike so the top comes to a point instead of a truncated cone.
  push(ctx, 'pineTier', trs(o.x, bottom + CH, o.z, 0, rnd() * 6.283, 0, R * 0.1, CH * 0.2, R * 0.1),
    dead ? brown : green);
  return null;
}

/* ----------------------------------------------------------------- broadleaf */

function buildBroadTrunk(ctx, o) {
  if (!ctx.inst.has('bTrunk')) {
    const g = new THREE.CylinderGeometry(0.38, 0.50, 1, 7, 1, false);
    scaleUV(g, 2, 2);
    inst(ctx, 'bTrunk', g, ctx.scenery.mat('bark'));
  }
  if (!ctx.inst.has('bBranch')) {
    const g = new THREE.CylinderGeometry(0.28, 0.44, 1, 6, 1, false);
    scaleUV(g, 1, 2);
    inst(ctx, 'bBranch', g, ctx.scenery.mat('bark'));
  }
  const r = rng(obsSeed(o, 4));
  const bottom = o.y - o.sy / 2;
  push(ctx, 'bTrunk', trs(o.x, bottom + o.sy / 2, o.z, 0, r() * 6.283, 0, o.sx, o.sy, o.sz), null);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * 6.283 + r() * 0.7;
    const len = o.sy * (0.42 + r() * 0.2);
    const tilt = 0.75 + r() * 0.35;
    push(ctx, 'bBranch',
      aim(o.x, bottom + o.sy * 0.62, o.z,
        Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt),
        0.40, len, 0.40), null);
  }
  return null;
}

function buildBroadCrown(ctx, o) {
  if (!ctx.inst.has('bLeaf')) {
    inst(ctx, 'bLeaf', new THREE.IcosahedronGeometry(1, 0), ctx.scenery.mat('leaf'));
  }
  const r = rng(obsSeed(o, 5));
  const bottom = o.y - o.sy / 2;
  const R = Math.min(o.sx, o.sz) * 0.5;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 6.283 + r() * 0.9;
    const cx = o.x + Math.cos(a) * R * 0.22 * r();
    const cz = o.z + Math.sin(a) * R * 0.22 * r();
    const cy = bottom + o.sy * (0.40 + (i / 6) * 0.36);
    // Blob radius limited by the room left inside the foliage box.
    const room = Math.max(0.4, R - Math.max(Math.abs(cx - o.x), Math.abs(cz - o.z)));
    const rad = Math.min(R * (0.44 + r() * 0.18), room);
    push(ctx, 'bLeaf',
      trs(cx, cy, cz, r() * 6.283, r() * 6.283, r() * 6.283, rad, rad * 0.72, rad * 0.92),
      i % 2 ? 0xa8c48e : 0x86ac6c);
  }
  // A downloaded shrub at the foot of half the crowns. It lives inside the
  // foliage box, which is already a non-collider, so it neither hides nor
  // invents a collider.
  if ((obsSeed(o, 6) >>> 9) % 2 === 0) {
    const s = Math.min(o.sx, o.sz) * 0.44;
    return placeAsset(ctx.scenery, 'shrub',
      o.x + (r() - 0.5) * R * 0.6, bottom, o.z + (r() - 0.5) * R * 0.6,
      s, o.sy * 0.3, s, r() * 6.283, obsSeed(o, 7));
  }
  return null;
}

/* ------------------------------------------------------- buildings & shells */

/**
 * A gabled shell fitted to one box: four punched walls, corner boards, a
 * plinth, a door and windows. `o` is the wall box; when `roofO` is supplied the
 * roof may use that wider, taller box for its eave overhang - the only place in
 * this module where geometry is allowed outside its own obstacle's box.
 */
function buildingShell(ctx, o, roofO, opts = {}) {
  const out = [];
  const w = o.sx, d = o.sz, H = o.sy;
  const t = Math.min(0.26, Math.min(w, d) * 0.08);
  const rise = roofO ? 0 : Math.min(0.95, H * 0.3);
  const wallTop = o.y + H / 2 - rise;          // world Y of the wall head
  const ridge = roofO ? roofO.y + roofO.sy / 2 : o.y + H / 2;
  const eave = roofO ? roofO.y - roofO.sy / 2 : wallTop;
  const rw = roofO ? roofO.sx : w;
  const rd = roofO ? roofO.sz : d;
  const wallH = H - rise;
  const wallCY = o.y - H / 2 + wallH / 2;      // wall centre, local y = 0

  const parts = [], trim = [], panes = [];
  const r = rng(obsSeed(o, 8));
  const plinth = Math.min(0.3, wallH * 0.12);
  const doorW = Math.min(1.0, w * 0.14);
  const doorH = Math.min(2.05, wallH - plinth - 0.15);
  const winW = Math.min(1.3, w * 0.17);
  const winH = Math.min(1.15, wallH * 0.32);
  const winY = wallH * 0.62;                    // local Y of the window centre
  const nFront = Math.max(2, Math.round((w - 1.6) / 2.6));
  const nSide = Math.max(1, Math.round((d - 1.6) / 2.6));

  const extraX = (ctx.houseWindow && ctx.houseWindow.get(o)) || [];

  // Long faces (+Z / -Z)
  for (const sgn of [1, -1]) {
    const openings = [];
    for (let i = 0; i < nFront; i++) {
      openings.push({ x: -w / 2 + (i + 1) * (w / (nFront + 1)), y: winY - wallH / 2, w: winW, h: winH });
    }
    if (sgn === 1) openings.push({ x: -w / 2 + Math.min(1.8, w * 0.24), y: -wallH / 2 + plinth + doorH / 2, w: doorW, h: doorH });
    const panel = wallGeo(w, wallH, t, openings, 0.4);
    if (panel) {
      if (sgn < 0) panel.rotateY(Math.PI);
      panel.translate(0, wallCY, sgn * (d / 2 - t / 2));
      parts.push(panel);
    }
    for (const op of openings) {
      const wf = windowGeo(op, t);
      if (sgn < 0) { wf.frame.rotateY(Math.PI); wf.pane.rotateY(Math.PI); }
      wf.frame.translate(0, wallCY, sgn * (d / 2 - t / 2));
      wf.pane.translate(0, wallCY, sgn * (d / 2 - t / 2));
      trim.push(wf.frame); panes.push(wf.pane);
    }
  }
  // Gable ends (+X / -X)
  for (const sgn of [1, -1]) {
    const openings = [];
    for (let i = 0; i < nSide; i++) {
      openings.push({ x: -d / 2 + (i + 1) * (d / (nSide + 1)), y: winY - wallH / 2, w: winW * 0.82, h: winH });
    }
    if (sgn === 1 && extraX.length) {
      // The window obstacles in the data are long glazed strips, not small
      // panes. They take precedence over the generated openings they overlap.
      for (const win of extraX) {
        const ex = { x: win.z - o.z, y: win.y - wallCY, w: win.sz, h: win.sy };
        for (let k = openings.length - 1; k >= 0; k--) {
          if (Math.abs(openings[k].x - ex.x) < (openings[k].w + ex.w) / 2) openings.splice(k, 1);
        }
        openings.push(ex);
      }
    }
    const panel = wallGeo(d, wallH, t, openings, 0.4);
    if (panel) {
      panel.rotateY(sgn * Math.PI / 2);
      panel.translate(sgn * (w / 2 - t / 2), wallCY, 0);
      parts.push(panel);
    }
    for (const op of openings) {
      const wf = windowGeo(op, t);
      wf.frame.rotateY(sgn * Math.PI / 2);
      wf.pane.rotateY(sgn * Math.PI / 2);
      wf.frame.translate(sgn * (w / 2 - t / 2), wallCY, 0);
      wf.pane.translate(sgn * (w / 2 - t / 2), wallCY, 0);
      trim.push(wf.frame); panes.push(wf.pane);
    }
  }
  // Gable infill triangles, only when the roof is inside the wall box.
  if (rise > 0.1) {
    for (const sgn of [1, -1]) {
      const g = gableGeo(w, rise, t, 0.4);
      g.translate(0, wallTop, sgn * (d / 2 - t / 2));
      parts.push(g);
    }
  }
  // Perimeter plinth band (not solid: it must not fill the doorway) and corner
  // boards, which are the cheapest thing that stops a wall reading as a card.
  const pb = t + 0.05;
  parts.push(spanGeo(-w / 2, 0, -d / 2, w / 2, plinth, -d / 2 + pb, 0.4));
  parts.push(spanGeo(-w / 2, 0, d / 2 - pb, w / 2, plinth, d / 2, 0.4));
  parts.push(spanGeo(-w / 2, 0, -d / 2 + pb, -w / 2 + pb, plinth, d / 2 - pb, 0.4));
  parts.push(spanGeo(w / 2 - pb, 0, -d / 2 + pb, w / 2, plinth, d / 2 - pb, 0.4));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    trim.push(spanGeo(
      sx > 0 ? w / 2 - t - 0.1 : -w / 2, o.y - H / 2, sz > 0 ? d / 2 - t - 0.1 : -d / 2,
      sx > 0 ? w / 2 : -w / 2 + t + 0.1, wallTop, sz > 0 ? d / 2 : -d / 2 + t + 0.1, 1));
  }

  const base = new THREE.Vector3(o.x, 0, o.z);
  const emit = (list, matName, name) => {
    const g = bake(list);
    if (!g) return;
    g.translate(base.x, 0, base.z);
    const mesh = new THREE.Mesh(g, ctx.scenery.mat(matName));
    mesh.name = name;
    out.push(mesh);
  };
  emit(parts, opts.wallMat || 'siding', `${name0(opts)}:wall`);
  emit(trim, 'trim', `${name0(opts)}:trim`);
  emit(panes, 'glassWin', `${name0(opts)}:glass`);

  // Roof. Eave is pinned to the bottom of whichever box owns the roof, so a
  // gable can never hang below a surface the collider does not cover.
  const halfD = rd / 2;
  const pitch = Math.atan2(ridge - eave, halfD);
  const slopeLen = Math.hypot(ridge - eave, halfD);
  const thick = Math.min(0.18, (ridge - eave) * 0.4);
  const roofParts = [];
  for (const sgn of [1, -1]) {
    const slope = new THREE.BoxGeometry(slopeLen + 0.02, thick, rw);
    scaleBoxUV(slope, slopeLen, thick, rw, 0.6);
    slope.rotateZ(sgn > 0 ? -pitch : pitch);
    slope.rotateY(sgn > 0 ? 0 : Math.PI);
    slope.translate(0, (ridge + eave) / 2, sgn * halfD / 2);
    roofParts.push(slope);
  }
  roofParts.push(spanGeo(-rw / 2, ridge - thick, -0.18, rw / 2, ridge, 0.18, 0.6));
  for (const sgn of [1, -1]) {
    roofParts.push(spanGeo(-rw / 2, eave, sgn > 0 ? halfD - 0.11 : -halfD, rw / 2, eave + thick * 1.1, sgn > 0 ? halfD : -halfD + 0.11, 0.8));
  }
  emit(roofParts, opts.roofMat || 'shingle', `${name0(opts)}:roof`);

  ctx.edges.push(o);
  return out;
}
const name0 = (opts) => opts.tag || 'shell';

function buildHouse(ctx, o) { return buildingShell(ctx, o, ctx.roofOf.get(o) || null, { tag: 'house' }); }
function buildCabin(ctx, o) { return buildingShell(ctx, o, null, { tag: 'cabin', wallMat: 'plank', roofMat: 'shingle' }); }
function buildShed(ctx, o) { return buildingShell(ctx, o, null, { tag: 'shed', wallMat: 'brick', roofMat: 'rust' }); }

/** A window with no house to host it: a framed pane inside its own box. */
function buildWindow(ctx, o) {
  const t = o.sx;
  const wf = windowGeo({ x: 0, y: 0, w: o.sz, h: o.sy }, t, { frame: 0.05, recess: 0.05, transom: true });
  const out = [];
  for (const g of [wf.frame, wf.pane]) {
    g.rotateY(Math.PI / 2);
    g.translate(o.x, o.y, o.z);
  }
  out.push(new THREE.Mesh(wf.frame, ctx.scenery.mat('trim')));
  out.push(new THREE.Mesh(wf.pane, ctx.scenery.mat('glassWin')));
  return out;
}

/* --------------------------------------------------------------- city block */

function buildBuilding(ctx, o) {
  const out = [];
  const w = o.sx, h = o.sy, d = o.sz;
  const inset = 0.10;                 // shell set back off the box face
  const sw = w - inset * 2, sd = d - inset * 2;
  out.push(new THREE.Mesh(boxGeo(sw, h, sd, o.x, o.y, o.z), surfaceMaterial(o.material)));

  // Plinth and cornice, both flush with the collision box.
  const trimGeo = bake([
    spanGeo(-sw / 2, -h / 2, -sd / 2, sw / 2, -h / 2 + 0.55, sd / 2, 0.4),
    spanGeo(-w / 2, h / 2 - 0.45, -d / 2, w / 2, h / 2, d / 2, 0.4),
  ]);
  trimGeo.translate(o.x, o.y, o.z);
  out.push(new THREE.Mesh(trimGeo, ctx.scenery.mat('concreteTrim')));

  // Window grid. Reveals stand 2 cm proud of the inset shell, glass 5 cm, and
  // the shell itself is set back - so everything stays inside the box while
  // still reading as a recessed opening rather than a decal.
  const floorH = 3.6, winH = 1.9, winW = 1.5;
  const reveals = [], glasses = [];
  const base = o.y - h / 2;
  const addWin = (cx, cy, cz, ry) => {
    const a = new THREE.BoxGeometry(winW + 0.26, winH + 0.26, 0.2);
    const tr = new THREE.BoxGeometry(winW + 0.26, 0.1, 0.14);
    const b = new THREE.BoxGeometry(winW, winH, 0.03);
    for (const g of [a, tr, b]) g.rotateY(ry);
    const nx = Math.sin(ry) * 0.05, nz = Math.cos(ry) * 0.05;
    a.translate(cx, cy, cz);
    tr.translate(cx + nx, cy, cz + nz);
    b.translate(cx + nx, cy, cz + nz);
    reveals.push(a, tr); glasses.push(b);
  };
  for (let f = 0; f < 8; f++) {
    const cy = base + 2.5 + f * floorH + winH / 2;
    if (cy + winH / 2 > base + h - 0.8) break;
    const nx = Math.max(1, Math.floor((sw - 2.2) / 2.9));
    for (let i = 0; i < nx; i++) {
      const cx = o.x - sw / 2 + (i + 1) * (sw / (nx + 1));
      addWin(cx, cy, o.z + sd / 2, 0);
      addWin(cx, cy, o.z - sd / 2, Math.PI);
    }
    const nz = Math.max(1, Math.floor((sd - 2.2) / 2.9));
    for (let i = 0; i < nz; i++) {
      const cz = o.z - sd / 2 + (i + 1) * (sd / (nz + 1));
      addWin(o.x + sw / 2, cy, cz, Math.PI / 2);
      addWin(o.x - sw / 2, cy, cz, -Math.PI / 2);
    }
  }
  out.push(new THREE.Mesh(bake(reveals), ctx.scenery.mat('reveal')));
  out.push(new THREE.Mesh(bake(glasses), ctx.scenery.mat('glassWin')));

  ctx.edges.push(o);
  return out;
}

function buildParapet(ctx, o) {
  const w = o.sx, h = o.sy, d = o.sz;
  const t = Math.min(0.64, Math.min(w, d) * 0.16);
  const cap = Math.min(0.16, h * 0.32);
  const c = t + 0.08;
  const parts = [
    // A hollow rim, not a slab: the roof deck has to read through the middle.
    spanGeo(-w / 2, 0, d / 2 - t, w / 2, h - cap, d / 2, 0.5),
    spanGeo(-w / 2, 0, -d / 2, w / 2, h - cap, -d / 2 + t, 0.5),
    spanGeo(w / 2 - t, 0, -d / 2 + t, w / 2, h - cap, d / 2 - t, 0.5),
    spanGeo(-w / 2, 0, -d / 2 + t, -w / 2 + t, h - cap, d / 2 - t, 0.5),
    spanGeo(-w / 2, h - cap, d / 2 - c, w / 2, h, d / 2, 0.6),
    spanGeo(-w / 2, h - cap, -d / 2, w / 2, h, -d / 2 + c, 0.6),
    spanGeo(w / 2 - c, h - cap, -d / 2, w / 2, h, d / 2, 0.6),
    spanGeo(-w / 2, h - cap, -d / 2, -w / 2 + c, h, d / 2, 0.6),
  ];
  const g = bake(parts);
  g.translate(o.x, o.y - h / 2, o.z);
  ctx.edges.push(o);
  const out = [new THREE.Mesh(g, surfaceMaterial(o.material))];
  // Roof deck inside the ring: this is the surface `collideWorld` rests a
  // craft on, so it has to look like a roof and not like more concrete.
  const deck = boxGeo(w - c * 2, 0.14, d - c * 2, o.x, o.y - h / 2 + 0.07, o.z, 0, 0.3);
  out.push(new THREE.Mesh(deck, ctx.scenery.mat('deck')));
  return out;
}

/* -------------------------------------------------------------- roof plant */

function buildWaterTower(ctx, o) {
  const out = [];
  const half = Math.min(o.sx, o.sz) * 0.5;
  const legR = half * 0.44;
  const legTop = 3.4;
  const parts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(0.16, 0.22, legTop, 6);
    leg.translate(sx * legR, legTop / 2, sz * legR);
    parts.push(leg);
  }
  for (let i = 0; i < 3; i++) {
    const y = 0.8 + i * 1.1;
    for (const a of [-1, 1]) {
      const g = new THREE.BoxGeometry(legR * 2.2, 0.08, 0.08);
      g.rotateZ(a * 0.6); g.translate(0, y, a * legR);
      parts.push(g);
      const g2 = new THREE.BoxGeometry(0.08, 0.08, legR * 2.2);
      g2.rotateX(-a * 0.6); g2.translate(a * legR, y, 0);
      parts.push(g2);
    }
  }
  const legs = bake(parts);
  legs.translate(o.x, o.y - o.sy / 2, o.z);
  out.push(new THREE.Mesh(legs, ctx.scenery.mat('steel')));

  const tR = half * 0.84, tH = 3.4;
  const tank = [];
  const cyl = new THREE.CylinderGeometry(tR, tR, tH, 14, 1, true);
  cyl.translate(0, legTop + tH / 2, 0);
  tank.push(cyl);
  const cap = new THREE.CircleGeometry(tR, 14);
  cap.rotateX(-Math.PI / 2); cap.translate(0, legTop + tH, 0);
  tank.push(cap);
  for (let i = 0; i < 3; i++) {
    const hoop = new THREE.TorusGeometry(tR + 0.05, 0.06, 5, 16);
    hoop.rotateX(Math.PI / 2);
    hoop.translate(0, legTop + 0.55 + i * (tH - 1.1) / 2, 0);
    tank.push(hoop);
  }
  const roof = new THREE.ConeGeometry(tR + 0.18, 0.72, 14);
  roof.translate(0, legTop + tH + 0.34, 0);
  tank.push(roof);
  const fin = new THREE.CylinderGeometry(0.06, 0.06, 0.45, 5);
  fin.translate(0, legTop + tH + 0.88, 0);
  tank.push(fin);
  const tg = bake(tank);
  tg.translate(o.x, o.y - o.sy / 2, o.z);
  out.push(new THREE.Mesh(tg, ctx.scenery.mat('rust')));

  const lad = [];
  for (const s of [-1, 1]) lad.push(spanGeo(Math.min(s * 0.2, s * 0.2 + 0.06), 0.3, -0.05, Math.max(s * 0.2, s * 0.2 + 0.06), legTop + tH * 0.75, 0.01, 1));
  for (let i = 0; i < 10; i++) lad.push(spanGeo(-0.22, 0.5 + i * 0.62, -0.05, 0.22, 0.56 + i * 0.62, 0.01, 1));
  const lg = bake(lad);
  lg.rotateY(0.7);
  lg.translate(o.x, o.y - o.sy / 2, o.z);
  out.push(new THREE.Mesh(lg, ctx.scenery.mat('darkSteel')));
  return out;
}

function buildAcPlant(ctx, o) {
  const w = o.sx, h = o.sy, d = o.sz;
  const parts = [], trim = [];
  parts.push(spanGeo(-w / 2 + 0.3, 0.28, -d / 2 + 0.3, w / 2 - 0.3, h - 0.14, d / 2 - 0.3, 0.45));
  trim.push(spanGeo(-w / 2 + 0.2, 0, -d / 2 + 0.2, w / 2 - 0.2, 0.3, d / 2 - 0.2, 0.6));
  for (let i = 0; i < 6; i++) {
    const y = 0.5 + i * ((h - 1.0) / 6);
    trim.push(spanGeo(w / 2 - 0.36, y, -d / 2 + 0.5, w / 2 - 0.3, y + 0.12, d / 2 - 0.5, 1));
  }
  for (let k = 0; k < 2; k++) {
    const fx = -w / 4 + k * (w / 2);
    const R = Math.min(w / 4, d / 2) * 0.88;
    const ring = new THREE.TorusGeometry(R, 0.08, 5, 18);
    ring.rotateX(Math.PI / 2); ring.translate(fx, h - 0.14, 0);
    trim.push(ring);
    const well = new THREE.CylinderGeometry(R * 0.95, R * 0.78, 0.18, 16, 1, true);
    well.translate(fx, h - 0.23, 0);
    parts.push(well);
    for (let b = 0; b < 4; b++) {
      const bl = new THREE.BoxGeometry(R * 1.75, 0.03, R * 0.3);
      bl.rotateY(b * Math.PI / 4);
      bl.rotateZ(0.22);
      bl.translate(fx, h - 0.18, 0);
      trim.push(bl);
    }
  }
  const out = [];
  for (const [list, matName, name] of [[parts, 'darkSteel', 'ac:casing'], [trim, 'steel', 'ac:trim']]) {
    const g = bake(list);
    g.translate(o.x, o.y - h / 2, o.z);
    const mesh = new THREE.Mesh(g, ctx.scenery.mat(matName));
    mesh.name = name;
    out.push(mesh);
  }
  return out;
}

/* --------------------------------------------------------------------- mast */

function buildMast(ctx, o) {
  const half = Math.min(o.sx, o.sz) * 0.5;
  const H = o.sy;
  const bays = Math.max(6, Math.round(H / 4));
  const base = half * 0.84;
  const halfAt = (t) => base * (1 - 0.7 * t);
  const parts = [];
  for (let i = 0; i < bays; i++) {
    const t0 = i / bays, t1 = (i + 1) / bays;
    const y0 = t0 * H, y1 = t1 * H;
    const r0 = halfAt(t0), r1 = halfAt(t1);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = new THREE.CylinderGeometry(0.05, 0.05, y1 - y0, 5);
      leg.translate(sx * (r0 + r1) / 2, (y0 + y1) / 2, sz * (r0 + r1) / 2);
      parts.push(leg);
    }
    for (let s = 0; s < 4; s++) {
      const a0 = (s / 4) * 6.283, a1 = ((s + 1) / 4) * 6.283;
      const p0 = [Math.cos(a0) * r1, Math.sin(a0) * r1];
      const p1 = [Math.cos(a1) * r1, Math.sin(a1) * r1];
      const seg = new THREE.BoxGeometry(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 0.05, 0.05);
      seg.rotateY(-Math.atan2(p1[1] - p0[1], p1[0] - p0[0]));
      seg.translate((p0[0] + p1[0]) / 2, y1, (p0[1] + p1[1]) / 2);
      parts.push(seg);
      const q0 = [Math.cos(a0) * r0, Math.sin(a0) * r0];
      const q1 = [Math.cos(a1) * r1, Math.sin(a1) * r1];
      const flat = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
      const dg = new THREE.BoxGeometry(Math.hypot(flat, y1 - y0), 0.035, 0.035);
      dg.rotateY(-Math.atan2(q1[1] - q0[1], q1[0] - q0[0]));
      dg.rotateZ(Math.atan2(y1 - y0, flat) * (s % 2 ? 1 : -1));
      dg.translate((q0[0] + q1[0]) / 2, (y0 + y1) / 2, (q0[1] + q1[1]) / 2);
      parts.push(dg);
    }
  }
  // Whip antenna, kept under the box top rather than above it.
  const wh = Math.min(H * 0.12, 2.5);
  const whip = new THREE.CylinderGeometry(0.03, 0.05, wh, 5);
  whip.translate(0, H - wh / 2, 0);
  parts.push(whip);
  const g = bake(parts);
  g.translate(o.x, o.y - H / 2, o.z);
  return new THREE.Mesh(g, ctx.scenery.mat('darkSteel'));
}

/* --------------------------------------------------------------- watchtower */

function buildWatchtower(ctx, o) {
  const out = [];
  const half = Math.min(o.sx, o.sz) * 0.5;
  const legR = half * 0.8;
  const legW = half * 0.26;
  const H = o.sy;
  const parts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * legR, z = sz * legR;
    parts.push(boxGeo(legW, H, legW, x, H / 2, z, 0, 0.5));
    parts.push(boxGeo(legW * 1.5, 0.16, legW * 1.5, x, H - 0.08, z, 0, 0.5));
  }
  const lifts = 3, spanY = H - 0.9;
  for (let i = 0; i < lifts; i++) {
    const y0 = 0.45 + (i * spanY) / lifts;
    const y1 = y0 + spanY / lifts;
    for (const s of [0, 1]) {
      const ax = s ? 1 : -1, az = s ? -1 : 1;
      const diag = Math.hypot(2 * legR, y1 - y0);
      for (const dir of [-1, 1]) {
        const g = boxGeo(diag, 0.11, 0.11, 0, 0, 0, 0, 0.6);
        g.rotateZ(dir * Math.atan2(y1 - y0, 2 * legR));
        g.translate(0, (y0 + y1) / 2, az * legR);
        parts.push(g);
        const g2 = boxGeo(diag, 0.11, 0.11, 0, 0, 0, 0, 0.6);
        g2.rotateX(-dir * Math.atan2(y1 - y0, 2 * legR));
        g2.translate(ax * legR, (y0 + y1) / 2, 0);
        parts.push(g2);
      }
      parts.push(boxGeo(2 * legR, 0.09, 0.09, 0, y0, az * legR, 0, 0.6));
      parts.push(boxGeo(0.09, 0.09, 2 * legR, ax * legR, y0, 0, 0, 0.6));
    }
  }
  const frame = bake(parts);
  frame.translate(o.x, o.y - H / 2, o.z);
  out.push(new THREE.Mesh(frame, ctx.scenery.mat('plank')));

  const deckO = ctx.deckOf.get(o);
  if (deckO) {
    const dw = deckO.sx, dh = deckO.sy, dd = deckO.sz;
    const dp = [];
    for (let i = 0; i < 5; i++) {
      const z = -dd / 2 + 0.18 + i * ((dd - 0.36) / 4);
      dp.push(spanGeo(-dw / 2 + 0.2, 0, z - 0.05, dw / 2 - 0.2, dh * 0.55, z + 0.05, 0.8));
    }
    dp.push(spanGeo(-dw / 2, dh * 0.55, -dd / 2, dw / 2, dh, dd / 2, 0.7));
    const deck = bake(dp);
    deck.translate(deckO.x, deckO.y - dh / 2, deckO.z);
    out.push(new THREE.Mesh(deck, ctx.scenery.mat('plank')));

    const rp = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      rp.push(boxGeo(0.1, dh, 0.1, sx * (dw / 2 - 0.09), 0, sz * (dd / 2 - 0.09), 0, 0.8));
    }
    for (const sz of [-1, 1]) rp.push(spanGeo(-dw / 2 + 0.1, dh * 0.6, sz * (dd / 2 - 0.15), dw / 2 - 0.1, dh * 0.85, sz * (dd / 2 - 0.03), 1));
    for (const sx of [-1, 1]) rp.push(spanGeo(sx * (dw / 2 - 0.15), dh * 0.6, -dd / 2 + 0.1, sx * (dw / 2 - 0.03), dh * 0.85, dd / 2 - 0.1, 1));
    for (let i = 0; i < 8; i++) {
      const x = -dw / 2 + 0.45 + i * ((dw - 0.9) / 7);
      for (const sz of [-1, 1]) rp.push(boxGeo(0.055, dh, 0.055, x, 0, sz * (dd / 2 - 0.09), 0, 1));
    }
    const rail = bake(rp);
    rail.translate(deckO.x, deckO.y + dh / 2, deckO.z);
    out.push(new THREE.Mesh(rail, ctx.scenery.mat('trim')));
  }
  return out;
}

/** Consumed by the watchtower builder. */
function buildDeck(ctx) { return null; }

/* ------------------------------------------------------------------ hangar */

function buildRoofSlab(ctx, o) {
  const out = [];
  const w = o.sx, h = o.sy, d = o.sz;
  out.push(new THREE.Mesh(boxGeo(w, h, d, o.x, o.y, o.z), surfaceMaterial(o.material)));
  const parts = [];
  const nP = Math.max(4, Math.round(w / 3.2));
  for (let i = 0; i <= nP; i++) {
    const x = -w / 2 + (i * w) / nP;
    parts.push(spanGeo(x - 0.1, -h / 2, -d / 2, x + 0.1, -h / 2 + h * 0.4, d / 2, 0.5));
  }
  const nT = Math.max(3, Math.round(d / 14));
  for (let i = 0; i <= nT; i++) {
    const z = -d / 2 + (i * d) / nT;
    parts.push(spanGeo(-w / 2, -h / 2 + h * 0.08, z - 0.22, w / 2, h / 2, z + 0.22, 0.4));
  }
  const g = bake(parts);
  g.translate(o.x, o.y, o.z);
  out.push(new THREE.Mesh(g, ctx.scenery.mat('darkSteel')));
  ctx.edges.push(o);
  return out;
}

function buildWall(ctx, o) {
  const along = o.sx > o.sz ? 'x' : 'z';
  const L = Math.max(o.sx, o.sz);
  const W = Math.min(o.sx, o.sz);
  // Which face looks into the hangar: the one nearer the world origin.
  const inX = o.x > 0 ? -1 : 1;
  const inZ = o.z > 0 ? -1 : 1;
  const parts = [];
  const n = Math.max(4, Math.round(L / 3.4));
  for (let i = 0; i <= n; i++) {
    const p = -L / 2 + (i * L) / n;
    const g = new THREE.BoxGeometry(0.28, o.sy * 0.94, 0.14);
    scaleBoxUV(g, 0.28, o.sy * 0.94, 0.14, 0.5);
    if (along === 'x') g.translate(o.x + p, o.y, o.z + inZ * (W / 2 - 0.07));
    else { g.rotateY(Math.PI / 2); g.translate(o.x + inX * (W / 2 - 0.07), o.y, o.z + p); }
    parts.push(g);
  }
  const band = (y, hh, inset) => {
    const g = along === 'x'
      ? spanGeo(-L / 2, y - hh / 2, inZ > 0 ? W / 2 - inset : -W / 2, L / 2, y + hh / 2, inZ > 0 ? W / 2 : -W / 2 + inset, 0.5)
      : spanGeo(inX > 0 ? W / 2 - inset : -W / 2, y - hh / 2, -L / 2, inX > 0 ? W / 2 : -W / 2 + inset, y + hh / 2, L / 2, 0.5);
    g.translate(o.x, o.y, o.z);
    return g;
  };
  parts.push(band(-o.sy / 2 + 0.6, 1.2, 0.22));
  parts.push(band(o.sy / 2 - 0.5, 1.0, 0.18));
  const mesh = new THREE.Mesh(bake(parts), surfaceMaterial(o.material));
  ctx.edges.push(o);
  return mesh;
}

function buildPartition(ctx, o) {
  const along = o.sx > o.sz ? 'x' : 'z';
  const L = Math.max(o.sx, o.sz);
  const T = Math.min(o.sx, o.sz);
  const doorW = Math.min(3.4, L * 0.3);
  const doorH = Math.min(2.7, o.sy * 0.85);
  const doorX = -L / 2 + doorW * 0.5 + L * 0.18;
  const panel = wallGeo(L, o.sy, T, [{ x: doorX, y: -o.sy / 2 + doorH / 2, w: doorW, h: doorH }], 0.45);
  if (along === 'z') panel.rotateY(Math.PI / 2);
  panel.translate(o.x, o.y, o.z);
  const f = 0.1;
  const fr = [
    spanGeo(doorX - doorW / 2 - f, -o.sy / 2, -T / 2, doorX - doorW / 2, -o.sy / 2 + doorH + f, T / 2, 1),
    spanGeo(doorX + doorW / 2, -o.sy / 2, -T / 2, doorX + doorW / 2 + f, -o.sy / 2 + doorH + f, T / 2, 1),
    spanGeo(doorX - doorW / 2 - f, -o.sy / 2 + doorH, -T / 2, doorX + doorW / 2 + f, -o.sy / 2 + doorH + f, T / 2, 1),
    spanGeo(-L / 2, -o.sy / 2, -T / 2, L / 2, -o.sy / 2 + 0.14, -T / 2 + 0.06, 1),
    spanGeo(-L / 2, -o.sy / 2, T / 2 - 0.06, L / 2, -o.sy / 2 + 0.14, T / 2, 1),
  ];
  const fg = bake(fr);
  if (along === 'z') fg.rotateY(Math.PI / 2);
  fg.translate(o.x, o.y, o.z);
  const out = [new THREE.Mesh(panel, surfaceMaterial(o.material)), new THREE.Mesh(fg, ctx.scenery.mat('trim'))];
  ctx.edges.push(o);
  return out;
}

function buildRail(ctx, o) {
  const along = o.sx > o.sz ? 'x' : 'z';
  const L = Math.max(o.sx, o.sz), T = Math.min(o.sx, o.sz);
  const parts = [];
  const put = (g) => {
    if (along === 'z') g.rotateY(Math.PI / 2);
    g.translate(o.x, o.y, o.z);
    parts.push(g);
  };
  // I-section, entirely within the 0.8 m box.
  put(spanGeo(-L / 2, -T / 2, -T / 2, L / 2, -T / 2 + T * 0.18, T / 2, 0.6));
  put(spanGeo(-L / 2, T / 2 - T * 0.16, -T / 2 + T * 0.1, L / 2, T / 2, T / 2 - T * 0.1, 0.6));
  put(spanGeo(-L / 2, -T / 2 + T * 0.18, -T * 0.1, L / 2, T / 2 - T * 0.16, T * 0.1, 0.6));
  for (const s of [-1, 1]) put(boxGeo(0.3, T * 0.8, T * 0.8, s * (L / 2 - 0.15), 0, 0, 0, 0.6));
  const mesh = new THREE.Mesh(bake(parts), ctx.scenery.mat('steel'));
  ctx.edges.push(o);
  return mesh;
}

function buildCrate(ctx, o) {
  const w = o.sx, h = o.sy, d = o.sz;
  const parts = [boxGeo(w - 0.06, h - 0.06, d - 0.06, 0, 0, 0, 0, 0.5)];
  const t = Math.min(0.14, Math.min(w, h, d) * 0.1);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(boxGeo(t, h, t, sx * (w / 2 - t / 2), 0, sz * (d / 2 - t / 2), 0, 0.6));
  }
  const bh = 0.14;
  for (const y of [-h * 0.29, h * 0.29]) {
    parts.push(spanGeo(-w / 2, y - bh / 2, d / 2 - 0.07, w / 2, y + bh / 2, d / 2, 0.7));
    parts.push(spanGeo(-w / 2, y - bh / 2, -d / 2, w / 2, y + bh / 2, -d / 2 + 0.07, 0.7));
    parts.push(spanGeo(w / 2 - 0.07, y - bh / 2, -d / 2, w / 2, y + bh / 2, d / 2, 0.7));
    parts.push(spanGeo(-w / 2, y - bh / 2, -d / 2, -w / 2 + 0.07, y + bh / 2, d / 2, 0.7));
  }
  const g = bake(parts);
  g.translate(o.x, o.y, o.z);
  ctx.edges.push(o);
  return new THREE.Mesh(g, surfaceMaterial(o.material));
}

function buildFence(ctx, o) {
  const along = o.sx > o.sz ? 'x' : 'z';
  const L = Math.max(o.sx, o.sz), T = Math.min(o.sx, o.sz);
  if (!ctx.inst.has('fencePost')) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    scaleBoxUV(g, 1, 1, 1, 0.6);
    inst(ctx, 'fencePost', g, ctx.scenery.mat('steel'));
  }
  const n = Math.max(2, Math.round(L / 5));
  const pz = Math.min(0.12, T * 0.85);
  for (let i = 0; i <= n; i++) {
    const p = -L / 2 + (i * L) / n;
    push(ctx, 'fencePost', along === 'x'
      ? trs(o.x + p, o.y, o.z, 0, 0, 0, 0.12, o.sy, pz)
      : trs(o.x, o.y, o.z + p, 0, 0, 0, pz, o.sy, 0.12), null);
  }
  const parts = [];
  for (const y of [o.sy * 0.5 - 0.07, -o.sy * 0.5 + 0.07]) {
    const g = along === 'x'
      ? spanGeo(-L / 2, y - 0.05, -0.055, L / 2, y + 0.05, 0.055, 0.8)
      : spanGeo(-0.055, y - 0.05, -L / 2, 0.055, y + 0.05, L / 2, 0.8);
    g.translate(o.x, o.y, o.z);
    parts.push(g);
  }
  const panel = along === 'x'
    ? boxGeo(L, o.sy - 0.16, 0.035, o.x, o.y, o.z, 0, 0.5)
    : boxGeo(0.035, o.sy - 0.16, L, o.x, o.y, o.z, 0, 0.5);
  return [
    new THREE.Mesh(bake(parts), ctx.scenery.mat('steel')),
    new THREE.Mesh(panel, surfaceMaterial('mesh')),
  ];
}

/* ------------------------------------------------------------------- rocks */

function buildRock(ctx, o) {
  const r = rng(obsSeed(o, 9));
  const key = (obsSeed(o, 10) & 1) ? 'rockA' : 'rockB';
  const bottom = o.y - o.sy / 2;
  const out = [placeAsset(ctx.scenery, key, o.x, bottom, o.z, o.sx, o.sy, o.sz, r() * 6.283, obsSeed(o, 11))];
  if ((obsSeed(o, 12) >>> 11) % 4 === 0) {
    const s = Math.min(o.sx, o.sz);
    out.push(placeAsset(ctx.scenery, 'snag', o.x + (r() - 0.5) * s * 0.3, bottom, o.z + (r() - 0.5) * s * 0.3,
      s * 0.6, o.sy * 0.8, s * 0.6, r() * 6.283, obsSeed(o, 13)));
  }
  return out;
}

/**
 * The Desert Tower landmark. The collider is an 26 x 80 x 26 box; this is a
 * faceted mesa that fills it without reaching the box faces, so nothing hangs
 * in the air past the silhouette the pilot is actually given.
 */
function buildMesa(ctx, o) {
  const w = o.sx, h = o.sy, d = o.sz;
  const r = rng(obsSeed(o, 14));
  const sides = 9, rings = 13;
  const base = Math.min(w, d) * 0.5;
  const ringVerts = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const profile = 1 - 0.36 * Math.pow(t, 0.7);
    const wob = 1 + (r() - 0.5) * 0.1;
    const ledge = (Math.sin(t * 9.1) > 0.86 ? 1.05 : 1) * (Math.sin(t * 4.3) > 0.9 ? 0.95 : 1);
    const rad = Math.min(base * 0.94, base * profile * wob * ledge);
    const ring = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * 6.283 + t * 0.35;
      const rr = rad * (0.82 + 0.18 * (((s * 7 + i * 3) % 5) / 4));
      ring.push(new THREE.Vector3(Math.cos(a) * rr, t * h, Math.sin(a) * rr));
    }
    ringVerts.push(ring);
  }
  const pos = [], idx = [];
  for (const ring of ringVerts) for (const v of ring) pos.push(v.x, v.y, v.z);
  pos.push(0, h, 0);
  const capStart = rings * sides;
  for (let i = 0; i < rings - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = i * sides + s, b = i * sides + (s + 1) % sides;
      const c = (i + 1) * sides + s, e = (i + 1) * sides + (s + 1) % sides;
      idx.push(a, c, b, b, c, e);
      idx.push(capStart, (i + 1) * sides + s, (i + 1) * sides + (s + 1) % sides);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.translate(o.x, o.y - h / 2, o.z);
  const out = [new THREE.Mesh(g, ctx.scenery.mat('dirtRock'))];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * 6.283 + r();
    const rad = base * (0.45 + r() * 0.2);
    out.push(placeAsset(ctx.scenery, i % 2 ? 'rockA' : 'rockB',
      o.x + Math.cos(a) * rad, o.y - h / 2, o.z + Math.sin(a) * rad,
      2.6 + r() * 1.6, 1.4 + r(), 2.6 + r() * 1.6, r() * 6.283, obsSeed(o, 20 + i)));
  }
  ctx.edges.push(o);
  return out;
}

/* --------------------------------------------------------------- dispatch */

const BUILDERS = {
  box: buildBox,
  house: buildHouse,
  window: buildWindow,
  cabin: buildCabin,
  shed: buildShed,
  building: buildBuilding,
  parapet: buildParapet,
  waterTower: buildWaterTower,
  acPlant: buildAcPlant,
  mast: buildMast,
  watchtower: buildWatchtower,
  watchtowerDeck: buildDeck,
  rock: buildRock,
  mesa: buildMesa,
  roofSlab: buildRoofSlab,
  wall: buildWall,
  partition: buildPartition,
  rail: buildRail,
  crate: buildCrate,
  fence: buildFence,
  pineTrunk: buildPineTrunk,
  pineCrown: buildPineCrown,
  treeTrunk: buildBroadTrunk,
  treeCrown: buildBroadCrown,
};