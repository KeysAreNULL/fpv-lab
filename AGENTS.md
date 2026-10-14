# FPV Lab — agent instructions

Browser FPV drone builder, flight simulator and racer. **No build step.** Plain ES
modules loaded directly by the browser, Three.js vendored in `vendor/`, all
textures and models vendored under `assets/`. It runs offline. Do not introduce a
bundler, npm, TypeScript, or a transpiler.

**Assets are vendored, and downloads go through the browser.** Textures, models
and libraries are committed under `assets/` and `vendor/` so the app runs
offline. If something genuinely has to be fetched, download it directly through
the browser tooling — do not route it to IDM (or any external download manager),
which detaches the file from the session and makes the provenance unclear. Prefer
CC0 sources (ambientCG, Poly Haven).

## Run it

```sh
node serve.js 8123          # then open http://localhost:8123
node serve.js 8123          # server must be running for any browser QA
```

`?debug=1` publishes diagnostics to `document.documentElement.dataset.fpvDebug`
and sets `dataset.fpvLab = 'ready'` once boot finishes. Use it for every automated
check.

## Test it

```sh
node tests/imports.mjs       # every module parses — run this after ANY refactor
node tests/physics.test.mjs  # 73 checks: prop, motor, battery, FC, body, collision
node tests/frame.test.mjs    # 21 checks: body-frame signs, hover, reaction torque
node tests/aero.test.mjs     # the flat-plate aero model is actually live
node tests/controls.test.mjs # channel bindings: expo, deadzone, invert, resolution
node tests/rates.test.mjs    # the three Betaflight rate profiles
node tests/rates.fc.test.mjs # ...and that the FC actually applies them
node tests/pid.test.mjs      # D damps, P stiffens - the direction of each term
node tests/propgeom.test.mjs # prop blades coplanar and correctly pitched
node tests/flight.test.mjs   # hands-off hover holds attitude, no drift
node tests/stress.test.mjs   # sustained flight on real key input, every track
node tests/recover.test.mjs  # reset rescues a diverged craft; the watchdog holds
node tests/attitude.test.mjs # CG on the thrust axis; angle mode singularity-free
```

All fourteen must pass before you call a change done. `imports.mjs` is the cheapest
smoke test in the repo — run it first, it catches the majority of mistakes in
about a second.

Browser QA (needs the server up) drives the real DOM:

```sh
node tests/qa.mjs            # walks every preset, flies, races, checks console
node tests/qa-weather.mjs    # cycles all seven weather presets
```

### Two harness constraints that will waste your time if you forget them

- `page.evaluate` runs in an **isolated world**. Page globals like `window.fpvLab`
  are invisible. QA scripts must drive real DOM controls and read state from the
  debug channel.
- Screenshots only come from the CLI harness. A backgrounded/hidden tab throttles
  `requestAnimationFrame`, so the render loop stops and any measurement taken
  there is stale.

## Accuracy: the rules this codebase is actually built on

These are not style preferences. Each one exists because violating it produced a
wrong result that looked right.

1. **Measure, never eyeball.** This project's hardest bugs were invisible on
   screen. Extents, collider radius, hover current and drag were all verified by
   running numbers in Node. If you change geometry or physics, assert the number
   (`measureExtents`, `analyseBuild`, a test) — do not reason about it in your
   head, and never settle for "it looks right".
2. **Units are in the symbol name, and the suffixes are load-bearing.**
   `__mm`, `__cm2`, `__mah`, `__m`, `__deg`, `__kg`. A `plateArea__cm2` needs
   `/1e4` for m², **not** `/100` — that one mistake made a 190 cm² plate a
   1.38 m slab. `__r` in the catalog is **milliohms**. When you convert, write the
   conversion and its factor in a comment.
3. **The body frame is aerospace NED: X forward, Y right, Z down, right-handed.**
   World space is Y-up. The conversion lives in `R_LEVEL` / `Q_LEVEL` /
   `attitudeOf()` in `src/sim/craft.js`.
4. **Level is `Q_LEVEL`, never the identity quaternion.** Because the frame is
   NED, identity leaves the airframe rolled on its side. *Every* spawn and
   re-level path must use it — `Simulation.reset()` and the race grid both got
   this wrong once.
5. **The FPV camera needs a basis, not a rotation.** It looks down its own `-Z`
   while the nose is body `+X`, which takes two rotations and one of them is easy
   to forget. Build the forward/up vectors explicitly and hand them to `lookAt`
   (`CameraRig.fpvPose`, `applyFpvOrientation`). Anything reproducing the FPV pose
   elsewhere — the delayed feed — must use the same basis.
6. **Mixer signs follow from the frame, not from the table.** `MIX_TABLE` in
   `fc.js` is asserted against thrust *direction* in `frame.test.mjs`. Roll right
   = more thrust on the **left** motors. Never trust the table; trust the test.
7. **Three.js gotchas that are load-bearing here:**
   - `scene.environment` must be set. Metalness with no env map renders
     near-black. `Viewport` builds a PMREM gradient from the current sky.
   - **Geometry and material caches are per instance, never module-level.**
     three.js owns geometry lifetime; a module-level cache disposed by one
     `DroneModel` pulls buffers out from under the other two.
   - Anything the camera sits inside has to fade (`Viewport.render` near-fades
     gates and pads; the craft is hidden outright in FPV mode).
8. **Track `bounds` are a backstop only, and must sit outside all real geometry.**
   A bound inside a slab drags the craft back down through the slab and out the
   floor. `physics.test.mjs` asserts every track's ceiling clears its roof slab.
9. **Guard against silently-disabled code.** The worst bug in this repo was a
   `if (!s.active) continue;` where nothing ever set `active`, which quietly
   disabled the entire aerodynamic model with no error anywhere. If you add a
   flag or an `enable`/`active` gate, grep for the setter and add a test that
   fails when the flag is absent.
10. **Never store an object where a string is compared.** `DroneModel.build()`
    stores `JSON.stringify(spec)` because `update()` compares strings; storing the
    object tore down and rebuilt the whole model every frame.

## Efficiency: how to work in here

- **Explore before editing.** `grep`/`glob` first, always. This repo is ~400 KB of
  JS across 30 modules and the answer is almost never in the file you guessed.
- **Verify claims against code, not against memory or against comments.**
  Several comments and README statements in this repo have drifted from the
  implementation. When the README and the code disagree, the code is the truth —
  fix the README.
- **Smallest correct change.** No speculative refactors, no reformatting, no
  "while I was in there". A diff that touches only what the task requires is
  reviewable in one pass.
- **Keep the fast loop fast.** `imports.mjs` (~1 s) → the two test files →
  browser QA. Do not open a browser to check a parse error.
- **Read the file header before editing the body.** Every module in `src/`
  documents *why* it is shaped the way it is. Those comments are load-bearing
  context, not decoration.
- **Comment the non-obvious, not the obvious.** The house style explains *why* a
  number is what it is ("the planar radius is exactly right, but a conservative
  sphere wants the height folded in"). Match it.

## Layout

```
src/
  core/       math helpers
  data/       parts catalog, track geometry, radio band plans, weather presets
  sim/        prop, motor, battery, fc, body, craft, environment, rf, sim, telemetry
  render/     viewport, droneMesh, cameras, fx, scenery, sky, materials
  race/       race state machine, ghost pilots, career
  ui/         builder, sim, tune, race views, dom helpers
tests/        physics, frame, imports, browser QA
vendor/       three.module.js, GLTFLoader.js, Sky.js
assets/       CC0 ambientCG textures and glTF scenery models
```

## Definition of done

- All fourteen Node suites pass (`imports`, `physics`, `frame`, `aero`, `controls`, `rates`, `rates.fc`, `pid`, `propgeom`, `flight`, `stress`, `recover`, `attitude`).
- Browser QA runs clean with no console errors.
- Any new invariant has a test that **fails without the fix**. A test that passes
  before and after is not a test.
- README updated if behaviour, file layout, or a documented number changed.