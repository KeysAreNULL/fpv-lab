// Battery model.
//
// A pack is `cells` series cells plus the wiring that joins them. Each cell
// carries its own state of charge, temperature and internal resistance, so the
// pack voltage is not just OCV: it sags under load, recovers with a two-pole
// polarisation lag, heats up, and pulls its weakest cell down first.
//
// Model stack, from slow to fast:
//   1. OCV(SOC)            per-chemistry discharge curve, evaluated by lookup
//   2. ESR(SOC, T, age)    ohmic part, rises at low SOC / low temp / with age
//   3. current-rate term   R_eff = R * (1 + k*I/Iref): diffusion + charge transfer
//   4. polarisation        two RC poles (bulk ~0.35 s, fast ~12 ms) so a punchout
//                          shows the real dip-then-partial-recovery shape
//   5. thermal             Joule heating with Newton cooling back to ambient
//   6. imbalance           per-cell OCV spread; a pack with no BMS diverges and
//                          eventually brings one cell under the cutoff
//   7. C-rate ceiling      beyond the rating the pack cannot source the current

import { clamp, curveEval, lerp, v3 } from '../core/math.js';

// OCV per cell, V vs state of charge (0..1).
const OCV = {
  'LiPo': [
    [0.000, 3.02], [0.010, 3.34], [0.030, 3.52], [0.060, 3.62], [0.120, 3.70],
    [0.250, 3.755], [0.400, 3.79], [0.550, 3.815], [0.700, 3.845], [0.850, 3.88],
    [1.000, 3.92],
  ],
  'Li-ion': [
    [0.000, 2.90], [0.010, 3.22], [0.030, 3.42], [0.060, 3.52], [0.120, 3.60],
    [0.250, 3.665], [0.400, 3.705], [0.550, 3.745], [0.700, 3.785], [0.850, 3.835],
    [1.000, 3.895],
  ],
};

// Per-cell internal resistance multiplier as SOC falls. A cell that is full
// looks resistant to charge but is not much worse under load than at mid SOC;
// a nearly-empty cell collapses, which is why LiPo sag explodes near cutoff.
const R_SOC = [
  [0.00, 3.6], [0.05, 1.95], [0.10, 1.42], [0.20, 1.14], [0.35, 1.00],
  [0.60, 0.97], [0.85, 1.00], [1.00, 1.06],
];

// Cutoff voltage per cell for the chemistry.
const CUTOFF = { 'LiPo': 3.50, 'Li-ion': 3.00 };

let uid = 0;

export class Battery {
  /**
   * @param {object} spec   catalog battery entry
   * @param {object} opts   { soc, tempC, cycles, condition } condition 0..1 (1 = new)
   */
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.id = ++uid;
    this.cells = spec.cells;
    this.chemistry = spec.chem;
    this.capacityAh = spec.capacity__mah / 1000;
    this.cRating = spec.cRating;
    this.maxCurrentA = this.capacityAh * this.cRating;
    this.cycleLife = spec.cycleLife;
    this.hasBMS = !!spec.internalBMS;
    this.balanceCurrentA = (spec.balance || 0) / 1000; // mA -> A
    this.nominalR = spec.Rcell__r / 1000;              // mOhm -> Ohm
    this.connResistance = (spec.chem === 'LiPo' ? 6 : 10) / 1000;

    this.condition = opts.condition != null ? clamp(opts.condition, 0.35, 1) : 1;
    const cycles = opts.cycles || 0;
    // Age: capacity fades, ESR climbs. Li-ion holds up far better.
    const fade = this.chemistry === 'Li-ion'
      ? Math.pow(cycles / this.cycleLife, 0.5) * 0.28
      : Math.pow(cycles / this.cycleLife, 0.85) * 0.45;
    this.ageFade = clamp(fade, 0, 0.7);
    this.usableAh = this.capacityAh * (1 - this.ageFade);

    // Cell states
    this.soc = opts.soc != null ? clamp(opts.soc, 0, 1) : 1.0;
    this.offsets = [];      // per-cell OCV offset (V), divergence accumulates
    this.cellTemp = [];     // per-cell temperature (C)
    this.spread = opts.spread != null ? opts.spread : 0.006; // initial imbalance
    for (let i = 0; i < this.cells; i++) {
      this.offsets.push((Math.random() * 2 - 1) * this.spread);
      this.cellTemp.push(opts.tempC != null ? opts.tempC : 24);
    }
    this.ambientC = opts.tempC != null ? opts.tempC : 24;

    // Polarisation states (V), per cell is overkill: track pack-level.
    this.vPol1 = 0; this.vPol2 = 0;
    this.currentA = 0;
    this.currentSmooth = 0;
    this.currentPeak = 0;
    this.voltage = spec.cells * this.ocvAvg();
    this.voltageSmooth = this.voltage;
    this.minCellV = this.voltage / this.cells;
    this.maxCellV = this.voltage / this.cells;
    this.tempAvg = this.ambientC;
    this.heatGain = 0;
    this.whUsed = 0;
    this.peakPowerW = 0;
    this.sagVolts = 0;
    this.crashed = false;      // pack is finished: SOC gone, or a cell dead
    this._underTime = 0;       // seconds spent below the cutoff voltage
    this.underVoltage = false; // momentary sag past cutoff (a punchout, not a fault)
    this.balanced = true;
    this.currentLimited = 0;   // 0..1, how much current the pack refused
    this.recovering = false;
  }

  get cutoffV() { return CUTOFF[this.chemistry] || 3.4; }
  get maxV() { return this.spec.maxV__v; }
  get minV() { return this.spec.minV__v; }

  ocvAt(soc) { return curveEval(OCV[this.chemistry] || OCV['LiPo'], clamp(soc, 0, 1)); }

  /** Internal resistance of one cell for the given SOC and temperature. */
  cellResistance(soc, tempC) {
    const r0 = this.nominalR * (1 + this.ageFade * 1.9);
    const socTerm = curveEval(R_SOC, clamp(soc, 0, 1));
    // Temperature: Li-ion resistance falls as it warms, but a very cold pack
    // is dramatically worse. Li-po rises slightly once hot.
    let tTerm;
    if (this.chemistry === 'Li-ion') {
      tTerm = 1 + 0.028 * Math.max(0, 12 - tempC) + 0.0016 * Math.max(0, tempC - 30);
    } else {
      tTerm = 1 + 0.030 * Math.max(0, 8 - tempC) + 0.0060 * Math.max(0, tempC - 45);
    }
    return r0 * socTerm * tTerm;
  }

  ocvAvg() {
    let s = 0;
    for (let i = 0; i < this.cells; i++) s += this.ocvAt(this.soc) + this.offsets[i];
    return s / this.cells;
  }

  /** Lowest cell terminal voltage under a given current (drives brownouts). */
  weakestCellUnder(currentA) {
    let worst = Infinity;
    const rPack = this.packResistance(currentA);
    const base = this.ocvAvg();
    for (let i = 0; i < this.cells; i++) {
      const v = base + this.offsets[i] - currentA * rPack;
      if (v < worst) worst = v;
    }
    return worst;
  }

  packResistance(currentA) {
    const rCell = this.cellResistance(this.soc, this.tempAvg);
    // Diffusion / charge-transfer: effective resistance creeps up with load.
    const k = this.chemistry === 'Li-ion' ? 0.16 : 0.10;
    const rate = 1 + k * clamp(Math.abs(currentA) / Math.max(1, this.maxCurrentA), 0, 2);
    return rCell * rate * this.cells + this.connResistance;
  }

  /**
   * Advance the pack by dt seconds drawing `currentA` (>0 = discharge).
   * Returns the instantaneous pack voltage.
   */
  step(dt, currentA) {
    const cLim = this.maxCurrentA;
    // Cells cannot source unlimited current: above the C rating the pack starts
    // refusing, which shows up as the voltage simply collapsing.
    let req = currentA;
    let refusal = 0;
    if (req > cLim) {
      refusal = (req - cLim) / Math.max(1, req);
      req = cLim;
    }
    this.currentLimited = refusal;
    this.currentA = currentA;

    // --- coulomb counting (charge per amp-second, minus a small self-discharge)
    const coulombs = currentA * dt;
    this.usableAh = Math.max(0.05, this.usableAh - (coulombs / 3600) * (1 + this.ageFade * 0.4));
    this.soc = clamp(this.usableAh / this.capacityAh, 0, 1);
    this.whUsed += currentA * this.voltage * dt / 3600;

    const rPack = this.packResistance(req);

    // --- polarisation: two poles, fast then slow
    const iBulk = req * 20e-6;    // ~20 mV under 1 A of bulk response
    const iFast = req * 240e-6;
    this.vPol1 = lagState(this.vPol1, iBulk, 0.35, dt);
    this.vPol2 = lagState(this.vPol2, iFast, 0.012, dt);

    // --- terminal voltage
    const ocv = this.ocvAvg();
    const v = ocv * this.cells - req * rPack - this.vPol1 * this.cells - this.vPol2 * this.cells;
    this.voltage = v;
    this.sagVolts = ocv * this.cells - v;
    this.voltageSmooth = lerp(this.voltageSmooth, v, clamp(dt * 40, 0, 1));
    this.peakPowerW = Math.max(this.peakPowerW, req * v);

    // --- weakest cell (with the imbalance offsets)
    const minR = rPack;
    const minOcv = ocv - Math.max(...this.offsets.map(Math.abs));
    this.minCellV = minOcv - req * minR;
    this.maxCellV = ocv + Math.max(...this.offsets.map(Math.abs)) - req * minR;

    // --- thermals per cell
    const heat = req * req * minR;               // W of loss in one cell
    const heatCap = this.chemistry === 'Li-ion' ? 46 : 30;   // J/K-ish lumped
    const coolTau = this.chemistry === 'Li-ion' ? 95 : 55;   // s to ambient
    for (let i = 0; i < this.cells; i++) {
      const dT = (heat / heatCap) * dt - ((this.cellTemp[i] - this.ambientC) / coolTau) * dt;
      this.cellTemp[i] += dT;
    }
    this.tempAvg = this.cellTemp.reduce((a, b) => a + b, 0) / this.cells;
    this.heatGain = this.tempAvg - this.ambientC;

    // --- imbalance divergence: BMS balance current pulls stragglers back,
    // otherwise cells drift apart as they age at different rates.
    if (this.hasBMS && this.balanceCurrentA > 0) {
      const pull = this.balanceCurrentA / (this.capacityAh * 24);
      for (let i = 0; i < this.cells; i++) this.offsets[i] *= (1 - pull * dt * 10);
    } else {
      const wander = 0.0016 * dt * (0.3 + this.ageFade * 3);
      for (let i = 0; i < this.cells; i++) {
        this.offsets[i] += (Math.random() * 2 - 1) * wander;
      }
    }
    const spread = Math.max(...this.offsets) - Math.min(...this.offsets);
    this.balanced = spread < 0.09;

    // --- failure checks.
    // A hard punch sags a healthy pack below its cutoff for a moment; that is
    // not a dead pack. Only a sustained undervoltage or an exhausted pack is.
    if (this.minCellV < this.cutoffV) this._underTime += dt; else this._underTime = 0;
    this.underVoltage = this._underTime > 0.25;
    this.crashed = this.soc <= 0.005 || (this._underTime > 4.0 && !this.hasBMS);
    this.recovering = this.soc < 0.18 && !this.crashed;

    // --- smoothed / peak current for the HUD
    this.currentSmooth = lerp(this.currentSmooth, currentA, clamp(dt * 12, 0, 1));
    const inst = Math.abs(currentA);
    this.currentPeak = inst > this.currentPeak ? inst : this.currentPeak * Math.exp(-dt * 0.8);
    return v;
  }

  /** Total pack capacity in Wh at full charge, accounting for age. */
  get ratedWh() { return this.capacityAh * this.cells * 3.7; }
  get remainingWh() { return this.usableAh * this.cells * this.ocvAt(this.soc); }

  /** Estimated flight time at a given current draw (crude, but honest). */
  timeLeftAt(currentA) {
    const usableA = this.usableAh * 0.92; // leave a little reserve
    return currentA > 1 ? (usableA / currentA) * 3600 : Infinity;
  }

  snapshot() {
    return {
      soc: this.soc, temp: this.tempAvg, cycles: this.cyclesUsed || 0,
      condition: this.condition,
    };
  }
}

function lagState(cur, target, tau, dt) {
  if (tau <= 0) return target;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

/**
 * Estimate flight time for a typical flight mix. Deliberately simple, but honest:
 * hover current sets the floor and throttle punches add on top, and the result is
 * the honest consequence of the pack's rated energy.
 */
export function estimateFlightTime(craft, { duty = 0.55, aggression = 0.7, avgV = 4 * 3.8, hoverA = null } = {}) {
  const pack = craft.battery;
  if (!pack) return { time: 0, avgCurrent: 0, powerW: 0 };
  // Pack-avg current: hover sets the floor, throttle punches add on top.
  const iHover = hoverA != null ? hoverA : (craft.hoverCurrentA || 0);
  const iPunch = Math.max(0, (craft.maxCurrentA || 0) * 0.42);
  const iAvg = iHover + (iPunch - iHover) * aggression * duty;
  const packV = pack.cells * avgV;
  const energyWh = pack.ratedWh * 0.92;   // do not fly into the last 8 %
  const powerW = Math.max(0, iAvg * packV);
  const time = powerW > 0 ? (energyWh / powerW) * 60 : 0;
  return { time, avgCurrent: iAvg, powerW };
}
