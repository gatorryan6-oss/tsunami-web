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

## 2026-07-18 — M11: economic layer — annualized risk table + EWS cost-benefit
- Scoped by user Q&A: cost-benefit + risk table, NO construction game;
  return periods illustrative; dollars and lives annualized SEPARATELY
  (never merged — no composite grade). Turns the outcomes the port already
  computes into economic DECISIONS.
- Shipped: `js/economy.js` (illustrative annual rates mapped from the
  desktop catalog — A 1/30 yr common far pulse, B 1/75 yr the regional,
  C 1/500 yr the near-field monster; EWS $15M; the annualize() math +
  compact fmtUsd). A "Risk & cost — design for which wave?" panel below
  the dashboard: a table (event · frequency · per-event deaths·loss ·
  per-YEAR deaths·loss) that BANKS each scenario's outcome as it's run —
  the property loss plus deaths in all four day/night × warned/unwarned
  combos, re-assessed from the SAME hazard fields (no re-run), so the
  ☀/☾ and 🚨 toggles re-price the whole annualized table INSTANTLY. A
  total line (expected deaths/yr · $/yr across events faced) and the EWS
  cost-benefit line.
- The lesson, verified live: **B (regional) 974 deaths/event → 13.0/yr;
  C (monster) 2,417/event → 4.8/yr** — the FREQUENT regional is the
  bigger ANNUAL killer despite C being deadlier per event (risk =
  consequence × frequency). The EWS line: "$15M once: annualized deaths
  17.8/yr → 4.8/yr (prevents ~13/yr). Property loss unchanged — warning
  saves lives, not buildings" — because the EWS fixes exactly the regional
  that dominates the annual toll, and does nothing for C or for property.
  Night re-prices instantly (B 1,591/event → 21.2/yr, total 28.6/yr,
  EWS prevents 21.2/yr); EWS-on drops B to 0 and the total to 4.8/yr.
  Empty state shows all three rows "1 in N yr · — run it —" with a
  build-your-profile prompt.
- Verified: annualized arithmetic exact (13.0 = 974/75, 4.8 = 2417/500,
  21.2 = 1591/75), toggles re-price from banked combos with no re-run,
  empty/partial states correct. invariants 18/18, verify.py PASS. Purely
  additive display + arithmetic on the already-canon-verified damage/
  casualty models — no physics, shaders, or model changes; parity stands.
- Deferred: buildable defenses + budget (the "spend to protect" loop) —
  the natural next economic dimension, and where the "property loss
  unchanged by warning" line points (walls, not warning, save buildings).
- Open bugs: none.
- Decisions: LIVE-banked, not baked (the table shows YOUR runs' numbers,
  matching the dashboard and the project's reproduce-don't-fabricate
  ethos); all four day/night × warning combos banked per run so toggles
  never require a re-run; lives never monetized (deaths/yr and $/yr on
  separate lines).

## 2026-07-17 — M10: UI polish — dashboard cards + grouped controls (user-scoped)
- Scoped by user Q&A: design for Chromebook AND projector (key numbers
  legible from the back row); readouts as DASHBOARD CARDS; controls as
  LABELED GROUPS in one bar; onboarding explicitly DEFERRED by the user
  ("I will add to this later").
- Shipped: the three small monospace readout lines (#town/#damage/
  #casualty) replaced by a five-card dashboard row under the map —
  SIMULATED TIME (the clock card now owns the teaching quantity; the
  status line keeps fps/telemetry), TOWN (population · buildings · value,
  constant baseline; town-load errors surface here), DAMAGE ($B ·
  %-of-value · collapsed · critical), DEATHS (~N · of-present · hurt),
  EVACUATION (% · the ☀/☾ + 🚨 conditions it was priced under — so
  toggling visibly re-prices). Numbers clamp(1.15rem→1.6rem), tabular
  figures; severity classes color the number (bad red / warn amber / good
  green: damage ≥40% bad, deaths ≥1 bad else good, evac ≥70 good / 30–70
  warn / <30 bad). The eight controls clustered into four captioned
  groups: SCENARIO (picker+Run+Reset) · CONDITIONS (☀/☾, 🚨) · VIEW
  (2D/3D, overlay) · SPEED. Reset blanks the outcome cards but keeps the
  conditions (they're settings, not outcomes) and the town baseline.
- Verified (real DOM via the app's own buttons): boot = groups
  [Scenario·Conditions·View·Speed], population card "3,749 · 850
  buildings · $0.48B", outcomes "—/no event yet". Scenario C flooded:
  Damage "$0.44B · 93% · 828 collapsed · 3/6 critical" (bad), Deaths
  "~2,416 of 2,867 · ~4,832 hurt" (bad), Evac "16% · ☀ day · no warning"
  (bad). ☾ Night click → "~3,666 of 3,749" (re-priced). 🚨 click on C →
  evac stays 2% (near-field: correctly unhelped). Scenario B + 🚨 →
  Deaths "~0" GREEN, Evac "100%" GREEN — the EWS lesson as a green
  dashboard. Reset → outcomes blank, conditions persist. invariants
  18/18, verify.py PASS (markers unaffected). Display-only: no physics,
  no shader, no model changes; parity untouched by construction.
- Deferred: onboarding/guided hints (user will spec later); the polarity-
  flip decision (separate thread); clock-card live-update verified by
  code-path identity only (hidden-pane rAF suspension blocks observing
  it here — same writer block that drove the old status clock).
- Open bugs: none.
- Decisions: conditions shown IN the evacuation card's sublabel (the
  number and the assumptions it was priced under travel together);
  population card persists across scenarios (same town by design).

## 2026-07-17 — M9.x: regional early warning (the EWS lesson, closes the M7 gap)
- Shipped: the deferred regional early-warning refinement — a "🚨 Warning"
  toggle that makes the difference between everyone-out and no-one-out for
  a DISTANT source, and near-nothing for a near-field quake. `js/events.js`
  (distillation of the desktop core/events/catalog.py): per-scenario source
  nature + the desktop's `_assessment_evac()` rule via `evacTimingFor()` —
  detection = EWS ? 30 s : the event's unwarned delay; and the casualty
  clock starts at the RUPTURE. Scenario B = regional (350 km / 3.5 km-deep,
  unwarned 2400 s); its wave enters the map at t=0, so the rupture sits at
  t_quake = −travel_time (−1889 s), crediting the same warning window the
  desktop gets by delaying the physics. Scenario C = near-field (t_quake 0,
  unwarned 180 s); A = offshore (no town relevance). app.js: `ewsOn` state
  + toggle (re-assesses casualties, like day/night); the casualty readout
  now names the mode ("no warning system" / "early warning ON"). The
  evac timing is chosen per scenario + EWS state in assessDamage.
- Verified: contract page **32/32** (+3 regional-canon checks) — the
  browser reproduces desktop-computed regional casualties (unwarned 2408 /
  EWS 785 on the synthetic fields) to machine epsilon, EWS-cuts-deaths
  pinned. LIVE IN-APP on the real physics: **scenario B (regional) — EWS
  off 974 dead / evac 45% → EWS on 0 dead / evac 100%** (matches the
  desktop's measured 1066→0: "warning, not walls, saves lives here").
  **Scenario C (near-field) — EWS off 2417 → on 2416 (0% reduction)**: no
  siren beats the near-field water — the essential counterpoint. invariants
  18/18, verify.py PASS. No physics/shared-shader changes (events.js +
  app-wiring + canon/contract only), so parity stands.
- Deferred: nothing for this thread — the early-warning lesson is complete
  both directions. (The desktop's $-cost EWS *defense* + budget system is a
  separate Phase-B feature never ported; the web models the EWS as a free
  teaching toggle, the right call without the economy.)
- Open bugs: none.
- Decisions: EWS as a toggle (not a purchase — the web port has no budget
  system); regional t_quake = −travel_time (shift the clock origin rather
  than delay the physics — identical warning window, keeps scenario B's
  frozen reference intact); the EWS toggle applies to all scenarios so the
  near-field "it doesn't help" is itself visible.

## 2026-07-17 — M9: hazard-overlay toggles (2D map + 3D terrain)
- Shipped: the four accumulated hazard fields as toggleable heatmaps on
  BOTH views, from one control + one legend. `js/intensity.js` — the JS
  mirror of the desktop core/hazard/intensity.py HAZARD_FIELDS: the single
  source of the overlay ramps, ranges, units, and paint domains (depth
  0.05–8 m land-only, speed 0–8 m/s land-only, momentum 0–200 m³/s²
  land-only, arrival auto-ranged everywhere-the-wave-reached), plus
  rampCss (legend gradient), rampUniforms (shader arrays), legendLabels
  (arrival shown in minutes). An "Overlay" `<select>` (None + the four
  fields) drives `setOverlay()`; the #colorbar legend swaps its title,
  gradient, and end labels to the active field (and restores the anomaly
  ramp on None). 2D: `display.frag` gains an overlay branch (same channel
  select + hazard_ramp as the 3D terrain) that REPLACES the base map where
  the field is valid + in-domain. 3D: the `terrain.frag` overlay branch —
  ported dormant back in M8a — is now wired in `scene3d.render(…, overlay)`
  to the SAME field spec + range, so both views paint one field
  identically. Both sample the solver's LIVE accumulator textures via a
  new display accessor `solver.hazardTextures` ({acc0, acc1}) — GPU-to-GPU,
  zero readback; the damage/casualty MODELS still consume through
  getHazardFields() (the accessor contract is intact — this is the
  display path the desktop's terrain_render uses too). Arrival's
  auto-range refreshes through getHazardFields()/arrivalRange() at the
  30-frame cadence.
- Verified (fresh self-contained modules on the live context; the app
  boots cached shaders in this pane, so tested by compiling the current
  display.frag + a directly-built fresh solver): at a flooded town cell
  (depth 5.83 m, bed 2.93 m) the four overlays paint DISTINCT, physically-
  correct ramp colors — depth (221,37,25) red-violet [matches the hand-
  calc at t=0.727], speed (61,31,209) blue-violet (fast), momentum
  (71,0,66) deep purple (high drag), arrival (79,196,103) green (arrived
  late at the town) — vs the anomaly base (198,47,31). 3D: depth overlay
  changes 37.5% of pixels (the inundated LAND), arrival 83.3% (ocean +
  land — the everywhere domain), exactly the field domains. Legend swaps
  correct for every field. GL error 0. **Parity re-verified (solver.js
  gained only the additive getter): scenario C identical to baseline —
  t=0 exactly 0.0, L∞ ≤1.82e-5, extent Jaccard 0.** invariants 18/18
  (hazard boundary intact — hazardTextures is not a readback), verify.py
  PASS.
- Deferred: the polarity-flip decision (BUILDLOG 2026-07-17) is about the
  ANOMALY ramp, not these overlays — the arrival ramp is already
  red=soonest by design; no flip needed here.
- Open bugs: none. (Dev-pane note persists: cached shaders/modules — the
  app boots the HTTP-cached display.frag/solver.js; a fresh visitor /
  hard-refresh gets the overlay. Fresh-import self-contained testing is
  the reliable local check.)
- Decisions: overlay = a shared display MODE (2D + 3D from one control);
  replace-while-active on the 2D map (chosen — two colormaps at once are
  unreadable); the overlay samples accumulator textures directly (display
  path), distinct from the getHazardFields() model path.

## 2026-07-17 — M8c: the town in 3D (instanced buildings + damage tint) — 3D view complete
- Shipped: `shaders/building.vert+frag` (ports of the desktop originals;
  explicit `layout(location=N)` qualifiers replace moderngl's name-based
  attribute binding — locations 0-1 per-vertex cube pos/norm, 2-5
  per-instance center/scale/rot/color) and the town section of
  `scene3d.js`: one 36-vertex unit cube + an 850×11-float instance buffer,
  the whole settlement in a SINGLE instanced draw, sunk SINK_M=1.5 m so
  boxes never float on slopes. Draw order terrain → TOWN → sky → water:
  buildings are opaque, so a flooded building shows through the
  translucent sea surface above it. `setTown(town)` builds instances from
  the frozen town.json (buildings never move — no sculpting in the web
  port); `setTownColors(Float32Array)` rewrites the color columns (37 KB
  re-upload at the damage cadence — trivial). losses.js: the damage ramp
  refactored into `damageColorRgb` (floats) with `damageColorCss` derived
  from it — the 2D overlay and the 3D instances tint from ONE function,
  so the two views can never disagree. app.js: `scene3d.setTown` per
  scenario (restores base colors on load/reset); assessDamage pushes the
  per-building tint to the 3D instances alongside the 2D readouts.
- Verified (in-browser, fresh self-contained modules — solver + town +
  scene built from scratch on the live context): GL error 0 throughout;
  render-diff with/without town = 5,346 changed sample pixels at 2.6 km
  (the settlement's footprint); scenario C fired and run to t=1500 s,
  damage assessed on the REAL hazard fields (92.8% loss / 828 collapsed —
  matching every M6/M7 number), tint pushed: red-building pixels 0 before
  → 812 after. Full scene (terrain + 850 buildings + sky + water)
  2.55 ms/render at 800² — 60 fps headroom. invariants 18/18, verify.py
  PASS. No physics/shared-context changes.
- Deferred: hazard overlays in 3D (terrain.frag branch is plumbed,
  waiting on the overlay milestone); building damage STATES as geometry
  (collapsed buildings still stand as boxes, only recolored — the desktop
  does the same).
- Open bugs: none in the app. (Dev-pane note: the embedded browser's
  module cache can serve a MIXED-version graph — fresh app.js + stale
  losses.js — which fails module instantiation and leaves the page at
  "booting…". Deploys are atomic per-commit and real browsers hard-refresh
  to a consistent graph; local testing must hard-refresh after edits.)
- Decisions: town instances rebuilt per scenario load (cheap, and the
  reset path restores base colors for free); one damage-ramp function
  feeds both views.

  **The 3D view (M8a skeleton → M8b water → M8c town) is complete.** Same
  town, same physics, same damage numbers as the 2D map — now watchable
  as a scene: the drawdown, the incoming wall, the flood, and the town
  turning red beneath it.

## 2026-07-17 — M8b: the living water (sea-surface mesh, Fresnel, foam)
- Shipped: `shaders/water.vert+frag`, faithful ports of the desktop
  originals. water.vert: the sea surface as a second displaced mesh —
  surface = bed + h, with DISPLAY-ONLY exaggeration of the anomaly
  (x8 shallow → x60 deep, the desktop's honest-display knobs; terrain
  stays 1:1), clamped never below the seabed, dry vertices tucked under
  the terrain. water.frag: Schlick Fresnel between the REFLECTED
  procedural sky (sky_color duplicated from sky.frag — the KEEP IN SYNC
  pair now exists in this repo too) and per-channel absorption (red dies
  in meters, blue last — why shallows are turquoise); animated ripple
  detail fading with camera distance and at the 3600 s time-wrap; foam
  driven by the SIMULATION state (Froude from G=hu/B=hv, thin fast run-up
  sheets, crest curvature — the state texture the solver already
  maintains, zero copies); the desktop's `1.0 - smoothstep` web-port note
  preserved (reversed-edge smoothstep is undefined by spec). scene3d.js:
  water program on the SAME grid VAO as the terrain (WebGL2 VAOs are
  program-independent — one mesh, two lifts), drawn LAST in the desktop's
  order (terrain → sky → water) so the translucent surface blends over
  terrain AND over sky at a tall crest's silhouette; structure mask = the
  scene's 1×1 zero texture (curvature foam fully active — correct with no
  walls); u_time = wall clock % 3600 (ripples live even when paused, like
  the desktop's continuously-running app).
- Verified (in-browser, fresh modules on the live context): compiles
  clean, GL error 0 throughout. Calm sea renders as WATER (teal/navy
  Fresnel surface at z=0) where M8a showed bare seabed. Scenario C fired
  and stepped to t=1500 s: the flood covers the coastal plain (182/306
  sample grid = water), foam at active edges. A fixed shoreline probe
  pixel tracks the event — dry sand at calm/t200, changing at t600,
  water-teal at t1200: the 3D sea follows the physics point-for-point.
  2.28 ms/render at 900² backing (iGPU) — 60 fps headroom alongside the
  solver. invariants 18/18, verify.py PASS. No physics or shared-context
  changes this milestone (gl.js only gained two loader entries), so
  parity needs no re-run; the M8a depth-context parity stands.
- Deferred: town buildings in 3D (M8c, next); hazard overlays in 3D.
- Open bugs: none.
- Decisions: water mesh reuses the terrain VAO (one grid, two vertex
  lifts); wall-clock ripples (display liveliness ≠ sim time — the foam
  PATTERN animates but foam PLACEMENT is pure sim state).

## 2026-07-17 — M8a: 3D scene skeleton (camera, sky, terrain, view toggle)
- Shipped: the 3D view's foundation, ported from the desktop render stack
  (SHADER_INVENTORY.md rated it all "translates directly" — it did).
  `js/mat4.js` (column-major perspective/lookAt/multiply/invert — built in
  WebGL's native layout, no transpose step), `js/camera.js` (OrbitCamera:
  z-up, yaw/pitch/distance, left-drag orbit / right-drag pan / wheel zoom,
  sliding near plane for depth precision), `shaders/sky.vert+frag`
  (far-plane fullscreen pass, procedural gradient + sun disc/halo; the
  sky_color function water.frag will duplicate in M8b — keep in sync),
  `shaders/terrain.vert+frag` (vertex-texture-fetch heightfield lift with
  the half-texel alignment; full material shader: elevation/slope
  splatting, fbm detail noise, wet-sand band, cavity shading, concrete-
  structure override, hazard-overlay branch ported but OFF), `js/scene3d.js`
  (grid mesh 513² verts / 1.57M indices, terrain→sky passes, 1×1 zero
  structure mask — NOT the desktop's bind-height fallback, which would
  read land > 0.5 m as concrete). The scene reads the SOLVER's own
  bedTexture as the heightfield: terrain is the physics' world by
  construction (coseismic drop shows the frame it fires), no stale upload
  path. app.js: `setView3d` toggle (button #viewmode), mouse controls
  (inert in 2D), camera framed on the town (desktop's ~2.6×radius,
  yaw −120°, pitch 40°), 3D renders at display resolution (dpr-capped)
  while 2D keeps its exact 513² backing; legend hidden in 3D (a colorbar
  and fixed scale bar describe the map, not a perspective scene).
- Verified (in-browser, fresh modules): GL error 0; sky gradient up top,
  sunlit earth-tone terrain below; orbit/zoom change the frame; ~0.1 ms/
  draw at 1320² backing (iGPU, far below budget); mid-run 3D after firing
  a source = no errors, reads the live bed. Toggle back to 2D restores
  backing 513², Shade-3 calm ocean (98,163,214) exact, town overlay
  painting. **Parity re-run on the depth-enabled context (the one shared-
  context change, gl.js depth:true): scenario C IDENTICAL to baseline —
  t=0 exactly 0.0, L∞ ≤1.82e-5, extent Jaccard 0.** invariants 18/18
  (sky/terrain are display shaders, outside the frozen physics set),
  verify.py PASS.
- Deferred: the water surface (M8b — at rest the seabed shows through
  where the sea will be, expected until then); town buildings in 3D
  (M8c); touch controls (mouse-only for now; Chromebook trackpads emit
  mouse events); hazard overlays in 3D (the terrain.frag branch is
  plumbed, waiting on the overlay milestone).
- Open bugs: none.
- Decisions: 2D↔3D as a same-page toggle (user pick) — one sim, one set
  of readouts, only the render path changes. Scene holds no solver
  reference (render() takes the live solver each frame) so scenario swaps
  can never leave it stale. SUN_DIR = (0.45, 0.35, 0.82), the desktop's
  afternoon southwest sun.

## 2026-07-17 — Colormap follow-up: calm = light ocean blue (Shade 3)
- The first pass (previous entry) made calm a near-white pale (#cfe3ec) —
  user found it washed-out (the sea read as fog; the tan land looked more
  colored than the water). Refined to a clear LIGHT OCEAN BLUE at zero so
  the resting sea plainly reads as water while staying distinctly lighter
  than the drawdown side (so it can't read as a negative anomaly).
- Final ramp (user pick "Shade 3"), display.frag `anomalyColor()` +
  #colorbar in sync: −2 m #0a3161 (deep navy) → −1 m #245f9c → 0 #62a3d6
  (light ocean blue, calm) → +1 m #ee9a4d (amber) → +2 m #c62f1f (red).
  Verified: calm renders exactly (98,163,214); legend matches; physics
  untouched (display-only); invariants 18/18, verify.py PASS.
- **DEFERRED DECISION — potential polarity flip.** Current polarity is the
  standard sea-surface-height / tsunami convention: warm = positive
  (crest, the hazard), cool = negative (drawdown). The user asked about
  FLIPPING it (red = negative drawdown, blue = positive crest) to
  dramatize the receding-sea warning sign. Held for now (kept the
  convention — it matches NOAA/altimetry maps, keeps "red crest → red
  damage" consistent with the damage/hazard overlays, and warm = more-
  intense across the future depth/speed/momentum instruments). If we DO
  flip later: invert the stop order in `anomalyColor()`, invert the
  #colorbar gradient, and swap the −2 m / +2 m legend labels — all three
  together. Revisit when building the hazard-overlay suite.

## 2026-07-17 — Colormap: calm sea no longer reads as "below zero" (user-caught)
- Symptom: the resting ocean was colored a mid-blue (#2673a6) nearly
  identical to the −1 m drawdown blue (#0659b2), so calm water read as a
  negative anomaly against the legend. The old ramp was a broken diverging
  map (blue on BOTH the negative side and near-zero, plus a green/blue
  discontinuity at 0).
- Fix (display.frag + index.html #colorbar, kept in sync): new 5-stop
  diverging ramp `anomalyColor(a)` with a LIGHT, central calm — chosen by
  the user (Option B): −2 m deep navy #08306b → −1 m blue #4a90c2 → 0 pale
  sea-blue #cfe3ec (calm) → +1 m amber #ef9a4d → +2 m red #c62f1f.
  Continuous through zero; the resting sea is now unmistakably "baseline"
  and any wave (cool drawdown / warm crest) pops against it.
- Verified: fresh display program renders calm deep ocean at EXACTLY
  (207,227,236) = #cfe3ec, uniform (the bed/state filter fix holds — no
  checkerboard); a stepped pulse's crest renders warm, nothing miscolored;
  the legend gradient in the DOM matches the shader stops exactly.
  Display-only — display.frag is not a frozen physics shader; parity and
  the physics are untouched. invariants 18/18, verify.py PASS.
- Decision: sea-surface-anomaly colormap must keep a LIGHT central (zero)
  tone so calm never reads as a signed anomaly; shader ramp and the
  #colorbar CSS gradient are the two keep-in-sync sites.

## 2026-07-17 — Fix: false-anomaly checkerboard in the town close-up (user-caught)
- Symptom: the zoomed town-inset ocean showed a static red/blue/teal
  checkerboard (user asked "are those waves?" — no) that never responded
  to the actual tsunami. It was a RENDERING artifact, not physics.
- Root cause: the display reconstructs the sea surface as `(bed + h)` and
  the anomaly as `(bed + h) - max(bed, 0)`. At rest h = -bed exactly, so
  the two cancel to a flat 0 — but ONLY if bed and h are sampled the same
  way. `bedTexture` was created NEAREST while the state (h) texture is
  LINEAR (OES_texture_float_linear present on this iGPU). Under a NEAREST
  bed and a LINEAR h, the reconstruction is wrong wherever the seabed
  slopes (up to the per-cell bathymetry step, ~2 m near shore → the full
  ±2 m display range). Invisible at 1x (sample points near texel centers);
  the ~25x inset zoom magnified it into vivid squares. Static because it
  depends only on the (fixed) bed, not the water — hence "never changes."
- Fix (solver.js): create `bedTexture` with the SAME display filter as the
  state textures (LINEAR when floatLinear, else NEAREST). One line + a
  comment explaining the cancellation contract. Display-only: every
  physics read of `u_bed` uses `texelFetch`, which ignores filtering.
- Verified: live GL test — deep-ocean inset pixels went from swinging
  `11,117,132 ↔ 88,103,133` (checkerboard) to uniform calm `38,115,166`,
  with only a genuine 1-cell transition at the real shoreline. Parity on
  scenario C (freshly-imported edited solver, most-sensitive coseismic +
  inundation case): IDENTICAL to the M2 baseline — t=0 exactly 0.0, L∞
  ≤1.82e-5, extent Jaccard 0 (exact), all snapshots pass. invariants
  18/18, verify.py PASS. Physics bit-identical by construction.
- Decision: bed and state display filters must always match — noted at the
  code site. The fix also slightly smooths the main-view terrain shading
  (LINEAR bed), a cosmetic improvement with no downside.

## 2026-07-17 — M7: casualties + day/night (Phase 2 complete)
- Shipped: `js/casualties.js` — faithful port of the desktop
  `core/damage/casualties.py`. Same fatality lognormal in depth with the
  median pulled DOWN by local flow speed (calm 2.0 m → swept 0.8 m at ≥3
  m/s), same three evacuation gates: LEAD TIME (depart = quake +
  detection 180 s + reaction 300 s; margin vs the building's arrival
  through a soft logistic, spread 90 s), REFUGE (nearest ground ≥ 15 m by
  the frontier-only search, on the POST-event bed so coseismic subsidence
  can drown a refuge), ROUTE (straight path sampled against the arrival
  field, cut to a 0.15 floor if the water beats the walker). Wired into
  the app: casualties assessed alongside damage at the 30-frame cadence,
  reported on a SEPARATE line from dollars (property and life are
  different axes — the divergence is the lesson), amber... red when > 0.
  A **day/night toggle** (☀/☾ button) flips occupancy: homes by night,
  schools/workplaces by day. Refuges cached per terrain epoch;
  `t_quake=null` = the wave's first arrival (near-field-correct).
- Verified: **contract page 29/29** (+8 casualty-canon checks): the
  browser reproduces desktop-computed expected day AND night casualties
  on the frozen synthetic fields — every building's expected deaths to
  1.1e-16 (day) / 2.2e-16 (night), fatalities/evac%/at-risk exact,
  defaults asserted equal to the desktop knobs, night-deadlier-than-day
  pinned. Live in-app on scenario C (driven to t≈30 min, real physics):
  damage $0.45B (93%, 828 collapsed) unchanged by the toggle; **day
  ~2,417 dead / evac 16%** vs **night ~3,667 dead / evac 2%** — matching
  the desktop showcase (~2,089 day / ~3,646 night). The real ☀/☾ button
  click flips the casualty line and leaves damage put. verify.py PASS,
  invariants 18/18, parity untouched.
- Deferred: regional early-warning window (scenario B / wavemaker) — the
  desktop's P7 credits a distant quake's travel-time head-start by
  passing the true rupture time as `t_quake`; the web port uses first-
  arrival everywhere (near-field-correct, understates B's warning). A
  clean M8+ addition when wanted. Also deferred: P5 evacuation DEFENSES
  (EWS/towers/drills) that would edit the evac knobs — none exist in the
  web port; the defaults ARE the model. By-building casualty detail is in
  `__app.getCasualtyReport()` but not surfaced beyond the summary line.
- Open bugs: none. Same embedded-browser module-cache quirk as M6
  (documented there); the app DOM was verified by a temporary
  `?devcachebust=1` on the app.js import (reverted before commit) — the
  ☀/☾ button, both readout lines, and toggle behavior all confirmed live.
- Decisions: casualties and damage on separate UI lines, never merged
  (the desktop rule). Day/night re-prices casualties only, never damage.
  Canon casualties use `t_quake=None` so the synthetic-field contract
  matches the app's default path exactly.

  **Phase 2 (M5 town → M6 damage → M7 casualties) is complete.** The
  browser now tells the whole story on one page: same town, three
  scenarios, dollars and lives on separate axes, day vs night. Every
  number reproduces the desktop canon to machine epsilon.

## 2026-07-17 — M6: structural damage (fragility + losses, live on the map)
- Shipped: `js/fragility.js` + `js/losses.js` — faithful ports of the
  desktop `core/damage/fragility.py` + `losses.py`. Same lognormal
  curves, same A&S-7.1.26 erf, same momentum-flux term raising the two
  severe states, same loss increments (0.10/0.20/0.30/0.40), same
  FRAGILITY table, same loud unknown-class guard. `assessTown(town,
  grid, hazard)` samples hazards at each building (nearest cell) and
  returns fractions + $ totals + by-type + damage-state counts + critical
  facilities listed SEPARATELY. Wired into the app: at the desktop's
  30-frame cadence once the event has fired (one `getHazardFields()`
  readback — the only hazard consumer), buildings recolor base→amber→red
  by expected fraction (the verbatim desktop ramp), and a "Damage: $X of
  $Y (Z%) · N collapsed, M major · c/6 critical hit" readout appears
  (amber when loss ≥ 1%). A final assessment fires on pause so a stopped
  frame shows the settled toll. `overlay.render(town, buildingColor)` —
  the M5 `colorOf` hook, now used; the renderer was untouched.
- Verified: **contract page 21/21** (14 accessor + 7 NEW damage-canon):
  the browser reproduces desktop-computed expected damage on frozen
  synthetic fields (`phase2_canon.json`) to machine epsilon — every
  building fraction max |Δ| 2.2e-16, total loss Δ 1.2e-7 $, loss% exact,
  state counts identical 10/3/23/236/578, 6/6 critical by type+damage.
  Live in-app (scenario C driven to t≈27 min): "$0.45B of $0.48B (93%) ·
  828 collapsed, 4 major · 3/6 critical hit", overlay ~53% red — matches
  the desktop's Phase-2 showcase ($0.43B/90%/827 collapse). Scenario A
  (floods nothing): 0% loss, 0 collapse, buildings stay base albedo (no
  false damage). verify.py PASS, invariants 18/18, parity unaffected
  (no physics touched).
- Deferred: a damage-display toggle (desktop's V key) — the web shows
  damage colors whenever a report exists; add a toggle if the classroom
  wants the plain town back mid-run. By-type and critical-facility detail
  is computed and in `__app.getDamageReport()` but not yet surfaced in
  the UI (M6 shows the summary line; a details panel is a polish item).
- Open bugs: none. Dev-environment caching quirk (documented, not a code
  bug): this embedded browser serves stale HTML/ES-modules on 200s across
  navigations AND server restarts — a top-level URL cache-buster
  (`?fresh=N`) forces truth. `tests.html` now dynamic-imports contract.js
  with a `?v=Date.now()` buster so the harness always runs current code;
  real visitors / hard-refresh are unaffected.
- Decisions: damage inputs for the canon are SYNTHETIC analytic fields,
  not a GPU run — a math contract wants fixed bytes both sides read, not
  hardware-varying physics (parity already covers the physics). Canon is
  computed from the re-read quantized+float32 fields (what the browser
  consumes), never the pre-quantization floats. town.json is READ by the
  canon script, never regenerated — desktop and browser assess identical
  cm-rounded coordinates.

## 2026-07-17 — M5: the town on the map (phase 2 begins)
- Shipped: **town.json** (frozen canon, 69 KB) baked by the DESKTOP
  generator (`port_package/make_town_data.py`, seed 1, desktop commit
  881070d) on the shared scenario bed — the three reference beds are
  bit-identical (verified at bake), so ONE town serves all three
  scenarios: 850 buildings (6 critical), population 3,749, value $0.48B,
  833/850 inside scenario c's frozen flood extent / 715 inside b's / a
  touches nothing (the phase-2 teaching arc, confirmed in data before any
  JS). Web side: `js/town.js` (loader with loud integrity checks —
  type-resolution, finite coords, recount vs bake summary; Town accessors
  mirroring the desktop API incl. `footprint()`), `js/overlay.js`
  (2D overlay canvas: type-colored building rects on the main map +
  "Town close-up" inset with a locator rectangle; critical facilities
  ringed, drawn on top), display pass gains a UV window (`u_uv0/u_uv1`,
  display.vert — free-form pass, not physics) so the inset re-draws the
  SAME display program through a zoomed window: live water in the
  close-up, zero readbacks. Town summary line in the UI; `__app` exposes
  town + overlay. `tests/test_invariants.py` + town.json integrity check
  (18 passed).
- Verified: parity ALL 3 scenarios PASS (identical numbers to the M2
  baseline — a: J=0, b: J=0.0006, c: J=0), contract 14/14, verify.py
  PASS, invariants 18/18. In-browser: town line exact
  ("850 buildings (6 critical) · population 3,749 · value $0.48B"),
  overlay pixels confirmed on the main map (east coast, north — the
  baked town location) and in the inset; scenario c driven to t=1608 s
  in-pane: inset town core sampled saturated-red (deep floodwater over
  the town) while the far-east mountains stayed dry earth tones.
- Deferred: building rotation in the overlay (subpixel at these scales —
  rects are axis-aligned); damage recoloring is M6 (`overlay.render`
  already takes a `colorOf(k, building)` hook so M6 never edits the
  renderer).
- Open bugs: none. (Dev-environment note: hidden browser-pane tab
  reports clientWidth 0 at boot — overlay falls back to the canvas
  attribute size and self-heals on the fps cadence; real visible
  browsers lay out before boot completes.)
- Decisions: town is DATA not code (user-confirmed) — the desktop keeps
  the generator, canon expected-value tests become possible (M6/M7 will
  read the same cm-rounded town.json on both sides); texel-CENTER uv
  mapping (`u = ((x-xmin)/dx + 0.5)/n`) is the ONE coordinate convention
  for overlay + inset (half-texel misalignment is invisible full-domain
  but ~18 px at inset zoom); inset lives top-left (deep ocean — never
  covers the coast).

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

## 2026-07-18 — 3D view: uniform wave exaggeration + keyboard pan (Opus)

Two display-only 3D tweaks (no physics, no parity impact), user-driven.

- **Uniform 10x wave exaggeration** (scene3d.js): both `u_exagg_shallow`
  and `u_exagg_deep` set to 10.0 (was 8x shallow / 60x deep, blended by
  depth). The old depth-split rendered open-ocean waves ~7.5x taller than
  the same anomaly at the coast — reading as "waves are bigger in deep
  water," the inverse of shoaling. One factor means any growth you SEE as
  the wave nears shore is real (Green's law); the deep pulse stays a faint
  blip and the wave "pops up" on the slope, which is the real behavior.
  Full-length propagation is for the 2D map. water.vert's
  mix(shallow,deep,smoothstep(20,250,depth)) collapses to a constant when
  the knobs are equal. Verified live: uniforms read 10/10 from the
  compiled program, 3D scene renders non-black, glError 0.
- **Keyboard pan** (camera.js + app.js): new `OrbitCamera.moveGround(
  forward, right)` slides the look-at point across the SEA-LEVEL plane
  (target z untouched) along the view heading. app.js binds WASD + arrow
  keys to it in 3D mode (guarded: ignored while typing in a control),
  step = distance*0.05. Fixes "can't travel out to deep water without
  zooming" — glide out over the ocean parallel to sea level, THEN zoom in
  on the blip. Right-drag pan (already present) is unchanged. Verified:
  moveGround translates 40 km with z held exactly.

## 2026-07-18 — Beach view: first-person "stand on the shore" camera (Opus)

A new 3D camera mode that puts the eye on the beach at human height,
looking out to sea, with waves at TRUE height (1x) — the view the whole
lesson is about (watch the sea come in). Display-only.

- **camera.js**: OrbitCamera gains `mode` ("orbit" | "beach"). Beach mode
  fixes the eye (`enterBeach(x,y,groundZ,lookYawDeg)` → eye = ground + 2 m)
  and aims the gaze from yaw/pitch; left-drag turns the head, wheel narrows
  the FOV like binoculars, WASD/arrows walk the eye along the ground. A
  tight near plane (1 m) so the water at your feet doesn't clip.
- **scene3d.js**: wave exaggeration is now a per-frame field
  (`waveExagg`, default 10) set each water draw, so a view can change it.
- **app.js + index.html**: a "Beach view" button. Enter → ensure 3D, stand
  a step seaward of the town core at the waterline looking west (sea is -x
  in every current scenario), `waveExagg = 1`. Exit (or leaving 3D) restores
  the orbit view and 10x. Beach walking uses a fixed 60 m stride.
- Verified live: eye lands seaward of the town at z=2 looking due west
  [-1,0,0], waveExagg 1, renders a horizon (blue sky over sea/beach),
  look + walk both respond, glError 0.

## 2026-07-18 — Beach view fixes: stand at the waterline, no sky-tilt (Opus)

User feedback on the beach view: stood too far from the water, selecting a
scenario tipped the gaze up at the sky, and the wave underwhelmed.

- **Stand at the true shoreline**: `beachStandingPoint()` reads the CPU bed
  (solver.b) and walks west along the town's row to the water's edge,
  standing on the last DRY cell on solid ground. Was a blind `cx - r - 300`
  that landed ~645 m offshore on the shallow shelf (so you looked across
  transparent shelf water — reads as tan seabed — to a distant sea). Now
  you're at the water's edge and the shoaled wave runs UP the beach at you.
- **Scenario-select no longer pans to the sky**: setScenario framed the
  town (pitch 40) unconditionally; in beach mode that hijacked the gaze.
  It now re-stands on the new scenario's shore (`enterBeachAt()`) when in
  beach mode instead of framing.
- Verified live: eye lands on the dry cell at the waterline (bed +0.35 m,
  sea one cell west, land one cell east); switching to the earthquake keeps
  the gaze level (pitch 0, still beach) and re-stands; a driven run floods
  8.5 m over the beach as white foam at the viewpoint.
- KNOWN/OPEN: the calm shallow sea still renders tan (clear water over the
  wide gentle shelf shows the sand) — a water-shader appearance question,
  not position; flagged for a follow-up (would touch the shared water.frag).

## 2026-07-18 — Beach view: stand IN the water's edge + North-Atlantic sea

User feedback with screenshots: from the beach the sea was a thin line at
the horizon and everything below it tan. Diagnosis (measured): the tan was
NOT water — standing on the 234 m dry cell with the eye 2 m up puts the
whole beach cell across the lower screen and compresses the sea into a
~1-degree horizon sliver; a water-color tint changed only 2% of pixels
because there were almost no water fragments to tint. Two changes:

- **Stand at the water's edge, wet side**: beachStandingPoint() now stops
  at the first WET cell and stands the eye 2 m above the SEA SURFACE
  (groundZ 0) — ankle-deep at the shore — with a -12 deg default gaze.
  The sea now runs from your feet to the horizon and fills the frame; the
  run-up wave comes straight at you.
- **North-Atlantic sea in beach mode** (water.frag + scene3d + app):
  new u_beach_sea uniform (0 = orbit view unchanged). At 1 the water body
  runs a cold steel blue (turquoise -> deep navy replaced by
  0.05,0.19,0.25 -> 0.02,0.08,0.16) and the surface goes near-opaque
  (alpha >= 0.90) so the shelf sand no longer shows through. The thin
  run-up alpha taper still applies, so flood sheets stay translucent.

Verified live: sky [147,185,230] / far sea [72,112,158] / near sea
[34,66,79] — dark-near, silvery-far, blue-dominant everywhere; exit
restores orbit + clear water + 10x; scenario switch re-stands correctly.
Physics shaders untouched: invariants 18/18, verify.py PASS.

## 2026-07-18 — Re-baked town + canon: the coastal-ribbon town (Opus)

The desktop town generator was redesigned (Checkpoint 4 follow-through:
buildings-per-cell = density x cell area, so the town spreads into a
shore-parallel ribbon at ~150 bldgs/km^2). This propagates that here —
site/data/town.json and phase2_canon.json are re-baked FROM the desktop,
as always (baked, not ported).

- **town.json**: 850 buildings, full civic kit, population 3,725,
  830/850 still inside scenario c's frozen inundation extent (the
  teaching-arc guard). As the web sees it: 177 physics cells occupied,
  max 13 buildings per cell (was 93 cells / max 35). Per-building damage
  coloring is now defensible — no building shares a hazard sample with
  20+ others.
- **phase2_canon.json** (284 KB): regenerated on the new town. New
  canon numbers — loss $0.32B of $0.48B (66%), states
  none 15 / minor 1 / moderate 24 / major 334 / collapse 476, day
  ~2,562 dead of 2,981 (evac 13%), night ~3,623 of 3,725 (evac 2%),
  regional unwarned ~2,527 (evac 15%) vs +EWS ~783 (evac 74%).
- The desktop canon script now DERIVES its synthetic-field box from the
  town's own extent instead of a hardcoded rectangle — the ribbon reached
  outside the old box and the "every building must sample inside the box"
  guard caught it loudly. Future town shapes are covered automatically.

Verified: tests/test_invariants 18/18; the in-browser contract page
(/tests.html) passes with ZERO failures and reproduces every desktop
number to machine epsilon (per-building expected deaths max |Δ| 1.11e-16
day / 4.44e-16 night); both teaching pins still hold — night deadlier
than day, and early warning cuts regional deaths 2,527 -> 783. App boots
and renders the new town.
