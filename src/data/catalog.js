// Parts catalog.
//
// Every number here is consumed by the simulator, not just displayed, so the units
// matter: SI internally (kg, m, ohm, kg*m^2, farad), grams/millimetres/maKV in the
// specs for readability. The `__m` and `__t` suffixes hide unit conversions:
//   __m  => mass in grams   __mm => length in millimetres
//   __r  => resistance in milliohms (per phase, motor) or per cell (pack)
//   __J  => polar rotor inertia in kg*m^2
//   __kv => KV in rpm/volt
//
// Figures are representative of real hardware of each class: winding resistance,
// polar inertia and pack ESR drive current draw, voltage sag and gyroscopic
// coupling, so relative differences between parts are meaningful. Winding
// resistance is quoted at the FIRST KV in the list; motor.js rescales it for the
// higher-KV windings (fewer turns, thinner wire, much more resistance).

export const CATEGORIES = [
  { id: 'frame', label: 'Frame', icon: 'frame' },
  { id: 'motor', label: 'Motors', icon: 'motor' },
  { id: 'prop', label: 'Props', icon: 'prop' },
  { id: 'esc', label: 'ESC', icon: 'esc' },
  { id: 'fc', label: 'Flight controller', icon: 'fc' },
  { id: 'rx', label: 'Receiver', icon: 'rx' },
  { id: 'vtx', label: 'VTX / camera', icon: 'vtx' },
  { id: 'battery', label: 'Battery', icon: 'batt' },
];

export const FRAMES = [
  {
    id: 'f-toothpick-3', name: 'Toothpick 3"', brand: 'Generic', tier: 0, mass__m: 32,
    wheelbase__mm: 165, propMax__mm: 152, plateArea__cm2: 62, armLength__mm: 82,
    motorMount: 'M2', motorPattern__mm: 16, motorHeight__mm: 12, stackHeight__mm: 20,
    stackOffset: { x: 0, y: 6 }, material: 'Carbon 3K', motorBoltTorque: 1.6,
    camTilt__deg: 22, notes: 'Featherweight 3" toothpick. Fragile, absurd agility.',
    cdr: 4.5, inertiaModel: 'plate',
  },
  {
    id: 'f-5-race', name: 'Vortex 5" Race', brand: 'Generic', tier: 1, mass__m: 118,
    wheelbase__mm: 220, propMax__mm: 140, plateArea__cm2: 190, armLength__mm: 110,
    motorMount: 'M3', motorPattern__mm: 16, motorHeight__mm: 17, stackHeight__mm: 30,
    stackOffset: { x: 0, y: 8 }, material: 'Carbon 3K unibody', motorBoltTorque: 2.4,
    camTilt__deg: 27, notes: 'True-X 5" race frame. Stiff, wide, fast.',
    cdr: 5.0, inertiaModel: 'plate',
  },
  {
    id: 'f-5-freestyle', name: 'Hardcore 5"', brand: 'Generic', tier: 1, mass__m: 152,
    wheelbase__mm: 225, propMax__mm: 145, plateArea__cm2: 240, armLength__mm: 112,
    motorMount: 'M3', motorPattern__mm: 19, motorHeight__mm: 17, stackHeight__mm: 30,
    stackOffset: { x: 0, y: 10 }, material: 'Carbon 3K + 7075 arms', motorBoltTorque: 2.8,
    camTilt__deg: 5, notes: 'Reinforced 5" freestyle frame, thicker arms.',
    cdr: 5.0, inertiaModel: 'plate',
  },
  {
    id: 'f-cinewhoop-3', name: 'Cinewhoop 3"', brand: 'Generic', tier: 2, mass__m: 118,
    wheelbase__mm: 156, propMax__mm: 127, plateArea__cm2: 150, armLength__mm: 78,
    motorMount: 'M2', motorPattern__mm: 16, motorHeight__mm: 11, stackHeight__mm: 16,
    stackOffset: { x: 0, y: 4 }, material: 'Carbon + TPU ducts', motorBoltTorque: 1.6,
    camTilt__deg: 14, ducts: true, notes: 'Ducted 3" cinewhoop. Whoopy, protected, quiet.',
    cdr: 4.2, inertiaModel: 'duct',
  },
  {
    // propMax leaves real clearance: at exactly 180 mm a 7x4x3 has no room to
    // spin up without clipping a frame edge, and you lose all propwash margin.
    id: 'f-7-lr', name: 'Voyager 7"', brand: 'Generic', tier: 3, mass__m: 285,
    wheelbase__mm: 360, propMax__mm: 195, plateArea__cm2: 420, armLength__mm: 180,
    motorMount: 'M3', motorPattern__mm: 16, motorHeight__mm: 20, stackHeight__mm: 36,
    stackOffset: { x: 0, y: 12 }, material: 'Carbon 3K + 7075', motorBoltTorque: 3.5,
    camTilt__deg: 20, notes: 'Dead-cat 7" long-range frame. Efficient, calm, big.',
    cdr: 6.0, inertiaModel: 'plate',
  },
  {
    id: 'f-9-hl', name: 'Mule 9" Lifter', brand: 'Generic', tier: 4, mass__m: 520,
    wheelbase__mm: 440, propMax__mm: 250, plateArea__cm2: 760, armLength__mm: 220,
    motorMount: 'M4', motorPattern__mm: 19, motorHeight__mm: 24, stackHeight__mm: 40,
    stackOffset: { x: 0, y: 14 }, material: 'Carbon + 6061 arms', motorBoltTorque: 4.5,
    camTilt__deg: 25, notes: 'Heavy-lift 9". Carries a GoPro, hauls 2 kg.',
    cdr: 7.0, inertiaModel: 'plate',
  },
  {
    id: 'f-x-10', name: 'Titan X 10"', brand: 'Generic', tier: 5, mass__m: 980,
    wheelbase__mm: 530, propMax__mm: 285, plateArea__cm2: 1150, armLength__mm: 265,
    motorMount: 'M4', motorPattern__mm: 25, motorHeight__mm: 28, stackHeight__mm: 45,
    stackOffset: { x: 0, y: 16 }, material: 'Carbon + alloy', motorBoltTorque: 5.0,
    camTilt__deg: 30, notes: 'X-class monster. Absurd power, absurd inertia.',
    cdr: 8.0, inertiaModel: 'plate',
  },
];

export const MOTORS = [
  {
    id: 'm-1404', name: 'Aero 1404', brand: 'Xrotor', tier: 0, mass__m: 18.5, stator: 14, kv: [3800, 4600, 5200],
    Rm__r: 380, RmHot__r: 270, J__J: 3.1e-7, Lm__u: 22, ironLoss: 0.011, bellMass: 0.55,
    maxPowerW: 260, shaft__mm: 1.5, mount: 'M2', mountPattern__mm: 6.5, height__mm: 12,
    notes: 'Tiny high-KV 14x04. Built for 3S toothpick speed.',
  },
  {
    id: 'm-1906', name: 'Swift 1906', brand: 'Xrotor', tier: 1, mass__m: 23.5, stator: 19, kv: [2700, 3300, 3800],
    Rm__r: 260, RmHot__r: 190, J__J: 7.6e-7, Lm__u: 32, ironLoss: 0.010, bellMass: 0.54,
    maxPowerW: 420, shaft__mm: 2, mount: 'M2', mountPattern__mm: 9.5, height__mm: 14,
    notes: 'Mid-size cinewhoop motor. Sweet 4S balance.',
  },
  {
    id: 'm-2207', name: 'Raptor 2207', brand: 'Xrotor', tier: 2, mass__m: 32.0, stator: 22, kv: [1750, 2400, 2800],
    Rm__r: 145, RmHot__r: 105, J__J: 1.55e-6, Lm__u: 44, ironLoss: 0.0085, bellMass: 0.52,
    maxPowerW: 950, shaft__mm: 5, mount: 'M3', mountPattern__mm: 12, height__mm: 17,
    notes: 'The 5" standard bearer. ~1750 KV for 6S, 2400+ for 4S.',
  },
  {
    id: 'm-2306', name: 'Falcon 2306.5', brand: 'T-Motor', tier: 2, mass__m: 32.0, stator: 23, kv: [1500, 1750, 1950, 2850],
    Rm__r: 105, RmHot__r: 78, J__J: 1.82e-6, Lm__u: 48, ironLoss: 0.0080, bellMass: 0.51,
    maxPowerW: 1080, shaft__mm: 5, mount: 'M3', mountPattern__mm: 12, height__mm: 17,
    notes: 'Narrow-winding race motor. ~1750 KV on 6S; a lot of top end per volt.',
  },
  {
    id: 'm-2812', name: 'Bruiser 2812', brand: 'T-Motor', tier: 3, mass__m: 78.0, stator: 28, kv: [700, 900, 1000],
    Rm__r: 31, RmHot__r: 22, J__J: 6.1e-6, Lm__u: 96, ironLoss: 0.0065, bellMass: 0.56,
    maxPowerW: 2400, shaft__mm: 5, mount: 'M3', mountPattern__mm: 16, height__mm: 20,
    notes: 'Big low-KV 28er. 7" long-range and 9" lifting workhorse.',
  },
  {
    id: 'm-4004', name: 'Cyclone 4004', brand: 'Ethix', tier: 4, mass__m: 128.0, stator: 40, kv: [350, 480, 600],
    Rm__r: 13.5, RmHot__r: 9.8, J__J: 1.9e-5, Lm__u: 190, ironLoss: 0.0050, bellMass: 0.58,
    maxPowerW: 5200, shaft__mm: 8, mount: 'M4', mountPattern__mm: 19, height__mm: 26,
    notes: 'X-class 40mm stator. Industrial torque in a 5 kg package.',
  },
];

export const PROPS = [
  { id: 'p-2.5tri', name: '2.5x1.9x3', brand: 'Generic', tier: 0, D__mm: 63.5, pitch__mm: 48, blades: 3,
    hub__mm: 13, mass__m: 0.85, mat: 'PC', fmBase: 0.62, price: 1.2, forClass: '2.5"',
    notes: 'Toothy 2.5" tri-blade. Very efficient, very fragile.' },
  { id: 'p-3tri', name: '3x3x3', brand: 'Generic', tier: 1, D__mm: 76.2, pitch__mm: 76, blades: 3,
    hub__mm: 14, mass__m: 1.6, mat: 'PC', fmBase: 0.66, price: 2.0, forClass: '3"',
    notes: 'Cinewhoop standard. Quiet, round, decent authority.' },
  { id: 'p-3.5x3', name: '3.5x3.2x3', brand: 'Generic', tier: 1, D__mm: 89, pitch__mm: 81, blades: 3,
    hub__mm: 14, mass__m: 2.2, mat: 'PC', fmBase: 0.67, price: 2.4, forClass: '3.5"' },
  { id: 'p-hq43', name: '5x4.3x3 HQ', brand: 'Generic', tier: 2, D__mm: 127, pitch__mm: 109, blades: 3,
    hub__mm: 15, mass__m: 4.3, mat: 'PC', fmBase: 0.72, price: 3.2, forClass: '5"',
    notes: 'The 5" workhorse. Thrust with a straight-ahead propwash trail.' },
  { id: 'p-hq45', name: '5x4.5x4 HQ', brand: 'Generic', tier: 2, D__mm: 127, pitch__mm: 114, blades: 3,
    hub__mm: 15, mass__m: 4.8, mat: 'PC', fmBase: 0.74, price: 3.6, forClass: '5"',
    notes: 'Slightly steeper. More punch out of a corner, more drag.' },
  { id: 'p-hq55', name: '5x5.5x3.5 HQ', brand: 'Generic', tier: 2, D__mm: 127, pitch__mm: 140, blades: 3,
    hub__mm: 15, mass__m: 5.1, mat: 'PC', fmBase: 0.70, price: 3.9, forClass: '5"',
    notes: 'Freestyle/climb. Huge static thrust, useless in forward flight.' },
  { id: 'p-2blade', name: '5x4.3x2', brand: 'Generic', tier: 3, D__mm: 127, pitch__mm: 109, blades: 2,
    hub__mm: 15, mass__m: 3.4, mat: 'PC', fmBase: 0.66, price: 3.4, forClass: '5"',
    notes: 'Two-blade efficiency prop. Efficient, but lower RPM and less control authority.' },
  { id: 'p-racer5', name: '5x3.6x3', brand: 'Generic', tier: 3, D__mm: 127, pitch__mm: 91, blades: 3,
    hub__mm: 15, mass__m: 3.9, mat: 'PC', fmBase: 0.75, price: 3.8, forClass: '5"',
    notes: 'Shallow race pitch. Highest figure of merit, least punch.' },
  { id: 'p-6', name: '6x3.5x3', brand: 'Generic', tier: 3, D__mm: 152, pitch__mm: 89, blades: 3,
    hub__mm: 15, mass__m: 6.5, mat: 'PC', fmBase: 0.73, price: 4.5, forClass: '6"',
    notes: 'Long-range cruiser prop. Larger diameter, fewer RPM.' },
  { id: 'p-7', name: '7x4x3', brand: 'Generic', tier: 4, D__mm: 178, pitch__mm: 102, blades: 3,
    hub__mm: 15, mass__m: 9.2, mat: 'PC', fmBase: 0.73, price: 6.0, forClass: '7"',
    notes: 'Long-range standard. The 7" efficiency sweet spot.' },
  { id: 'p-9', name: '9x4.5x3', brand: 'Generic', tier: 5, D__mm: 229, pitch__mm: 114, blades: 3,
    hub__mm: 17, mass__m: 15.0, mat: 'PC', fmBase: 0.70, price: 9.0, forClass: '9"' },
  { id: 'p-10', name: '10x4.5x3', brand: 'Generic', tier: 5, D__mm: 254, pitch__mm: 114, blades: 3,
    hub__mm: 17, mass__m: 19.0, mat: 'PC', fmBase: 0.69, price: 11.0, forClass: '10"' },
];

export const ESCS = [
  { id: 'e-4a35', name: '4-in-1 35A 3-6S', brand: 'Generic', tier: 0, mass__m: 22, maxContA: 35, maxBurstA: 42,
    vMin: 3, vMax: 6, protocol: 'DShot600', mcu: 'F411', currentSense: true, escRTotal__r: 1.8,
    telemetry: true, vtxControl: false, notes: 'Weighless and cheap. Fine until it is not.' },
  { id: 'e-4a45', name: '4-in-1 45A 4-8S', brand: 'Generic', tier: 1, mass__m: 30, maxContA: 45, maxBurstA: 54,
    vMin: 4, vMax: 8, protocol: 'DShot600', mcu: 'F722', currentSense: true, escRTotal__r: 1.4,
    telemetry: true, vtxControl: true, notes: 'Modern 8S-capable stack with a real FET rating.' },
  { id: 'e-4a55', name: '4-in-1 55A 4-8S', brand: 'Generic', tier: 2, mass__m: 39, maxContA: 55, maxBurstA: 68,
    vMin: 4, vMax: 8, protocol: 'DShot1200', mcu: 'F722', currentSense: true, escRTotal__r: 1.1,
    telemetry: true, vtxControl: true, notes: 'Race-grade. 1200 DShot for snappier throttle response.' },
  { id: 'e-4a65', name: '4-in-1 65A 4-8S', brand: 'Generic', tier: 3, mass__m: 47, maxContA: 65, maxBurstA: 80,
    vMin: 4, vMax: 8, protocol: 'DShot1200', mcu: 'F722', currentSense: true, escRTotal__r: 0.95,
    telemetry: true, vtxControl: true, notes: 'Heavy hitter. Extra mass, extra current headroom.' },
  { id: 'e-4a90', name: '4-in-1 90A 6-12S', brand: 'Generic', tier: 4, mass__m: 68, maxContA: 90, maxBurstA: 112,
    vMin: 6, vMax: 12, protocol: 'DShot1200', mcu: 'H743', currentSense: true, escRTotal__r: 0.72,
    telemetry: true, vtxControl: true, notes: 'Do everything. 12S native, no fear of a 40 A punchout.' },
];

export const FCS = [
  { id: 'fc-f411', name: 'F411 20x20', brand: 'Generic', tier: 0, mass__m: 17, mcu: 'STM32F411',
    gyro: 'ICM42688', gyroHz: 8000, gyroNoise: 0.85, gyroRng: 2000, imuDelayUs: 28,
    uarts: 3, motors: 4, blackboxRate: 1000, ram: '128K', notes: 'Cheap 20x20. Works, but the gyro and the MCU are entry-level.' },
  { id: 'fc-f7', name: 'F7 30.5x30.5', brand: 'Generic', tier: 1, mass__m: 32, mcu: 'STM32F722',
    gyro: 'ICM42688', gyroHz: 8000, gyroNoise: 0.55, gyroRng: 2000, imuDelayUs: 18,
    uarts: 6, motors: 4, blackboxRate: 2000, ram: '256K', notes: 'Mainstream 30.5 stack. Plenty of headroom for filters and RPM telemetry.' },
  { id: 'fc-f7pro', name: 'F722 20x20 Pro', brand: 'Generic', tier: 2, mass__m: 24, mcu: 'STM32F722',
    gyro: 'BMI270', gyroHz: 8000, gyroNoise: 0.34, gyroRng: 4000, imuDelayUs: 11,
    uarts: 5, motors: 4, blackboxRate: 4000, ram: '256K', notes: 'Low IMU delay and a quiet BMI270. Noticeably crisper.' },
  { id: 'fc-h7', name: 'H743 30.5x30.5', brand: 'Generic', tier: 3, mass__m: 40, mcu: 'STM32H743',
    gyro: 'ICM42688', gyroHz: 16000, gyroHzReal: 8000, gyroNoise: 0.22, gyroRng: 4000, imuDelayUs: 9,
    uarts: 8, motors: 8, blackboxRate: 8000, ram: '512K', notes: 'Flagship. 16 kHz gyro sampling, 8 kHz PID loop, 8 motor outputs.' },
];

export const RXS = [
  { id: 'rx-elrs2', name: 'ELRS 2.4 GHz', brand: 'Generic', tier: 0, mass__m: 0.9, rateHz: 250,
    latencyMs: 16, range: 400, protocol: 'CRSF', failsafeMs: 500, noise: 1.0,
    notes: 'Cheap, ubiquitous, ~250 Hz with a jittery tail.' },
  { id: 'rx-elrs900', name: 'ELRS 900 MHz', brand: 'Generic', tier: 2, mass__m: 1.6, rateHz: 200,
    latencyMs: 11, range: 4000, protocol: 'CRSF', failsafeMs: 350, noise: 0.7,
    notes: 'Full-duplex 900 MHz. Penetrates everything, low latency.' },
  { id: 'rx-crsf', name: 'Crossfire', brand: 'Generic', tier: 3, mass__m: 3.2, rateHz: 150,
    latencyMs: 9, range: 10000, protocol: 'CRSF', failsafeMs: 900, noise: 0.55,
    notes: 'The gold standard for range. Heavy and power hungry.' },
  { id: 'rx-ghost', name: 'Ghost Ghost', brand: 'Generic', tier: 1, mass__m: 5.0, rateHz: 125,
    latencyMs: 8, range: 8000, protocol: 'GHST', failsafeMs: 200, noise: 0.8,
    notes: 'Analog latency you can feel, and a failsafe you can rely on.' },
];

export const VTXS = [
  { id: 'vt-caddx-hd', name: 'Caddx Ant Lite + Nano', brand: 'Generic', tier: 1, mass__m: 8.5,
    system: 'analog', powerMw: 200, mWMin: 25, channels: 48, latencyMs: 6, sensor: 'CMOS',
    fov__deg: 150, distortion: 0.35, latencyBaseMs: 6,
    notes: 'The classic analog image. Latency you can shave frames off.' },
  { id: 'vt-hdzero', name: 'HDZero Race 3', brand: 'Generic', tier: 2, mass__m: 31,
    system: 'digital', powerMw: 25, mWMin: 25, channels: 90, latencyMs: 15, sensor: 'CMOS',
    fov__deg: 150, distortion: 0.42, latencyBaseMs: 15,
    notes: 'Digital race system. High frame rate, ~15 ms of pipeline delay.' },
  { id: 'vt-dji', name: 'DJI O3 Air Unit', brand: 'Generic', tier: 3, mass__m: 36,
    system: 'digital', powerMw: 25, mWMin: 25, channels: 60, latencyMs: 28, sensor: '1/1.3" CMOS',
    fov__deg: 160, distortion: 0.28, latencyBaseMs: 28,
    notes: 'Beautiful image, 4K60 recording, and 28 ms of latency.' },
  { id: 'vt-analog-hi', name: 'Rush Tank II + Foxeer', brand: 'Generic', tier: 4, mass__m: 22,
    system: 'analog', powerMw: 1000, mWMin: 25, channels: 48, latencyMs: 4, sensor: 'CMOS',
    fov__deg: 155, distortion: 0.38, latencyBaseMs: 4,
    notes: 'Maximum analog output. Interference is a real trade-off.' },
];

export const BATTERIES = [
  {
    id: 'b-4s1500-100', name: '4S 1500 mAh 100C', brand: 'Generic', tier: 0, chem: 'LiPo',
    cells: 4, capacity__mah: 1500, cRating: 100, mass__m: 178, Rcell__r: 2.55, balance: 0,
    maxV__v: 16.8, minV__v: 13.2, cycleLife: 60, internalBMS: false, price: 22,
    notes: 'Cheap LiPo. Enormous C rating, thin margins, dies young.',
  },
  {
    id: 'b-4s1300-li', name: '4S 1300 mAh 100C Li-ion', brand: 'Generic', tier: 1, chem: 'Li-ion',
    cells: 4, capacity__mah: 1300, cRating: 100, mass__m: 196, Rcell__r: 9.2, balance: 180,
    maxV__v: 16.8, minV__v: 12.0, cycleLife: 400, internalBMS: true, price: 34,
    notes: '21700 Li-ion pack. Heavier, but it sags far less and lasts for years.',
  },
  {
    id: 'b-6s1300-100', name: '6S 1300 mAh 100C', brand: 'Generic', tier: 2, chem: 'LiPo',
    cells: 6, capacity__mah: 1300, cRating: 100, mass__m: 232, Rcell__r: 2.15, balance: 0,
    maxV__v: 25.2, minV__v: 19.8, cycleLife: 60, internalBMS: false, price: 28,
    notes: '6S race pack. Higher voltage means harder sag on a big punch.',
  },
  {
    id: 'b-6s2200-80', name: '6S 2200 mAh 80C', brand: 'Generic', tier: 3, chem: 'Li-ion',
    cells: 6, capacity__mah: 2200, cRating: 80, mass__m: 386, Rcell__r: 5.4, balance: 200,
    maxV__v: 25.2, minV__v: 18.0, cycleLife: 400, internalBMS: true, price: 52,
    notes: 'Big Li-ion endurance pack. Boring, cold, dependable.',
  },
  {
    id: 'b-6s1500-li', name: '6S 1500 mAh 130C Li-ion', brand: 'Generic', tier: 4, chem: 'Li-ion',
    cells: 6, capacity__mah: 1500, cRating: 130, mass__m: 268, Rcell__r: 4.1, balance: 250,
    maxV__v: 25.2, minV__v: 18.0, cycleLife: 300, internalBMS: true, price: 62,
    notes: 'Top-end cells. Very low ESR and a 130 C burst rating.',
  },
  {
    id: 'b-8s1300-li', name: '8S 1300 mAh 120C', brand: 'Generic', tier: 5, chem: 'Li-ion',
    cells: 8, capacity__mah: 1300, cRating: 120, mass__m: 360, Rcell__r: 4.6, balance: 220,
    maxV__v: 33.6, minV__v: 24.0, cycleLife: 350, internalBMS: true, price: 96,
    notes: '8S native. Deep mains flight on very little current.',
  },
  {
    id: 'b-12s1500-li', name: '12S 1500 mAh 90C', brand: 'Generic', tier: 5, chem: 'Li-ion',
    cells: 12, capacity__mah: 1500, cRating: 90, mass__m: 780, Rcell__r: 5.2, balance: 180,
    maxV__v: 50.4, minV__v: 30.0, cycleLife: 300, internalBMS: true, price: 165,
    notes: '12S (6S2P) heavy lifter pack. X-class territory: big voltage, big '
      + 'mass, and the only way to turn a 10" prop at a sensible rpm.',
  },
  {
    id: 'b-12s2200-li', name: '12S 2200 mAh 75C', brand: 'Generic', tier: 5, chem: 'Li-ion',
    cells: 12, capacity__mah: 2200, cRating: 75, mass__m: 1120, Rcell__r: 4.4, balance: 200,
    maxV__v: 50.4, minV__v: 30.0, cycleLife: 320, internalBMS: true, price: 215,
    notes: 'Enormous 12S pack. Flies a 9-10" lifter for a very long time, on legs '
      + 'that have to survive landing it.',
  },
];

export const DATA = {
  frame: FRAMES, motor: MOTORS, prop: PROPS, esc: ESCS, fc: FCS,
  rx: RXS, vtx: VTXS, battery: BATTERIES,
};

export const TIERS = ['Entry', 'Sport', 'Competitive', 'Elite', 'Pro', 'Factory'];

export function listParts(cat) { return DATA[cat] || []; }
export function getPart(cat, id) {
  const l = DATA[cat];
  if (!l) return null;
  return l.find((p) => p.id === id) || l[0];
}
export function partPrice(cat, id) {
  const p = getPart(cat, id);
  if (!p) return 0;
  if (p.price != null) return p.price;
  // Simple price curve for parts that only carry a tier.
  const base = { frame: 60, motor: 32, prop: 6, esc: 55, fc: 70, rx: 22, vtx: 65, battery: 30 }[cat] || 40;
  return Math.round(base * (1 + 0.85 * (p.tier || 0)));
}
export function buildCost(spec) {
  let total = 0;
  for (const cat of CATEGORIES) total += partPrice(cat.id, spec[cat.id]);
  return Math.round(total);
}

// Suggested prop class for a frame, used by the builder's fit warnings.
export function framePropClass(frame) {
  const d = frame.propMax__mm;
  if (d < 70) return '2.5"';
  if (d < 82) return '3"';
  if (d < 95) return '3.5"';
  if (d < 120) return '3.5"';
  if (d < 140) return '5"';
  if (d < 168) return '6"';
  if (d < 210) return '7"';
  if (d < 245) return '9"';
  return '10"';
}

export const DEFAULTS = {
  frame: 'f-5-race', motor: 'm-2207', prop: 'p-hq43', esc: 'e-4a45',
  fc: 'fc-f7', rx: 'rx-elrs2', vtx: 'vt-caddx-hd', battery: 'b-6s1300-100',
};
