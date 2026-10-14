// Cameras and the FPV feed.
//
// The FPV camera is not just "a camera at the front": it is the video link's
// output, so it carries the link's latency, its snow, its dropouts and its
// interference. When the RF solver says the signal is 2 dB below threshold,
// what you see degrades the way analog actually degrades - progressively into
// snow - while digital holds and then falls off a cliff. That difference is the
// whole reason people choose one system over the other.

import * as THREE from '../../vendor/three.module.js';
import { clamp, lerp, RAD, DEG } from '../core/math.js';
import { attitudeOf } from '../sim/craft.js';

export const CAMERA_MODES = [
  { id: 'fpv', label: 'FPV', key: '1' },
  { id: 'chase', label: 'Chase', key: '2' },
  { id: 'orbit', label: 'Orbit', key: '3' },
  { id: 'top', label: 'Top-down', key: '4' },
  { id: 'pit', label: 'Pilot view', key: '5' },
];

// Scratch objects for the per-frame lookAt maths, so nothing allocates here.
const TMP_TARGET = new THREE.Vector3();
const TMP_MATRIX = new THREE.Matrix4();

export class CameraRig {
  constructor(camera, viewport) {
    this.camera = camera;
    this.viewport = viewport;
    this.mode = 'chase';
    this.chaseDist = 1.1;
    this.chaseHeight = 0.35;
    this.chasePos = new THREE.Vector3(0, 2, 4);
    this.chaseLook = new THREE.Vector3();
    this.orbitAngle = 0.7;
    this.orbitDist = 1.4;
    this.orbitHeight = 0.45;
    this.smooth = 0;
    this.shake = 0;
    this.fpvPos = new THREE.Vector3();
    // FOV wobbles with the throttle, exactly like a cheap FPV lens breathing.
    this.baseFov = 100;
    this.fov = 100;
    // Feed quality, driven by the RF model
    this.quality = 1;
    this.latencyMs = 5;
    this.frameDelivered = null;
    this.feedPos = { x: 0, y: 0, z: 0 };
    this.feedQuat = { x: 0, y: 0, z: 0, w: 1 };
    this._pending = [];
  }

  setMode(m) { this.mode = m; }

  /**
   * Drop the smoothing lag so the camera jumps straight to the craft.
   *
   * Without this, recovering from a lost craft looks like nothing happened: the
   * simulation has been reset to the start pad, but the camera is still lerping
   * back from wherever it was, and since the lerp is per-frame it takes a long
   * time to come back from a large excursion. Reset has to feel immediate.
   */
  snap(craft) {
    if (!craft) return;
    const b = craft.body;
    // If the craft itself is still somewhere impossible, do not chase it.
    if (!Number.isFinite(b.pos.x) || !Number.isFinite(b.pos.y)) return;
    this.chasePos.set(b.pos.x, b.pos.y + this.chaseHeight, b.pos.z + this.chaseDist);
    this.chaseLook.set(b.pos.x, b.pos.y, b.pos.z);
    this.fpvPos.set(b.pos.x, b.pos.y, b.pos.z);
    this.shake = 0;
    this._pending.length = 0;
  }

  /** Where the FPV camera physically sits on the craft. */
  fpvMount(craft) {
    return {
      pos: { x: 0.026, y: 0, z: -(craft.frame.stackHeight__mm / 1000 + 0.022) },
      tilt: craft.frame.camTilt__deg || 20,
      fov: craft.vtx.fov__deg || 150,
    };
  }

  /** Camera pose for the FPV feed, in world space. */
  fpvPose(craft) {
    const b = craft.body;
    const m = this.fpvMount(craft);
    // The lens is a fixed part tilted up about the craft's lateral axis; it does
    // not swing round the nose, so the mount point is used as-is.
    const world = new THREE.Vector3(m.pos.x, m.pos.y, m.pos.z)
      .applyQuaternion(new THREE.Quaternion(b.quat.x, b.quat.y, b.quat.z, b.quat.w))
      .add(new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z));
    const q = new THREE.Quaternion(b.quat.x, b.quat.y, b.quat.z, b.quat.w);
    // Body-frame up is -Z (NED). The lens is bolted to the frame, so the image's
    // vertical is the airframe's vertical - not whatever the camera's own up is.
    const up = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const t = m.tilt * DEG;
    const forward = new THREE.Vector3(Math.cos(t), 0, -Math.sin(t)).applyQuaternion(q);
    return { world, up, forward, tilt: m.tilt, fov: m.fov };
  }

  /**
   * Point a camera out of the nose.
   *
   * A three.js camera looks down its own -Z, so turning it to look along the
   * airframe's +X takes two rotations, not one. A single quarter turn about Y
   * gets the view *direction* right and leaves the camera's up pointing out of
   * the craft's right-hand side, which renders the whole feed on its side; a
   * half turn about Y points it at the ground instead. Building the basis
   * explicitly is the only way to get direction and roll right together.
   */
  applyFpvOrientation(camera, pose) {
    camera.up.copy(pose.up);
    camera.lookAt(TMP_TARGET.copy(camera.position).add(pose.forward));
  }

  update(craft, dt, opts = {}) {
    const b = craft.body;
    const e = attitudeOf(b.quat);
    const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);

    // FOV breathes with speed and throttle, and narrows as the feed degrades
    // because a weak analog signal also loses sync on the sync separator.
    const target = this.baseFov + clamp(speed * 0.35, 0, 14) + (craft.fc.throttleOut / 1000 - 0.3) * 6;
    this.fov = lerp(this.fov, target, clamp(dt * 6, 0, 1));

    if (this.mode === 'fpv') {
      const pose = this.fpvPose(craft);
      this.camera.position.copy(pose.world);
      this.applyFpvOrientation(this.camera, pose);
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
    } else if (this.mode === 'chase') {
      const behind = new THREE.Vector3(-Math.cos(e.yaw), 0, Math.sin(e.yaw)).normalize();
      const flat = new THREE.Vector3(behind.x, 0, behind.z);
      const target = new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z)
        .addScaledVector(flat, -this.chaseDist)
        .add(new THREE.Vector3(0, this.chaseHeight, 0));
      const k = clamp(dt * 5.5, 0, 1);
      this.chasePos.lerp(target, k);
      this.camera.position.copy(this.chasePos);
      this.chaseLook.lerp(new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z), k);
      this.camera.lookAt(this.chaseLook);
      this.camera.fov = 72;
      this.camera.updateProjectionMatrix();
    } else if (this.mode === 'orbit') {
      this.orbitAngle += dt * 0.25;
      const p = new THREE.Vector3(
        b.pos.x + Math.cos(this.orbitAngle) * this.orbitDist,
        b.pos.y + this.orbitHeight,
        b.pos.z + Math.sin(this.orbitAngle) * this.orbitDist);
      this.camera.position.lerp(p, clamp(dt * 6, 0, 1));
      this.camera.lookAt(b.pos.x, b.pos.y, b.pos.z);
      this.camera.fov = 60;
      this.camera.updateProjectionMatrix();
    } else if (this.mode === 'top') {
      this.camera.position.set(b.pos.x, b.pos.y + 14, b.pos.z + 0.01);
      this.camera.lookAt(b.pos.x, b.pos.y, b.pos.z);
      this.camera.fov = 55;
      this.camera.updateProjectionMatrix();
    } else if (this.mode === 'pit') {
      const p = opts.pilot || { x: 0, y: 1.6, z: 3 };
      this.camera.position.set(p.x, p.y, p.z);
      this.camera.lookAt(b.pos.x, b.pos.y, b.pos.z);
      this.camera.fov = 65;
      this.camera.updateProjectionMatrix();
    }

    // Camera shake from surface buffet and impacts.
    const buffet = (craft.surfaceWash || 0) * 0.0025;
    this.shake = lerp(this.shake, buffet + clamp((craft.battery.voltage < 12 ? 0.002 : 0), 0, 1), dt * 5);
    if (this.shake > 1e-5) {
      const t = performance.now() * 0.001;
      this.camera.rotateX(Math.sin(t * 71) * this.shake);
      this.camera.rotateY(Math.sin(t * 53) * this.shake);
    }
  }

  /**
   * The FPV feed is a *delayed* copy of the camera pose, delayed by the link
   * latency. That is why a digital system feels disconnected from the craft.
   */
  pushFeedPose(craft, latencyMs) {
    const pose = this.fpvPose(craft);
    // The delayed pose carries the *orientation* the lens would have had, which
    // for a nose-mounted camera is the airframe's, not a lookAt result.
    const quat = new THREE.Quaternion().setFromRotationMatrix(
      TMP_MATRIX.lookAt(pose.world, TMP_TARGET.copy(pose.world).add(pose.forward), pose.up));
    this._pending.push({
      at: latencyMs / 1000, pos: pose.world.clone(), quat, fov: pose.fov,
    });
    while (this._pending.length > 12) this._pending.shift();
  }

  popFeedPose(dt) {
    let out = null;
    for (let i = this._pending.length - 1; i >= 0; i--) {
      this._pending[i].at -= dt;
      if (this._pending[i].at <= 0) { out = this._pending[i]; this._pending.splice(i, 1); }
    }
    return out;
  }
}

/* ------------------------------------------------------------ FPV overlays */

// Canvas-based post effects drawn over the FPV feed: analog snow, digital
// blocking, rolling sync loss and static from interference. Done in 2D over the
// WebGL canvas because that is exactly what the pipeline does in reality.
export class FpvOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.snowCanvas = document.createElement('canvas');
    this.snowCanvas.width = 256; this.snowCanvas.height = 192;
    this.sctx = this.snowCanvas.getContext('2d');
    this.image = this.sctx.createImageData(256, 192);
    this.scrollY = 0;
    this.t = 0;
    this.enabled = true;
    this.useBarrel = false;
  }

  resize(w, h, dpr) {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  /** @param v {snow, dropout, static, quality, analog, rolling, latency} */
  draw(v) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!this.enabled || v.quality >= 0.999 && v.snow <= 0.001) return;
    this.t += 1;

    // --- analog snow: real per-pixel noise, generated in a small tile and scaled
    if (v.analog && v.snow > 0.002) {
      const img = this.image;
      const d = img.data;
      const amount = clamp(v.snow, 0, 1);
      for (let i = 0; i < d.length; i += 4) {
        // A rolling band, like a real sync loss, plus uniform grain
        const n = Math.random();
        const band = Math.random() < 0.02 ? 1 : 0;
        const g = clamp(n * (1 - amount) + Math.random() * amount + band * amount, 0, 1) * 255;
        d[i] = d[i + 1] = d[i + 2] = g;
        d[i + 3] = 255 * clamp(amount * 1.4, 0, 1);
      }
      this.sctx.putImageData(img, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.imageSmoothingEnabled = false;
      const scale = Math.max(W / 256, H / 192);
      ctx.drawImage(this.snowCanvas, 0, 0, 256 * scale, 192 * scale);
      ctx.restore();
    }

    // --- digital blocking: macroblocks and dropped frames
    if (!v.analog && (v.dropout > 0.002 || v.quality < 0.999)) {
      const n = Math.round(v.dropout * 26 + (1 - v.quality) * 6);
      for (let i = 0; i < n; i++) {
        const bw = 20 + Math.random() * 110;
        const bh = 12 + Math.random() * 70;
        ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '10,14,18' : '210,220,230'},${0.35 + Math.random() * 0.5})`;
        ctx.fillRect(Math.random() * W, Math.random() * H, bw, bh);
      }
      if (v.dropout > 0.25) {
        ctx.fillStyle = `rgba(8,10,13,${v.dropout * 0.55})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    // --- intercarrier interference: another pilot's video beating against yours
    if (v.static > 0.002) {
      const bands = Math.round(2 + v.static * 6);
      for (let i = 0; i < bands; i++) {
        const y = ((this.t * (1 + i * 0.4) + i * 90) % (H + 120)) - 60;
        const h = 20 + Math.random() * 70 * v.static;
        const g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, `rgba(235,242,250,${0.10 * v.static})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, y, W, h);
      }
    }

    // --- rolling vertical hold loss when the link is gone
    if (v.rolling > 0.001) {
      const bandH = H * v.rolling;
      const y = ((this.t * 9) % (H + bandH)) - bandH;
      ctx.fillStyle = 'rgba(12,15,19,0.85)';
      ctx.fillRect(0, y, W, bandH);
      ctx.fillStyle = 'rgba(200,220,240,0.25)';
      ctx.fillRect(0, y, W, 2);
    }

    // --- barrel distortion vignette, the signature of a cheap FPV cam
    if (this.useBarrel) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35,
        W / 2, H / 2, Math.max(W, H) * 0.72);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }
}

/* -------------------------------------------------------------- RF overlay */

// A little link-budget diagram next to the feeds: the path loss, the
// penetration loss and the resulting signal strength for each term.
export function drawLinkBar(canvas, budget, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!budget) {
    ctx.fillStyle = '#8695a4';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('no link', 8, 16);
    return;
  }
  // The budget carries no frequency of its own (it is a loss figure, not a link
  // description), so gating on budget.freq here always read undefined and the
  // transmit power row rendered as "+0". A non-null budget is the only
  // condition that matters.
  const rows = [
    ['TX power', opts.txDbm || 0],
    ['Free space', -budget.fspl],
    ['Penetration', -budget.pen],
    ['Diffraction', -budget.diff],
    ['Antenna / pol', -(budget.gTx + budget.gRx + budget.pol)],
    ['Excess', -budget.excess],
  ];
  let y = 14;
  ctx.font = '10px ui-monospace, monospace';
  for (const [label, val] of rows) {
    const mag = Math.abs(val);
    const bw = clamp(mag / 110, 0, 1) * (w - 96);
    const positive = val >= 0;
    ctx.fillStyle = positive ? '#4fd18b' : '#e0736a';
    ctx.fillRect(78, y - 8, bw, 9);
    ctx.fillStyle = '#9fb0bd';
    ctx.fillText(label, 4, y);
    ctx.fillStyle = '#c8d4de';
    ctx.fillText(`${val >= 0 ? '+' : ''}${val.toFixed(0)}`, 80 + bw, y);
    y += 14;
  }
  ctx.strokeStyle = '#3a4652';
  ctx.beginPath(); ctx.moveTo(78, 6); ctx.lineTo(78, y - 8); ctx.stroke();
  const rssi = opts.rssi != null ? opts.rssi : 0;
  ctx.fillStyle = '#c8d4de';
  ctx.fillText(`RSSI ${rssi.toFixed(0)} dBm   margin ${(opts.margin || 0).toFixed(0)} dB`, 4, y + 6);
}
