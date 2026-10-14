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
node tests/aero.test.mjs       # flat-plate aerodynamics is actually live
node tests/controls.test.mjs   # channel bindings, expo, deadzone, invert
node tests/rates.test.mjs      # the three Betaflight rate profiles
node tests/rates.fc.test.mjs   # ...and that the FC actually applies them
node tests/pid.test.mjs        # D damps and P stiffens - the direction of each term
node tests/propgeom.test.mjs   # prop blades are coplanar and correctly pitched
node tests/flight.test.mjs     # hands-off hover holds attitude and does not drift
node tests/stress.test.mjs     # sustained flight on real key input, every track
node tests/recover.test.mjs    # reset rescues a diverged craft; a watchdog exists
node tests/attitude.test.mjs   # CG on the thrust axis; angle mode is singularity-free
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

Mixer signs follow from that frame (`MIX_TABLE` in `fc.js`):

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
uses, which means a unit slip shows up as an absurd object. Each of these was
found by measuring the model in Node rather than by looking at it:

| symbol | unit | what it is *not* |
| --- | --- | --- |
| `plateArea__cm2` | cm² | divide by **1e4** for m², not 100 — `/100` made a 190 cm² plate 1.38 m across, a ten-times slab that swallowed the airframe |
| `pitch__mm` | mm of *pitch* (109 on a 5x4.3) | not blade thickness, and not an angle: extruding by it gave 10 cm paddles, and `pitch / radius` gave a 54° blade that stood on edge |
| `D__mm` | mm | the prop disc lies in the body **XY** plane, because the spin axis is Z (NED) — rotating the blade geometry on to an edge stops it spinning about Z at all |
| arm direction | `+atan2(y, x)` | the mirrored sign puts both arms on the same side and the frame draws as two crossed sticks |
| arm profile origin | centred on the arm's **midpoint** | the mesh sits at the *half* hub, so a profile drawn `0 → armLength` puts every motor mount 40 mm outboard of its own motor |

It is assembled from real parts rather than boxes: a tapered unibody bottom
plate sized from `plateArea__cm2`, a raised canopy, three tiers of standoffs
carrying the ESC, FC and RX (30.5 or 20×20 mounting, read off `stackOffset.y`),
four extruded arms ramped up to the motor mount plane with pads and bolts at the
frame's `motorPattern__mm`, motor bells with base, stator can, vent slots and
shaft (the heights sum to `height__mm` exactly, so the prop lands on the shaft
and not inside the bell), an angled camera pod with base plate, brackets, barrel
and glass, a finned VTX with its coax pigtail, the duck antenna on (-0.55, 0,
-0.83), a strapped pack with an XT60 and a balance lead, a capacitor, a camera
cage, GPS masts on the long-range frames and duct rings when the frame spec sets
`ducts`. Ducts are sized to land on the prop tip circle rather than outside it:
real guards do overhang, but overhang means visible plastic through walls.

`measureExtents(craft)` walks every vertex and returns the world X/Y/Z extents
under `Q_LEVEL` and under identity, plus the furthest vertex from the body
origin. Measured, not eyeballed — and measured from *vertices*, because the AABB
of a rotated prop blade reports corners at r·√2 and reads as a false "the model
is bigger than the collider":

| build | Q_LEVEL X | Q_LEVEL Y | Q_LEVEL Z | collider | swept radius |
| --- | --- | --- | --- | --- | --- |
| `f-5-race` 5×4.3 | 0.266 | 0.123 | 0.256 | 0.174 | 0.179 |
| `f-7-lr` 7×4 | 0.412 | 0.163 | 0.396 | 0.269 | 0.272 |
| `f-x-10` 10×4.5 | 0.602 | 0.225 | 0.576 | 0.392 | 0.393 |

Q_LEVEL leaves X ≈ Z with Y small (flat); identity leaves X ≈ Y with Z small,
which is the same pancake-on-edge failure as the table above. The bottom plate
on the stock 5" is 121 mm across the back against a 220 mm wheelbase, which is
the other number worth checking — it is supposed to be smaller than the arms are
long.

Two things the mesh cannot fix, both in `craft.js`:

- **The collision sphere is a planar radius used in 3D.** It is
  `hypot(hub.x, hub.y) + D/2000`, but the props sit `stackOffset.y +
  motorHeight + 4 mm` *above* the body origin and a pitched blade sweeps its tip
  another `r·sin(pitch)` up. Every frame's worst swept corner therefore sits
  0.4–7.6 % outside the sphere. The planar radius is exactly right — the prop
  tips reach `propTipRadius` and no further — but a conservative sphere wants
  the height folded in.
- **The battery's inertia box is below the bottom plate.** The pack is modelled
  on the canopy, pushed forward against the camera with the antenna sweeping
  back over it, which is where a real one lives.

Geometry and materials are cached **per instance**. They cannot be module-level:
three.js owns geometry lifetime, so a cache one `DroneModel` disposes pulls the
buffers out from under the other two (builder preview, sim, race).

The model is rebuilt only when the spec string changes: `build()` stores
`JSON.stringify(spec)` because `update()` compares against a string, and
storing the object tore the whole model down and rebuilt it every frame.

## Rates

The Tune view's Rates card is Betaflight's Rates page: a profile switch, per-axis
knobs, and a live curve for all three axes.

All three of Betaflight's profile types are implemented as the real formulas, in
`src/sim/rates.js`:

```
Actual:     rate = stick * centerSensitivity
                 + sign(stick) * |stick|^actualExpo * (maxRate - centerSensitivity)
Betaflight: rate = stick * rcRate + sign(stick) * |stick|^expo * superRate
                    (stick pre-shaped by rcExpo)
Kiss:       rate = stick * rcRate + sign(stick) * |stick| * superRate
```

with `actualExpo = 10^(expo/100)`, so expo 0 is linear and expo 100 is very flat
at centre. Stick goes through a shared deadzone first — `applyDeadzoneRange`
rescales the surviving travel, so full deflection still reaches max rate past
the deadzone rather than quietly capping below it.

Sliders shown per axis depend on the profile, as in Betaflight: Actual gets
**Centre sens / Max rate / Expo**, Betaflight gets **Rc rate / Super rate /
Expo / Rc expo**, Kiss gets **Rc rate / Super rate**. Yaw carries its own,
slower and flatter, defaults the way every real tune sets it up.

This replaced an inline hybrid that read Betaflight's legacy `rcRate`/`expo`
knobs and then applied a hand-rolled curve matching neither convention, so a tune
ported from the configurator behaved differently here. Old saves are migrated by
`normaliseRates()`, which maps the flat `rcRate`/`expo`/`centerSens`/`maxRate`
fields onto roll and pitch.

`rates` is a live reference held on the tune (`fc.rates === fc.tune.rates`), and
`applyTune()` re-points it. That matters: the Tune view edits rates in place, and
picking a library preset replaces `fc.tune` wholesale, so without the re-point a
preset change would silently leave the old curve in force.

## Controls

The Simulator's **Controls** panel binds a physical control surface to each of
the four flight channels (throttle, roll, pitch, yaw).

It is click-to-bind rather than a dropdown, because the mapping cannot be
enumerated ahead of time. A **RadioMaster Pocket** on USB enumerates as a
gamepad, but which axes its gimbals land on depends on the radio's joystick
driver and on how the radio is configured. So: click **Bind** on a channel, move
the stick or press the button you want on it, and the panel assigns whatever
moved. **Bind keyboard to &lt;channel&gt;** does the same for a key.

Per channel you then get invert, deadzone and expo. Expo matters more than it
looks: at expo 0 a gimbal is linear and feels twitchy, at expo 1 it is cubic and
hover trim becomes easy while full deflection is still reachable. **Calibrate
centre** records the current value as zero, for a gimbal that does not return to
exactly centre.

The binding model lives in `src/sim/controls.js` and is deliberately DOM-free so
it can be tested headless (`tests/controls.test.mjs`). A channel that is
unbound, or bound to a surface that is not currently connected, resolves to
`null` and falls back to the keyboard rather than snapping to centre.

Throttle is unidirectional in the sim (0..1), so a bipolar transmitter stick is
mapped centre-to-zero and full-deflection-to-one.

Every channel row carries an **inv** toggle directly beside its Bind button. A
transmitter whose yaw axis reads backwards is the single most common thing to get
wrong when binding, so it should not be buried behind selecting the channel first.

## Bugs worth writing down

All of these failed silently, with no error anywhere. They are noted rather than
just fixed because each one produced plausible-looking output.

**The aerodynamics were switched off, and nothing said so.**
`applyAero` gates every surface on `s.active`. Nothing in the codebase ever set
that field, and `!undefined` is true, so *every* surface was skipped: the whole
flat-plate model documented above was a no-op and `aeroDrag` was permanently
exactly 0.

**The aerodynamic forces pointed the wrong way.** The drag vector was negated
(`-w` instead of `+w`) and the plate normal force used the wrong sign. `w` is the
air's velocity in the body frame, and the force the air exerts points *downstream,
along +w* — a body sitting in a westerly is pushed downwind. With both signs
inverted, a craft falling at 20 m/s picked up **34 N of "drag" pushing it down**,
six times its own weight, so it accelerated into the ground instead of braking,
and a tilted plate pushed down where it should have lifted. The craft tumbled,
and any impact on a slab at 10 m/s or faster produced **NaN**.

**The prop discs and arms were modelled as flat plates normal to thrust.**
Roll rate `ωx` puts a `z`-velocity differential across any surface with `y ≠ 0`,
and a normal force on that surface produces more roll torque. Positive feedback:
the craft reached 892 rad/s and NaN in 1.3 s. A disc's normal force *is* thrust,
and `prop.solve()` already computes it, so arms and discs are drag-only now and
roll damping comes from the drag term.

**The prop blades were pitched about a fixed world axis.**
`rotation.z = spin` and `rotation.x = pitch` on the same object compose as
`Rx·Ry·Rz`, so the pitch landed about world X *after* the spin. Measured pitch
about each blade's own radial axis came out **−9.2 / 0.0 / +9.2 / 0.0 degrees** on
a 4-blade — an 18.4° spread, so the blades were not coplanar and each looked bent
the wrong way. The sign was wrong too, making a reverse-pitch prop. Fixed with a
nested group (outer spins about Z, inner pitches about X).

**The D term had the wrong sign.** `sum` drives the mixer in the same sense as P,
so D must *subtract* when the gyro is already accelerating. It was adding, which
made D anti-damping: sweeping D from 42 to 90 made step overshoot climb from 50%
to 68%. No test caught it, because every existing test asserted closed-loop
tracking, which a destabilising D still satisfies. `tests/pid.test.mjs` now
asserts the *direction* of each term.

There was also a quieter cousin: `Simulation` passed `pidDivisor: 1` while
alternating the PID loop every second tick. `stepCraft` hands `runPID` a
`dt * pidDivisor`, so the FC believed its loop period was half the truth and D's
derivative came out exactly 2× too large.

### Measured behaviour after these fixes

| preset | setpoint @50% stick | peak | overshoot | settle |
| --- | --- | --- | --- | --- |
| Stock 5" | 350 °/s | 425 °/s | 21% | 0.10 s |
| Smooth / cinematic | 214 °/s | 243 °/s | 14% | 0.10 s |
| Race / sharp | 531 °/s | 689 °/s | 30% | 0.10 s |
| Freestyle / soft | 331 °/s | 395 °/s | 19% | 0.10 s |
| Freestyle / filthy | 425 °/s | 541 °/s | 27% | 0.10 s |
| Long range / efficient | 173 °/s | 188 °/s | 9% | 0.10 s |

Free fall reaches 8.1 m/s terminal velocity; a 50 m drop rebounds 0.46 m.

## Weight distribution, and why angle mode used to tumble

**The CG sat ahead of the thrust line.** The pack is on the canopy pushed
forward against the camera, which is where a real one lives, but the stack and
camera are forward too, so everything pulled the centre of gravity ahead of the
motor axis — **6.5 mm forward on the stock 5"**. Thrust acts on the motor axis
while the body rotates about the CG, so that offset is a real nose-up moment, not
a modelling detail: the craft pitched back on its own with the sticks centred.

The pack position is now **solved** rather than guessed. `buildCraft` sums the
forward moment of every part added before the battery and places the pack so the
CG lands on the thrust axis — 0.00 mm fore/aft error on every frame, rather than
only the one the numbers were read off. The CG still sits well *below* the thrust
plane (about 23 mm on the stock build), which is what gives pendulum stability;
that restoring moment only appears once the craft is tilted, so it costs nothing
in level trim.

**Body-frame force positions are measured from the origin, but torque is taken
about the CG.** `addForceAtBody` was passing `bodyPoint` straight into the cross
product, so every aerodynamic force picked up a spurious moment of `com × f`
that scaled with airspeed. `body.com` now exists and the lever arm is shifted
first.

**`qToEuler` is gimbal-locked, and angle mode was differencing it.** ZYX is
singular at pitch = ±90: crossing that attitude flips the reported pitch by 180°
in a single step — **measured, a 289° jump** during a slow roll. Angle mode
computed `(desired − euler) × kp`, so the error was garbage; the loop saturated,
slammed the craft over, crossed the singularity again and oscillated through the
full 360°. Asking for 13.8° produced a **360° peak-to-peak** swing.

Angle mode now uses `attitudeErrorRate`, which takes the shortest rotation from
the current attitude to the desired one as an axis-angle vector. That has no
singularity anywhere, including inverted — the same approach Betaflight uses.
Measured after: 13.8° requested, 13.4° held, **0.1° peak-to-peak**.

`attitudeOf` itself still uses the ZYX extraction, so the HUD can still show a
jump at exactly ±90° of pitch. That is inherent to reporting three angles for a
rotating body and is cosmetic; nothing in the control loop depends on it now.

## Losing the craft

A rigid-body sim can be driven to a non-finite or astronomically large state by a
transient: a bad frame time, a deep penetration, a filter blowing up. Once that
happens **nothing recovers it on its own**. The camera follows the craft to
infinity, so the map and the quad both vanish, and every subsequent step
propagates the same infinities — which is why Reset looked like it did nothing.

`Simulation.watchdog()` runs immediately after each integration step. If the
craft's state is not finite, or it has left a generous margin around the arena
(four times `bounds.half`, six times the ceiling), it is put back on its spawn
point and the recovery is reported. The margins are deliberately loose: a fast
craft legitimately leaves the arena for a moment, and this is a last resort, not
a substitute for fixing the cause.

`App.resetCraft()` additionally snaps both camera rigs, so a recovery is
visible immediately instead of the rig spending seconds smoothing back from
wherever it was.

Restored bindings have to update the DOM as well as the model. `ControlsView`
builds its rows in the constructor from the defaults, so a `load()` that only
swapped the model left every checkbox showing the old value — a binding would
load correctly and still read the wrong way on screen.

Bindings persist through `persist()`, not only through the explicit Save. The
Controls panel persists on every change, so with the field missing from
`persist()` every rebind was written to `localStorage` and then dropped — the
mapping never survived a reload even though the panel said it had.

## Loading assets without re-downloading

`serve.js` used to send `Cache-Control: no-store` on every response, and
`scenery.js` fetched the glTF and its `.bin` buffers with `cache: 'no-store'`
as well. Together those guaranteed that every page refresh re-downloaded the
whole ~3.8 MB asset set.

Now the server sends an `ETag` and answers conditional requests with `304 Not
Modified`. Vendored assets — textures, models — are served
`public, max-age=31536000, immutable`, so after the first load the browser does
not even revalidate them. Source files are served `no-cache`, which stores but
revalidates, so an edit is still picked up on refresh. The `cache: 'no-store'`
fetches are gone; the existing empty-body retry is the real defence against a
poisoned cache entry and was never the reason for them.

Both of these failed silently, with no error anywhere, which is why they are
noted rather than just fixed.

**The aerodynamics were switched off and nothing said so.**
`applyAero` gates every surface on `s.active`. Nothing in the codebase ever set
that field, and `!undefined` is true, so *every* surface was skipped: the whole
flat-plate model documented above was a no-op and `aeroDrag` was permanently
exactly 0. The defaults are now set in the `AeroSurface` constructor, and
`tests/aero.test.mjs` asserts the surfaces are live and that they respond to
incidence and to airspeed — a test that fails if the gate ever comes back.

For the stock 5" this changes the numbers a lot, because there was previously no
air drag at all. Measured at 1.196 kg/m³, level, nose-first: **1.72 N at
20 m/s, 3.87 N at 30 m/s, 15.5 N at 60 m/s** — 0.31 g at 20 m/s, which is in the
right place for a 5" quad. The craft now actually reaches a terminal velocity
instead of accelerating indefinitely.

**The RF wavelength was short by a factor of a million.**
`fresnelRadius` and the two-ray ground term used `299.792458 / fMHz`, which is
metres-per-µs, not metres. At 5.8 GHz that produced a 51 mm wavelength instead
of 51 m, so the Fresnel clearance radius was ~1000× too small and the knife-edge
obstruction check effectively never fired. It is `299792458 / (fMHz * 1e6)` now.

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
| Propwash | Surface model: ground-effect turbulence plus a buffet term, plus a 3-pass mutual prop-to-prop term. The *test* asserts mutual wash is negligible on a coplanar quad, which is geometrically true: the offset between two coplanar props lies in the disc plane and stays perpendicular to the disc normal under any rigid rotation of the frame |
| Motor | Kt ≠ Ke (0.88 ratio), winding resistance scaling as `R ∝ KV^-1.7`, back-EMF, current limiting |
| Battery | OCV curve, ESR sag, polarisation, temperature, cycle age, cell imbalance |
| Airframe | Flat-plate aerodynamics on 11 surfaces (bottom plate, canopy, four arms, four prop discs, camera stack), prop thrust and reaction torque, gyroscopic precession |
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
  data/       parts catalog, track geometry, radio band plans, weather presets
  sim/        prop, motor, battery, fc, body, craft, environment, rf, sim,
              telemetry, rates (Betaflight profiles), controls (channel bindings)
  render/     viewport, drone mesh, cameras, fx, scenery, sky, materials
  race/       race state machine, ghost pilots, career
  ui/         builder, sim, tune, race, controls views, dom helpers
tests/        physics, frame, aero, controls, rates, rates.fc, imports, browser QA
```
