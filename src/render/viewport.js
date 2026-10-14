// Viewport: renderer, scene, lighting and the look.
//
// The brief is a clean engineering / blueprint presentation, so surfaces are
// matte and lightly shaded with bright edge lines on top. That reads as
// "technical drawing of a real place" instead of "video game", and it keeps
// legibility high when the camera is chasing a small object at speed.

import * as THREE from '../../vendor/three.module.js';
import { clamp, lerp } from '../core/math.js';
import { groundMaterial, preloadTextures } from './materials.js';
import { SkySystem } from './sky.js';
import { Scenery } from './scenery.js';
import { getWeather, sunVector, WEATHER } from '../data/weather.js';

export class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance', alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x0d1117, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    // Exponential fog rather than linear: weather changes haze continuously,
    // and linear near/far cannot express that without popping.
    this.scene.fog = new THREE.FogExp2(0x20242c, 0.003);
    this.scene.background = new THREE.Color(0x0d1117);

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.02, 4000);
    this.camera.position.set(0, 3, 8);

    // Sun. Shadows are off: the track is a few hundred metres of boxes and a
    // shadow pass over all of them costs more than it is worth at this scale.
    this.key = new THREE.DirectionalLight(0xfff2e0, 3.0);
    this.key.position.set(40, 90, 20);
    this.scene.add(this.key);
    // Opposing fill so the shaded side of a surface is not simply black.
    this.fill = new THREE.DirectionalLight(0x8090aa, 0.6);
    this.fill.position.set(-30, 20, -40);
    this.scene.add(this.fill);
    this.hemi = new THREE.HemisphereLight(0xbdd0e8, 0x2a2f38, 1.1);
    this.scene.add(this.hemi);
    // A small flat floor term. Without it, anything facing away from both the
    // sun and the sky reads as pure black, which is what made the scene look
    // unlit rather than merely dim.
    this.ambient = new THREE.AmbientLight(0xffffff, 0.3);
    this.scene.add(this.ambient);

    this.weather = getWeather('clear');
    // Null means "the user has not chosen a sky", so a track's own `weather:`
    // default applies. It was seeded with 'clear', and since `'clear' || t.weather`
    // always took the first operand, no track default could ever reach the scene.
    this.weatherId = null;
    this.weatherExplicit = false;
    this.rain = null;

    // Open sky. The dome replaces a flat background colour and also generates
    // the environment map, so `scene.environment` is the sky the camera sees
    // rather than a canvas gradient standing in for it.
    this.sky = new SkySystem();
    this.sky.setRenderer(this.renderer);
    for (const o of this.sky.objects) this.scene.add(o);

    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);
    this.trackGroup = new THREE.Group();
    this.scene.add(this.trackGroup);
    this.droneGroup = new THREE.Group();
    this.scene.add(this.droneGroup);
    this.fxGroup = new THREE.Group();
    this.scene.add(this.fxGroup);

    this.gridHelper = this._makeGrid(600, 60, 0x2a3542, 0x1b232d);
    this.scene.add(this.gridHelper);

    this.raceLine = null;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Neutral studio environment for part previews: no fog, no track, even light. */
  setStudio() {
    this.scene.background = new THREE.Color(0x161b22);
    this.scene.fog = null;
    this.renderer.setClearColor(0x161b22, 1);
    // A part preview is a studio shot. A sky dome behind a product turntable is
    // just a distracting gradient, and the studio already supplies its own
    // gradient IBL below.
    this.sky.sky.visible = false;
    this.sky.stars.visible = false;
    this.key.intensity = 2.4;
    this.key.color.set(0xffffff);
    this.key.position.set(2, 4, 3);
    this.fill.intensity = 1.1;
    this.fill.color.set(0x9fc0e0);
    this.fill.position.set(-3, 1.5, -2);
    this.hemi.intensity = 1.4;
    this.hemi.color.set(0xd4e2f4);
    this.hemi.groundColor.set(0x3a4048);
    this.ambient.intensity = 0.5;
    this.renderer.toneMappingExposure = 1.15;
    this.scene.environment = null;
    this._updateEnvMap(getWeather('clear'), true);
    this.bounds = { half: 200, ceiling: 90 };
    this.gridHelper.visible = false;
    if (this.rain) this.rain.visible = false;
    if (!this.groundMesh) this._makeGround({ ground: 'concrete' });
  }

  _makeGrid(size, div, c1, c2) {
    const g = new THREE.GridHelper(size, div, c1, c2);
    g.material.transparent = true;
    g.material.opacity = 0.5;
    return g;
  }

  resize() {
    const w = this.canvas.clientWidth || 1280;
    const h = this.canvas.clientHeight || 720;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setEnvironment(track) {
    const t = track || {};
    this.track = t;
    this.bounds = t.bounds || { half: 200, ceiling: 90 };
    // An explicit user choice wins and sticks across track changes; otherwise the
    // track's own weather is the default, so loading the hangar over a sunny
    // rooftop actually looks overcast.
    const chosen = this.weatherExplicit ? this.weatherId : null;
    this.applyWeather(chosen || t.weather || 'clear');
    const g = this.gridHelper;
    g.position.set(0, 0.002, 0);
    g.visible = !t.interior;
    this.ground = this._makeGround(t);
  }

  /**
   * Applies a full lighting state. Everything visual at once - sun, sky, fog,
   * exposure, rain - so switching weather changes the mood as a unit instead of
   * leaving half the previous sky behind.
   */
  applyWeather(idOrState) {
    const w = typeof idOrState === 'string'
      ? getWeather(idOrState) : idOrState;
    this.weather = w;
    if (typeof idOrState === 'string') this.weatherId = idOrState;

    // Indoors the sky is not the light source. A hangar is lit by overhead
    // industrial fittings, so it gets its own rig: a strong key straight down
    // plus bounce off the floor. Dimming an outdoor sky and hoping reads as a
    // black scene, which is not what a hangar looks like.
    const indoor = this.track && this.track.interior;
    const v = sunVector(w);

    // The dome is driven first: it owns the sky colours and the IBL, and the
    // hemisphere/fill lights below are then balanced against what it produced.
    this.sky.apply({ ...w, id: this.weatherId }, v, { indoor });
    if (!indoor) this.sky.update(this.camera, true);

    if (indoor) {
      this.key.position.set(12, 100, 18);
      this.key.intensity = 2.5;
      this.key.color.set(0xfff0dc);
      this.fill.position.set(-40, 26, -30);
      this.fill.intensity = 0.75;
      this.fill.color.set(0x9fb0c4);
      this.hemi.intensity = 0.7;
      this.hemi.color.set(0xb8c4d0);
      this.hemi.groundColor.set(0x6a6258);
      this.ambient.intensity = 0.42;
    } else {
      this.key.position.set(v.x * 100, v.y * 100, v.z * 100);
      this.key.intensity = w.sunI;
      this.key.color.set(w.sunColor);
      // The hemisphere and ambient terms are now largely REDUNDANT outdoors.
      //
      // `scene.environment` is the sky dome rendered into a PMREM, which means
      // it already supplies sky-colour irradiance from above and ground-bounce
      // from below - exactly what a HemisphereLight models. Leaving the old
      // values at full strength on top of it double-counts the whole sky, and
      // it shows: every upward-facing surface reads washed out and the dark
      // carbon of the airframe lifts to pale blue. They are cut to about a
      // third, which leaves a floor so nothing is ever pure black (still the
      // documented reason they exist) without fighting the IBL.
      this.fill.position.set(-v.x * 60, 30, -v.z * 60);
      this.fill.intensity = 0.25 + w.hemiI * 0.3;
      this.fill.color.set(w.skyHorizon);
      this.hemi.intensity = w.hemiI * 0.32;
      this.hemi.color.set(w.skyTop);
      this.hemi.groundColor.set(w.groundBounce);
      this.ambient.intensity = w.ambient * 0.30;
    }

    if (this.scene.fog) {
      this.scene.fog.color.set(indoor ? (this.track.fogColor || 0x2b3038) : w.fogColor);
      this.scene.fog.density = indoor
        ? (this.track.fog ? 1 / (this.track.fog.far || 300) : 0.003)
        : w.fogDensity;
    }
    // Outdoors the dome is the background, so scene.background must stay null:
    // a background colour would paint over it. Indoors there is no dome, so the
    // clear colour is what you actually see past the doors.
    this.scene.background = indoor ? new THREE.Color(0x14171c) : null;
    this.renderer.toneMappingExposure = w.exposure;
    this.renderer.setClearColor(indoor ? 0x14171c : w.skyHorizon, 1);
    this._updateEnvMap(w, indoor);
    this._applyRain(indoor ? 0 : w.rain);
    return w;
  }

  /**
   * Builds the environment map.
   *
   * This is not a nicety. A PBR material with metalness has almost no diffuse
   * response - all of its look comes from reflected surroundings - so with
   * `scene.environment` unset every metal surface renders near-black. The
   * hangar walls and the rooftop plant were exactly that.
   *
   * Outdoors the dome renders its own PMREM (`SkySystem.bakeEnvironment`), so
   * the reflections agree with the sky on screen and a low sun actually shows
   * up in a polished surface. Indoors there is no visible sky, so the IBL is
   * the old vertical gradient: a dark ceiling, a bright band at the far wall
   * and a dark floor, which is a reasonable stand-in for a lit hangar shell.
   */
  _updateEnvMap(w, indoor) {
    if (!indoor) {
      const tex = this.sky.envTexture || this.sky.bakeEnvironment();
      this.scene.environment = tex || null;
      return;
    }
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(this.renderer);
    const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 32;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 32);
    g.addColorStop(0, '#20242c');
    g.addColorStop(0.45, '#6d7480');
    g.addColorStop(1, '#2a2d31');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 32);

    const tex = new THREE.CanvasTexture(cv);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const rt = this._pmrem.fromEquirectangular(tex);
    if (this._envRT) this._envRT.dispose();
    this._envRT = rt;
    this.scene.environment = rt.texture;
    // The texture itself is only needed to produce the PMREM target.
    tex.dispose();
  }
  _applyRain(amount) {
    const want = amount > 0.02;
    if (!want) {
      if (this.rain) this.rain.visible = false;
      return;
    }
    if (!this.rain) this.rain = this._makeRain();
    this.rain.visible = true;
    this.rain.material.opacity = 0.4 + amount * 0.5;
    this.rain.userData.amount = amount;
  }

  _makeRain() {
    // Density is what sells rain, not drop count: 1200 drops scattered over a
    // 26 m box is a tenth of a drop per cubic metre and reads as clear. Keep the
    // emitter tight around the camera and the same budget looks like weather.
    const N = 1400;
    const R = 9;                          // half-width of the emitter box, metres
    const H = 13;
    const streak = 0.5;
    const pos = new Float32Array(N * 6);
    const drop = (i, y) => {
      const x = (Math.random() - 0.5) * 2 * R;
      const z = (Math.random() - 0.5) * 2 * R;
      pos[i * 6] = x; pos[i * 6 + 1] = y; pos[i * 6 + 2] = z;
      pos[i * 6 + 3] = x; pos[i * 6 + 4] = y - streak; pos[i * 6 + 5] = z;
    };
    for (let i = 0; i < N; i++) drop(i, Math.random() * H);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // Line segments, not points: a point is a dot, and rain reads as streaks.
    // WebGL clamps line width to 1 px on most drivers, so the visibility has to
    // come from contrast and count rather than thickness.
    const m = new THREE.LineBasicMaterial({
      color: 0xf0f6ff, transparent: true, opacity: 0.5, depthWrite: false,
      fog: false,
    });
    const p = new THREE.LineSegments(g, m);
    p.frustumCulled = false;
    p.userData.amount = 0.5;
    p.userData.N = N;
    p.userData.R = R;
    p.userData.H = H;
    p.userData.streak = streak;
    this.scene.add(p);
    return p;
  }

  /** Animates rain and keeps it centred on the camera. */
  tickWeather(dt, cameraPos) {
    if (!this.rain || !this.rain.visible) return;
    const p = this.rain.geometry.attributes.position;
    const N = this.rain.userData.N;
    const R = this.rain.userData.R;
    const H = this.rain.userData.H;
    const a = this.rain.userData.amount;
    const fall = 16 + a * 18;
    const drift = (this.weather.wind || 0) * 0.4;
    // Longer streaks when it is raining harder, which is what actually reads as
    // intensity - more drops alone just looks like static.
    const len = this.rain.userData.streak * (0.5 + a);
    for (let i = 0; i < N; i++) {
      let y = p.getY(i * 2) - fall * dt;
      let x = p.getX(i * 2) + drift * dt;
      const z = p.getZ(i * 2);
      if (y < 0) {
        y += H;
        x = (Math.random() - 0.5) * 2 * R;
      }
      if (x > R) x -= 2 * R; else if (x < -R) x += 2 * R;
      p.setXYZ(i * 2, x, y, z);
      p.setXYZ(i * 2 + 1, x, y - len, z);
    }
    p.needsUpdate = true;
    if (cameraPos) this.rain.position.set(cameraPos.x, 0, cameraPos.z);
  }

  _makeGround(t) {
    if (this.groundMesh) {
      this.scene.remove(this.groundMesh);
      this.groundMesh.geometry.dispose();
    }
    const size = (this.bounds?.half || 200) * 4;
    const geo = new THREE.PlaneGeometry(size, size);
    // The ground is one huge quad, so its UVs have to be scaled by world size or
    // a single tile would be stretched over the whole arena.
    const kind = t.ground || 'concrete';
    const per = 0.12;
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * size * per, uv.getY(i) * size * per);
    uv.needsUpdate = true;
    const m = new THREE.Mesh(geo, groundMaterial(kind));
    m.rotation.x = -Math.PI / 2;
    m.position.y = -0.01;
    this.scene.add(m);
    this.groundMesh = m;
    return m;
  }

  clearTrack() {
    while (this.trackGroup.children.length) {
      const c = this.trackGroup.children.pop();
      c.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
    }
    if (this.raceLine) { this.raceLine.geometry.dispose(); this.raceLine = null; }
  }

  /** Material tints, so an RF/structural read is visible at a glance. */
  static materialColor(material) {
    const m = {
      concrete: 0x4a5058, reinforced: 0x565d66, brick: 0x6b4536, wood: 0x6a5236,
      woodStud: 0x7a6242, plywood: 0x8a7048, drywall: 0xa8b0b8, glass: 0x9fc4d8,
      metal: 0x8c96a4, foliage: 0x2f4a2c, mesh: 0x6a7078, rubber: 0x3a3d42,
    };
    return m[material] || 0x50565e;
  }

  buildTrack(track) {
    this.clearTrack();
    this.setEnvironment(track);

    // Scenery turns each obstacle into real geometry - conifers, houses, city
    // blocks, rock - fitted inside its collision box. `track.obstacles` itself
    // is untouched: it is still the RF and collider truth.
    if (!this.scenery) this.scenery = new Scenery();
    this.trackGroup.add(this.scenery.build(track));
    this.sceneryStats = this.scenery.stats;

    // Race line
    if (track.line) {
      const pts = track.line.map((p) => new THREE.Vector3(p.x, p.y, p.z));
      const lg = new THREE.BufferGeometry().setFromPoints(pts);
      this.raceLine = new THREE.Line(lg, new THREE.LineBasicMaterial({
        color: 0x3d7fa8, transparent: true, opacity: 0.55,
      }));
      this.scene.add(this.raceLine);
    }

    // Gates: a square frame the pilot aims at, numbered so a miss is obvious.
    this.gateGroup = new THREE.Group();
    this.gates = [];
    track.gateList.forEach((g, i) => {
      const grp = new THREE.Group();
      grp.position.set(g.x, g.y, g.z);
      grp.rotation.y = Math.atan2(g.nx, g.nz);
      const r = g.r;
      const col = g.type === 'start' ? 0x4fd18b : g.type === 'finish' ? 0xf0c04a : 0x66a8d8;
      // Lit and dim, not unlit MeshBasicMaterial. The grid start sits exactly on
      // the start gate, so the chase camera is inside the ring: an unlit 50%
      // opaque torus then fills the view as a flat band of colour.
      const mat = new THREE.MeshStandardMaterial({
        color: col, transparent: true, opacity: 0.3,
        roughness: 0.6, metalness: 0,
        emissive: col, emissiveIntensity: 0.35, side: THREE.DoubleSide,
        depthWrite: false,
      });
      const bar = new THREE.Mesh(new THREE.TorusGeometry(r, 0.035, 6, 4), mat);
      bar.rotation.z = Math.PI / 4;
      grp.add(bar);
      const post = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(r * 1.2, r * 1.2, 0.02)),
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.22 }));
      grp.add(post);
      this.trackGroup.add(grp);
      this.gates.push(grp);
    });

    // Start pad. Lit rather than MeshBasicMaterial: the chase camera sits barely
    // a metre behind the craft on the grid, so a full-brightness unlit ring
    // fills half the view as a flat green slab. As a lit, partly transparent
    // marking it reads as paint on the floor - and it is faded out entirely when
    // the camera is over it, because the craft is parked right on top of it.
    const pad = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.62, 32),
      new THREE.MeshStandardMaterial({
        color: 0x3f9a6a, transparent: true, opacity: 0.32,
        roughness: 0.9, metalness: 0, side: THREE.DoubleSide, depthWrite: false,
      }));
    pad.rotation.x = -Math.PI / 2;
    // On the track's start pad, which is at the track's own height - not always
    // the ground plane. Rooftops starts 34 m up.
    pad.position.set(track.start.x, track.start.y + 0.02, track.start.z);
    this.trackGroup.add(pad);
    this.startPad = pad;

    // Pilot marker, so the link budget makes visible sense
    const pilot = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.25, 1.1, 4, 8),
      new THREE.MeshBasicMaterial({ color: 0xe0e6ec }));
    body.position.y = 0.8;
    pilot.add(body);
    pilot.position.set(track.pilot.x, track.pilot.y - 0.8, track.pilot.z);
    this.trackGroup.add(pilot);
    this.pilotMarker = pilot;
  }

  /** Highlight the next gate. */
  setActiveGate(i) {
    if (!this.gates) return;
    for (let k = 0; k < this.gates.length; k++) {
      const g = this.gates[k];
      const active = k === i;
      // Capped well below opaque: the active gate is the one you are flying
      // through, and at 0.95 it is a wall of colour across the whole view.
      g.userData.base = active ? 0.5 : 0.18;
      // Opacity belongs to the near-fade pass, which runs inside render(); this
      // only sets the target it fades towards.
      g.children[0].material.emissiveIntensity = active ? 0.55 : 0.25;
      g.scale.setScalar(active ? 1.12 : 1);
    }
  }

  /**
   * Fades the ground markings the camera is sitting inside. On the grid the
   * chase camera is within a metre of the start ring and directly over the start
   * pad - the craft is parked on it - so without this the first seconds of every
   * heat are behind a sheet of coloured plastic.
   */
  _fadeNearGates(cam) {
    if (!cam) return;
    const cp = cam.position;
    if (this.gates) {
      for (const g of this.gates) {
        const base = g.userData.base != null ? g.userData.base : 0.2;
        const d = Math.hypot(g.position.x - cp.x, g.position.y - cp.y, g.position.z - cp.z);
        const f = Math.min(1, Math.max(0, (d - 0.9) / 2.2));
        g.children[0].material.opacity = base * f;
        g.visible = f > 0.01;
      }
    }
    // The pad is flat on the floor, so only the horizontal offset matters: a
    // camera 40 m up looking down at the start box should still see it.
    const pad = this.startPad;
    if (pad) {
      const d = Math.hypot(pad.position.x - cp.x, pad.position.z - cp.z);
      const near = Math.min(1, Math.max(0, (d - 0.45) / 1.6));
      pad.material.opacity = 0.32 * near;
      pad.visible = near > 0.01;
    }
  }

  setShowRaceLine(v) {
    if (this.raceLine) this.raceLine.visible = v;
  }

  render() {
    this._fadeNearGates(this.camera);
    // The dome is a fixed-size box that rides with the camera. Without this it
    // slides visibly once the craft is a few hundred metres downrange, because
    // the racing lines on the long tracks run out to 300+ m.
    this.sky.update(this.camera, false);
    this.renderer.render(this.scene, this.camera);
  }
}
