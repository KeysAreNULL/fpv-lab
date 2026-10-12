// Blackbox / telemetry recorder.
//
// Records at a fixed rate into preallocated ring buffers so a long flight does
// not thrash the garbage collector, and can dump a CSV that looks like a real
// blackbox log: gyro, setpoint, PID terms, motor outputs, RPM, voltage and
// current. That is the file you would actually load into a blackbox viewer to
// work out why a tune is oscillating, so it is worth having.

const FIELDS = [
  'time',
  'gyroRoll', 'gyroPitch', 'gyroYaw',
  'setRoll', 'setPitch', 'setYaw',
  'pRoll', 'pPitch', 'pYaw',
  'iRoll', 'iPitch', 'iYaw',
  'dRoll', 'dPitch', 'dYaw',
  'fRoll', 'fPitch', 'fYaw',
  'throttle',
  'm0', 'm1', 'm2', 'm3',
  'rpm0', 'rpm1', 'rpm2', 'rpm3',
  'voltage', 'current', 'thrust',
  'alt', 'speed',
  'vtxRSSI', 'vtxQual', 'rcLQ',
];

export class Telemetry {
  constructor(seconds = 120, rateHz = 1000, extraFields = []) {
    this.rate = rateHz;
    this.fields = FIELDS.concat(extraFields);
    this.n = this.fields.length;
    this.cap = Math.max(1024, Math.round(seconds * rateHz));
    this.buf = new Float32Array(this.cap * this.n);
    this.head = 0;
    this.count = 0;
    this.acc = 0;
    this.enabled = true;
    this.t0 = 0;
    // Column indices, including any caller-supplied extras.
    this.index = {};
    this.fields.forEach((f, i) => { this.index[f] = i; });
  }

  get dropped() { return this.count >= this.cap; }

  /** Call every physics tick; stores at `rate`. */
  sample(dt, craft, extra) {
    if (!this.enabled) return;
    this.acc += dt;
    const period = 1 / this.rate;
    if (this.acc < period) return;
    this.acc -= period;
    if (this.acc > period * 8) this.acc = 0;   // do not try to catch up after a stall

    const fc = craft.fc;
    const b = craft.body;
    const idx = this.index;
    const vals = SCRATCH;
    for (let f = 0; f < this.n; f++) vals[f] = 0;
    vals[idx.time] = (performance.now() - this.t0) / 1000;
    vals[idx.gyroRoll] = fc.gyro.x; vals[idx.gyroPitch] = fc.gyro.y; vals[idx.gyroYaw] = fc.gyro.z;
    vals[idx.setRoll] = fc.setpoint.x; vals[idx.setPitch] = fc.setpoint.y; vals[idx.setYaw] = fc.setpoint.z;
    vals[idx.pRoll] = fc.axis[0].pTerm; vals[idx.pPitch] = fc.axis[1].pTerm; vals[idx.pYaw] = fc.axis[2].pTerm;
    vals[idx.iRoll] = fc.axis[0].iOut; vals[idx.iPitch] = fc.axis[1].iOut; vals[idx.iYaw] = fc.axis[2].iOut;
    vals[idx.dRoll] = fc.axis[0].dOut; vals[idx.dPitch] = fc.axis[1].dOut; vals[idx.dYaw] = fc.axis[2].dOut;
    vals[idx.fRoll] = fc.axis[0].fOut; vals[idx.fPitch] = fc.axis[1].fOut; vals[idx.fYaw] = fc.axis[2].fOut;
    vals[idx.throttle] = fc.throttleOut;
    for (let i = 0; i < 4; i++) {
      vals[idx.m0 + i] = fc.motors[i];
      vals[idx.rpm0 + i] = craft.motors[i].RPM;
    }
    vals[idx.voltage] = craft.battery.voltage;
    vals[idx.current] = craft.currentA;
    vals[idx.thrust] = craft.thrust;
    vals[idx.alt] = b.pos.y;
    vals[idx.speed] = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    if (extra) {
      for (const k in extra) {
        if (idx[k] != null) vals[idx[k]] = extra[k];
      }
    }
    this.buf.set(vals, this.head * this.n);
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
  }

  start(now = performance.now()) { this.t0 = now; this.head = 0; this.count = 0; this.acc = 0; }

  /** CSV in chronological order, oldest first. */
  toCSV() {
    const rows = [];
    const start = this.count < this.cap ? 0 : this.head;
    for (let k = 0; k < this.count; k++) {
      const i = (start + k) % this.cap;
      const row = [];
      for (let f = 0; f < this.n; f++) {
        const v = this.buf[i * this.n + f];
        row.push(Number.isFinite(v) ? (Math.abs(v) < 1e-4 ? '0' : v.toFixed(3)) : '0');
      }
      rows.push(row.join(','));
    }
    return this.fields.join(',') + '\n' + rows.join('\n');
  }

  /** Column extraction in chronological order, for the on-screen graphs. */
  column(name, max = 4096) {
    const f = this.fields.indexOf(name);
    if (f < 0) return [];
    const out = [];
    const start = this.count < this.cap ? 0 : this.head;
    for (let k = 0; k < this.count; k++) {
      const i = (start + k) % this.cap;
      out.push(this.buf[i * this.n + f]);
    }
    return out.length > max ? out.slice(out.length - max) : out;
  }
}

// Cache field indices once.
const SCRATCH = new Float64Array(64);

/* ------------------------------------------------------------------ graphs */

/** Rolling time-series buffer for the HUD strips (no CSV needed). */
export class Trace {
  constructor(n = 240) {
    this.n = n;
    this.data = new Float32Array(n);
    this.i = 0;
    this.filled = 0;
  }
  push(v) {
    this.data[this.i] = v;
    this.i = (this.i + 1) % this.n;
    if (this.filled < this.n) this.filled++;
  }
  /** Oldest-to-newest view. */
  forEach(fn) {
    const start = this.filled < this.n ? 0 : this.i;
    for (let k = 0; k < this.filled; k++) fn(this.data[(start + k) % this.n], k);
  }
  get last() { return this.filled ? this.data[(this.i - 1 + this.n) % this.n] : 0; }
  get max() {
    let m = -Infinity;
    for (let k = 0; k < this.filled; k++) m = Math.max(m, this.data[k]);
    return m;
  }
  get min() {
    let m = Infinity;
    for (let k = 0; k < this.filled; k++) m = Math.min(m, this.data[k]);
    return m;
  }
  avg() {
    if (!this.filled) return 0;
    let s = 0;
    for (let k = 0; k < this.filled; k++) s += this.data[k];
    return s / this.filled;
  }
  clear() { this.i = 0; this.filled = 0; this.data.fill(0); }
}

/** Bundle of HUD traces. */
export function makeTraces(n = 200) {
  return {
    throttle: new Trace(n), current: new Trace(n), voltage: new Trace(n), sag: new Trace(n),
    rpm: new Trace(n), gyroRoll: new Trace(n), gyroPitch: new Trace(n), gyroYaw: new Trace(n),
    setRoll: new Trace(n), setPitch: new Trace(n), setYaw: new Trace(n),
    speed: new Trace(n), alt: new Trace(n), thrust: new Trace(n),
    vtxQual: new Trace(n), rcLQ: new Trace(n), wash: new Trace(n),
  };
}
