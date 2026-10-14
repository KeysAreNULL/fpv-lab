// RF propagation for the control link and the video link.
//
// Everything here is a real link budget rather than a distance-fade curve:
//   P_rx = P_tx + G_tx + G_rx - FSPL(d) - penetration - diffraction - excess
// with per-axis antenna patterns, polarisation mismatch, Fresnel-zone clearance,
// knife-edge diffraction at building corners, and co-channel interference from
// other pilots.
//
// The practical difference that matters in the sim: analog video degrades
// gradually into snow as the signal falls, while digital video holds almost
// perfectly and then falls off a cliff.

import {
  clamp, v3, vsub, vdot, vlen, vnorm, vcross, vadd,
} from '../core/math.js';
import {
  fsplDb, materialLossDb, knifeEdgeLossDb, fresnelRadius, MATERIALS,
  ANALOG_BANDS, DIGITAL_SYSTEMS, RC_SYSTEMS,
} from '../data/radio.js';

/* ---------------------------------------------------------------- ray tools */

// Slab-method ray/AABB intersection. Returns {t0,t1,normal} or null.
function rayBox(ox, oy, oz, dx, dy, dz, b, pad = 0) {
  const ix = 1 / (dx || 1e-12), iy = 1 / (dy || 1e-12), iz = 1 / (dz || 1e-12);
  let t0 = (-Infinity), t1 = Infinity, axis = 0, sign = 1;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  const lo = [b.min.x - pad, b.min.y - pad, b.min.z - pad];
  const hi = [b.max.x + pad, b.max.y + pad, b.max.z + pad];
  for (let i = 0; i < 3; i++) {
    let tn = (lo[i] - o[i]) * (1 / (d[i] || 1e-12));
    let tf = (hi[i] - o[i]) * (1 / (d[i] || 1e-12));
    let s = -1;
    if (tn > tf) { const tmp = tn; tn = tf; tf = tmp; s = 1; }
    if (tn > t0) { t0 = tn; axis = i; sign = s; }
    if (tf < t1) t1 = tf;
    if (t0 > t1) return null;
  }
  return { t0, t1, axis, sign };
}

/* ----------------------------------------------------------------- RF world */

// A set of axis-aligned obstacles in metres with material tags. Tracks, gates
// and the ground plane all register here, so the same solver works for the
// racing environment and for the free-flight sandbox props.
export class RFWorld {
  constructor() {
    this.obstacles = [];
    this.groundY = 0;
    this.hasGround = true;
  }
  clear() { this.obstacles.length = 0; }

  /** @param {object} b {min:{x,y,z}, max:{x,y,z}, material} */
  add(b) {
    if (!b.material) b.material = 'concrete';
    this.obstacles.push(b);
    return b;
  }
  addBox(cx, cy, cz, sx, sy, sz, material) {
    return this.add({
      min: { x: cx - sx / 2, y: cy - sy / 2, z: cz - sz / 2 },
      max: { x: cx + sx / 2, y: cy + sy / 2, z: cz + sz / 2 },
      material, center: { x: cx, y: cy, z: cz }, size: { x: sx, y: sy, z: sz },
    });
  }

  /**
   * Trace a straight path and return everything that attenuates it.
   * @returns {number} total additional loss in dB beyond free space
   */
  trace(a, b, freqMHz, wantDetail = false) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const D = Math.hypot(dx, dy, dz);
    if (D < 1e-6) return wantDetail ? { loss: 0, segments: [], shadow: false, distance: D } : 0;
    const ux = dx / D, uy = dy / D, uz = dz / D;
    const lambda = 299.792458 / freqMHz;

    let loss = 0;
    let worstDiff = 0;
    let shadowed = false;
    const segments = [];

    for (const ob of this.obstacles) {
      const hit = rayBox(a.x, a.y, a.z, ux, uy, uz, ob);
      if (!hit) continue;
      if (hit.t1 < 0 || hit.t0 > D) continue;

      const t0 = Math.max(0, hit.t0), t1 = Math.min(D, hit.t1);
      const chord = t1 - t0;

      // Perpendicular offset of the box centre from the line: used for both the
      // Fresnel clearance check and the knife-edge approximation.
      const c = ob.center || {
        x: (ob.min.x + ob.max.x) / 2, y: (ob.min.y + ob.max.y) / 2, z: (ob.min.z + ob.max.z) / 2,
      };
      const px = a.x + ux * t0, py = a.y + uy * t0, pz = a.z + uz * t0;
      const rx = c.x - px, ry = c.y - py, rz = c.z - pz;
      const proj = rx * ux + ry * uy + rz * uz;
      const perp = Math.sqrt(Math.max(0, rx * rx + ry * ry + rz * rz - proj * proj));

      // Fresnel clearance: if the obstruction is close enough to the line of
      // sight, the link is compromised even without a solid crossing.
      const fr = perp > 0 ? fresnelRadius(Math.max(0.5, proj), Math.max(0.5, D - proj), freqMHz) : 0;
      if (perp < fr * 0.6) {
        // Inside the inner Fresnel zone: treat as an obstruction with a v value
        // derived from how deep it intrudes.
        const v = (fr - perp) / Math.max(fr, 1e-3) * 2.0;
        const dLoss = knifeEdgeLossDb(v);
        if (dLoss > worstDiff) worstDiff = dLoss;
        shadowed = true;
      }

      if (chord > 1e-4) {
        // Solid crossing. Grazing the surface (very short chord) mostly means a
        // reflection off a corner rather than a wall crossing.
        const grazing = chord < 0.9;
        const matLoss = materialLossDb(ob.material, freqMHz);
        const m = MATERIALS[ob.material] || MATERIALS.drywall;
        if (grazing) {
          // Grazing: partial reflection, scaled by how edge-on it is.
          const g = 0.35 + 0.65 * m.scatter;
          const l = matLoss * g * 0.5;
          loss += l;
          segments.push({ material: ob.material, db: l, chord, grazing: true });
        } else {
          loss += matLoss;
          segments.push({ material: ob.material, db: matLoss, chord, grazing: false });
          shadowed = true;
        }
      }
    }

    // Ground / terrain: a shallow grazing path over the ground plane suffers
    // from the ground reflection cancelling the direct ray.
    if (this.hasGround) {
      const minY = Math.min(a.y, b.y);
      if (minY < 0.6 && D > 3) {
        const r1 = Math.max(0.5, -a.y), r2 = Math.max(0.5, -b.y);
        const dTot = D;
        const twoRay = Math.sqrt(2 * (1 / r1 + 1 / r2) * (lambda * lambda) / (4 * Math.PI));
        const v = (0.8 - Math.abs(a.y - b.y)) * Math.sqrt(2 * (1 / r1 + 1 / r2) / lambda) * 0.25;
        const gl = knifeEdgeLossDb(v) + twoRay;
        if (gl > worstDiff) worstDiff = gl;
      }
    }

    const total = loss + worstDiff;
    if (!wantDetail) return total;
    return {
      loss: total, segments, shadow: shadowed, distance: D,
      diffraction: worstDiff, penetration: loss,
    };
  }
}

/* ------------------------------------------------------- antenna behaviour */

// Duck-antenna dipole: broadside maximum, nulls along the antenna axis. Real
// antennas have a finite null, so blend towards omni.
export function vtxAntennaGainDb(axisWorld, losDir) {
  const c = clamp(Math.abs(vdot(axisWorld, losDir)), 0, 1);
  const s2 = 1 - c * c;
  const pattern = 0.2 + 0.8 * s2;
  return 2.0 + 10 * Math.log10(pattern);
}

// Goggle patch antennas: roughly broadside toward the pilot, linearly polarised.
export function rxAntennaGainDb(polAxisWorld, losDir) {
  const c = Math.abs(vdot(polAxisWorld, losDir));
  const bw = 0.55;
  const g = 0.35 + 0.65 * Math.pow(Math.max(0, 1 - Math.pow(1 - c, 2) / (bw * bw)), 1.5);
  return 2.6 + 10 * Math.log10(Math.max(g, 0.05));
}

// Linear polarisation mismatch between the drone's VTX antenna and the goggles.
export function polarisationLossDb(txAxis, rxPol) {
  const c = clamp(Math.abs(vdot(txAxis, rxPol)), 0, 1);
  const loss = -10 * Math.log10(Math.max(c * c, 0.0032));
  return clamp(loss, 0, 25);
}

/* --------------------------------------------------------------- link budget */

function dbmToMw(dbm) { return Math.pow(10, dbm / 10); }

// Multiband / multipath excess loss. Line of sight is not free: real paths
// bounce, and NLoS paths lose the reflection that would otherwise be received.
function excessLossDb(shadowed, materialLoss) {
  if (!shadowed) return 1.2 + 0.25 * Math.log10(1 + materialLoss); // small NLoS ripple
  return 3.5 + 0.9 * Math.log10(1 + materialLoss);
}

/**
 * Generic one-way link. Returns received power and a per-term breakdown.
 */
export function linkBudget(world, opts) {
  const {
    txDbm, freqMHz, txPos, rxPos, txAxis, rxPol, sensDbm,
  } = opts;
  const a = txPos, b = rxPos;
  const d = vsub(b, a);
  const dist = vlen(d);
  const los = vnorm(d);
  const fspl = fsplDb(dist, freqMHz);
  const detail = world.trace(a, b, freqMHz, true);
  const gTx = vtxAntennaGainDb(txAxis, los);
  const gRx = rxAntennaGainDb(rxPol, los);
  const pol = polarisationLossDb(txAxis, rxPol);
  const excess = excessLossDb(detail.shadow, detail.penetration);
  const rssi = txDbm + gTx + gRx - fspl - detail.loss - pol - excess;
  return {
    rssi, distance: dist, fspl, pen: detail.penetration, diff: detail.diffraction,
    gTx, gRx, pol, excess, segments: detail.segments, shadow: detail.shadow,
    margin: rssi - sensDbm,
  };
}

/* ------------------------------------------------------------- video link */

export class VideoLink {
  constructor(cfg) { this.configure(cfg); }

  /**
   * @param cfg {system:'analog'|'hdzero'|'dji'|'walksnail', band, channel, powerMw,
   *            rxType, polarisation:'linear'|'circular'}
   */
  configure(cfg) {
    Object.assign(this, {
      system: 'analog', band: 'R', channel: 1, powerMw: 200,
      rxType: 'analog', polarisation: 'linear', latencyBaseMs: 5,
    }, cfg || {});
    this.freqMHz = this.frequency();
    this.txDbm = 10 * Math.log10(Math.max(0.01, this.powerMw));
    // Receiver characteristics. Analog gimbals have a wide usable window with
    // graceful snow; digital has a very narrow cliff.
    if (this.system === 'analog') {
      this.sensDbm = -104;
      this.cliffDbm = -108;
      this.artifact = true;
    } else {
      this.sensDbm = -99;
      this.cliffDbm = -103;
      this.artifact = false;
    }
    this.channelKey = this.system === 'analog'
      ? `A:${this.band}:${this.channel}`
      : `D:${this.system}:${this.channel}`;
  }

  frequency() {
    if (this.system === 'analog') {
      const b = ANALOG_BANDS[this.band] || ANALOG_BANDS.R;
      return b.ch[(this.channel - 1) % 8];
    }
    const sys = DIGITAL_SYSTEMS[this.system] || DIGITAL_SYSTEMS.hdzero;
    return sys.freqOf(clamp(this.channel, 1, sys.maxCh));
  }
  channelLabel() {
    if (this.system === 'analog') {
      const b = ANALOG_BANDS[this.band] || ANALOG_BANDS.R;
      return `${this.band}${this.channel} · ${b.ch[(this.channel - 1) % 8]} MHz`;
    }
    const sys = DIGITAL_SYSTEMS[this.system] || DIGITAL_SYSTEMS.hdzero;
    return sys.channelName(clamp(this.channel, 1, sys.maxCh));
  }

  /**
   * Evaluate the link against the RF world.
   * @param interferers [{rssiDbm, channelKey, powerMw}] other VTXs
   */
  update(world, txPos, txAxis, rxPos, rxPol, interferers = []) {
    const lb = linkBudget(world, {
      txDbm: this.txDbm, freqMHz: this.freqMHz, txPos, rxPos, txAxis, rxPol,
      sensDbm: this.sensDbm,
    });
    this.budget = lb;
    this.rssi = lb.rssi;

    // Co-channel and adjacent-channel interference. Analog has no lock at all:
    // a stronger neighbour simply replaces your picture. Digital systems
    // ignore other channels entirely, which is why they win races.
    let isr = -40; // interference-to-signal ratio in dB, -inf when clean
    let sameChannel = false;
    for (const iv of interferers) {
      if (iv.channelKey !== this.channelKey) {
        if (this.system === 'analog' && iv.adjacent) {
          const fr = iv.freqMHz - this.freqMHz;
          // Analogue VTXs have no channel filter: you get audible beat noise and
          // a ghost image from anything within a channel or two.
          if (Math.abs(fr) < 34) {
            isr = Math.max(isr, iv.rssiDbm - lb.rssi - 3);
          }
        }
        continue;
      }
      sameChannel = true;
      isr = Math.max(isr, iv.rssiDbm - lb.rssi);
    }
    this.interferenceRatio = isr;
    this.hasInterference = sameChannel || isr > -28;

    // Signal quality: 0..1. Analog ramps; digital is a cliff.
    const lo = this.cliffDbm, hi = this.sensDbm + 6;
    let sig = clamp((lb.rssi - lo) / (hi - lo), 0, 1);
    let quality = this.artifact
      ? Math.pow(sig, 1.35)
      : clamp((lb.rssi - lo + 1.5) / 2.2, 0, 1); // digital cliff
    if (this.artifact) {
      if (isr > -6) quality *= clamp(1 - (isr + 6) / 12, 0, 1);
    } else if (isr > -3) {
      // Digital co-channel: the two links stomp on each other, then collapse.
      quality *= clamp(1 - (isr + 3) / 14, 0, 1);
    }
    this.quality = clamp(quality, 0, 1);
    this.signal = sig;
    this.locked = this.quality > (this.artifact ? 0.12 : 0.5);

    // Latency grows as the link degrades: retransmits and lower FEC block rate.
    const baseLat = this.latencyBaseMs;
    this.latencyMs = baseLat + (1 - this.quality) * (this.artifact ? 6 : 45);

    // Dropout severity drives the visual artefacts in the FPV feed.
    this.snow = this.artifact ? clamp(1 - sig * 1.6, 0, 1) : 0;
    this.dropout = this.artifact
      ? clamp((0.25 - this.quality) * 6, 0, 1)
      : clamp((0.9 - this.quality) * 6, 0, 1);
    this.static = clamp((isr + 26) / 20, 0, 1);
    return this;
  }

  summary() {
    const b = this.budget;
    return {
      freq: this.freqMHz, rssi: this.rssi, quality: this.quality,
      channel: this.channelLabel(), margin: b ? b.margin : 0,
    };
  }
}

/* ------------------------------------------------------------- radio link */

export class RadioLink {
  constructor(cfg) { this.configure(cfg); }

  configure(cfg) {
    Object.assign(this, {
      protocol: 'elrs2', rateHz: 250, failsafeMs: 500, txDbm: 20,
      latencyBaseMs: 8, jumps: 1,
    }, cfg || {});
    const sys = RC_SYSTEMS[this.protocol] || RC_SYSTEMS.elrs2;
    this.sys = sys;
    this.freqMHz = sys.freqMHz;
    this.txDbm = sys.txDbm;
    this.sensDbm = sys.sensDbm;
    this.periodMs = 1000 / this.rateHz;
    // Seed the reported state so the link is readable *before* it has ever
    // ticked.
    //
    // `Simulation.step` only calls `update()` once per link period (4 ms at
    // 250 Hz), and `hud()` reads `radio.rssi` on every rendered frame. On the
    // first frame of the first step those two disagree - the accumulator has
    // not reached the period yet - so rssi/lq/latency are still undefined and
    // the control-link panel threw on `undefined.toFixed`. That took down the
    // whole sim render loop on the very first frame after switching to the
    // simulator tab, which is why it presented as "the app is broken".
    //
    // Starting at a perfect link is the right seed: it is what a real receiver
    // reports before it has heard anything, and within a few milliseconds the
    // real budget replaces it.
    //
    // `configure` is also called when the pilot switches protocol mid-flight,
    // which is not a reboot: the counters below are lifetime totals, so they
    // are only seeded once and a reconfigure leaves them alone.
    const seed = this.droppedFrames === undefined;
    this.rssi = this.txDbm;
    this.lq = 1;
    this.margin = 999;
    this.snr = 999;
    this.latencyMs = this.latencyBaseMs;
    this.delivered = true;
    this.silentMs = 0;
    this.failsafe = false;
    this.degraded = false;
    if (seed) this.droppedFrames = 0;
  }
  label() { return `${this.sys.label} ${this.freqMHz} MHz @ ${this.rateHz} Hz`; }

  /**
   * Update the control link. Returns {lq, rssi, latencyMs, delivered}.
   * `delivered` is false when this RC frame was lost (failsafe progression).
   */
  update(world, txPos, rxPos, rxPol, dt) {
    // The control transmitter sits with the pilot; the RX is on the drone.
    const lb = linkBudget(world, {
      txDbm: this.txDbm, freqMHz: this.freqMHz, txPos, rxPos,
      txAxis: { x: 0, y: 0, z: 0 }, rxPol, sensDbm: this.sensDbm,
    });
    this.rssi = lb.rssi;
    this.margin = lb.margin;
    // Link quality is a smooth function of the margin, plus hop-based loss for
    // non-hopping systems. Digital RC survives much deeper into the noise.
    const lq = clamp((lb.margin + 6) / 14, 0, 1);
    const hopReliability = this.sys.hopping
      ? Math.pow(lq, 1.2)
      : Math.pow(clamp((lb.margin + 14) / 26, 0, 1), 2.1);
    this.lq = clamp(hopReliability, 0, 1);
    this.snr = lb.margin;

    // Frame delivery: with a hopping link an individual frame can be missing
    // even at high LQ; at low LQ frames go missing constantly.
    const missP = this.sys.hopping
      ? clamp(1 - Math.pow(this.lq, 3.5), 0, 1)
      : clamp(1 - Math.pow(this.lq, 9), 0, 1);
    this.delivered = Math.random() > missP * 0.6;
    this.droppedFrames++;

    // Latency: base + queueing at the link rate + retries.
    this.latencyMs = this.latencyBaseMs + this.periodMs * (this.jumps - 1) / 2
      + (1 - this.lq) * 26;
    if (!this.delivered) this.latencyMs += this.periodMs * 2.2;

    this.silentMs = this.delivered ? 0 : (this.silentMs || 0) + this.periodMs;
    this.failsafe = this.silentMs > this.failsafeMs;
    this.degraded = this.lq < 0.55;
    return this;
  }
  reset() { this.silentMs = 0; this.failsafe = false; }
}

/**
 * Frequency plan for a race: allocate VTX channels to pilots so nobody shares
 * one. With analog this is only possible up to 8 racers on Raceband.
 */
export function allocateChannels(system, count) {
  if (system === 'analog') {
    const order = ['R', 'F', 'B', 'A', 'E', 'L'];
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push({ band: order[i % order.length], channel: Math.floor(i / order.length) % 8 + 1 });
    }
    return out;
  }
  const sys = DIGITAL_SYSTEMS[system];
  const out = [];
  for (let i = 0; i < count; i++) out.push({ channel: i % sys.maxCh + 1 });
  return out;
}
