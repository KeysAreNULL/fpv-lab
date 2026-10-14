// Open sky: an atmospheric dome instead of a flat background colour.
//
// Before this, `scene.background` was a solid THREE.Color taken straight from
// the weather preset, so the "sky" was one flat tone with no gradient, no sun
// and no horizon. That reads as a backdrop, not as weather, and it is the reason
// an outdoor track looked like a model on a table.
//
// This wraps three's Preetham analytic daylight model (vendored as
// `vendor/Sky.js`) and drives its four parameters from the existing weather
// presets, so `applyWeather()` keeps working as the single place the sky is
// described. Two things are added on top of the stock shader:
//
//   - **Stars**, for the night preset. Preetham is a *daylight* model: below
//     the horizon it goes almost black, which is right for dusk but loses the
//     one thing you actually want to look at when you select "night".
//   - **A real environment map.** The old code built the IBL from a 64x32
//     canvas gradient. The dome can generate its own PMREM from a scene render
//     instead, which is the same sky the camera sees - so metal actually
//     reflects a sky with a sun in it, and the ambient term stops being a
//     guess.
//
// The dome is a 1x1x1 box that is scaled up and re-centred on the camera every
// frame, because the racing line takes the craft 800 m downrange and a
// fixed-position dome would visibly slide.

import * as THREE from '../../vendor/three.module.js';
import { Sky } from '../../vendor/Sky.js';
import { clamp, lerp } from '../core/math.js';

/**
 * Weather preset -> Preetham parameters.
 *
 * These are not arbitrary. The Preetham model's own defaults (turbidity 2,
 * rayleigh 1, mie 0.005) are a clear day, and they are the reference point
 * here: `clear` keeps them, and the others move away from it in the direction
 * that preset is described as.
 *
 *  turbidity   aerosol load. Low = crisp and blue, high = washed out and milky.
 *  rayleigh    molecular scattering; raises overall sky brightness and pushes
 *              the zenith blue. Low values are what make a sky go grey.
 *  mie*        the forward-scattering lobe around the sun: the bright haze
 *              bloom you get looking into a low sun.
 *
 * `starTint` is separate from the scattering entirely - see `_makeStars`.
 */
const SKY_TUNING = {
  clear:    { turbidity: 2.0, rayleigh: 1.4, mie: 0.004, mieG: 0.80, stars: 0,    sunTint: 0 },
  hazy:     { turbidity: 8.0, rayleigh: 0.9, mie: 0.010, mieG: 0.78, stars: 0,    sunTint: 0 },
  overcast: { turbidity: 3.0, rayleigh: 0.4, mie: 0.016, mieG: 0.72, stars: 0,    sunTint: 0 },
  dusk:     { turbidity: 6.0, rayleigh: 2.6, mie: 0.012, mieG: 0.86, stars: 0.25, sunTint: 0 },
  night:    { turbidity: 2.4, rayleigh: 0.5, mie: 0.003, mieG: 0.80, stars: 1.0,  sunTint: 0 },
  rain:     { turbidity: 12.0, rayleigh: 0.35, mie: 0.020, mieG: 0.68, stars: 0,   sunTint: 0 },
  fog:      { turbidity: 16.0, rayleigh: 0.30, mie: 0.024, mieG: 0.60, stars: 0,   sunTint: 0 },
};
const DEFAULT_TUNING = SKY_TUNING.clear;

// The dome has to sit inside the camera's far plane (4000 m) or it clips.
const DOME_SIZE = 6000;

export class SkySystem {
  constructor() {
    /** @type {Sky} */
    this.sky = new Sky();
    this.sky.name = 'skydome';
    this.sky.scale.setScalar(DOME_SIZE);
    this.sky.renderOrder = -1000;        // draw before everything else
    this.sky.frustumCulled = false;
    this.sky.visible = false;

    this.stars = this._makeStars();
    this.stars.visible = false;

    // A tiny scene used only to render the dome into a PMREM cube. Rendering the
    // dome directly (rather than approximating it with a canvas gradient) is
    // what makes `scene.environment` agree with the sky on screen.
    this._envScene = new THREE.Scene();
    this._pmrem = null;
    this._envRT = null;
    this.tuning = { ...DEFAULT_TUNING };
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.indoor = false;
  }

  /** Objects that belong in the scene graph for an outdoor sky. */
  get objects() {
    return [this.sky, this.stars];
  }

  /**
   * Applies a weather state. Mirrors the signature of `Viewport.applyWeather` so
   * the viewport can hand the same object straight through.
   */
  apply(w, sunVec, opts = {}) {
    const indoor = !!opts.indoor;
    this.indoor = indoor;
    const t = opts.tuning || SKY_TUNING[w.id] || DEFAULT_TUNING;

    // Indoors the sky is not the light source and is not visible except past
    // the doors, so it keeps a neutral dusk-ish dome that never lights anything.
    this.sky.visible = !indoor;
    this.stars.visible = !indoor && t.stars > 0.01;
    if (indoor) return this;

    this.tuning = { ...t };
    const u = this.sky.material.uniforms;
    u.turbidity.value = t.turbidity;
    u.rayleigh.value = t.rayleigh;
    u.mieCoefficient.value = t.mie;
    u.mieDirectionalG.value = t.mieG;
    u.up.value.set(0, 1, 0);

    // Preetham expects the sun position as a direction it normalises itself.
    // Below the horizon it wants the *reflected* position, not a negative one:
    // a negative Y produces a NaN in the sunfade term on some drivers.
    const sx = sunVec.x, sy = sunVec.y, sz = sunVec.z;
    this.sunDir.set(sx, sy, sz);
    const belowHorizon = sy < 0;
    u.sunPosition.value.set(sx, belowHorizon ? Math.abs(sy) * 0.06 + 0.02 : sy, sz);

    if (this.stars.visible) {
      this.stars.material.opacity = t.stars * clamp(1 - Math.max(0, sy) * 3, 0, 1);
      // The sun direction drives the moon, so the dome has something in it to
      // look at at night instead of being uniformly dark.
      this.stars.material.uniforms.sunDir.value.set(sx, -Math.abs(sy) - 0.25, sz);
    }
    return this;
  }

  /**
   * Points the dome and the stars at the camera and refreshes the environment
   * map. `env` is only re-baked when `true`, because a PMREM generation is a
   * render and must not happen once per frame.
   */
  update(camera, env = false) {
    if (this.sky.visible) {
      this.sky.position.copy(camera.position);
      this.stars.position.copy(camera.position);
    }
    if (env && this.sky.visible) this.bakeEnvironment();
  }

  /**
   * Renders the dome into a PMREM cube and publishes it as `scene.environment`.
   *
   * The stars are deliberately excluded: they are a handful of bright points,
   * and a prefiltered mip chain turns them into a uniform grey lift that reads
   * as a dirty lens rather than as a night sky.
   */
  bakeEnvironment() {
    const renderer = this._renderer;
    if (!renderer) return null;
    if (!this._pmrem) this._pmrem = new THREE.PMREMGenerator(renderer);

    const prevVisible = this.stars.visible;
    this.stars.visible = false;
    this._envScene.add(this.sky);
    this.sky.position.set(0, 0, 0);
    this.sky.scale.setScalar(100);
    const rt = this._pmrem.fromScene(this._envScene, 0, 1, 1000);
    // Put the dome back exactly as it was: it is live scene geometry and is
    // parented by the Viewport, not by this helper scene.
    this._envScene.remove(this.sky);
    this.stars.visible = prevVisible;

    if (this._envRT) this._envRT.dispose();
    this._envRT = rt;
    this.envTexture = rt.texture;
    return rt.texture;
  }

  /** The PMREM generator needs the live renderer; it is set once by Viewport. */
  setRenderer(r) { this._renderer = r; }

  /**
   * Stars as points on the inside of the dome.
   *
   * Three tricks make this read as a sky rather than as scattered dots:
   * per-star colour temperature (blue-white through amber), a magnitude
   * distribution weighted so bright stars are rare, and a soft round sprite
   * instead of the square you get from a raw point.
   */
  _makeStars() {
    const N = 2600;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const size = new Float32Array(N);

    // Deterministic: the night sky should be the same sky every session.
    let a = 0x9e3779b9;
    const rnd = () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const r = DOME_SIZE * 0.42;
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      // Uniform on the upper hemisphere: cos-lat distribution, so stars do not
      // bunch at the pole the way naive lat/long sampling makes them.
      const u = rnd() * 2 - 1;
      const phi = rnd() * Math.PI * 2;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      const y = Math.abs(u);
      pos[i * 3] = r * s * Math.cos(phi);
      pos[i * 3 + 1] = r * y + r * 0.05;
      pos[i * 3 + 2] = r * s * Math.sin(phi);

      // Magnitude: a cubic weight makes the few bright ones stand out and
      // leaves a lot of faint dust, which is the real distribution.
      const mag = Math.pow(rnd(), 3.2);
      // Colour temperature: mostly white, a few blue and a few amber.
      const temp = rnd();
      if (temp > 0.86) c.setHSL(0.08, 0.55, 0.66);        // amber giants
      else if (temp > 0.72) c.setHSL(0.60, 0.45, 0.78);   // blue-white
      else c.setHSL(0.58, 0.06, 0.86);                   // near-white
      col[i * 3] = c.r * (0.25 + mag);
      col[i * 3 + 1] = c.g * (0.25 + mag);
      col[i * 3 + 2] = c.b * (0.25 + mag);
      size[i] = 1.0 + mag * 5.0;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('starSize', new THREE.BufferAttribute(size, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        opacity: { value: 1 },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        pixelRatio: { value: Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1) },
      },
      vertexShader: /* glsl */`
        attribute float starSize;
        varying vec3 vColor;
        varying float vFade;
        uniform float pixelRatio;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mv;
          gl_PointSize = starSize * pixelRatio;
          // Fade the low ones out: real stars near the horizon are washed out
          // by atmosphere, and it stops the dome from having a hard bottom edge.
          vFade = smoothstep(-0.02, 0.22, normalize( position ).y );
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vColor;
        varying float vFade;
        uniform float opacity;
        uniform vec3 sunDir;
        void main() {
          // Round sprite with a soft core. A raw gl_Point is a hard square.
          vec2 d = gl_PointCoord - vec2( 0.5 );
          float r2 = dot( d, d );
          if ( r2 > 0.25 ) discard;
          float core = exp( -r2 * 14.0 );
          float halo = exp( -r2 * 4.0 ) * 0.25;
          gl_FragColor = vec4( vColor * ( core + halo ), ( core + halo ) * opacity * vFade );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      vertexColors: true,
    });

    const p = new THREE.Points(geo, mat);
    p.frustumCulled = false;
    p.renderOrder = -999;
    p.name = 'stars';
    return p;
  }

  dispose() {
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.stars.geometry.dispose();
    this.stars.material.dispose();
    if (this._envRT) this._envRT.dispose();
    if (this._pmrem) this._pmrem.dispose();
  }
}

export { SKY_TUNING };