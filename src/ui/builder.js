// Builder view: part chooser, per-part configuration, and the predicted numbers.
//
// The stats here are not estimates bolted on afterwards: they come out of the
// same static analysis the simulator uses, so what the builder promises is what
// the craft actually does when you fly it.

import { el, clear, sliderRow, selectRow, statRow, fmt } from './dom.js';
import {
  CATEGORIES, DATA, TIERS, getPart, partPrice, buildCost, framePropClass, listParts,
} from '../data/catalog.js';
import { analyseBuild } from '../sim/craft.js';
import { Prop } from '../sim/prop.js';

export class BuilderView {
  constructor(root, app) {
    this.app = app;
    this.catRail = root.querySelector('#builder-cats');
    this.partsEl = root.querySelector('#parts');
    this.configEl = root.querySelector('#config');
    this.statsEl = root.querySelector('#stats');
    this.warnEl = root.querySelector('#warnings');
    this.hintEl = root.querySelector('#builder-hint');
    this.category = 'frame';
    this.buildCatRail();
  }

  buildCatRail() {
    clear(this.catRail);
    const box = el('div', { class: 'panel' });
    box.appendChild(el('div', { class: 'panel-head' }, [el('h2', { text: 'Category' })]));
    const list = el('div', { class: 'list' });
    this.catButtons = CATEGORIES.map((c) => el('button', {
      class: c.id === this.category ? 'sel' : '',
      onclick: () => { this.category = c.id; this.render(); },
    }, [
      el('span', { class: 'pn', text: c.label }),
      el('span', { class: 'pb', text: `${listParts(c.id).length} options` }),
    ]));
    this.catButtons.forEach((b) => list.appendChild(b));
    box.appendChild(list);
    this.catRail.appendChild(box);

    const sel = el('div', { class: 'panel' });
    sel.appendChild(el('div', { class: 'panel-head' }, [el('h2', { text: 'Build' })]));
    const nameIn = el('input', {
      type: 'text', value: this.app.buildName, style: { width: '100%' },
      oninput: (e) => { this.app.buildName = e.target.value; this.app.persist(); },
    });
    sel.appendChild(el('div', { class: 'cfg-row' }, [el('label', { class: 'lbl', text: 'Name' }), nameIn, el('span')]));
    const presets = el('div', { class: 'list', style: { marginTop: '8px' } });
    for (const p of PRESETS) {
      presets.appendChild(el('button', {
        onclick: () => { this.app.setSpec({ ...p.spec }); },
      }, [
        el('span', { class: 'pn', text: p.name }),
        el('span', { class: 'pb', text: p.note }),
      ]));
    }
    sel.appendChild(el('div', { class: 'lbl', style: { margin: '10px 0 5px' }, text: 'Presets' }));
    sel.appendChild(presets);
    this.catRail.appendChild(sel);
  }

  render() {
    this.catButtons.forEach((b, i) => b.classList.toggle('sel', CATEGORIES[i].id === this.category));
    const cat = this.category;
    const spec = this.app.spec;
    const parts = listParts(cat);
    const selectedId = spec[cat];
    const selected = getPart(cat, selectedId);

    this.hintEl.textContent = `${parts.length} ${CATEGORIES.find((c) => c.id === cat).label.toLowerCase()} options`;
    clear(this.partsEl);
    for (const p of parts) {
      const fits = this.fits(cat, p);
      const card = el('button', {
        class: `part${p.id === selectedId ? ' sel' : ''}${fits ? '' : ' dim'}`,
        onclick: () => { this.app.setSpec({ [cat]: p.id }); },
      }, [
        el('span', { class: 'pt', text: TIERS[p.tier || 0] }),
        el('span', { class: 'pn', text: p.name }),
        el('span', { class: 'pb', text: `${p.brand} · ${this.subtitle(cat, p)}` }),
        el('span', { class: 'ps', text: `$${partPrice(cat, p.id)}` }),
      ]);
      this.partsEl.appendChild(card);
    }

    this.renderConfig(cat, selected);
    this.renderStats();
  }

  /** Rough compatibility so obviously wrong combinations are visible immediately. */
  fits(cat, p) {
    const s = this.app.spec;
    if (cat === 'motor') return p.mount === getPart('frame', s.frame).motorMount;
    if (cat === 'prop') return p.D__mm <= getPart('frame', s.frame).propMax__mm;
    if (cat === 'esc') {
      const cells = getPart('battery', s.battery).cells;
      return cells >= p.vMin && cells <= p.vMax;
    }
    if (cat === 'battery') {
      const e = getPart('esc', s.esc);
      return s.cells ? true : (p.cells >= e.vMin && p.cells <= e.vMax);
    }
    if (cat === 'frame') {
      const prop = getPart('prop', s.prop);
      return prop.D__mm <= p.propMax__mm;
    }
    return true;
  }

  subtitle(cat, p) {
    switch (cat) {
      case 'frame': return `${p.wheelbase__mm} mm · ${p.propMax__mm} mm props`;
      case 'motor': return `${p.stator} mm · ${p.kv.join('/')} KV`;
      case 'prop': return `${p.blades} blade · ${p.mat}`;
      case 'esc': return `${p.maxContA} A · ${p.vMin}-${p.vMax}S · ${p.protocol}`;
      case 'fc': return `${p.mcu} · ${p.gyro}`;
      case 'rx': return `${p.rateHz} Hz · ${p.latencyMs} ms`;
      case 'vtx': return `${p.system} · ${p.powerMw} mW`;
      case 'battery': return `${p.cells}S ${p.capacity__mah} mAh ${p.cRating}C · ${p.chem}`;
      default: return '';
    }
  }

  renderConfig(cat, p) {
    clear(this.configEl);
    const box = el('div');
    const app = this.app;
    const spec = this.app.spec;

    const note = (t) => box.appendChild(el('div', { class: 'desc', style: { marginLeft: 0 }, text: t }));
    note(p.notes || '');

    if (cat === 'motor') {
      box.appendChild(selectRow('KV variant', p.kv.map((k) => ({ value: String(k), label: `${k} KV` })),
        String(p.kv[spec.motorKvIndex || 0]), (v) => app.setSpec({ motorKvIndex: p.kv.indexOf(Number(v)) })));
      box.appendChild(el('div', { class: 'desc', text:
        `Phase resistance ${p.Rm__r} mΩ at ${p.kv[0]} KV (scaled per winding), `
        + `polar inertia ${(p.J__J * 1e6).toFixed(2)} g·cm². Rotor inertia is what couples `
        + `throttle punches into the airframe through the gyros.` }));
    }
    if (cat === 'battery') {
      box.appendChild(sliderRow('Cycles', {
        min: 0, max: Math.max(1, p.cycleLife), step: 1, value: spec.cycles || 0,
        onInput: (v) => app.setSpec({ cycles: v }),
        desc: `Capacity fade and internal-resistance growth with age. `
          + `Li-po dies at ${p.cycleLife} cycles, Li-ion at ${p.cycleLife}.`,
      }));
      box.appendChild(el('div', { class: 'desc', text:
        `${p.chem}: ${p.Rcell__r} mΩ per cell (${(p.Rcell__r * p.cells / 1000).toFixed(3)} Ω for the pack), `
        + `${p.cRating} C = ${((p.capacity__mah / 1000) * p.cRating).toFixed(0)} A. `
        + (p.internalBMS ? 'Has a BMS with cell balancing.' : 'No BMS: cells will diverge under load.') }));
    }
    if (cat === 'vtx') {
      box.appendChild(el('div', { class: 'desc', text:
        `${p.system} · ${p.fov__deg}° lens · ${p.latencyBaseMs} ms pipeline. `
        + (p.system === 'digital' ? 'Digital holds a clean image then falls off a cliff.' : 'Analog degrades gradually into snow.') }));
    }
    if (cat === 'frame') {
      box.appendChild(el('div', { class: 'desc', text:
        `Wheelbase ${p.wheelbase__mm} mm, plates ${p.plateArea__cm2} cm², `
        + `${p.material}, camera tilt ${p.camTilt__deg}°. Best prop: ${framePropClass(p)}.` }));
    }
    this.configEl.appendChild(box);
  }

  renderStats() {
    const spec = this.app.spec;
    let a;
    try {
      a = analyseBuild(spec, { density: this.app.env.density });
    } catch (e) {
      clear(this.statsEl).appendChild(el('div', { class: 'warn-row error', text: 'Analysis failed: ' + e.message }));
      return;
    }
    this.lastAnalysis = a;
    const g = this.app.env.density;
    const tw = a.thrustRatio;
    const twLevel = tw < 2.2 ? 'warn' : tw > 12 ? 'warn' : 'good';

    clear(this.statsEl);
    this.statsEl.append(
      statRow('All-up weight', `${(a.mass * 1000).toFixed(0)} g`, { hero: true }),
      statRow('Thrust : weight', `${tw.toFixed(2)} : 1`, {
        level: twLevel,
        bar: Math.min(100, (tw / 12) * 100),
        barColor: tw < 2.2 || tw > 12 ? 'var(--warn)' : 'var(--accent-2)',
      }),
      statRow('Hover throttle', `${(a.hoverThrottle * 100).toFixed(1)} %`, {
        level: a.hoverThrottle < 0.14 || a.hoverThrottle > 0.62 ? 'warn' : 'good',
        desc: '',
      }),
      statRow('Hover current', `${a.hoverCurrent.toFixed(1)} A`),
      statRow('Hover power', `${a.hoverPowerW.toFixed(0)} W`),
      statRow('Thrust / watt', `${a.gPerW.toFixed(2)} g/W`, {
        level: a.gPerW < 1.4 ? 'warn' : a.gPerW > 2.6 ? 'good' : '',
      }),
      statRow('Full-throttle current', `${a.maxCurrent.toFixed(0)} A`, {
        level: a.maxCurrent > a.maxCurrent * 0 + 200 ? '' : '',
      }),
      statRow('Pack energy', `${a.packWh.toFixed(1)} Wh`),
      statRow('Flight time (mixed)', this.fmtTime(a.mixTime), { hero: true }),
      statRow('Motor rpm (hover)', `${(a.hoverRPM[0] / 1000).toFixed(1)} k`),
      statRow('Prop tip speed', `${a.propTipSpeed[0].toFixed(0)} m/s`),
      statRow('Air density', `${g.toFixed(3)} kg/m³`),
      statRow('Drag @ 25 m/s', this.dragAt25(spec)),
    );

    clear(this.warnEl);
    if (!a.warnings.length) {
      this.warnEl.appendChild(el('div', { class: 'warn-row ok', text: 'Build is sane. Fly it.' }));
    } else {
      for (const w of a.warnings) {
        this.warnEl.appendChild(el('div', { class: `warn-row ${w.level}`, text: w.text }));
      }
    }
  }

  /** mixTime is already in minutes. */
  fmtTime(s) {
    if (!Number.isFinite(s) || s <= 0) return '--';
    const m = Math.floor(s);
    const sec = Math.round((s - m) * 60);
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }

  /** Rough frontal-area drag estimate, useful when comparing frames. */
  dragAt25(spec) {
    const prop = new Prop(getPart('prop', spec.prop));
    prop.solve(200, 0, 1.225, {});
    const f = getPart('frame', spec.frame);
    const area = f.plateArea__cm2 / 1e4 * 2 + prop.A * 4;
    const cd = 0.55;
    const q = 0.5 * 1.225 * 25 * 25 * area * cd;
    return `${q.toFixed(1)} N`;
  }
}

/* --------------------------------------------------------------- presets */

export const PRESETS = [
  {
    name: 'Street racing 5"',
    note: '5x4.3x3, 2207 1750KV, 6S 1300 - the default race build',
    spec: { frame: 'f-5-race', motor: 'm-2207', motorKvIndex: 0, prop: 'p-hq43',
      esc: 'e-4a45', fc: 'fc-f7', rx: 'rx-elrs2', vtx: 'vt-hdzero', battery: 'b-6s1300-100' },
  },
  {
    name: 'Cinewhoop 3"',
    note: 'Cinematic: 3x3x3 on 4S, gentle rates, analog for the look',
    spec: { frame: 'f-cinewhoop-3', motor: 'm-1906', motorKvIndex: 1, prop: 'p-3tri',
      esc: 'e-4a35', fc: 'fc-f411', rx: 'rx-elrs2', vtx: 'vt-dji', battery: 'b-4s1500-100' },
  },
  {
    // 1750 KV, not 2400: 5x5.5x3.5 on 6S at 2400 KV would be 40k rpm and
    // several hundred amps, which is how you cook a motor in one flight.
    name: 'Freestyle 5"',
    note: 'Stiff frame, 5x5.5x3.5, 6S 1500 Li-ion for the punch',
    spec: { frame: 'f-5-freestyle', motor: 'm-2207', motorKvIndex: 0, prop: 'p-hq55',
      esc: 'e-4a65', fc: 'fc-f7pro', rx: 'rx-elrs900', vtx: 'vt-hdzero', battery: 'b-6s1500-li' },
  },
  {
    name: 'Long range 7"',
    note: '7x4x3 on 8S Li-ion: quiet, efficient, and a 25 mW link is fine out here',
    spec: { frame: 'f-7-lr', motor: 'm-2812', motorKvIndex: 1, prop: 'p-7',
      esc: 'e-4a65', fc: 'fc-f7pro', rx: 'rx-elrs900', vtx: 'vt-hdzero', battery: 'b-8s1300-li' },
  },
  {
    name: 'Heavy lifter 9"',
    note: '9x4.5x3 on 12S: carries a camera, a battery and a payload',
    spec: { frame: 'f-9-hl', motor: 'm-4004', motorKvIndex: 0, prop: 'p-9',
      esc: 'e-4a90', fc: 'fc-h7', rx: 'rx-crsf', vtx: 'vt-dji', battery: 'b-12s1500-li' },
  },
  {
    name: 'Toothpick 3"',
    note: '103 g AUW, 1404 4600KV on 4S. Absurd, and only just flies',
    spec: { frame: 'f-toothpick-3', motor: 'm-1404', motorKvIndex: 1, prop: 'p-2.5tri',
      esc: 'e-4a35', fc: 'fc-f411', rx: 'rx-elrs2', vtx: 'vt-caddx-hd', battery: 'b-4s1500-100' },
  },
  {
    // 350 KV on 12S gives a 10" prop about 4-5k rpm, which is what a 10" prop
    // actually wants. Higher KV would just make noise and heat.
    name: 'X-class lifter',
    note: '10x4.5x3, 40 mm 350 KV, 12S: a camera barge with a cargo bay',
    spec: { frame: 'f-x-10', motor: 'm-4004', motorKvIndex: 0, prop: 'p-10',
      esc: 'e-4a90', fc: 'fc-h7', rx: 'rx-crsf', vtx: 'vt-dji', battery: 'b-12s1500-li' },
  },
];
