// Betaflight rate profiles.
//
// Betaflight's Rates page has three profile types, and they are genuinely
// different formulas, not three presets of one curve. This module implements all
// three plus the shared deadzone handling, with no DOM so it can be tested
// headless.
//
// The previous `stickToRate` in fc.js was a hybrid: it read Betaflight's legacy
// `rcRate`/`expo` knobs and then applied a hand-rolled curve that matched
// neither of Betaflight's conventions. Anyone porting a tune from the configurator
// got numbers that meant something else.
//
// Reference (Betaflight `applyActualRates` / `applyBetaflightRates` / `applyKissRates`):
//
//   Actual:     rate = stick * centerSensitivity
//                  + sign(stick) * |stick|^actualExpo * (maxRate - centerSensitivity)
//   Betaflight: rate = stick * rcRate * centerSensitivity/100
//                  + sign(stick) * |stick|^expo * superRate
//   KISS:       rate = stick * centerRate + sign(stick) * |stick| * maxRate
//
// In every profile `actualExpo` is `10^(expo/100)`, so expo 0 is linear and
// expo 100 is an extremely flat centre. Stick is deadzone-normalised first, so
// the curve starts at exactly zero rate at the centre.

/** Profile types, in Betaflight's order. */
export const RATE_PROFILES = ['actual', 'betaflight', 'kiss'];

export const PROFILE_LABELS = {
  actual: 'Actual',
  betaflight: 'Betaflight',
  kiss: 'Kiss',
};

export const AXIS_KEYS = ['roll', 'pitch', 'yaw'];

/**
 * Per-axis defaults, in Betaflight's units: deg/s at centre, deg/s at full
 * stick, expo 0-100. Yaw is deliberately slower and flatter than roll/pitch,
 * which is how every real tune sets it up.
 *
 * The expo values matter more than they look. In the actual profile
 * `actualExpo = 10^(expo/100)`, so expo 40 is a 10^0.4 curve that gives 4 deg/s at
 * 10% stick - technically correct, practically unusable. Real tunes sit in the
 * 0-25 band, race tunes closest to 0.
 */
export const DEFAULT_RATE_AXES = {
  roll: { centerSensitivity: 90, maxRate: 900, expo: 12, rcRate: 280, superRate: 50, rcExpo: 70 },
  pitch: { centerSensitivity: 90, maxRate: 900, expo: 12, rcRate: 280, superRate: 50, rcExpo: 70 },
  yaw: { centerSensitivity: 70, maxRate: 640, expo: 10, rcRate: 240, superRate: 40, rcExpo: 70 },
};

export const DEFAULT_RATES = {
  type: 'actual',
  deadzone: 0.04,
  axes: DEFAULT_RATE_AXES,
};

/** A fresh, fully-populated rates config. */
export function defaultRates() {
  return JSON.parse(JSON.stringify(DEFAULT_RATES));
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/**
 * Betaflight's `applyDeadzoneRange`: scale the surviving travel back out to the
 * full 0..1 range so the stick still reaches max rate past the deadzone. The
 * 0.01 floor is Betaflight's: it stops the curve going singular at centre.
 */
export function applyDeadzone(stick, deadzone) {
  const dz = clamp(deadzone || 0, 0, 0.99);
  const s = clamp(stick, -1, 1);
  if (dz <= 0) return s;
  const a = Math.abs(s);
  if (a < dz) return 0;
  const sign = Math.sign(s);
  return sign * (a - dz) / (1 - dz);
}

const actualExpo = (expo) => Math.pow(10, clamp(expo || 0, 0, 100) / 100);

/** Betaflight "Actual" profile. */
export function actualRate(stick, { centerSensitivity, maxRate, expo } = {}) {
  const rc = clamp(stick, -1, 1);
  if (Math.abs(rc) < 1e-9) return 0;
  const cs = centerSensitivity ?? 50;
  const mr = maxRate ?? 850;
  const e = actualExpo(expo);
  const movement = Math.max(Math.abs(rc), 0.01);
  return rc * cs + Math.sign(rc) * Math.pow(movement, e) * (mr - cs);
}

/** Betaflight's own legacy rc-rate profile. */
export function betaflightRate(stick, { rcRate, superRate, expo, rcExpo } = {}) {
  const rc = clamp(stick, -1, 1);
  if (Math.abs(rc) < 1e-9) return 0;
  const a = Math.abs(rc);
  const sign = Math.sign(rc);
  const rr = rcRate ?? 280;
  const sr = superRate ?? 50;
  const e = actualExpo(expo);
  // rcExpo shapes the stick itself before the rate is derived from it.
  const expof = rc * (rcExpo ?? 70) + rc * (100 - (rcExpo ?? 70));
  const movement = Math.max(Math.abs(expof / 100), 0.01);
  return expof / 100 * rr + sign * Math.pow(movement, e) * sr;
}

/** KISS: the simplest of the three, no expo shaping at all. */
export function kissRate(stick, { rcRate, superRate } = {}) {
  const rc = clamp(stick, -1, 1);
  if (Math.abs(rc) < 1e-9) return 0;
  const movement = Math.max(Math.abs(rc), 0.01);
  return rc * (rcRate ?? 280) + Math.sign(rc) * movement * (superRate ?? 50);
}

/** Dispatch to the active profile for one axis. */
export function rateForAxis(stick, axisCfg = {}, type = 'actual') {
  switch (type) {
    case 'kiss': return kissRate(stick, axisCfg);
    case 'betaflight': return betaflightRate(stick, axisCfg);
    case 'actual':
    default: return actualRate(stick, axisCfg);
  }
}

/**
 * The full path a stick command takes: deadzone, then the active profile.
 * `axis` is 'roll' | 'pitch' | 'yaw'.
 */
export function stickToRate(stick, axis, rates = DEFAULT_RATES) {
  const cfg = (rates && rates.axes && rates.axes[axis]) || DEFAULT_RATE_AXES[axis];
  const type = (rates && rates.type) || 'actual';
  const dz = (rates && rates.deadzone) ?? 0.04;
  return rateForAxis(applyDeadzone(stick, dz), cfg, type);
}

/**
 * Sample the curve for plotting, over stick 0..1 on one side only (the curve is
 * symmetric, so plotting both sides is just a mirror).
 */
export function sampleCurve(axis, rates = DEFAULT_RATES, n = 64) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    out.push({ stick: s, rate: stickToRate(s, axis, rates) });
  }
  return out;
}

/**
 * Merge a stored/partial rates object onto the defaults. Old saves only have the
 * flat `rcRate`/`expo`/`centerSens`/`maxRate` knobs; those map onto roll and
 * pitch, which is what they used to drive.
 */
export function normaliseRates(stored, legacyTune) {
  const base = defaultRates();
  if (legacyTune) {
    // Carry the old flat fields onto roll and pitch so an existing tune does not
    // silently reset to defaults on upgrade.
    if (Number.isFinite(legacyTune.centerSens)) {
      base.axes.roll.centerSensitivity = legacyTune.centerSens;
      base.axes.pitch.centerSensitivity = legacyTune.centerSens;
    }
    if (Number.isFinite(legacyTune.maxRate)) {
      base.axes.roll.maxRate = legacyTune.maxRate;
      base.axes.pitch.maxRate = legacyTune.maxRate;
    }
    if (Number.isFinite(legacyTune.rcRate)) {
      base.axes.roll.rcRate = legacyTune.rcRate;
      base.axes.pitch.rcRate = legacyTune.rcRate;
    }
    if (Number.isFinite(legacyTune.expo)) {
      base.axes.roll.expo = legacyTune.expo;
      base.axes.pitch.expo = legacyTune.expo;
      base.axes.roll.rcExpo = legacyTune.expo;
      base.axes.pitch.rcExpo = legacyTune.expo;
    }
  }
  if (stored) {
    if (RATE_PROFILES.includes(stored.type)) base.type = stored.type;
    if (Number.isFinite(stored.deadzone)) base.deadzone = clamp(stored.deadzone, 0, 0.99);
    for (const a of AXIS_KEYS) {
      if (stored.axes && stored.axes[a]) base.axes[a] = { ...base.axes[a], ...stored.axes[a] };
    }
  }
  return base;
}