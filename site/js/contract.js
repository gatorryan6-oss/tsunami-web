// getHazardFields() contract tests — the JS mirror of the desktop
// tests/test_hazard.py section 5 (plus the section-3 analytic momentum
// pin), which the desktop declares as THE accessor contract for this port.
// The future damage-model phase builds on exactly this shape.
//
// Differences from the desktop test, and why:
//  * The "accessor equals the raw solver reads" equivalence check is
//    omitted: in this codebase getHazardFields() IS the only wrapper over
//    those reads (hazard.js), and tests/test_invariants.py statically
//    forbids any other module from touching them — the property holds by
//    construction, not by sampling.
//  * Field arrays are flat Float32Array(n*n) (row-major, j=0 south), the
//    JS equivalent of the desktop's (n, n) float32.

import { GPUNonlinearSWESolver } from "./solver.js";
import { Simulation } from "./sim.js";
import { getHazardFields, arrivalRange, inundationExtent } from "./hazard.js";
import { loadTown } from "./town.js";
import { assessTown } from "./losses.js";
import { assessCasualties, nearestRefuges, defaultEvacuationParams } from "./casualties.js";
import { planEvacuation } from "./routing.js";

export async function runContractChecks(gl, shaders) {
    const checks = [];
    const check = (ok, name) => checks.push({ ok: !!ok, name });

    // --- 1. Analytic momentum pin (desktop test_hazard section 3) --------
    // A hand-set uniform flow: depth 4 m, speed 3 m/s -> h*u^2 = 36.
    {
        const n = 17;
        const bed = new Float32Array(n * n).fill(-10.0);
        const s = new GPUNonlinearSWESolver(gl, shaders, bed, n, 100.0,
                                            { manningN: 0.0 });
        try {
            s.enableMaxTracking();
            const h = new Float32Array(n * n).fill(4.0);
            const hu = new Float32Array(n * n).fill(12.0);   // u = 3 m/s
            s.loadState(h, hu, null);
            s.timeS = 1.0;
            s.snapshotMax();
            let gf = getHazardFields(s);
            let maxSpeed = 0, maxMom = 0;
            for (let i = 0; i < n * n; i++) {
                if (gf.speed[i] > maxSpeed) maxSpeed = gf.speed[i];
                if (gf.momentum[i] > maxMom) maxMom = gf.momentum[i];
            }
            check(Math.abs(maxSpeed - 3.0) < 1e-4,
                  `max speed of the uniform flow is 3 m/s (${maxSpeed.toFixed(4)})`);
            check(Math.abs(maxMom - 36.0) < 1e-3,
                  `momentum flux = h*u^2 = 36 m^3/s^2 (${maxMom.toFixed(4)})`);
            // Running max: a calmer later state must not lower it.
            const hu2 = new Float32Array(n * n).fill(4.0);   // u = 1 -> 4
            s.loadState(h, hu2, null);
            s.timeS = 2.0;
            s.snapshotMax();
            gf = getHazardFields(s);
            maxMom = 0;
            for (let i = 0; i < n * n; i++) {
                if (gf.momentum[i] > maxMom) maxMom = gf.momentum[i];
            }
            check(Math.abs(maxMom - 36.0) < 1e-3,
                  "momentum flux is a running maximum (a calmer state can't lower it)");
        } finally {
            s.release();
        }
    }

    // --- 2. The accessor contract on a live beach run (section 4+5) ------
    {
        const nb = 129;
        const dx = 100.0;
        const bed = new Float32Array(nb * nb);
        for (let j = 0; j < nb; j++) {
            for (let i = 0; i < nb; i++) {
                const x = (i - (nb - 1) / 2) * dx;
                bed[j * nb + i] = Math.max((x - 2000.0) * 0.004, -30.0);
            }
        }
        const solver = new GPUNonlinearSWESolver(gl, shaders, bed, nb, dx,
                                                 { openEdges: ["west"] });
        try {
            solver.enableMaxTracking();

            const hz0 = getHazardFields(solver);
            check(arrivalRange(hz0) === null,
                  "arrivalRange is null before the wave arrives");

            solver.addGaussian(-3000.0, 0.0, 3.0, 1800.0);
            solver.snapshotMax();
            // 800 s: the wave needs ~300 s to reach the shore and run-up
            // starts after ~500 s (measured: 0 flooded cells at t=400,
            // 144 at t=600, 258 at t=800) — the desktop's 400 s stops at
            // "arrived", this test also wants "flooded" for the extent.
            const sim = new Simulation(solver, 64.0);
            while (sim.simTime < 800.0) sim.advance(0.05);

            const gf = getHazardFields(solver);
            const n2 = nb * nb;
            check(["depth", "speed", "momentum", "arrival"].every(
                      k => gf[k] instanceof Float32Array && gf[k].length === n2),
                  "contract: four Float32Array(n*n) fields named depth/speed/momentum/arrival");
            let maxDepth = 0, maxMom = 0;
            let nonNeg = true, arrivalSentinel = true, dryNoArrival = true;
            for (let i = 0; i < n2; i++) {
                if (gf.depth[i] > maxDepth) maxDepth = gf.depth[i];
                if (gf.momentum[i] > maxMom) maxMom = gf.momentum[i];
                if (gf.depth[i] < 0 || gf.speed[i] < 0 || gf.momentum[i] < 0)
                    nonNeg = false;
                if (!(gf.arrival[i] >= 0.0 || gf.arrival[i] === -1.0))
                    arrivalSentinel = false;
                if (gf.depth[i] <= 0.0 && gf.arrival[i] !== -1.0)
                    dryNoArrival = false;
            }
            check(maxDepth > 0.1 && maxMom > 0.0,
                  "the accessor sees the wave (depth and momentum are live)");
            check(nonNeg,
                  "contract: depth/speed/momentum are non-negative running maxima");
            check(arrivalSentinel,
                  "contract: arrival is seconds >= 0, with -1 = never arrived");
            check(dryNoArrival,
                  "contract: cells the water never reached have no arrival time");
            const rng = arrivalRange(gf);
            check(rng !== null && rng[0] < rng[1],
                  `arrivalRange is a proper interval after arrival (${rng})`);
            check(rng[0] >= 0.0 && rng[1] <= sim.simTime + 1e-3,
                  "arrival times fall within the run");

            // Inundation extent: on land only, thresholded on max depth.
            const ext = inundationExtent(gf, solver.b, 0.1);
            let extOnLandOnly = true, extMatchesRule = true, flooded = 0;
            for (let i = 0; i < n2; i++) {
                const should = (solver.b[i] > 0.0 && gf.depth[i] > 0.1) ? 1 : 0;
                if (ext[i] !== should) extMatchesRule = false;
                if (ext[i] && solver.b[i] <= 0.0) extOnLandOnly = false;
                flooded += ext[i];
            }
            check(extOnLandOnly, "extent marks land cells only");
            check(extMatchesRule,
                  "extent = (max depth > 0.1 m) & (bed > 0), exactly");
            check(flooded > 0,
                  `the 3 m beach wave floods some land (${flooded} cells)`);
        } finally {
            solver.release();
        }
    }

    // --- 3+4. Phase-2 canon (web M6/M7): the fragility/losses AND casualty
    // ports reproduce desktop-computed expected numbers on FIXED synthetic
    // hazard fields and the frozen town. A pure math contract — no GPU — so
    // agreement is tight (both sides: float32 field bytes, float64 A&S erf).
    await phase2CanonChecks(check);

    return { pass: checks.every(c => c.ok), checks };
}

/** Rebuild the (n, n) float32 field the desktop assessed: float32(box
 *  values) inside the box, the `outside` fill elsewhere. Mirrors
 *  make_phase2_canon.embed_full EXACTLY. */
function embedField(n, box, flat, outside) {
    const full = new Float32Array(n * n).fill(outside);
    const w = box.i1 - box.i0 + 1;
    const src = Float32Array.from(flat);   // 6-sig-digit JSON -> float32
    for (let jj = box.j0; jj <= box.j1; jj++) {
        for (let ii = box.i0; ii <= box.i1; ii++) {
            full[jj * n + ii] = src[(jj - box.j0) * w + (ii - box.i0)];
        }
    }
    return full;
}

async function phase2CanonChecks(check) {
    let canon;
    try {
        const r = await fetch("data/phase2_canon.json");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        canon = await r.json();
    } catch (e) {
        check(false, `damage canon: failed to load phase2_canon.json (${e.message})`);
        return;
    }
    const town = await loadTown();
    const g = canon.provenance.grid;
    const grid = { n: g.n, dx: g.dx_m, xmin: g.xmin_m, ymin: g.ymin_m };
    const box = canon.box, o = canon.outside;
    const hazard = {
        depth: embedField(grid.n, box, canon.fields.depth, o.depth),
        speed: embedField(grid.n, box, canon.fields.speed, o.speed),
        momentum: embedField(grid.n, box, canon.fields.momentum, o.momentum),
        arrival: embedField(grid.n, box, canon.fields.arrival, o.arrival),
        n: grid.n,
    };
    const report = assessTown(town, grid, hazard);
    const exp = canon.expected_damage;

    // Per-building fractions: the exhaustive check. Tolerance 1e-9 (JSON
    // stores full-precision expected fractions; the only divergence is
    // float64 op-order, negligible).
    let maxErr = 0, worst = -1;
    for (let k = 0; k < report.fractions.length; k++) {
        const e = Math.abs(report.fractions[k] - exp.fractions[k]);
        if (e > maxErr) { maxErr = e; worst = k; }
    }
    check(report.fractions.length === exp.fractions.length,
          `damage canon: ${report.fractions.length} building fractions ` +
          `(desktop ${exp.fractions.length})`);
    check(maxErr < 1e-9,
          `damage canon: every building fraction matches desktop ` +
          `(max |Δ| ${maxErr.toExponential(2)} at #${worst})`);

    // Aggregates.
    check(Math.abs(report.totalLoss - exp.total_loss) < 1.0,
          `damage canon: total loss $${(report.totalLoss / 1e9).toFixed(4)}B ` +
          `matches desktop $${(exp.total_loss / 1e9).toFixed(4)}B`);
    check(Math.abs(report.totalValue - exp.total_value) < 1e-6,
          `damage canon: total value matches desktop ` +
          `($${(report.totalValue / 1e9).toFixed(2)}B)`);
    check(Math.abs(report.lossPct - exp.loss_pct) < 1e-6,
          `damage canon: loss ${report.lossPct.toFixed(1)}% matches desktop`);

    // State counts — the histogram must be identical bucket-for-bucket.
    const states = ["none", "minor", "moderate", "major", "collapse"];
    const countsMatch = states.every(
        s => (report.counts[s] || 0) === (exp.counts[s] || 0));
    check(countsMatch,
          `damage canon: damage-state counts match desktop ` +
          `(${states.map(s => (report.counts[s] || 0)).join("/")})`);

    // Critical facilities: same set, same fractions, same order.
    let critMatch = report.critical.length === exp.critical.length;
    for (let k = 0; k < report.critical.length && critMatch; k++) {
        critMatch = report.critical[k][0] === exp.critical[k][0] &&
            Math.abs(report.critical[k][1] - exp.critical[k][1]) < 1e-9;
    }
    check(critMatch,
          `damage canon: ${report.critical.length} critical facilities ` +
          `match desktop by type + damage`);

    // --- Casualty canon (web M7). Same fields, plus the POST-event bed
    // (here the pre-event bed — the canon applies no coseismic) for the
    // refuge search, and default evacuation knobs. Both day and night.
    let bed;
    try {
        const br = await fetch("data/a_deep_propagation/bed.json");
        const bj = await br.json();
        bed = Float32Array.from(bj.data);
    } catch (e) {
        check(false, `casualty canon: failed to load bed (${e.message})`);
        return;
    }
    const ec = canon.expected_casualties;
    // The browser's defaults must equal the knobs the desktop used, or the
    // reproduction is meaningless — assert it, don't assume it.
    const p = defaultEvacuationParams();
    const paramsMatch =
        p.detectionDelayS === ec.params.detection_delay_s &&
        p.reactionDelayS === ec.params.reaction_delay_s &&
        p.walkSpeedMS === ec.params.walk_speed_m_s &&
        p.criticalSpeedFactor === ec.params.critical_speed_factor &&
        p.refugeMinElevM === ec.params.refuge_min_elev_m &&
        p.spreadS === ec.params.spread_s &&
        p.routeCutFloor === ec.params.route_cut_floor &&
        p.routeCutDepthM === ec.params.route_cut_depth_m &&
        p.injuriesPerFatality === ec.params.injuries_per_fatality &&
        p.offroadSpeedFactor === ec.params.offroad_speed_factor;
    check(paramsMatch,
          "casualty canon: web evacuation defaults equal the desktop knobs");

    // The evacuation lookup the port computes from the bed + roads (part
    // of what's tested): the network route PLAN when town.json carries a
    // road graph (M12c), else the legacy nearest-refuge array. The regional
    // cases reuse it — detection deltas change the clock, not the routes.
    const refuges = (town.roads && town.roads.edges.length > 0)
        ? planEvacuation(town, grid, bed, p)
        : nearestRefuges(town, grid, bed, p);
    for (const mode of ["day", "night"]) {
        const daytime = mode === "day";
        const rep = assessCasualties(town, grid, bed, hazard, p, daytime,
                                     refuges, ec.t_quake_s);
        const e = ec[mode];
        // Per-building expected deaths: the exhaustive check.
        let maxErr = 0, worst = -1;
        for (let k = 0; k < rep.perBuilding.length; k++) {
            const d = Math.abs(rep.perBuilding[k] - e.per_building[k]);
            if (d > maxErr) { maxErr = d; worst = k; }
        }
        check(maxErr < 1e-9,
              `casualty canon (${mode}): every building's expected deaths ` +
              `match desktop (max |Δ| ${maxErr.toExponential(2)} at #${worst})`);
        check(Math.abs(rep.fatalities - e.fatalities) < 1e-6,
              `casualty canon (${mode}): ${Math.round(rep.fatalities)} dead ` +
              `matches desktop ${Math.round(e.fatalities)}`);
        check(Math.abs(rep.evacSuccess - e.evac_success) < 1e-9 &&
              rep.present === e.present && rep.atRisk === e.at_risk,
              `casualty canon (${mode}): evac ${(100 * rep.evacSuccess).toFixed(0)}% ` +
              `· present ${rep.present} · at-risk ${rep.atRisk} match desktop`);
    }
    // The lesson, pinned: night must be deadlier than day (homes emptied
    // into high-ground schools/workplaces by day).
    check(canon.expected_casualties.night.fatalities >
          canon.expected_casualties.day.fatalities,
          "casualty canon: night is deadlier than day (the day/night lesson)");

    // --- Regional early-warning cases (M9.x): the SAME assessCasualties
    // with a rupture BEFORE the field's first arrival (t_quake < 0) and the
    // two detection delays the EWS toggle switches. Pins the negative-
    // t_quake + detection wiring; day mode.
    const rg = canon.expected_casualties_regional;
    if (rg) {
        for (const [tag, blk] of [["unwarned", rg.unwarned], ["ews", rg.ews]]) {
            const pr = { ...p, detectionDelayS: blk.detection_delay_s,
                         reactionDelayS: rg.reaction_delay_s };
            const rep = assessCasualties(town, grid, bed, hazard, pr, true,
                                         refuges, rg.t_quake_s);
            let maxErr = 0;
            for (let k = 0; k < rep.perBuilding.length; k++) {
                maxErr = Math.max(maxErr,
                    Math.abs(rep.perBuilding[k] - blk.per_building[k]));
            }
            check(maxErr < 1e-9 && Math.abs(rep.fatalities - blk.fatalities) < 1e-6,
                  `casualty canon (regional ${tag}): ${Math.round(rep.fatalities)} dead ` +
                  `· evac ${(100 * rep.evacSuccess).toFixed(0)}% match desktop ` +
                  `(t_quake ${rg.t_quake_s.toFixed(0)}s, det ${blk.detection_delay_s}s)`);
        }
        check(rg.ews.fatalities < rg.unwarned.fatalities,
              "casualty canon: early warning cuts regional deaths (the EWS lesson)");
    }
}
