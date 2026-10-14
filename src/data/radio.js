// RF tables: band plans, digital channel maps, link budgets and obstruction materials.
//
// Frequencies are in MHz. Attenuation figures are dB referenced to 2.4 GHz and
// scaled with frequency at runtime (penetration loss grows roughly as f^0.35 for
// common building materials, which is why 900 MHz punches through concrete that
// stops 5.8 GHz dead).

/* ------------------------------------------------------- analog band plans */

export const ANALOG_BANDS = {
  A: { label: 'Band A (Boscam)', ch: [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725] },
  B: { label: 'Band B (FatShark)', ch: [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866] },
  E: { label: 'Band E (DJI)', ch: [5705, 5685, 5665, 5645, 5905, 5925, 5945, 5965] },
  F: { label: 'Band F (ImmersionRC)', ch: [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880] },
  L: { label: 'Band L (Low)', ch: [5645, 5665, 5685, 5705, 5725, 5745, 5765, 5785] },
  R: { label: 'Raceband 8', ch: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917] },
  U: { label: 'Band U (468)', ch: [4740, 4760, 4780, 4800, 4820, 4840, 4860, 4880] },
};

export const ANALOG_MW = [25, 200, 500, 1000];

/* ------------------------------------------------- digital channel mapping */

// HDZero: 90 channels. Raceband 8 map onto the low, tightly-spaced race channels.
export const HDZERO_BANDS = [
  { label: 'RB8', ch: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917] },
  { label: 'R36', ch: [5748, 5760, 5772, 5784, 5796, 5808, 5820, 5832, 5844, 5856, 5868, 5880,
                       5892, 5904, 5916, 5928, 5940, 5952] },
  { label: 'F25', ch: [5658, 5670, 5682, 5694, 5706, 5718, 5730, 5742, 5754, 5766, 5778, 5790,
                       5802, 5814, 5826, 5838, 5850, 5862, 5874, 5886, 5898, 5910, 5922, 5934, 5946] },
];
// DJI O3: 5.8 GHz race channels (8) plus a wide 2.4/5.8 auto list (60).
export const DJI_5G = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];
export const DJI_2G = [2405, 2408, 2411, 2414, 2417, 2420, 2423, 2426, 2429, 2432, 2435, 2438,
                       2441, 2444, 2447, 2450, 2453, 2456, 2459, 2462, 2465, 2468, 2471, 2474, 2477];

export const DIGITAL_SYSTEMS = {
  hdzero: {
    label: 'HDZero',
    count: 90,
    fixedPower: true,
    maxCh: 90,
    // Raceband channel numbers used by the timing system convention.
    raceCh: [1, 2, 3, 4, 5, 6, 7, 8],
    channelName(ch) {
      if (ch >= 1 && ch <= 8) return `RB8 / ch${ch} (${HDZERO_BANDS[0].ch[ch - 1]} MHz)`;
      if (ch <= 26) return `R36 / ch${ch}`;
      if (ch <= 51) return `F25 / ch${ch - 25}`;
      return `ch${ch}`;
    },
    freqOf(ch) {
      if (ch >= 1 && ch <= 8) return HDZERO_BANDS[0].ch[ch - 1];
      if (ch <= 26) return HDZERO_BANDS[1].ch[(ch - 1) % 18];
      return HDZERO_BANDS[2].ch[(ch - 26) % 25];
    },
  },
  dji: {
    label: 'DJI O3',
    count: 68,
    fixedPower: true,
    maxCh: 68,
    raceCh: [1, 2, 3, 4, 5, 6, 7, 8],
    channelName(ch) {
      if (ch <= 8) return `5.8 RB8 / ch${ch} (${DJI_5G[ch - 1]} MHz)`;
      if (ch <= 38) return `2.4 ch${ch - 8}`;
      return `5.8 ch${ch - 38}`;
    },
    freqOf(ch) {
      if (ch <= 8) return DJI_5G[ch - 1];
      if (ch <= 38) return DJI_2G[ch - 9];
      return DJI_5G[(ch - 39) % 8];
    },
  },
  walksnail: {
    label: 'Walksnail',
    count: 150,
    fixedPower: true,
    maxCh: 150,
    raceCh: [1, 2, 3, 4, 5, 6, 7, 8],
    channelName(ch) {
      if (ch <= 8) return `RB8 / ch${ch}`;
      return `ch${ch}`;
    },
    freqOf(ch) {
      if (ch <= 8) return DJI_5G[ch - 1];
      return 5658 + ((ch - 1) * 3.5) % 300;
    },
  },
};

/* --------------------------------------------------------- control protocols */

export const RC_SYSTEMS = {
  'elrs2': { label: 'ExpressLRS 2.4', freqMHz: 2400, txDbm: 20, sensDbm: -108, hopping: true,
             dutyOk: 0.999, note: 'Frequency-hopping 2.4 GHz. Very hard to knock out.' },
  'elrs900': { label: 'ExpressLRS 900', freqMHz: 900, txDbm: 20, sensDbm: -110, hopping: true,
             dutyOk: 0.999, note: 'Full-duplex 900 MHz. Long range and low latency.' },
  'crsf': { label: 'Crossfire', freqMHz: 868, txDbm: 20, sensDbm: -106, hopping: true,
             dutyOk: 0.998, note: '868/915 MHz. Enormous range and a long failsafe window.' },
  'ghost': { label: 'Ghost', freqMHz: 2400, txDbm: 21, sensDbm: -104, hopping: false,
             dutyOk: 0.997, note: 'Analog 2.4 GHz. Minimum latency, no frequency hopping.' },
  'wifi': { label: 'Wi-Fi (BF OSD)', freqMHz: 2437, txDbm: 17, sensDbm: -92, hopping: false,
             dutyOk: 0.99, note: 'Unencrypted telemetry link. Fine for tuning, not for racing.' },
};

/* ------------------------------------------------------ obstruction materials */

// att = dB through one layer at the 2.4 GHz reference. `t` = 0..1 transparency
// used for visualising the link, `scatter` = diffraction edge softness.
export const MATERIALS = {
  air:       { label: 'Air',              att2g: 0.0,  t: 1.00, scatter: 0 },
  drywall:   { label: 'Drywall / plaster',att2g: 2.5,  t: 0.82, scatter: 0.2 },
  glass:     { label: 'Glass window',     att2g: 3.2,  t: 0.78, scatter: 0.15 },
  wood:      { label: 'Wood siding',      att2g: 5.0,  t: 0.68, scatter: 0.4 },
  woodStud:  { label: 'Timber stud wall', att2g: 9.0,  t: 0.46, scatter: 0.5 },
  plywood:   { label: 'Plywood',         att2g: 4.5,  t: 0.72, scatter: 0.3 },
  brick:     { label: 'Brick',            att2g: 17.0, t: 0.24, scatter: 0.6 },
  concrete:  { label: 'Concrete',         att2g: 26.0, t: 0.11, scatter: 0.8 },
  reinforced:{ label: 'Reinforced conc.', att2g: 34.0, t: 0.06, scatter: 0.9 },
  metal:     { label: 'Metal / foil',     att2g: 62.0, t: 0.01, scatter: 1.0 },
  foliage:   { label: 'Foliage',          att2g: 12.0, t: 0.35, scatter: 0.7 },
  mesh:      { label: 'Chain-link / gate',att2g: 3.0,  t: 0.80, scatter: 0.9 },
  rubber:    { label: 'Tyre / mat',       att2g: 8.0,  t: 0.5,  scatter: 0.4 },
};

// Free-space path loss, dB. d in metres, f in MHz.
export function fsplDb(d, fMHz) {
  const dm = Math.max(0.15, d);
  return 32.44 + 20 * Math.log10(dm / 1000) + 20 * Math.log10(fMHz);
}

// Penetration loss through one material layer at an arbitrary frequency.
// Common building materials scale with frequency roughly as f^0.35; foil/metal
// is treated as frequency independent.
export function materialLossDb(material, fMHz) {
  const m = MATERIALS[material] || MATERIALS.drywall;
  if (m.att2g <= 0) return 0;
  if (material === 'metal' || material === 'mesh') return m.att2g;
  return m.att2g * Math.pow(Math.max(200, fMHz) / 2437, 0.35);
}

// Approximate ITU-R P.526 knife-edge diffraction loss for a single obstruction.
export function knifeEdgeLossDb(v) {
  if (v <= -0.78) return 0;
  if (v > 40) return 85;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) * (v - 0.1) + 1) + v - 0.1);
}

// Fresnel radius at distance d from a link of total length D.
export function fresnelRadius(d1, d2, fMHz) {
  // c = 299,792,458 m/s and fMHz is in MHz, so lambda = c / (fMHz * 1e6).
  // Dropping the 1e6 gave millimetres instead of metres, which made the Fresnel
  // radius ~1000x too small and quietly disabled the knife-edge obstruction test.
  const lambda = 299792458 / (fMHz * 1e6); // m
  return Math.sqrt((lambda * d1 * d2) / (d1 + d2));
}
