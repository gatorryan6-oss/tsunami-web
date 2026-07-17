# Build log — Tsunami Simulator Web

Single source of truth for project state. Newest entry at the top of the
Milestones section. Claude Code: read this whole file at session start; append
an entry at the end of every milestone. Never delete or rewrite old entries.

Entry format:

```
## YYYY-MM-DD — M[n]: [milestone name]
- Shipped: [what now works, one or two lines]
- Deferred: [anything pushed to later, with the milestone it moved to]
- Open bugs: [anything known-broken, even if minor]
- Decisions: [any design/architecture choice made mid-milestone]
```

---

## Current state (seed this once when installing, then let entries take over)

- **Committed:** nothing yet — repo created 2026-07-16 by the Fable port
  session (Prompt 2 of the desktop repo's `tsunami_webgl_port_fable_prompts_1.md`).
- **Deferred:** everything past Phase 1 (damage/casualty/scoring models, town,
  defenses, 3D render stack, DEM import, extra sources — see the desktop
  repo's CONSTRAINTS.md non-goals).
- **Open bugs:** none known.
- **Next up:** M0 walking skeleton → M1 physics core → M2 parity gate
  (STOP for Gate 1) → M3 hazard accessor → M4 minimal UI (STOP for Gate 2).

## Standing rules (accumulated this session; keep appending)

1. **Desktop is physics-canonical.** Browser-vs-reference disagreement beyond
   HARNESS.md tolerance = browser bug. Never tune references or tolerances.
2. **Physics shaders are verbatim ports** of `reference_shaders/*` (frozen
   copies of the desktop originals at commit 36adb05). The ONLY allowed
   difference is the marked ES-3.00 header (version + precision). Enforced by
   `tests/test_invariants.py`.
3. **Fixed-dt banked-time stepping** (`Simulation.advance` contract): every
   substep in a frame uses the SAME dt; fractional remainders are banked,
   never run short. A varying dt parametrically pumps energy (measured blowup
   on desktop). Cap 24 substeps/frame, drop backlog honestly.
4. **Parity sampling rule:** a snapshot is the state at the FIRST substep
   whose cumulative t ≥ t_requested. The dt sequence itself is expected to
   differ from the reference (priced into tolerance).
5. **Port 5078** is this project's server port — recorded in CLAUDE.md,
   guarded by test_invariants (run.bat and verify.py must agree).
6. **No silent GL degradation:** missing `EXT_color_buffer_float` = loud
   full-screen failure. Missing `OES_texture_float_linear` = display-only
   fallback (NEAREST), physics untouched, console note.

---

## Milestones

(entries accumulate here, newest first)

## 2026-07-17 — DEPLOYED: live on Cloudflare Pages
- Shipped: **https://tsunami-web.pages.dev** — GitHub repo
  (gatorryan6-oss/tsunami-web, master) connected to Cloudflare Pages with
  auto-deploy on every push. Settings: build command empty, output
  directory `site`. No code changes were needed to deploy.
- Verified against the LIVE site (2026-07-17): /parity.html → PASS all 3
  scenarios within tolerance (28.0 s); /tests.html → PASS all 14 contract
  checks. The public site reproduces the desktop physics, full stop.
- Note: Pages "pretty URLs" 308-redirect /parity.html → /parity and
  /tests.html → /tests. Browsers follow this transparently; both forms
  work. Plain curl needs -L or the extensionless form.
- Chromebook verification (GAPS #1) is now trivially available to anyone:
  open https://tsunami-web.pages.dev/parity.html on the target machine and
  look for the green PASS banner. Still pending actual Chromebook hardware.
- Decisions: master = production branch; every future push to master
  deploys automatically (~40 MB data re-uploads are deduplicated by Pages,
  so pushes stay fast).

## 2026-07-16 — M4.5: event fires on Run, not on load (user-caught UX gap)
- Shipped: scenarios now load AT REST on the pre-event bed (calm ocean) and
  the source fires on the first Run press after a ~0.9 s narrated beat
  ("Mw 9 rupture! The seafloor jumps — and the sea surface above copies it
  instantly."). Before this, the near-field scenario sat parked at the
  post-quake t=0 state — a screen already red before Run, which erased the
  cause-and-effect teaching moment (user report). scenario.js split into
  createSolverAtRest + fireScenarioSource; createSolverForScenario
  composes both, so the PARITY path is byte-for-byte the same recipe —
  re-ran /parity.html after the refactor: PASS, all 3 scenarios (25.3 s).
- Also shipped: run-lan.bat — serves on 0.0.0.0:5078 for Chromebook/
  classroom access over the local network (run.bat stays localhost-only).
- Verified: before Run — 0 red pixels, anomaly exactly 0, status says the
  event is armed; during the beat — narration + disabled button; after —
  the uplift flash appears and the solver clock is still 0 (the source
  lands at t = 0 exactly like the reference recipe; no stepping happens
  during the wait, so the wavemaker window is never mid-cut).
- Open bugs: none.
- Decisions: the beat is WALL time only, never sim time — sources must
  land on a zero clock (desktop landmine: installing a wavemaker whose
  window is already open mid-cuts the train).

## 2026-07-16 — GATE 2 CLOSE-OUT (end of the Fable port session)

### Final verification results, verbatim

Parity harness (http://127.0.0.1:5078/parity.html, this machine's Intel
iGPU, run at close-out — identical numbers to the M2 run, i.e. fully
deterministic):

```
PASS — all 3 scenarios within tolerance (25.5 s)
a_deep_propagation — PASS
t=60    60.24 / 60.24     2.97e-6   3.92e-7   217497
t=120   120.08 / 120.08   3.17e-6   6.06e-7   217497
t=180   180.31 / 180.31   3.17e-6   7.15e-7   217497
t=240   240.15 / 240.15   3.38e-6   8.49e-7   217497
t=300   300.39 / 300.39   7.57e-6   9.68e-7   217497
extent  end t=300.4 s     Jaccard 0.0000 (0/0 cells)      0 vs 0 ref
b_shelf_shoaling — PASS
t=400   400.26 / 400.26   4.83e-6   9.88e-7   217497
t=900   900.23 / 900.23   4.13e-6   1.01e-6   217497
t=1400  1400.33 / 1400.33  5.22e-6  1.04e-6   217498
t=1900  1900.05 / 1900.05  1.10e-5  1.08e-6   218191
t=2400  2400.17 / 2400.17  4.28e-6  1.12e-6   219179
extent  end t=2400.2 s    Jaccard 0.0006 (1/1649 cells)   1649 vs 1648 ref
c_nearfield_inundation — PASS
t=0     0.00 / 0.00       0.00e+0   0.00e+0   217497
t=300   300.26 / 300.26   3.46e-6   9.64e-7   217617
t=900   900.11 / 900.11   5.12e-6   1.38e-6   218561
t=1500  1500.23 / 1500.23  7.40e-6  2.63e-6   221488
t=2400  2400.16 / 2400.16  1.82e-5  4.79e-6   222561
extent  end t=3000.2 s    Jaccard 0.0000 (0/4916 cells)   4916 vs 4916 ref
(columns: snapshot | t actual web/ref | rel_L∞ ≤1e-3 | rel_L2 wet ≤1e-4 | wet cells)
```

Accessor contract (http://127.0.0.1:5078/tests.html):
`PASS — all 14 contract checks` (momentum pin 36.0000 exact, speed 3.0000).

Kit verification:
```
PASS: http://127.0.0.1:5078/ returned 200 and all 2 expected markers.
17 passed in 0.02s   (tests/test_invariants.py)
```

### Current state

Phase 1 (WebGL2 port with verified physics parity) is COMPLETE: M0–M4 all
shipped and committed (fc87069 → 56f06f3). The app runs at
http://127.0.0.1:5078/ via run.bat: three reference scenarios as presets,
run/pause/reset/speed, colorbar + 20 km scale bar, physics at 513² with
~1.6–2.2 ms/substep on this Intel iGPU (×60–90 sim speed available;
default ×30).

### Exact next action (for the next session, any model)

1. Ask the human: deploy to Cloudflare Pages now? The site/ folder IS the
   deployable artifact (static, no build step). Point Pages at the repo,
   root = site/. Nothing in the code needs changing.
2. GAPS.md item 1 (desktop repo): confirm the two GL extensions and run
   /parity.html + /tests.html on a REAL Chromebook — the whole harness
   runs in-browser precisely so the target machine can verify itself.
   **2026-07-16 status: DEFERRED — no Chromebook on hand.** Deployment
   (item 1) is the realistic route anyway: school Chromebooks can't reach
   a home-LAN server; once the site is public, verification is "open the
   URL." A phone/tablet on the local Wi-Fi is a strong interim proxy —
   mobile GPUs (Mali/Adreno) are the same silicon class as budget
   Chromebooks and exactly the fp16/mediump-risk hardware the harness
   guards against (run-lan.bat prints the address to visit).
3. After that, the natural phase 2 is the damage/casualty models consuming
   getHazardFields() (the contract is tested and frozen), or the 3D view
   (desktop render shaders are inventoried "translates directly").

### Open bugs, ranked

- None known in the app.
- (Tooling, not the app) The embedded dev browser pane runs the tab
  hidden: rAF is suspended there and screenshots time out. Verify UI
  changes by driving window.__app.sim.advance()/draw() directly, or use a
  real browser window.

### Standing rules accumulated this session

The six in the header section of this file (desktop-canonical physics,
verbatim shaders, fixed-dt banking, first-crossing sampling, port 5078,
loud GL failure) — all unchanged, all enforced where a test can enforce
them. No rule was added after M0; none was violated.

### Traps — the three things most likely to mislead a model that wasn't here

1. **The physics shaders look editable. They are not.** Any "cleanup,"
   "optimization," or ES-idiom change to site/shaders/{fullscreen.vert,
   swe_hll_step,swe_max_acc,swe_hll_splat}.frag breaks
   tests/test_invariants.py, which diffs them line-for-line against
   reference_shaders/ outside the marked ES header. That is by design:
   physics changes go to the DESKTOP repo first, get re-verified there,
   then re-freeze here. If the invariant test blocks you, the test is
   right.
2. **The dt machinery is a contract, not an implementation detail.**
   stableDt() is a cached CFL readback (refresh every 30 calls, 0.9
   margin) and the parity runner calls it once per SUBSTEP — the same
   cadence the desktop exporter used. Simulation.advance banks fractional
   remainders and never steps short; every substep in a frame uses the
   SAME dt. "Fixing" any of this (fresher dt, running the remainder,
   per-substep exact readback) will still look fine for minutes and then
   either destabilize the scheme or silently change the dt sequence the
   harness prices in.
3. **solver.readState() returns a REUSED buffer.** Two calls = the second
   overwrites the first's contents (deliberate: 4.2 MB/call at 513²).
   Consume immediately or copy. The parity runner compares inside take()
   for exactly this reason. readHazards()/readMomentum() allocate fresh
   arrays and are safe to hold.

## 2026-07-16 — M4: teacher-facing minimum UI
- Shipped: colorbar (CSS gradient sampled EXACTLY from display.frag's
  anomaly ramp — keep-in-sync comment at both sites), 20 km distance scale
  bar (sized from canvas clientWidth vs domain_m, resize-aware, verified
  pixel-exact 110/110), sim clock in teacher units ("12 min 05 s"),
  scenario description line from params.json, "running below requested
  speed" honesty note when the 24-substep cap engages, footer links to the
  parity + contract pages. Scenario picker / run/pause/reset / speed
  already existed (M1 shell) — this completes the M4 list; nothing beyond it.
- Verified: pause holds the clock, reset rebuilds the scenario at t=0,
  120 synthetic frames at x30 gave 57.46 s sim vs 57.6 requested
  (remainder banked, never stepped short), canvas fully painted.
- Deferred: nothing.
- Open bugs: none in the app. (Dev-tooling note: the embedded browser
  pane's tab is hidden, so rAF is suspended there — UI loop verified by
  driving frame() body directly; a real visible browser window runs it
  normally.)
- Decisions: hidden-tab rAF suspension is accepted as correct behavior
  (sim pauses when not watched; 0.1 s wall-clamp prevents jumps on return).

## 2026-07-16 — M3: hazard accessor contract encoded as tests
- Shipped: site/tests.html + site/js/contract.js — the JS mirror of the
  desktop tests/test_hazard.py §5 (the declared accessor contract) plus the
  §3 analytic momentum pin. 14/14 checks PASS on this machine: uniform-flow
  speed 3.0000 m/s and momentum h*u² = 36.0000 exactly; running-max
  property; four Float32Array(n²) fields; non-negativity; arrival sentinel
  -1 + dry-cells-have-no-arrival; arrivalRange interval; extent = (depth >
  0.1 m) & (bed > 0) exactly, land-only, 258 cells flooded on the test
  beach. (getHazardFields()/inundationExtent themselves shipped in M1 and
  already fed the M2 extent comparison — M3 is the contract-as-test.)
- Deferred: nothing.
- Open bugs: none.
- Decisions: the desktop's "accessor equals raw solver reads" equivalence
  check is omitted in JS — it holds by construction (hazard.js is the only
  wrapper) and statically (test_invariants.py forbids other callers);
  contract beach run extended 400→800 s because this test also asserts
  FLOODING (measured onset ~500 s), not just arrival like the desktop's.

## 2026-07-16 — M2: parity gate PASSES (all 3 scenarios, first run)
- Shipped: site/parity.html + site/js/parity.js — loads each reference
  scenario, steps headlessly with the exporter's exact rule (one stableDt()
  per substep; snapshot at FIRST substep crossing t_requested), compares h
  per snapshot + final inundation extent through getHazardFields().
- Measured on this machine (Intel iGPU, Chromium-based browser pane),
  browser vs frozen desktop-GPU reference:
    a_deep_propagation:     L∞ 3.0e-6..7.6e-6, L2 3.9e-7..9.7e-7, extent 0/0
    b_shelf_shoaling:       L∞ ≤1.1e-5, L2 ≤1.1e-6, extent 1/1,649 (J=0.0006)
    c_nearfield_inundation: t=0 EXACTLY 0.0; L∞ ≤1.8e-5, L2 ≤4.8e-6,
                            extent 4,916/4,916 EXACT (J=0)
  Tolerances are 1e-3 / 1e-4 / 0.02 — headroom 50–300×. The browser sits in
  the same noise band as the desktop's own CPU-vs-GPU divergence (worst
  2.9e-5 / 4.3e-6), which is the definition of success in HARNESS.md.
  Full 3-scenario run: 22.5 s (~14,400 substeps ≈ 1.6 ms/substep at 513²
  including readbacks and JSON fetches).
- Deferred: nothing new.
- Open bugs: none.
- Decisions: parity runs in-browser (real GPU — a Chromebook can verify
  itself by opening /parity.html); results exposed at window.__PARITY__ for
  automation. "npm run test:parity equivalent" = open /parity.html; no node
  toolchain introduced (CONSTRAINTS: no build-step exotica).

## 2026-07-16 — M0+M1: scaffolding, walking skeleton, physics core ported
- Shipped: kit scaffolding (CLAUDE.md, BUILDLOG, verify.py on port 5078,
  run.bat, settings hook, tests/test_invariants.py — 17 checks green);
  reference data copied from desktop port_package (JSON views, 40 MB) into
  site/data/; desktop physics shaders frozen in reference_shaders/ and
  ported VERBATIM to GLSL ES 3.00 (only the marked header differs —
  enforced by test); solver.js = method-for-method port of
  GPUNonlinearSWESolver (3-texture RK2 rotation, cached-CFL stableDt,
  splat, coseismic, wavemaker stages, MRT hazard accumulator);
  wavemaker.js, sim.js (banked fixed-dt advance), hazard.js
  (getHazardFields + inundationExtent), scenario.js (data loaders +
  make_reference.py source-application order), display pass matching the
  reference-PNG colormap, index.html shell with scenario picker /
  run/pause/reset/speed.
- Verified on this machine (Intel iGPU, browser): scenario (a) boots,
  stableDt = 0.3963 s (exact CFL match vs hand calc), 2 m splat spreads
  into a ring (peak 0.36 m at t = 40 s), volume ratio over 100 substeps =
  1.00000001 (mass conserved), no NaN, display paints ocean/land/anomaly.
  Measured 2.23 ms/substep at 513² incl. accumulator — inside the < 2×
  desktop budget from CONSTRAINTS.md.
- Deferred: updateBed (sculpting), addSurfaceDisplacement, updateRoughness
  (editing interactions — later phase per DATAFLOW §4); gauges/readRow;
  async readbacks (correctness never needs them).
- Open bugs: Browser-pane screenshots time out in this dev environment
  (tooling quirk, not the app — pixel sampling via 2D-canvas copy works and
  is what the checks use).
- Decisions: state textures NEAREST unless OES_texture_float_linear exists
  (display-only fallback, physics filter-independent per texelFetch);
  window.__app debug handle exposed for console checks; display view is
  2D top-down for phase 1 (3D terrain/water/sky stack is a later phase —
  SHADER_INVENTORY says it translates directly when wanted).
