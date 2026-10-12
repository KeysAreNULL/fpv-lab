// FPV LAB - application entry point.
//
// Two simulations run at most one at a time (the workshop and the race), each
// with its own physics state and its own camera. The render loop reads whatever
// the last physics tick produced, so frame rate never changes the flight model.

import { $, $$, el, clear, download, fmt } from './ui/dom.js';
import * as THREE from '../vendor/three.module.js';
import { DEFAULTS, getPart, buildCost } from './data/catalog.js';
import { TRACKS, getTrack } from './data/tracks.js';
import { Simulation, PHYSICS_HZ } from './sim/sim.js';
import { Environment } from './sim/environment.js';
import { RFWorld } from './sim/rf.js';
import { cloneTune, DEFAULT_TUNE } from './sim/fc.js';
import { Viewport } from './render/viewport.js';
import { DroneModel } from './render/droneMesh.js';
import { CameraRig, FpvOverlay } from './render/cameras.js';
import { Effects } from './render/fx.js';
import { BuilderView, PRESETS } from './ui/builder.js';
import { SimView } from './ui/simview.js';
import { TuneView } from './ui/tuneview.js';
import { RaceView } from './ui/raceview.js';
import { Career } from './race/race.js';
import { attitudeOf, Q_LEVEL } from './sim/craft.js';
import { preloadTextures } from './render/materials.js';
import { getWeather } from './data/weather.js';

const STORE_KEY = 'fpv-lab.v1';

class App {
  constructor() {
    this.spec = { ...DEFAULTS, motorKvIndex: 0, cycles: 0 };
    this.buildName = 'Street racer';
    this.tune = cloneTune(DEFAULT_TUNE);
    this.view = 'builder';
    this.windSpeed = 2;
    this.windDir = 90;
    this.gust = 1.5;
    this.rxPolAngle = 0;
    this.trackId = 't-hangar';

    this.load();

    this.env = new Environment({ tempC: 22, turbulence: 0.2 });
    this.applyWind();

    this.sim = new Simulation({ spec: this.spec, env: this.env, tune: this.tune });
    this.sim.onEvent = (k, t) => this.simview.message(k, t);
    this.raceSim = new Simulation({ spec: this.spec, env: this.env, tune: this.tune });
    this.raceSim.pilotMode = 'fixed';
    // A hard wall hit is a prop strike, and the pilot should hear about it.
    for (const s of [this.sim, this.raceSim]) {
      s.craft.onImpact = (severity) => {
        if (severity > 6) this.simview.message('warn', `Prop strike at ${severity.toFixed(0)} m/s`);
      };
    }

    this.setupViews();
    this.setupKeys();
    this.loadTrack(this.trackId, true);
    document.documentElement.dataset.fpvLab = 'ready';
    // Opt-in diagnostics on the DOM, for automated checks and for when the
    // console is not in front of you:  index.html?debug
    this.debug = new URLSearchParams(location.search).has('debug');

    this.last = performance.now();
    this.fps = 60;
    this.acc = 0;
    requestAnimationFrame((t) => this.frame(t));
  }

  /* ------------------------------------------------------------- views */
  setupViews() {
    const simRoot = document.querySelector('[data-view="sim"]');
    const raceRoot = document.querySelector('[data-view="race"]');
    const builderRoot = document.querySelector('[data-view="builder"]');
    const tuneRoot = document.querySelector('[data-view="tune"]');

    this.viewport = new Viewport($('#gl', simRoot));
    this.viewportR = new Viewport($('#gl-race', raceRoot));
    this.viewportB = new Viewport($('#gl-builder', builderRoot));
    this.viewportB.setStudio();
    // Textures stream in over the first second or so. The scene is already
    // usable from flat tints, so this never blocks the first frame.
    preloadTextures();
    this.drone = new DroneModel();
    this.droneR = new DroneModel();
    this.droneB = new DroneModel();   // builder preview: its own instance,
    // because a three.js object has exactly one parent and cannot be shared.
    this.viewport.droneGroup.add(this.drone.group);
    this.viewportR.droneGroup.add(this.droneR.group);
    this.viewportB.droneGroup.add(this.droneB.group);
    this.rig = new CameraRig(this.viewport.camera, this.viewport);
    this.raceRig = new CameraRig(this.viewportR.camera, this.viewportR);
    // Builder preview: a slow turntable, so the geometry reads at a glance.
    this.previewAngle = 0.7;
    this.previewDist = 0.85;
    this.previewHeight = 0.28;
    this.installOrbit($('#gl-builder', builderRoot));
    this.fpv = new FpvOverlay($('#fpv-overlay', simRoot));
    this.fx = new Effects();
    this.fxR = new Effects();
    this.viewport.fxGroup.add(this.fx.group);
    this.viewportR.fxGroup.add(this.fxR.group);

    // Career state has to exist before the views, because the race view renders it.
    this.career = new Career(this.careerState);

    this.builderView = new BuilderView(builderRoot, this);
    this.simview = new SimView(simRoot, this);
    this.tuneview = new TuneView(tuneRoot, this);
    this.raceview = new RaceView(raceRoot, this);

    // Tabs
    const tabs = [
      ['builder', 'Builder'], ['sim', 'Simulator'],
      ['tune', 'Tune'], ['race', 'Race'],
    ];
    const nav = $('#tabs');
    this.tabButtons = tabs.map(([id, label]) => el('button', {
      class: id === this.view ? 'active' : '',
      text: label,
      onclick: () => this.setView(id),
    }));
    this.tabButtons.forEach((b) => nav.appendChild(b));

    $('#btn-save').onclick = () => this.save();
    $('#btn-load').onclick = () => this.openGarage();
    $('#garage-close').onclick = () => $('#garage').classList.add('hidden');
    $('#help-close').onclick = () => $('#help').classList.add('hidden');
    $('#btn-fly').onclick = () => this.setView('sim');
    $('#btn-csv').onclick = () => this.exportCsv();

    this.builderView.render();
    this.refreshCost();
    this.updateRxPol();
    this.setView(this.view);
  }

  setView(id) {
    this.view = id;
    this.tabButtons.forEach((b, i) => b.classList.toggle('active',
      ['builder', 'sim', 'tune', 'race'][i] === id));
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === id));
    if (id === 'sim' || id === 'race' || id === 'builder') {
      const vp = id === 'sim' ? this.viewport : id === 'race' ? this.viewportR : this.viewportB;
      vp.resize();
      if (id === 'sim') this.sizeOverlay();
    }
  }

  /* ------------------------------------------------------------- state */
  setSpec(patch) {
    const spec = { ...this.spec, ...patch };
    // Keep the build legal: if the frame changed, drop props/motors that do not fit.
    const frame = getPart('frame', spec.frame);
    const prop = getPart('prop', spec.prop);
    const motor = getPart('motor', spec.motor);
    const esc = getPart('esc', spec.esc);
    const batt = getPart('battery', spec.battery);
    if (prop.D__mm > frame.propMax__mm) {
      const fit = ['p-2.5tri', 'p-3tri', 'p-3.5x3', 'p-hq43', 'p-6', 'p-7', 'p-9', 'p-10']
        .map((id) => getPart('prop', id)).filter((p) => p.D__mm <= frame.propMax__mm);
      spec.prop = (fit[fit.length - 1] || getPart('prop', 'p-2.5tri')).id;
    }
    if (motor.mount !== frame.motorMount) {
      const fit = ['m-1404', 'm-1906', 'm-2207', 'm-2306', 'm-2812', 'm-4004']
        .map((id) => getPart('motor', id)).filter((m) => m.mount === frame.motorMount);
      spec.motor = (fit[0] || motor).id;
      spec.motorKvIndex = 0;
    }
    if (batt.cells < esc.vMin || batt.cells > esc.vMax) {
      const fit = ['b-4s1500-100', 'b-4s1300-li', 'b-6s1300-100', 'b-6s2200-80',
        'b-6s1500-li', 'b-8s1300-li'].map((id) => getPart('battery', id))
        .filter((b) => b.cells >= esc.vMin && b.cells <= esc.vMax);
      spec.battery = (fit[0] || batt).id;
    }
    this.spec = spec;
    this.sim.rebuild(spec);
    this.raceSim.rebuild(spec);
    this.applyWind();
    this.builderView.render();
    this.refreshCost();
    this.persist();
  }

  refreshCost() {
    const cost = buildCost(this.spec);
    this.buildCost = cost;
    $('#cost').textContent = '$' + cost;
    $('#buildname').textContent = this.buildName;
  }

  get buildCostValue() { return this.buildCost; }

  applyWind() {
    this.env.setWind(this.windSpeed, this.windDir, this.gust);
  }

  setTune(t) {
    this.tune = t;
    this.sim.setTune(t);
    this.raceSim.setTune(t);
  }
  pushTune() {
    this.sim.craft.fc.applyTune();
    this.raceSim.craft.fc.applyTune();
  }

  updateRxPol() {
    // Rotate the goggle polarisation axis about the forward horizontal axis.
    const a = (this.rxPolAngle || 0) * Math.PI / 180;
    this.sim.updateRxPolarisation(a);
    this.raceSim.updateRxPolarisation(a);
  }

  /* -------------------------------------------------------- persistence */
  save() {
    const state = {
      spec: this.spec, buildName: this.buildName, tune: this.tune,
      career: this.career ? this.career.toJSON() : null,
      garage: this.garage,
      env: { windSpeed: this.windSpeed, windDir: this.windDir, gust: this.gust,
        tempC: this.env.tempC, turbulence: this.env.turbulence },
    };
    this.garage = this.garage || [];
    this.garage.unshift({
      name: this.buildName, spec: this.spec, tune: this.tune, at: Date.now(),
    });
    if (this.garage.length > 12) this.garage.pop();
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    this.simview.message('ok', 'Build saved to garage');
  }

  load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.spec) this.spec = { ...DEFAULTS, ...s.spec };
      if (s.buildName) this.buildName = s.buildName;
      if (s.tune) this.tune = s.tune;
      if (s.garage) this.garage = s.garage;
      if (s.career) this.careerState = s.career;
      if (s.env) {
        this.windSpeed = s.env.windSpeed ?? 2;
        this.windDir = s.env.windDir ?? 90;
        this.gust = s.env.gust ?? 1.5;
        this._envTemp = s.env.tempC;
        this._envTurb = s.env.turbulence;
      }
    } catch (e) { /* corrupt store: start fresh */ }
  }

  persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        spec: this.spec, buildName: this.buildName, tune: this.tune,
        career: this.career ? this.career.toJSON() : this.careerState,
        garage: this.garage,
      }));
    } catch (e) { /* storage full or blocked: not fatal */ }
  }

  openGarage() {
    const box = $('#garage-list');
    clear(box);
    const list = this.garage || [];
    if (!list.length) box.appendChild(el('div', { class: 'warn-row info', text: 'No saved builds yet.' }));
    for (const g of list) {
      box.appendChild(el('button', {
        onclick: () => {
          this.spec = { ...g.spec };
          this.buildName = g.name;
          this.setTune(g.tune || cloneTune(DEFAULT_TUNE));
          this.sim.rebuild(this.spec);
          this.raceSim.rebuild(this.spec);
          this.builderView.buildCatRail();
          this.builderView.render();
          this.refreshCost();
          $('#garage').classList.add('hidden');
        },
      }, [
        el('span', { class: 'pn', text: g.name }),
        el('span', { class: 'pb',
          text: `${getPart('frame', g.spec.frame).name} · ${getPart('motor', g.spec.motor).name}`
            + ` · ${getPart('prop', g.spec.prop).name} · $${buildCost(g.spec)}` }),
      ]));
    }
    $('#garage').classList.remove('hidden');
  }

  exportCsv() {
    const t = this.sim.telemetry;
    const name = `blackbox_${this.buildName.replace(/\W+/g, '_')}_${Date.now()}.csv`;
    download(name, t.toCSV());
    this.simview.message('ok', `Exported ${t.count} rows`);
  }

  /* -------------------------------------------------------------- input */
  setupKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const sim = this.view === 'race' ? this.raceSim : this.sim;
      sim.input.key(e.code, true);
      switch (e.code) {
        case 'Enter': this.toggleArm(); e.preventDefault(); break;
        case 'KeyR': this.resetCraft(); break;
        case 'Digit1': this.setCamera('fpv'); this.simview.syncCameras(); break;
        case 'Digit2': this.setCamera('chase'); this.simview.syncCameras(); break;
        case 'Digit3': this.setCamera('orbit'); this.simview.syncCameras(); break;
        case 'Digit4': this.setCamera('top'); this.simview.syncCameras(); break;
        case 'Digit5': this.setCamera('pit'); this.simview.syncCameras(); break;
        case 'KeyF': this.fx.showWash = !this.fx.showWash; break;
        case 'KeyT': this.fx.trailOn = !this.fx.trailOn;
          if (!this.fx.trailOn) this.fx.clearTrail(); break;
        case 'Slash': $('#help').classList.toggle('hidden'); break;
        case 'BracketLeft': sim.speedScale = Math.max(0.1, sim.speedScale / 2); break;
        case 'BracketRight': sim.speedScale = Math.min(2, sim.speedScale * 2); break;
      }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      const sim = this.view === 'race' ? this.raceSim : this.sim;
      sim.input.key(e.code, false);
    });
    window.addEventListener('blur', () => {
      const sim = this.view === 'race' ? this.raceSim : this.sim;
      sim.input.reset();
    });
  }

  toggleArm() {
    const sim = this.view === 'race' ? this.raceSim : this.sim;
    if (sim.craft.fc.armed) {
      sim.disarm();
      this.simview.message('info', 'Disarmed');
    } else if (!sim.arm()) {
      this.simview.message('warn', 'Arming refused');
    }
    this.updateArmButton();
  }
  resetCraft() {
    const sim = this.view === 'race' ? this.raceSim : this.sim;
    sim.reset({ rebuildBattery: false });
    this.updateArmButton();
  }
  updateArmButton() {
    const sim = this.view === 'race' ? this.raceSim : this.sim;
    const armed = sim.craft.fc.armed;
    // Two views own an arm control, so both have to follow the same state.
    for (const sel of ['#btn-arm', '#btn-race-arm']) {
      const b = $(sel);
      if (!b) continue;
      b.textContent = armed ? 'Disarm' : 'Arm';
      b.classList.toggle('primary', !armed);
    }
  }

  setCamera(id) {
    const rig = this.view === 'race' ? this.raceRig : this.rig;
    rig.setMode(id);
  }
  setRaceCameraDefault() { this.raceRig.setMode('chase'); this.raceview.syncCameras(); }

  /* ------------------------------------------------------------- tracks */
  loadTrack(id, initial) {
    const track = getTrack(id);
    this.trackId = id;
    this.track = track;
    // Rebuild both the RF world and the collider set from the same obstacle list,
    // so what attenuates the link is exactly what you can see, hit and hide
    // behind. Foliage and netting are transparent to RF and passable in flight,
    // which is why they are excluded from the collision set.
    const world = new RFWorld();
    const colliders = [];
    for (const o of track.obstacles) {
      const b = world.addBox(o.x, o.y, o.z, o.sx, o.sy, o.sz, o.material);
      if (track.collision.indexOf(o) >= 0) {
        colliders.push(b);
      } else {
        b.noCollide = true;
      }
    }
    // Collision comes from track.obstacles only. track.roof is rendering
    // metadata (the viewport draws the slab as an obstacle), and synthesising a
    // second slab from it produced a collider with no visible geometry: an
    // invisible ceiling sitting inside the real one, which overlapping-box
    // push-out could ratchet a craft down through.
    this.rfWorld = world;
    this.colliders = colliders;
    this.sim.rfWorld = world;
    this.raceSim.rfWorld = world;
    this.sim.colliders = colliders;
    this.raceSim.colliders = colliders;
    this.env.rfWorld = world;
    this.env.bounds = track.bounds;
    if (this.sim.craft) this.sim.craft.colliders = colliders;
    if (this.raceSim.craft) this.raceSim.craft.colliders = colliders;
    this.viewportR.buildTrack(track);
    this.viewport.buildTrack(track);
    // The builder preview stays a clean studio: a part has no business being
    // lost inside a hangar.
    this.viewportB.setStudio();
    this.raceSim.pilotPos = { ...track.pilot };
    this.sim.pilotPos = { ...track.pilot };
    if (this.raceview) this.raceview.renderTrackInfo();
  }

  /**
   * Sets the sky on both flight viewports and pushes the matching wind and
   * turbulence into the simulation, so "rain" means both a wet-looking sky and
   * a craft that is being buffeted.
   */
  setWeather(id) {
    this.weatherId = id;
    const w = getWeather(id);
    for (const vp of [this.viewport, this.viewportR]) {
      if (vp) vp.applyWeather(id);
    }
    this.windSpeed = w.wind;
    this.gust = w.wind * 0.22;
    this.env.turbulence = w.turb;
    this.applyWind();
    if (this.simview) this.simview.buildEnvConfig();
  }

  /* ---------------------------------------------------------- main loop */
  sizeOverlay() {
    const c = $('#fpv-overlay');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    this.fpv.resize(w, h, dpr);
  }

  frame(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fps = this.fps * 0.92 + (1 / Math.max(1e-3, dt)) * 0.08;

    try {
      if (this.view === 'sim') this.frameSim(dt);
      else if (this.view === 'race') this.frameRace(dt);
      else if (this.view === 'tune') this.frameTune(dt);
      else this.frameBuilder(dt);
    } catch (e) {
      // Report through the DOM as well as the console: a silent exception inside
      // the render loop looks exactly like a frozen app.
      console.error(e);
      document.documentElement.dataset.fpvError = String(e && e.stack || e).slice(0, 400);
      if (!this._errShown) {
        this._errShown = true;
        this.simview.message('error', String(e && e.message || e));
      }
    }
    if (this.debug) {
      try { this.publishDiagnostics(); } catch (e) {
        document.documentElement.dataset.fpvDiagError = String(e && e.stack || e).slice(0, 300);
      }
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Mirror the important state onto the DOM so it can be inspected or tested. */
  publishDiagnostics() {
    const vp = this.view === 'sim' ? this.viewport : this.view === 'race' ? this.viewportR : this.viewportB;
    const sim = this.view === 'race' ? this.raceSim : this.sim;
    const h = sim.hud();
    const d = {
      view: this.view,
      fps: Math.round(this.fps),
      armed: h.armed,
      alt: +h.alt.toFixed(2),
      speed: +h.speed.toFixed(2),
      rpm: h.rpm.map((r) => Math.round(r)),
      voltage: +h.voltage.toFixed(2),
      current: +h.current.toFixed(1),
      thrust: +h.thrust.toFixed(2),
      vtx: { q: +h.vtx.quality.toFixed(3), rssi: +(h.vtx.rssi || 0).toFixed(0),
        lat: +(h.vtx.latency || 0).toFixed(1), snow: +(h.vtx.snow || 0).toFixed(2) },
      rc: { lq: +h.rc.lq.toFixed(3), rssi: +h.rc.rssi.toFixed(0) },
      wash: { surface: +(h.wash.surface || 0).toFixed(2), ge: +(h.wash.groundEffect || 1).toFixed(3) },
      cam: vp.camera.position.toArray().map((v) => +v.toFixed(2)),
      canvas: [vp.canvas.width, vp.canvas.height],
      io: {
        rawThrottle: +sim.input.raw.throttle.toFixed(3),
        keys: [...sim.input.keys].join('+'),
        rcQueue: sim.rc.queue.length,
        linkPeriod: sim.radio.periodMs,
        fcThrottleOut: Math.round(sim.craft.fc.throttleOut),
        motor0: Math.round(sim.craft.fc.motors[0]),
        armed: sim.craft.fc.armed,
        motorsArmed: sim.craft.motors[0].RPM > 1,
      },
      race: this.raceview && this.raceview.race
        ? { state: this.raceview.race.state, lap: this.raceview.race.lap,
          gate: this.raceview.race.gateIndex, laps: this.raceview.race.lapTimes.length } : null,
      weather: {
        id: vp.weatherId,
        interior: !!(vp.track && vp.track.interior),
        track: vp.track ? vp.track.id : null,
        sun: +vp.key.intensity.toFixed(2),
        amb: +vp.ambient.intensity.toFixed(2),
        exposure: +vp.renderer.toneMappingExposure.toFixed(2),
        fog: vp.scene.fog ? +vp.scene.fog.density.toFixed(5) : 0,
        rain: vp.rain ? (vp.rain.visible ? +vp.rain.userData.amount.toFixed(2) : 0) : 0,
        envMap: !!vp.scene.environment,
      },
    };
    document.documentElement.dataset.fpvDebug = JSON.stringify(d);
  }

  frameSim(dt) {
    const sim = this.sim;
    sim.step(dt);
    const craft = sim.craft;
    const h = sim.hud();

    this.drone.update(craft, dt);
    this.drone.group.position.set(craft.body.pos.x, craft.body.pos.y, craft.body.pos.z);
    this.drone.group.quaternion.set(craft.body.quat.x, craft.body.quat.y,
      craft.body.quat.z, craft.body.quat.w);
    this.fx.update(dt, craft);
    this.rig.update(craft, dt, { pilot: sim.pilotPos });

    // The FPV feed is a delayed copy of the camera, and the delay is the link's.
    const isFpv = this.rig.mode === 'fpv';
    this.rig.latencyMs = h.vtx.latency || 5;
    this.rig.pushFeedPose(craft, this.rig.latencyMs);
    this.viewport.tickWeather(dt, this.viewport.camera.position);
    this.viewport.render();

    this.simview.updateHud(h, isFpv);
    this.simview.updateGauges(h);
    this.simview.updateLinkPanel(h);
    this.updateArmButton();

    // Overlay the feed artefacts only when actually looking at FPV.
    const v = sim.video;
    this.fpv.enabled = isFpv || this.sim.overlayAlways;
    this.fpv.draw({
      snow: v.snow, dropout: v.dropout, static: v.static,
      quality: v.quality, analog: v.system === 'analog',
      rolling: v.dropout > 0.5 ? v.dropout : 0,
    });
  }

  frameRace(dt) {
    const sim = this.raceSim;
    sim.step(dt);
    const craft = sim.craft;

    this.droneR.update(craft, dt);
    this.droneR.group.position.set(craft.body.pos.x, craft.body.pos.y, craft.body.pos.z);
    this.droneR.group.quaternion.set(craft.body.quat.x, craft.body.quat.y,
      craft.body.quat.z, craft.body.quat.w);
    this.fxR.update(dt, craft);
    this.raceRig.update(craft, dt, { pilot: sim.pilotPos });
    this.updateRaceRivals();

    this.viewportR.tickWeather(dt, this.viewportR.camera.position);
    this.viewportR.render();
    this.raceview.update(dt);
    this.updateArmButton();
  }

  /** Rivals are drawn as wireframe diamonds so a race reads at a glance. */
  updateRaceRivals() {
    const rv = this.raceview;
    if (!this.rivalGroup) {
      this.rivalGroup = new THREE.Group();
      this.viewportR.scene.add(this.rivalGroup);
      this.rivalMarks = [];
    }
    while (this.rivalMarks.length < rv.rivals.length) {
      const g = new THREE.Group();
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.10, 0)),
        new THREE.LineBasicMaterial({ color: 0xe0a04a, transparent: true, opacity: 0.9 }));
      g.add(edges);
      const dir = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.ConeGeometry(0.05, 0.24, 4)),
        new THREE.LineBasicMaterial({ color: 0xe0a04a, transparent: true, opacity: 0.55 }));
      dir.rotation.x = -Math.PI / 2;
      dir.position.z = 0.20;
      g.add(dir);
      this.rivalGroup.add(g);
      this.rivalMarks.push(g);
    }
    this.rivalMarks.forEach((m, i) => {
      const r = rv.rivals[i];
      m.visible = !!r;
      if (!r) return;
      m.position.set(r.pos.x, r.pos.y, r.pos.z);
      m.rotation.y = r.heading || 0;
    });
  }

  frameTune(dt) {
    // Keep flying in the background so the scopes stay live.
    const sim = this.sim;
    if (!sim.paused) sim.step(dt);
    const craft = sim.craft;
    this.drone.update(craft, dt);
    this.drone.group.position.set(craft.body.pos.x, craft.body.pos.y, craft.body.pos.z);
    this.drone.group.quaternion.set(craft.body.quat.x, craft.body.quat.y,
      craft.body.quat.z, craft.body.quat.w);
    this.rig.update(craft, dt, { pilot: sim.pilotPos });
    this.viewport.render();
    this.tuneview.update();
  }

  frameBuilder(dt) {
    // Preview mode: the props turn at their real hover rpm, but the craft is
    // pinned level and motionless so the model reads as a drawing.
    const sim = this.sim;
    const craft = sim.craft;
    sim.previewMode = true;
    sim.step(dt);
    sim.previewMode = false;

    this.droneB.update(craft, dt);
    this.droneB.group.position.set(0, 0.30, 0);
    // Level is Q_LEVEL, not identity. The body frame is aerospace NED, so an
    // identity quaternion leaves the airframe rolled on its side.
    this.droneB.group.quaternion.set(Q_LEVEL.x, Q_LEVEL.y, Q_LEVEL.z, Q_LEVEL.w);

    // Scale the orbit with the airframe so a 10" and a toothpick both frame well.
    const s = craft.frame.wheelbase__mm / 1000;
    this.previewAngle += dt * 0.22;
    const dist = s * 1.85 * this.previewDist;
    const cam = this.viewportB.camera;
    cam.position.set(
      Math.cos(this.previewAngle) * dist,
      s * 0.9 + this.previewHeight,
      Math.sin(this.previewAngle) * dist);
    cam.lookAt(0, 0.30, 0);
    cam.fov = 42;
    cam.updateProjectionMatrix();
    this.viewportB.render();
  }

  /** Drag to orbit, wheel to zoom, for the builder preview. */
  installOrbit(canvas) {
    let dragging = false, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; lx = e.clientX; ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.previewAngle -= (e.clientX - lx) * 0.012;
      this.previewHeight = Math.max(-0.5, Math.min(1.2,
        this.previewHeight + (e.clientY - ly) * 0.002));
      lx = e.clientX; ly = e.clientY;
    });
    const stop = () => { dragging = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.previewDist = Math.max(0.35, Math.min(4, this.previewDist * (1 + Math.sign(e.deltaY) * 0.1)));
    }, { passive: false });
  }
}

// NB: the global is named `fpvLab`, not `app` - the <div id="app"> in the markup
// would otherwise become window.app and shadow it.
function boot() {
  try {
    if (!window.fpvLab) window.fpvLab = new App();
  } catch (e) {
    window.__bootError = e;
    console.error(e);
    // Surface it: a silent blank page is the worst possible failure mode.
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;inset:12px;z-index:99;margin:0;padding:14px;'
      + 'background:#1a0f10;color:#f0b0a6;border:1px solid #e06a5a;border-radius:6px;'
      + 'font:12px ui-monospace,monospace;white-space:pre-wrap;overflow:auto';
    box.textContent = 'FPV LAB failed to start\n\n' + (e && e.stack ? e.stack : e);
    document.body.appendChild(box);
  }
}
window.addEventListener('DOMContentLoaded', boot);
if (document.readyState !== 'loading') boot();
