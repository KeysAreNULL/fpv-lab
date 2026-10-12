// Effects: dust, propwash visualisation and a flight trail.
//
// Kept deliberately cheap - particle counts scale with how much disturbed flow
// there actually is, so nothing is allocated during normal flight.

import * as THREE from '../../vendor/three.module.js';
import { clamp, rng } from '../core/math.js';

const MAX_PARTICLES = 220;

/**
 * Points render as flat squares without a sprite, which at chase-camera range
 * reads as a string of grey blocks rather than disturbed air. One shared
 * radial-gradient texture turns them into soft specks; it is built once and
 * reused by every Effects instance.
 */
let _softDot = null;
function softDot() {
  if (_softDot) return _softDot;
  const s = 32;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  _softDot = new THREE.CanvasTexture(cv);
  return _softDot;
}

export class Effects {
  constructor() {
    this.group = new THREE.Group();
    this.rand = rng(12345);
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.vel = new Float32Array(MAX_PARTICLES * 3);
    this.count = 0;
    this.head = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setDrawRange(0, 0);
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xa8b4c0, size: 0.045, transparent: true, opacity: 0.42,
      sizeAttenuation: true, depthWrite: false, map: softDot(),
    }));
    this.group.add(this.points);
    this.geo = geo;

    // Flight trail
    this.trailMax = 400;
    this.trailPos = new Float32Array(this.trailMax * 3);
    this.trailIdx = 0;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    tg.setDrawRange(0, 0);
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({
      color: 0x4fd18b, transparent: true, opacity: 0.7,
    }));
    this.group.add(this.trail);
    this.trailGeo = tg;
    this.trailOn = false;

    // Propwash cone visualisation, one per prop
    this.cones = [];
    for (let i = 0; i < 4; i++) {
      const geo2 = new THREE.ConeGeometry(0.09, 0.6, 10, 1, true);
      geo2.translate(0, -0.3, 0);
      const m = new THREE.Mesh(geo2, new THREE.MeshBasicMaterial({
        color: 0x8fd0ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
      }));
      this.group.add(m);
      this.cones.push(m);
    }
    this.showWash = false;
  }

  emit(x, y, z, vx, vy, vz, life = 0.8) {
    const i = this.head;
    this.positions[i * 3] = x; this.positions[i * 3 + 1] = y; this.positions[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.head = (this.head + 1) % MAX_PARTICLES;
    this.count = Math.min(MAX_PARTICLES, this.count + 1);
  }

  update(dt, craft, opts = {}) {
    // Dust: only when the props are actually disturbing a surface, and only
    // when there is a surface to disturb.
    const surf = craft.surfaceWash || 0;
    const clear = craft.clearance;
    const near = clear != null && clear < 1.2;
    if (near && surf > 0.5 && this.rand() < surf * 0.8) {
      const n = 1 + Math.floor(surf * 2);
      for (let k = 0; k < n; k++) {
        const p = craft.props[(Math.random() * 4) | 0];
        const w = craft.body.pointToWorld(p.propPos, {});
        const r = (Math.random() - 0.5) * 0.14;
        this.emit(w.x + r, Math.max(0.01, w.y - 0.09), w.z + r,
          (Math.random() - 0.5) * 1.2, 0.2 + Math.random() * 0.5, (Math.random() - 0.5) * 1.2,
          0.5 + Math.random() * 0.5);
      }
    }

    // Integrate and age
    let alive = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const drag = Math.exp(-dt * 1.6);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * drag - 0.4 * dt;
      this.vel[i * 3 + 2] *= drag;
      this.positions[i * 3] += this.vel[i * 3] * dt;
      this.positions[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.life[i] > 0) alive++;
    }
    this.geo.setDrawRange(0, MAX_PARTICLES);
    this.geo.attributes.position.needsUpdate = true;
    this.points.material.opacity = clamp(surf * 0.35, 0, 0.6);

    // Propwash cones
    const q = new THREE.Quaternion(craft.body.quat.x, craft.body.quat.y, craft.body.quat.z, craft.body.quat.w);
    for (let i = 0; i < 4; i++) {
      const c = this.cones[i];
      const p = craft.props[i];
      const hub = craft.body.pointToWorld(p.propPos, {});
      c.position.set(hub.x, hub.y, hub.z);
      // Cones point along the thrust axis (body -Z); three.js cones point +Y,
      // so rotate +Y onto -Z and flip.
      c.quaternion.copy(q);
      c.rotateX(Math.PI);
      const strength = this.showWash
        ? clamp((p.w || 0) / 8, 0, 1) * (1 - clamp((craft.clearance || 99) / 3, 0, 1)) + 0.15
        : 0;
      c.material.opacity = strength * 0.30;
      c.scale.setScalar(0.6 + strength * 1.4);
      c.visible = strength > 0.02;
    }

    // Trail
    if (this.trailOn) {
      const b = craft.body;
      this.trailPos[this.trailIdx * 3] = b.pos.x;
      this.trailPos[this.trailIdx * 3 + 1] = b.pos.y;
      this.trailPos[this.trailIdx * 3 + 2] = b.pos.z;
      this.trailIdx = (this.trailIdx + 1) % this.trailMax;
      const n = Math.min(this.trailMax, this.trailIdx || this.trailMax);
      this.trailGeo.setDrawRange(0, n);
      this.trailGeo.attributes.position.needsUpdate = true;
    }
  }

  clearTrail() { this.trailIdx = 0; this.trailGeo.setDrawRange(0, 0); }
}
