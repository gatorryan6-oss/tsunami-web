# Tsunami Simulator Web — project memory

**Read `BUILDLOG.md` before doing anything.** It is the single source of truth
for project state: which milestones are committed, what's deferred, and what
bugs are open. Do not rely on conversation history for any of that.

## What this repo is

The WebGL2 browser port of the desktop tsunami simulator (the adjacent repo,
`../tsunami simulator`). Phase 1 = physics parity + minimal teacher UI.
The port contract lives in the desktop repo's `port_package/`
(SHADER_INVENTORY.md, DATAFLOW.md, CONSTRAINTS.md, HARNESS.md, GAPS.md) —
read those before touching physics.

## Standing rules

1. **A milestone is not done until verification passes.** Before declaring any
   milestone complete: run `python verify.py` (smoke test) and
   `python -m pytest tests/test_invariants.py -q` (architecture checks).
   Both must pass on THIS machine — "the code looks right" doesn't count.
2. **Append to `BUILDLOG.md` at the end of every milestone.** Entry format is
   in that file's header. Log deferrals and open bugs there the moment they
   appear — that is how they survive to the next session.
3. **Extend earlier phases, never rebuild them.** If an earlier phase's code
   seems wrong, say so and stop; don't quietly rewrite it.
4. **Patch, don't regenerate.** Gaps become decimal milestones (M4.5), inserted
   when the build reaches that point.
5. **The desktop version is canonical for physics.** Where desktop and browser
   disagree beyond the HARNESS.md tolerance, the browser is wrong by
   definition. Fix the port; never "tune" the reference, never widen a
   tolerance, never regenerate the frozen reference `.npy`/`.json` data.

## Architecture invariants

These are enforced as tests in `tests/test_invariants.py`. If a test blocks
something you're trying to do, the test is right until the human says otherwise.

- **Physics shaders are verbatim ports.** `site/shaders/swe_hll_step.frag`,
  `swe_max_acc.frag`, `swe_hll_splat.frag`, `fullscreen.vert` must match the
  frozen desktop originals in `reference_shaders/` line-for-line outside the
  marked ES-3.00 header block. Improvements go to the DESKTOP first, then
  re-freeze.
- **Physics constants are frozen** and must appear verbatim where they live:
  `H_DRY = 1e-3`, `THETA = 1.3`, `WM_MIN_DEPTH = 1.0` (step shader);
  `SPLAT_MIN_DEPTH = 0.02` (splat); `ARRIVE_ANOMALY = 0.05` (accumulator);
  `CFL_SAFETY = 0.35`, `DT_MARGIN = 0.9`, `REFRESH_EVERY = 30` (solver.js).
- **`precision highp float` in every physics shader; `mediump` in the physics
  path is a parity bug by definition.**
- **All hazard consumption goes through `getHazardFields()`** (site/js/hazard.js).
  Nothing else reads the accumulator textures back.
- **The reference data under `site/data/` is frozen canon** (copied from the
  desktop `port_package/reference/`, commit 36adb05). Never edited, never
  regenerated here.

## Conventions adopted during the port (2026-07-16 Fable session)

- **Row order, everywhere:** fields are flat row-major Float32Arrays with
  j = 0 as the SOUTH row — which is also GL texture row 0, readPixels row
  0, and the order of the JSON data files. There are NO flips anywhere in
  the pipeline. (The desktop reference PNGs are flipped at save time for
  viewing; the data is not.) If a display looks upside down, fix the
  display, never the data path.
- **`solver.readState()` reuses one buffer** (4.2 MB at 513²) — consume
  immediately or copy. `readHazards()`/`readMomentum()` allocate fresh.
- **ES modules, no bundler, no node.** New pages import from `site/js/`
  directly; everything must keep working from `python -m http.server`.
- **Automation handles:** the app exposes `window.__app`
  ({solver, sim, scenarioData, draw}); the parity page sets
  `window.__PARITY__`; the contract page sets `window.__CONTRACT__`.
  Drive these from the console/tooling instead of adding test plumbing.
- **The display colormap lives in two places on purpose** (display.frag
  and the #colorbar CSS gradient in index.html) — keep-in-sync comments
  mark both. It intentionally matches the desktop reference PNGs.
- **Scenario setup order is frozen** (scenario.js mirrors
  make_reference.py): construct at rest on the PRE-event bed → enable
  tracking → apply source → reset tracking → snapshotMax. Reordering
  breaks the arrival field and scenario (c)'s t=0 exactness.
- **Sim speed honesty:** when the 24-substep cap engages, say so in the
  UI ("running below requested speed") — never silently drop time.

## How to run

- `run.bat` — serves the static site on **port 5078** (one double-click), then
  open http://127.0.0.1:5078/.
- `python verify.py` — starts the server if needed, hits it, checks the response.
- Parity: open http://127.0.0.1:5078/parity.html — runs all three reference
  scenarios against the frozen data and reports PASS/FAIL per criterion.

Port 5078 is this project's dedicated port (5000=FieldStop, 5050=Statecraft,
5055/5057/5077 = other projects — do not collide).
