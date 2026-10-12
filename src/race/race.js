// Race director.
//
// Runs a heat against a track's gate list: gate sequencing, lap and sector
// timing, missed-gate penalties, wrong-way detection and the ghost replay used
// for the personal-best target. Also the career layer: results pay money,
// money buys parts, parts have tiers, and the next tier has to be earned.

import { clamp, rng, fmt } from '../core/math.js';
import { getTrack, distanceToLine } from '../data/tracks.js';

/* -------------------------------------------------------------------- race */

export class Race {
  constructor(track, opts = {}) {
    this.track = typeof track === 'string' ? getTrack(track) : track;
    this.name = this.track.name;
    this.gates = this.track.gateList;
    this.laps = opts.laps || 3;
    this.gateIndex = 0;
    this.lap = 0;
    this.state = 'ready';        // ready | flying | finished | dnf
    this.startTime = 0;
    this.lapStart = 0;
    this.lapTimes = [];
    this.bestLap = opts.bestLap != null ? opts.bestLap : null;
    this.sectors = [];
    this.gatesPassed = 0;
    this.gatesMissed = 0;
    this.penalty = 0;
    this.wrongWay = false;
    this.finishTime = null;
    this.ghost = null;
    this.events = [];
    this.prevPos = null;
    this.lastGateAt = 0;
    this.heatTime = 0;
    this.onEvent = opts.onEvent || null;
  }

  emit(kind, text) {
    const e = { t: this.heatTime, kind, text };
    this.events.push(e);
    if (this.events.length > 60) this.events.shift();
    if (this.onEvent) this.onEvent(e);
  }

  start(now) {
    this.state = 'flying';
    this.startTime = now;
    this.lapStart = now;
    this.gateIndex = 0;
    this.lap = 0;
    this.heatTime = 0;
    this.emit('info', 'Heat started');
  }

  /** Feed the craft state once per frame. */
  update(dt, now, pos, quat, vel) {
    this.heatTime += dt;
    if (this.state !== 'flying') return;
    const g = this.gates[this.gateIndex];
    if (!g) return;

    // Gate test: the drone must pass through the plane within the gate radius.
    // Using the signed distance to the plane means a fast craft cannot tunnel
    // through between frames, which is the classic bug in racing games.
    const dx = pos.x - g.x, dy = pos.y - g.y, dz = pos.z - g.z;
    const along = dx * g.nx + dz * g.nz;
    const lateral = Math.hypot(dx - along * g.nx, dy, dz - along * g.nz);
    const prevAlong = this.prevAlong;
    const crossed = prevAlong != null && prevAlong < 0 && along >= 0;
    const inside = crossed && lateral < g.r;

    // Distance travelled towards the gate, for a more forgiving approach.
    const dxp = prevAlong != null ? along - prevAlong : 0;

    if (crossed) {
      if (lateral < g.r) {
        this.gatesPassed++;
        this.lastGateAt = this.heatTime;
        const nextIdx = this.gateIndex + 1;
        if (g.type === 'start' && this.lap === 0 && this.gatesPassed === 1) {
          this.emit('gate', 'Lap 1');
        }
        if (g.type === 'finish') {
          this.completeLap(now);
        }
        if (nextIdx >= this.gates.length) {
          // wrapped past the end without hitting a finish gate
          this.gateIndex = 0;
        } else {
          this.gateIndex = nextIdx;
        }
      } else {
        // flew past the gate plane outside the frame
        this.gatesMissed++;
        this.penalty += 2;
        this.emit('penalty', `Missed gate ${this.gateIndex + 1} (+2 s)`);
        // Skip it so the race does not dead-end, but only if the drone has
        // clearly moved on.
        const gp = this.gates[Math.min(this.gates.length - 1, this.gateIndex + 1)];
        const toNext = Math.hypot(pos.x - gp.x, pos.z - gp.z);
        if (toNext < Math.hypot(pos.x - g.x, pos.z - g.z) * 0.7) {
          this.gateIndex = this.gateIndex + 1 >= this.gates.length ? 0 : this.gateIndex + 1;
        }
      }
    }
    this.prevAlong = along;

    // Wrong way: compare heading against the direction of travel along the
    // line. The reference has to be the *next* gate - the current gate's normal
    // is only meaningful while you are crossing its plane, so flying a normal
    // line between two gates that sit at an angle read as wrong way.
    if (this.prevPos) {
      const mx = pos.x - this.prevPos.x, mz = pos.z - this.prevPos.z;
      const mv = Math.hypot(mx, mz);
      if (mv > 0.05) {
        const nxt = this.gates[this.gateIndex + 1] || g;
        const tx = nxt.x - pos.x, tz = nxt.z - pos.z;
        const tl = Math.hypot(tx, tz);
        if (tl > 0.5) {
          const fwd = (mx * tx + mz * tz) / tl;
          this.wrongWay = fwd < -mv * 0.35;
        }
      }
    }
    this.prevPos = { x: pos.x, z: pos.z };
  }

  completeLap(now) {
    const t = now - this.lapStart;
    const adj = t + this.penalty;
    this.lapTimes.push(adj);
    if (this.bestLap == null || adj < this.bestLap) {
      this.bestLap = adj;
      this.emit('best', `Lap ${this.lap + 1}: ${fmt.timeMs(adj)} (best)`);
    } else {
      this.emit('lap', `Lap ${this.lap + 1}: ${fmt.timeMs(adj)}`);
    }
    this.penalty = 0;
    this.lap++;
    this.lapStart = now;
    if (this.lap >= this.laps) {
      this.state = 'finished';
      this.finishTime = now - this.startTime + this.penalty;
      this.emit('finish', `Finished: ${fmt.timeMs(this.finishTime)}`
        + (this.penalty ? ` (incl. ${this.penalty} s penalty)` : ''));
    } else {
      this.gateIndex = 0;
    }
  }

  get progress() {
    return this.gateIndex / Math.max(1, this.gates.length);
  }

  summary() {
    const total = this.lapTimes.reduce((a, b) => a + b, 0);
    return {
      laps: this.lapTimes.length,
      total: this.state === 'finished' ? total : (this.lapTimes.length ? total : nowish()),
      lapTimes: this.lapTimes.slice(),
      bestLap: this.bestLap,
      gatesPassed: this.gatesPassed,
      gatesMissed: this.gatesMissed,
      penalty: this.penalty,
      state: this.state,
    };
  }
}
const nowish = () => 0;

/**
 * Simple AI rival: follows the racing line with a lookahead, a speed limit that
 * scales with corner tightness, and enough noise that it is beatable.
 */
export class GhostPilot {
  constructor(track, seed = 1, skill = 0.9) {
    this.track = track;
    this.rand = rng(seed * 7919 + 13);
    this.skill = clamp(skill, 0.4, 1.05);
    this.i = 0;
    this.lap = 0;
    this.gateIndex = 1;
    this.t = 0;
    this.lapTime = 0;
    this.best = null;
    this.pos = { ...track.line[0] };
    this.quat = { x: 0, y: 0, z: 0, w: 1 };
    this.done = false;
  }

  step(dt, speed = 26) {
    this.t += dt;
    this.lapTime += dt;
    const line = this.track.line;
    // Look ahead proportional to speed: faster means a longer, smoother line.
    const look = Math.max(2, Math.round(speed * 0.22));
    this.i = (this.i + 1) % line.length;
    const target = line[(this.i + look) % line.length];
    const here = line[this.i];
    const k = clamp(dt * 9 * this.skill, 0, 1);
    this.pos.x += (target.x - this.pos.x) * k;
    this.pos.y += (target.y - this.pos.y) * k;
    this.pos.z += (target.z - this.pos.z) * k;
    // add a little wander so it does not look robotic
    const w = 0.35 * (1 - this.skill);
    this.pos.x += Math.sin(this.t * 3.1) * w * dt;
    this.pos.y += Math.sin(this.t * 4.3) * w * dt;
    this.pos.z += Math.cos(this.t * 2.7) * w * dt;
    const prev = line[(this.i - 1 + line.length) % line.length];
    const heading = Math.atan2(target.x - this.pos.x, target.z - this.pos.z);
    this.heading = heading;
  }

  lapComplete() {
    const t = this.lapTime;
    if (this.best == null || t < this.best) this.best = t;
    this.lapTime = 0;
    this.lap++;
    return t;
  }
}

/* ------------------------------------------------------------------ career */

export const CAREER_STARTS = { cash: 320, tier: 0, reputation: 0 };

export class Career {
  constructor(state) {
    this.cash = state?.cash ?? CAREER_STARTS.cash;
    this.rep = state?.rep ?? 0;
    this.tier = state?.tier ?? 0;
    this.tracks = new Set(state?.tracks || ['t-hangar']);
    this.results = state?.results || [];
    this.bestLaps = state?.bestLaps || {};
    this.pending = null;
  }

  canEnter(trackId) {
    const t = getTrack(trackId);
    return this.tracks.has(trackId) && t.tier <= this.tier + 1;
  }

  /** Unlock the next tier's track once you have banked enough reputation. */
  unlockables() {
    return Object.values({}).length ? [] : [];
  }

  availableTracks() {
    const all = ['t-hangar', 't-rooftops', 't-suburb', 't-forest', 't-tower'];
    return all.filter((id) => {
      const t = getTrack(id);
      return t.tier <= this.tier + 1;
    });
  }

  finishHeat(trackId, race, buildCost) {
    if (!race || race.state !== 'finished') {
      return { ok: false, text: 'Did not finish' };
    }
    const clean = race.gatesMissed === 0;
    const accuracy = clean ? 1 : Math.max(0, 1 - race.gatesMissed / Math.max(1, race.gates.length));
    const payout = Math.round(
      (clean ? 220 : 110) * (0.6 + 0.4 * accuracy) + race.lapTimes.length * 25);
    const repGain = Math.round((clean ? 45 : 18) + (race.lapTimes.length || 0) * 6);
    // Entry is spares, fuel and scrutineering - it scales with what you are
    // flying, but you already own the build. Charging the full build cost every
    // heat made the first race on a $600 quad lose $300, so the meta could never
    // get off the ground.
    const entry = Math.round(buildCost * 0.06);
    this.cash += payout - entry;
    this.rep += repGain;
    const prev = this.bestLaps[trackId];
    const best = race.bestLap;
    const isPB = prev == null || best < prev;
    if (isPB) this.bestLaps[trackId] = best;
    // Tier promotion on reputation
    let promoted = false;
    if (this.rep >= 400 && this.tier === 0) { this.tier = 1; promoted = true; }
    else if (this.rep >= 1200 && this.tier === 1) { this.tier = 2; promoted = true; }
    else if (this.rep >= 2600 && this.tier === 2) { this.tier = 3; promoted = true; }
    const res = {
      ok: true, payout, entry, repGain, net: payout - entry, promoted, isPB,
      clean,
    };
    this.results.unshift({ trackId, time: race.finishTime, best, clean, at: Date.now() });
    if (this.results.length > 40) this.results.pop();
    if (promoted) this.tracks.add(this.nextTrackId());
    return res;
  }

  nextTrackId() {
    const order = ['t-hangar', 't-rooftops', 't-suburb', 't-forest', 't-tower'];
    const idx = Math.min(order.length - 1, this.tier);
    return order[idx];
  }

  toJSON() {
    return {
      cash: this.cash, rep: this.rep, tier: this.tier,
      tracks: [...this.tracks], results: this.results, bestLaps: this.bestLaps,
    };
  }
}
