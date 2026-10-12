// Race view: track selection, heat running, lap timing, rivals and career.

import { el, clear, Scope, fmt } from './dom.js';
import { TRACKS, getTrack } from '../data/tracks.js';
import { Race, GhostPilot, Career } from '../race/race.js';
import { allocateChannels, VideoLink } from '../sim/rf.js';
import { vlen, vsub } from '../core/math.js';

export class RaceView {
  constructor(root, app) {
    this.app = app;
    this.root = root;
    this.tracklist = root.querySelector('#tracklist');
    this.trackinfo = root.querySelector('#trackinfo');
    this.lapsEl = root.querySelector('#laps');
    this.positionsEl = root.querySelector('#positions');
    this.racepanel = root.querySelector('#racepanel');
    this.careerEl = root.querySelector('#career');
    this.scope = new Scope(root.querySelector('#racescope'));
    this.cams = root.querySelector('#cams-race');
    this.trackId = 't-hangar';
    this.race = null;
    this.rivals = [];
    this.hudEl = root.querySelector('#hud-race');
    // Nothing to report until there is a heat. Leaving it visible drew an empty
    // box over the feed on entry to the race view.
    this.hudEl.style.display = 'none';
    this.buildCameraSwitch();
    this.buildTrackList();
    this.buildCareer();
    this.renderTrackInfo();

    root.querySelector('#btn-race').onclick = () => this.startHeat();
    root.querySelector('#sel-rivals').onchange = () => {};
    // Arming is routed through the app, which already picks raceSim when the
    // race view is up. Without a visible control the only way in was the Enter
    // key, which is not discoverable.
    this.armBtn = root.querySelector('#btn-race-arm');
    this.armBtn.onclick = () => this.app.toggleArm();
    root.querySelector('#btn-race-reset').onclick = () => this.app.resetCraft();
  }

  /**
   * Race events go to the same message feed as everything else. SimView owns
   * that DOM, so delegate rather than duplicating it. This must exist as a real
   * method: calling it as one took the whole gate update down with it, because
   * it is invoked from inside Race.emit.
   */
  message(kind, text) {
    this.app.simview.message(kind, text);
  }

  buildCameraSwitch() {
    clear(this.cams);
    this.camButtons = [['fpv', 'FPV'], ['chase', 'Chase'], ['pit', 'Pilot'], ['top', 'Top']]
      .map(([id, label]) => el('button', {
        class: id === 'chase' ? 'active' : '',
        text: label,
        onclick: () => { this.app.raceRig.setMode(id); this.syncCameras(); },
      }));
    this.camButtons.forEach((b) => this.cams.appendChild(b));
  }
  syncCameras() {
    const m = this.app.raceRig.mode;
    const ids = ['fpv', 'chase', 'pit', 'top'];
    this.camButtons.forEach((b, i) => b.classList.toggle('active', ids[i] === m));
  }

  buildTrackList() {
    clear(this.tracklist);
    this.trackButtons = TRACKS.map((t) => el('button', {
      class: t.id === this.trackId ? 'sel' : '',
      onclick: () => {
        this.trackId = t.id;
        this.renderTrackInfo();
        this.buildTrackList();
        this.app.loadTrack(t.id, false);
      },
    }, [
      el('span', { class: 'pn', text: t.name }),
      el('span', { class: 'pb', text: `${t.lengthM.toFixed(0)} m · ${t.gateList.length} gates · tier ${t.tier}` }),
    ]));
    this.trackButtons.forEach((b) => this.tracklist.appendChild(b));
  }

  renderTrackInfo() {
    const t = getTrack(this.trackId);
    clear(this.trackinfo);
    this.trackinfo.appendChild(el('div', { html: `<b>${t.location}</b>` }));
    this.trackinfo.appendChild(el('div', { style: { marginTop: '4px' }, text: t.brief }));
    const mats = {};
    for (const o of t.obstacles) mats[o.material] = (mats[o.material] || 0) + 1;
    const list = Object.entries(mats).map(([k, v]) => `${k}×${v}`).join(', ');
    this.trackinfo.appendChild(el('div', { style: { marginTop: '6px', color: 'var(--fg-dim)' },
      text: `Obstacles: ${list}` }));
    const best = this.app.career.bestLaps[this.trackId];
    if (best != null) {
      this.trackinfo.appendChild(el('div', { style: { marginTop: '4px', color: 'var(--accent-2)' },
        text: `Your best lap: ${fmt.timeMs(best)}` }));
    }
  }

  buildCareer() {
    const c = this.app.career;
    clear(this.careerEl);
    this.careerEl.append(
      el('div', { class: 'stat' }, [el('span', { class: 'k', text: 'Cash' }),
        el('span', { class: 'v', text: '$' + c.cash })]),
      el('div', { class: 'stat' }, [el('span', { class: 'k', text: 'Reputation' }),
        el('span', { class: 'v', text: String(c.rep) })]),
      el('div', { class: 'stat' }, [el('span', { class: 'k', text: 'Tier' }),
        el('span', { class: 'v', text: ['Entry', 'Sport', 'Competitive', 'Elite', 'Pro', 'Factory'][c.tier] })]),
    );
    const next = c.nextTrackId();
    if (!c.tracks.has(next)) {
      this.careerEl.appendChild(el('div', { class: 'warn-row info',
        text: `Win reputation to unlock ${getTrack(next).name}.` }));
    }
  }

  startHeat() {
    const track = getTrack(this.trackId);
    const laps = parseInt(this.root.querySelector('#sel-laps').value, 10);
    const nRivals = parseInt(this.root.querySelector('#sel-rivals').value, 10);
    const sim = this.app.raceSim;
    sim.pilotPos = { ...track.pilot };
    sim.pilotMode = 'fixed';
    const best = this.app.career.bestLaps[this.trackId];
    this.race = new Race(track, {
      laps, bestLap: best != null ? best : null,
      onEvent: (e) => this.app.raceview.message(e.kind, e.text),
    });

    // Rival pilots, and a frequency plan that gives each racer its own channel.
    this.rivals = [];
    const alloc = allocateChannels(sim.video.system, 1 + nRivals);
    this.rivalsConfig = alloc.slice(1).map((a, i) => ({
      band: a.band, channel: a.channel,
    }));
    for (let i = 0; i < nRivals; i++) {
      const p = new GhostPilot(track, i + 1, 0.72 + Math.random() * 0.28);
      p.name = `Rival ${i + 1}`;
      this.rivals.push(p);
    }
    sim.reset({ x: track.start.x, y: 0.06, z: track.start.z, rebuildBattery: true });
    this.app.viewportR.buildTrack(track);
    this.app.raceview.buildTrackList();
    this.app.setRaceCameraDefault();
    this.race.start(sim.time);
    this.hudEl.style.display = '';
    this.app.raceview.message('ok', `Heat started: ${track.name}, ${laps} lap${laps > 1 ? 's' : ''}`);
    this.state = 'racing';
  }

  update(dt) {
    if (!this.race) return;
    const sim = this.app.raceSim;
    const craft = sim.craft;

    // Feed the RF world with the other pilots' transmitters so interference is real.
    const interferers = [];
    for (let i = 0; i < this.rivals.length; i++) {
      const p = this.rivals[i];
      p.step(dt, 26);
      const cfg = this.rivalsConfig[i] || {};
      const v = new VideoLink();
      v.configure({
        system: sim.video.system, band: cfg.band, channel: cfg.channel,
        powerMw: sim.video.powerMw, latencyBaseMs: craft.vtx.latencyBaseMs,
      });
      interferers.push({
        channelKey: v.channelKey,
        freqMHz: v.freqMHz,
        adjacent: true,
        rssiDbm: this.rivalRssi(v),
      });
    }
    sim.interferers = interferers;

    this.race.update(dt, sim.time, craft.body.pos, craft.body.quat, craft.body.vel);
    this.app.viewportR.setActiveGate(this.race.gateIndex);
    this.renderLaps();
    this.renderPositions();
    this.renderPanel();
    this.renderHud(sim);

    if (this.race.state === 'finished' && this.state === 'racing') {
      this.state = 'done';
      this.finish();
    }
  }

  /**
   * The race HUD. This element was built but never filled in, so it rendered
   * as an empty box over the feed. Keep it to what a racer needs at a glance:
   * where you are in the lap, how fast, and whether the link and the pack are
   * still good.
   */
  renderHud(sim) {
    const h = sim.hud();
    const r = this.race;
    const q = h.vtx.quality;
    const cells = [
      ['Lap', `${Math.min(r.lap + 1, r.laps)}/${r.laps}`],
      ['Gate', `${Math.min(r.gateIndex + 1, r.gates.length)}/${r.gates.length}`],
      ['Speed', `${h.speed.toFixed(1)} m/s`],
      ['Alt', `${h.alt.toFixed(2)} m`],
      ['Pack', `${h.voltage.toFixed(2)} V`,
        h.voltage < 14.4 ? 'bad' : h.voltage < 15.6 ? 'warn' : ''],
      ['Link', `${(q * 100).toFixed(0)}%`, q > 0.6 ? 'good' : q > 0.2 ? 'warn' : 'bad'],
    ];
    const rows = cells.map(([k, v, cls]) =>
      `<div class="row"><span class="lbl2">${k}</span><span class="${cls || ''}">${v}</span></div>`).join('');
    clear(this.hudEl);
    // Top-right, not top-left: #racepanel already owns the LAP clock there and
    // the two drew on top of each other.
    this.hudEl.appendChild(el('div', { class: 'tr', html: `<div class="box">${rows}</div>` }));
    if (!sim.craft.fc.armed && r.state === 'flying') {
      this.hudEl.appendChild(el('div', { class: 'bc', html: '<div class="box">DISARMED - arm to fly the heat</div>' }));
    }
  }

  rivalRssi(vtx) {    // Rival transmitters sit at roughly their own track position with the same
    // power, so use the same free-space loss with distance to our pilot.
    const p = this.app.raceSim.pilotPos;
    let rssi = -130;
    for (const rival of this.rivals) {
      const d = Math.max(1, vlen(vsub(p, rival.pos)));
      rssi = Math.max(rssi, vtx.txDbm
        - (32.44 + 20 * Math.log10(d / 1000) + 20 * Math.log10(vtx.freqMHz)));
    }
    return rssi;
  }

  finish() {
    const buildCost = this.app.buildCost;
    const res = this.app.career.finishHeat(this.trackId, this.race, buildCost);
    this.buildCareer();
    this.renderTrackInfo();
    this.app.persist();
    if (res.ok) {
      this.message('ok', `Heat result: ${fmt.timeMs(this.race.finishTime)}`
        + `${res.isPB ? ' - personal best' : ''} · +$${res.payout} · +${res.repGain} rep`);
      if (res.promoted) this.message('ok', `Promoted! ${getTrack(this.app.career.nextTrackId()).name} unlocked.`);
    } else {
      this.message('warn', 'Heat did not finish.');
    }
  }

  renderLaps() {
    const l = clear(this.lapsEl);
    const r = this.race;
    l.appendChild(el('div', { class: 'stat hero' }, [
      el('span', { class: 'k', text: r.state === 'finished' ? 'Total' : 'Elapsed' }),
      el('span', { class: 'v', text: fmt.timeMs(r.state === 'finished'
        ? r.finishTime : (this.app.raceSim.time - r.startTime)) }),
    ]));
    r.lapTimes.forEach((t, i) => {
      const isBest = t === r.bestLap;
      l.appendChild(el('div', { class: `stat${isBest ? ' good' : ''}` }, [
        el('span', { class: 'k', text: `Lap ${i + 1}` }),
        el('span', { class: 'v', text: fmt.timeMs(t) }),
      ]));
    });
    if (r.penalty) {
      l.appendChild(el('div', { class: 'stat bad' }, [
        el('span', { class: 'k', text: 'Penalty' }),
        el('span', { class: 'v', text: `+${r.penalty} s` }),
      ]));
    }
    l.appendChild(el('div', { class: 'stat' }, [
      el('span', { class: 'k', text: 'Gates' }),
      el('span', { class: 'v', text: `${r.gatesPassed} / ${r.gates.length}` }),
    ]));
  }

  renderPositions() {
    const p = clear(this.positionsEl);
    const track = getTrack(this.trackId);
    const craft = this.app.raceSim.craft;
    // Progress measured by nearest point on the line plus the gate index.
    const mine = this.progressOf(craft.body.pos, this.race ? this.race.gateIndex : 0);
    p.appendChild(el('div', { class: 'stat good' }, [
      el('span', { class: 'k', text: 'You' }),
      el('span', { class: 'v', text: `${(mine * 100).toFixed(0)} %` }),
    ]));
    for (const r of this.rivals) {
      p.appendChild(el('div', { class: 'stat' }, [
        el('span', { class: 'k', text: r.name }),
        el('span', { class: 'v', text: `lap ${r.lap + 1}` }),
      ]));
    }
  }

  progressOf(pos, gateIdx) {
    const track = getTrack(this.trackId);
    const line = track.line;
    let best = Infinity, bi = 0;
    for (let i = 0; i < line.length; i++) {
      const q = line[i];
      const d = (q.x - pos.x) ** 2 + (q.y - pos.y) ** 2 + (q.z - pos.z) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    return Math.min(1, (bi / Math.max(1, line.length - 1)) * 0.9 + (gateIdx / 40) * 0.1);
  }

  renderPanel() {
    const p = clear(this.racepanel);
    const r = this.race;
    const craft = this.app.raceSim.craft;
    const h = this.app.raceSim.hud();
    p.appendChild(el('div', { class: 'lbl2', text: r.state === 'finished' ? 'FINISH' : 'LAP' }));
    p.appendChild(el('div', { class: 'big2', text: r.state === 'finished'
      ? fmt.timeMs(r.finishTime)
      : fmt.timeMs(this.app.raceSim.time - r.startTime) }));
    p.appendChild(el('div', { style: { marginTop: '6px', display: 'grid', gap: '2px' } }, [
      el('div', { class: 'row2', style: { justifyContent: 'space-between' } }, [
        el('span', { class: 'lbl2', text: 'Lap' }), el('span', { text: `${r.lap + 1}/${r.laps}` })]),
      el('div', { class: 'row2', style: { justifyContent: 'space-between' } }, [
        el('span', { class: 'lbl2', text: 'Gate' }), el('span', { text: `${r.gateIndex + 1}/${r.gates.length}` })]),
      el('div', { class: 'row2', style: { justifyContent: 'space-between' } }, [
        el('span', { class: 'lbl2', text: 'Best' }),
        el('span', { text: r.bestLap ? fmt.timeMs(r.bestLap) : '--' })]),
      el('div', { class: 'row2', style: { justifyContent: 'space-between' } }, [
        el('span', { class: 'lbl2', text: 'Alt' }), el('span', { text: `${craft.body.pos.y.toFixed(1)} m` })]),
      el('div', { class: 'row2', style: { justifyContent: 'space-between' } }, [
        el('span', { class: 'lbl2', text: 'Speed' }),
        el('span', { text: `${Math.hypot(craft.body.vel.x, craft.body.vel.z).toFixed(1)} m/s` })]),
      el('div', { class: 'row2', style: { justifyContent: 'space-between' } }, [
        el('span', { class: 'lbl2', text: 'VTX' }),
        el('span', { style: { color: h.vtx.quality > 0.6 ? 'var(--accent-2)' : 'var(--warn)' },
          text: `${(h.vtx.quality * 100).toFixed(0)}%` })]),
    ]));
    if (r.wrongWay) {
      p.appendChild(el('div', { class: 'warn-row error', style: { marginTop: '6px' }, text: 'WRONG WAY' }));
    }
    if (r.gatesMissed) {
      p.appendChild(el('div', { class: 'warn-row warn', style: { marginTop: '6px' },
        text: `${r.gatesMissed} gate${r.gatesMissed > 1 ? 's' : ''} missed` }));
    }
  }
}
