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
