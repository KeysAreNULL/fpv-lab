// Tiny DOM helpers. No framework: the UI is a handful of panels and a canvas,
// and a 3D renderer plus an 8 kHz physics loop does not want a virtual DOM
// competing for the main thread.

export function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (e) => { while (e && e.firstChild) e.removeChild(e.firstChild); return e; };

/** Labelled slider with a live numeric readout. */
export function sliderRow(label, { min, max, step = 1, value, unit = '', onInput, desc }) {
  const val = el('span', { class: 'val', text: fmtNum(value, step) + unit });
  const input = el('input', {
    type: 'range', min, max, step, value,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      val.textContent = fmtNum(v, step) + unit;
      onInput(v);
    },
  });
  const row = el('div', { class: 'cfg-row' }, [
    el('label', { class: 'lbl', text: label }), input, val,
  ]);
  row.setValue = (v) => { input.value = v; val.textContent = fmtNum(v, step) + unit; };
  if (desc) row.appendChild(el('div', { class: 'desc', text: desc }));
  return row;
}

export function fmtNum(v, step = 1) {
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return Number(v).toFixed(dec);
}

/** Select row. */
export function selectRow(label, options, value, onChange) {
  const sel = el('select', { onchange: (e) => onChange(e.target.value) },
    options.map((o) => el('option', {
      value: o.value, selected: String(o.value) === String(value),
    }, [o.label])));
  return el('div', { class: 'cfg-row' }, [el('label', { class: 'lbl', text: label }), sel, el('span')]);
}

/** Statistic row with optional bar and severity class. */
export function statRow(key, value, opts = {}) {
  const cls = `stat${opts.hero ? ' hero' : ''}${opts.level ? ' ' + opts.level : ''}`;
  const row = el('div', { class: cls }, [
    el('span', { class: 'k', text: key }),
    el('span', { class: 'v', text: value }),
  ]);
  if (opts.bar != null) {
    row.appendChild(el('div', { class: 'meter' }, [
      el('i', { style: { width: `${Math.max(0, Math.min(100, opts.bar))}%`,
        background: opts.barColor || 'var(--accent)' } }),
    ]));
  }
  return row;
}

export function segButtons(options, value, onChange) {
  const wrap = el('div', { class: 'seg' });
  const btns = options.map((o) => el('button', {
    class: o.value === value ? 'active' : '',
    text: o.label,
    onclick: () => {
      btns.forEach((b) => b.classList.remove('active'));
      btns[options.indexOf(o)].classList.add('active');
      onChange(o.value);
    },
  }));
  btns.forEach((b) => wrap.appendChild(b));
  wrap.setValue = (v) => btns.forEach((b, i) => b.classList.toggle('active', options[i].value === v));
  return wrap;
}

/** Canvas scope with a consistent look. */
export class Scope {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.bg = opts.bg || '#1a2029';
    this.grid = opts.grid || 'rgba(160,185,210,0.14)';
    this.axis = opts.axis || 'rgba(160,185,210,0.24)';
    this.pad = opts.pad || { l: 30, r: 6, t: 8, b: 14 };
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
  }
  begin() {
    const c = this.canvas;
    const w = c.clientWidth || 260, h = c.clientHeight || 150;
    const W = Math.round(w * this.dpr), H = Math.round(h * this.dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, w, h);
    return { ctx, w, h };
  }
  grid_(w, h, cols = 6, rows = 4) {
    const ctx = this.ctx;
    const { l, r, t, b } = this.pad;
    const gw = w - l - r, gh = h - t - b;
    ctx.strokeStyle = this.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= cols; i++) {
      const x = l + (gw * i) / cols;
      ctx.moveTo(x, t); ctx.lineTo(x, t + gh);
    }
    for (let i = 0; i <= rows; i++) {
      const y = t + (gh * i) / rows;
      ctx.moveTo(l, y); ctx.lineTo(l + gw, y);
    }
    ctx.stroke();
    return { l, t, gw, gh };
  }
  plot(series, opts = {}) {
    // series: [{data:[], color, width, fill}]
    const { w, h } = this.begin();
    const { l, t, gw, gh } = this.grid_(w, h, opts.cols || 6, opts.rows || 4);
    const ctx = this.ctx;
    let min = opts.min, max = opts.max;
    if (min == null || max == null) {
      min = Infinity; max = -Infinity;
      for (const s of series) {
        for (const v of s.data) { if (v < min) min = v; if (v > max) max = v; }
      }
      if (!Number.isFinite(min)) { min = -1; max = 1; }
      if (min === max) { min -= 1; max += 1; }
      const m = (max - min) * 0.12;
      min -= m; max += m;
    }
    // zero line
    if (min < 0 && max > 0) {
      const y = t + gh * (1 - (0 - min) / (max - min));
      ctx.strokeStyle = this.axis;
      ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + gw, y); ctx.stroke();
    }
    for (const s of series) {
      const n = s.data.length;
      if (!n) continue;
      const pts = new Array(n);
      for (let i = 0; i < n; i++) {
        pts[i] = {
          x: l + (gw * i) / Math.max(1, n - 1),
          y: t + gh * (1 - (s.data[i] - min) / (max - min)),
        };
      }
      if (s.fill) {
        // Shade to the zero line (or the floor) so overlapping traces stay legible.
        const base = Math.max(Math.min(0, max), Math.min(min, 0));
        const by = t + gh * (1 - (base - min) / (max - min));
        ctx.beginPath();
        ctx.moveTo(pts[0].x, by);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.lineTo(pts[n - 1].x, by);
        ctx.closePath();
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (s.dot) {
        const last = pts[n - 1];
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(last.x, last.y, 2, 0, 7); ctx.fill();
      }
    }
    ctx.fillStyle = 'rgba(140,160,180,0.75)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(opts.labelMax ?? max.toFixed(0), l - 4, t + 8);
    ctx.fillText(opts.labelMin ?? min.toFixed(0), l - 4, t + gh);
    if (opts.labels) {
      ctx.textAlign = 'left';
      let y = t + 8;
      for (const [name, color] of opts.labels) {
        ctx.fillStyle = color;
        ctx.fillRect(l + 4, y - 6, 8, 2);
        ctx.fillStyle = 'rgba(160,180,200,0.9)';
        ctx.fillText(name, l + 16, y);
        y += 11;
      }
    }
    ctx.textAlign = 'left';
  }
  drawBars(values, opts = {}) {
    const { w, h } = this.begin();
    const ctx = this.ctx;
    const { l, t, gw, gh } = this.grid_(w, h, 4, 2);
    const n = values.length;
    const bw = gw / Math.max(1, n);
    values.forEach((v, i) => {
      const x = l + i * bw;
      const f = Math.max(0, Math.min(1, v / (opts.max || 1)));
      const bh = gh * f;
      ctx.fillStyle = Array.isArray(opts.colors) ? opts.colors[i] : (opts.color || '#58b7e8');
      ctx.fillRect(x + 1, t + gh - bh, bw - 2, bh);
    });
    ctx.fillStyle = 'rgba(140,160,180,0.75)';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'right';
    // `opts.max` is already the top of the scale in real units (2000 for motor
    // output), so it is printed as-is. The *1000 here rendered "2000000".
    ctx.fillText(String(Math.round(opts.max || 1)), l - 4, t + 8);
    ctx.fillText('0', l - 4, t + gh);
    ctx.textAlign = 'left';
  }
}

/** Format helpers re-exported so views do not import math directly. */
export const fmt = {
  n: (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '--'),
  int: (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString() : '--'),
  timeMs(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '--.---';
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return m + ':' + s.toFixed(3).padStart(6, '0');
  },
  p: (v) => (Number.isFinite(v) ? v + '%' : '--'),
};

export function download(filename, text, type = 'text/csv') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
