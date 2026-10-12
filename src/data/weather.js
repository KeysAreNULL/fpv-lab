// Weather and lighting.
//
// A track says where it is; this says what the sky is doing there. Each preset
// is a complete lighting state - sun angle and colour, sky gradient, ambient
// fill, fog density and tone-mapping exposure - so switching weather changes the
// whole mood at once instead of one light at a time.
//
// Sun position is given as elevation above the horizon and compass bearing, not
// as a raw direction vector, because that is how you actually reason about it:
// "low sun in the west" is a lighting instruction, [0.4, 0.2, -0.9] is not.

const D2R = Math.PI / 180;

/**
 * @typedef {object} Weather
 * @property {string} label
 * @property {number} sunElev   degrees above the horizon
 * @property {number} sunAzim   degrees clockwise from north
 * @property {number} sunI      sun intensity
 * @property {number} sunColor  hex
 * @property {string} skyTop    hex, zenith
 * @property {string} skyHorizon hex, at the horizon
 * @property {number} hemiI     sky/ground bounce intensity
 * @property {number} groundBounce hex
 * @property {number} ambient   flat ambient floor, so nothing is ever pure black
 * @property {number} fogDensity FogExp2 density. 0 disables fog.
 * @property {string} fogColor  hex
 * @property {number} exposure  tone-mapping exposure
 * @property {number} rain      0..1 precipitation
 * @property {number} wind      m/s
 * @property {number} turb      turbulence multiplier handed to the sim
 */

/** @type {Record<string, Weather>} */
export const WEATHER = {
  clear: {
    label: 'Clear',
    sunElev: 58, sunAzim: 135, sunI: 3.1, sunColor: 0xfff4e2,
    skyTop: 0x3d78c8, skyHorizon: 0xa8c8e8,
    hemiI: 1.15, groundBounce: 0x6a6252, ambient: 0.32,
    fogDensity: 0.0016, fogColor: 0xc4d8ea, exposure: 1.05,
    rain: 0, wind: 2.5, turb: 0.35,
  },
  hazy: {
    label: 'Hazy',
    sunElev: 46, sunAzim: 120, sunI: 2.5, sunColor: 0xfff0d4,
    skyTop: 0x8aa4c0, skyHorizon: 0xd8d2c0,
    hemiI: 1.05, groundBounce: 0x7a7060, ambient: 0.42,
    fogDensity: 0.006, fogColor: 0xd0ccbc, exposure: 1.0,
    rain: 0, wind: 1.5, turb: 0.3,
  },
  overcast: {
    label: 'Overcast',
    sunElev: 70, sunAzim: 200, sunI: 0.85, sunColor: 0xdfe4ea,
    skyTop: 0x7e8c9c, skyHorizon: 0xb4bcc4,
    hemiI: 1.35, groundBounce: 0x5e6068, ambient: 0.62,
    fogDensity: 0.004, fogColor: 0xa8b2bc, exposure: 1.12,
    rain: 0, wind: 5.0, turb: 0.55,
  },
  dusk: {
    label: 'Dusk',
    sunElev: 4, sunAzim: 255, sunI: 2.0, sunColor: 0xffb264,
    skyTop: 0x2a3a68, skyHorizon: 0xe08a4c,
    hemiI: 0.75, groundBounce: 0x4a3c30, ambient: 0.3,
    fogDensity: 0.005, fogColor: 0xa07050, exposure: 1.15,
    rain: 0, wind: 3.0, turb: 0.4,
  },
  night: {
    label: 'Night',
    sunElev: 34, sunAzim: 300, sunI: 0.28, sunColor: 0x9fb4d8,
    skyTop: 0x0a1020, skyHorizon: 0x1c2438,
    hemiI: 0.4, groundBounce: 0x1a1e26, ambient: 0.2,
    fogDensity: 0.004, fogColor: 0x141a26, exposure: 1.3,
    rain: 0, wind: 2.0, turb: 0.35,
  },
  rain: {
    label: 'Rain',
    sunElev: 62, sunAzim: 190, sunI: 0.55, sunColor: 0xc8d2dc,
    skyTop: 0x4a5560, skyHorizon: 0x76808a,
    hemiI: 0.95, groundBounce: 0x4c5258, ambient: 0.55,
    fogDensity: 0.011, fogColor: 0x8a949e, exposure: 1.18,
    rain: 0.75, wind: 7.5, turb: 0.95,
  },
  fog: {
    label: 'Fog',
    sunElev: 40, sunAzim: 150, sunI: 1.1, sunColor: 0xe8e4dc,
    skyTop: 0x9aa4ac, skyHorizon: 0xd0d4d6,
    hemiI: 1.25, groundBounce: 0x787c80, ambient: 0.7,
    fogDensity: 0.03, fogColor: 0xc8ccd0, exposure: 1.1,
    rain: 0.05, wind: 1.0, turb: 0.3,
  },
};

export const WEATHER_ORDER = ['clear', 'hazy', 'overcast', 'dusk', 'night', 'rain', 'fog'];

export function getWeather(id) {
  return WEATHER[id] || WEATHER.clear;
}

/**
 * Unit vector from elevation/azimuth in degrees. Bearing 0 = north (-Z), 90 =
 * east (+X), matching the world frame used by the renderer.
 */
export function sunVector(w, out = {}) {
  const e = w.sunElev * D2R, a = w.sunAzim * D2R;
  const h = Math.cos(e);
  out.x = h * Math.sin(a);
  out.y = Math.sin(e);
  out.z = -h * Math.cos(a);
  return out;
}

/** Mixes two weather states. Used for smooth transitions, not just cuts. */
export function blendWeather(a, b, t, out = {}) {
  const lerp = (x, y) => x + (y - x) * t;
  const mixHex = (x, y) => {
    const ar = (x >> 16) & 255, ag = (x >> 8) & 255, ab = x & 255;
    const br = (y >> 16) & 255, bg = (y >> 8) & 255, bb = y & 255;
    return (Math.round(lerp(ar, br)) << 16) | (Math.round(lerp(ag, bg)) << 8)
      | Math.round(lerp(ab, bb));
  };
  out.label = t < 0.5 ? a.label : b.label;
  out.sunElev = lerp(a.sunElev, b.sunElev);
  out.sunAzim = lerp(a.sunAzim, b.sunAzim);
  out.sunI = lerp(a.sunI, b.sunI);
  out.sunColor = mixHex(a.sunColor, b.sunColor);
  out.skyTop = mixHex(a.skyTop, b.skyTop);
  out.skyHorizon = mixHex(a.skyHorizon, b.skyHorizon);
  out.hemiI = lerp(a.hemiI, b.hemiI);
  out.groundBounce = mixHex(a.groundBounce, b.groundBounce);
  out.ambient = lerp(a.ambient, b.ambient);
  out.fogDensity = lerp(a.fogDensity, b.fogDensity);
  out.fogColor = mixHex(a.fogColor, b.fogColor);
  out.exposure = lerp(a.exposure, b.exposure);
  out.rain = lerp(a.rain, b.rain);
  out.wind = lerp(a.wind, b.wind);
  out.turb = lerp(a.turb, b.turb);
  return out;
}
