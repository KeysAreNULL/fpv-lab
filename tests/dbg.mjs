import { analyseBuild } from '../src/sim/craft.js';
import { PRESETS } from '../src/ui/builder.js';
import { getPart } from '../src/data/catalog.js';

// Reproduce App.setSpec's legality coercion to find what breaks the X-class preset.
function coerce(spec) {
  const frame = getPart('frame', spec.frame);
  const prop = getPart('prop', spec.prop);
  const motor = getPart('motor', spec.motor);
  const esc = getPart('esc', spec.esc);
  const batt = getPart('battery', spec.battery);
  const before = { ...spec };
  if (prop.D__mm > frame.propMax__mm) {
    const fit = ['p-2.5tri','p-3tri','p-3.5x3','p-hq43','p-6','p-7','p-9','p-10']
      .map((id) => getPart('prop', id)).filter((p) => p.D__mm <= frame.propMax__mm);
    spec.prop = (fit[fit.length - 1] || getPart('prop','p-2.5tri')).id;
  }
  if (motor.mount !== frame.motorMount) {
    const fit = ['m-1404','m-1906','m-2207','m-2306','m-2812','m-4004']
      .map((id) => getPart('motor', id)).filter((m) => m.mount === frame.motorMount);
    spec.motor = (fit[0] || motor).id;
    spec.motorKvIndex = 0;
  }
  if (batt.cells < esc.vMin || batt.cells > esc.vMax) {
    const fit = ['b-4s1500-100','b-4s1300-li','b-6s1300-100','b-6s2200-80','b-6s1500-li','b-8s1300-li']
      .map((id) => getPart('battery', id))
      .filter((b) => b.cells >= esc.vMin && b.cells <= esc.vMax);
    spec.battery = (fit[0] || batt).id;
  }
  return { before, spec };
}

for (const p of PRESETS) {
  const { before, spec } = coerce({ ...p.spec });
  const changed = Object.keys(spec).filter((k) => spec[k] !== before[k]);
  const r = analyseBuild(spec);
  console.log(`${p.name.padEnd(20)} AUW ${(r.mass*1000).toFixed(0)}g  T/W ${r.thrustRatio.toFixed(2)}`
    + `  hover ${(r.hoverThrottle*100).toFixed(0)}%${changed.length ? '   COERCED: ' + changed.map(k=>`${k} ${before[k]}->${spec[k]}`).join(', ') : ''}`);
}