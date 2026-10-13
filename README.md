# FPV Lab

A browser FPV drone builder, flight simulator and racer. Build a quad from a real
parts catalog, watch the physics tell you whether it can actually fly, then fly
it through a hangar with a modelled radio link and video link.

No build step. Plain ES modules, Three.js vendored locally, runs offline.

## Running it

```sh
node serve.js 8123
```

Then open <http://localhost:8123>. Add `?debug=1` to publish diagnostics onto
`document.documentElement.dataset.fpvDebug` for automated checks.

## Tests

```sh
node tests/physics.test.mjs    # 73 checks: prop, motor, battery, FC, body, collision
node tests/frame.test.mjs      # 21 checks: body-frame signs, hover, reaction torque
node tests/imports.mjs         # every module parses
```

Browser QA (needs the server running):

```sh
node "<browser-automation>/browser.mjs" "http://localhost:8123/?debug=1" --script ".\tests\qa.mjs"
node "<browser-automation>/browser.mjs" "http://localhost:8123/?debug=1" --script ".\tests\qa-weather.mjs"
```

`qa.mjs` walks every preset, flies, races and checks for console errors;
`qa-weather.mjs` cycles all seven weather presets and reports the resulting
lighting state.

Two harness constraints worth knowing:

- `page.evaluate` runs in an **isolated world**, so page globals like
  `window.fpvLab` are invisible. Both QA scripts drive the real DOM controls and
  read state from the debug channel instead.
- Screenshots only come from the CLI harness. The interactive tab throttles
  `requestAnimationFrame` when hidden, so the render loop stops and any
  measurement taken there is stale.


## The body frame

The craft body uses aerospace **NED**: X forward, Y right, Z down, right-handed.
World space is Y-up. The offset is handled by `R_LEVEL` / `Q_LEVEL` /
`attitudeOf()` in `src/sim/craft.js`.

**Level is `Q_LEVEL`, not the identity quaternion.** Because the frame is
NED, applying an identity rotation leaves the airframe rolled on its side — a
1.378 m quad rendering as a 1.378 m pancake standing on edge. Measured world
extents, which is how it was caught:

| Quaternion | World X | World Y | World Z |
| --- | --- | --- | --- |
| identity | 1.378 | 1.378 | 0.201 ← on its side |
| `Q_LEVEL` | 1.378 | 0.201 | 1.378 ← flat |

Mixer signs follow from that frame (`MIX_TABLE` in `craft.js`):

- roll right = more thrust on the **left** motors
- pitch nose-up = more thrust on the **front** motors
- yaw nose-right = more thrust from the **CCW** props (FL, RR)

`tests/frame.test.mjs` asserts each of these against a thrust direction rather
than trusting the table.

**Everyplace that spawns or re-levels a craft must use `Q_LEVEL`,** not just
`buildCraft`. `Simulation.reset()` wrote the identity quaternion, which put the
airframe on its side in the workshop and on the race grid, with the HUD reading
`-90°` pitch while the model lay nose-down in the dirt.

### The FPV camera needs a basis, not a rotation

A three.js camera looks down its own `-Z`; the nose is body `+X`. Turning it to
face the nose takes **two** rotations, and one of them is easy to forget:

| what you do | view direction | image roll |
| --- | --- | --- |
| `rotateY(π)` | body +Z → the ground | correct |
| `rotateY(tilt − π/2)` | nose, tilted up | **90°: the feed lies on its side** |
| `up = body −Z`, `lookAt(pos + forward)` | nose, tilted up | correct |

So `CameraRig.fpvPose()` builds the world forward and up vectors explicitly and
`applyFpvOrientation()` hands them to `lookAt`. Anything that reproduces the FPV
pose elsewhere (the delayed feed pose) has to use the same basis.

## Surfaces

Track and ground surfaces are `MeshStandardMaterial` with CC0 scans from
[ambientCG](https://ambientcg.com), vendored under `assets/textures` (colour,
normal and roughness maps for concrete, corrugated metal, plaster, plywood,
brick, asphalt and grass). Box UVs are rescaled by world size so a 170 m hangar
wall and a 0.4 m crate show the same grain — default per-face 0..1 UVs cannot do
that.

Everything degrades gracefully: a missing map still builds from its tint.

Three rendering rules worth knowing before changing this:

- **`scene.environment` must be set.** A PBR material with metalness has almost
  no diffuse response — all of its look comes from reflected surroundings. With
  no environment map every metal surface renders near-black. `Viewport`
  generates a small gradient env map from the current sky via `PMREMGenerator`.
- **Indoor tracks need their own lighting.** A hangar is lit by overhead
  industrial fittings; dimming an outdoor sky and hoping gives a black scene.
  `applyWeather` branches on `track.interior` and uses a dedicated overhead rig,
  and suppresses fog and rain.
- **Anything the camera sits inside has to fade.** `Viewport.render()` fades the
  gate rings and the start pad by distance, and the craft is hidden outright in
  FPV mode: the lens is inside the airframe and every material on it is opaque,
  so without both the first seconds of every heat are behind coloured plastic.

## The drone model

`src/render/droneMesh.js` builds geometry from the same numbers the physics
uses, which means a unit slip shows up as an absurd object. Four have been, and
all four were found by measuring the model in Node rather than by looking at it:

| symbol | unit | what it is *not* |
| --- | --- | --- |
| `plateArea__cm2` | cm² | divide by **1e4** for m², not 100 — `/100` made a 190 cm² plate 1.38 m across, a ten-times slab that swallowed the airframe |
| `pitch__mm` | mm of *pitch* (109 on a 5x4.3) | not blade thickness, and not an angle: extruding by it gave 10 cm paddles, and `pitch / radius` gave a 54° blade that stood on edge |
| `D__mm` | mm | the prop disc lies in the body **XY** plane, because the spin axis is Z (NED) — rotating the blade geometry on to an edge stops it spinning about Z at all |
| arm direction | `+atan2(y, x)` | the mirrored sign puts both arms on the same side and the frame draws as two crossed sticks |

The model is rebuilt only when the spec string changes: `build()` stores
`JSON.stringify(spec)` because `update()` compares against a string, and
storing the object tore the whole model down and rebuilt it every frame.

## Weather and lighting

`src/data/weather.js` defines seven complete lighting states — clear, hazy,
overcast, dusk, night, rain, fog. Each is a whole mood (sun angle, colour,
sky, ambient, fog density, exposure, rain, wind, turbulence), not one light, so
switching changes everything at once.

Sun position is authored as **elevation and compass bearing**, not a direction
vector, because "low sun in the west" is a lighting instruction and
`[0.4, 0.2, -0.9]` is not.

Weather is chosen in the Simulator's Environment panel, alongside live sun
elevation, bearing and exposure sliders. It drives the simulation as well as the
render: selecting rain sets wind to 7.5 m/s and raises turbulence to 0.95, so
the craft is actually buffeted rather than merely looking wet.

A track may pin a default (`weather:`), but an explicit user choice always wins —
otherwise changing track would silently undo the sky you picked.

Rain is a camera-locked column of line segments, not points: a point is a dot,
and rain reads as streaks. Density is what sells it, so the emitter stays tight
around the camera. WebGL clamps line width to 1 px on most drivers, so
visibility comes from contrast and count rather than thickness.


## Physics

Rates: 8 kHz rigid-body integration, PID at 4 kHz (alternating `runPID`), radio
and video links updated at their own real frame rates.

| Area | Model |
| --- | --- |
| Prop | Momentum theory with CT/FM curves anchored to published 5x4.3x3 data (1.20 kg @ 28k rpm, 3.22 g/W) |
| Ground effect | Prandtl, from nearest-surface clearance to ground **or** ceiling — both are image surfaces |
| Vortex ring state | Loss of thrust when descending faster than induced flow |
| Propwash | Surface model: ground-effect turbulence plus a buffet term. Mutual prop-to-prop wash is geometrically impossible on a rigid planar quad and is deliberately not modelled |
| Motor | Kt ≠ Ke (0.88 ratio), winding resistance scaling as `R ∝ KV^-1.7`, back-EMF, current limiting |
| Battery | OCV curve, ESR sag, polarisation, temperature, cycle age, cell imbalance |
| Airframe | Flat-plate aerodynamics, prop thrust and reaction torque, gyroscopic precession |
| Collision | Sphere vs AABB with penetration response; separate soft arena bounds as a backstop |
| RF | Ray/AABB trace with material penetration loss and knife-edge diffraction |

Validated reference numbers for the 5" race build: 568–591 g all-up, T/W ~10.4:1,
hover at 26–27 % throttle / 14 A / ~334 W, ~1.77 g/W, 137 A at full throttle,
9.8k hover RPM, ~2.1 min mixed flight.

## Geometry vs. bounds

Track `bounds` are a **backstop only**. Any surface a craft can actually hit is
modelled as an obstacle, and the soft bound sits outside that geometry. Putting
the bound inside is a real failure mode, not a cosmetic one: `collideWorld`
rests a craft on a roof slab at `slabTop + radius`, and a bound set lower will
drag it back down through the slab and out the floor. `tests/physics.test.mjs`
asserts every track's ceiling clears its roof slab.

Three things about the collision sphere, all of which were wrong at some point:

- **It has to reach the prop tips.** The hubs sit at 45 degrees, so their
  distance from the centre is the arm offset times √2, not the offset. Using the
  offset alone made the sphere 3–4 cm smaller than the airframe, and the props
  drove through walls before anything stopped them — the opposite of what the
  prop-strike model claims.
- **An embedded craft comes out where it went in.** Ejecting by "which axis has
  a non-zero velocity" picked X first, so a craft in the roof slab travelling
  40 m/s sideways was pushed out of the roof's *85 m side*. The axis now comes
  from how shallow the box is along it, and the face from the direction of
  travel: falling in through a ceiling comes back out through the ceiling,
  a craft in a thin wall comes out sideways whatever its vertical drift.
- **Prop-strike severity decays.** It is the severity of the last hit, not a
  record for the session; as a running maximum one crash re-reported itself for
  the rest of the flight, and `Simulation.reset()` did not clear it.

The hangar is 14 m to the underside of the roof, which is what an aircraft
hangar actually is. At 9 m the ceiling was barely a body length above the
racing line and capped every vertical line in the workshop.

## Units

`__r` in the parts catalog is **milliohms** (divided by 1000 in code).
`mass__m` is kilograms, `__mm` millimetres, `__mah` milliamp-hours.

## Layout

```
src/
  core/       math helpers
  data/       parts catalog, track geometry, radio band plans
  sim/        prop, motor, battery, fc, body, craft, environment, rf, sim
  render/     viewport, drone mesh, cameras, fx
  race/       race state machine, ghost pilots, career
  ui/         builder, sim, tune, race views, dom helpers
tests/        physics, frame, imports, browser QA
```
