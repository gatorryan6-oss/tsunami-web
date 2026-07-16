// The parity harness — the signal that defines success for this port.
//
// For each reference scenario: build the solver exactly the way the desktop
// reference generator did (scenario.js mirrors make_reference.py), step it
// headlessly with the SAME rule the exporter used (one stableDt() call per
// substep; a snapshot is the state at the FIRST substep whose cumulative
// t >= t_requested), and compare the water-depth field h against the frozen
// reference at every snapshot, plus the final inundation extent.
//
// Pass criteria (HARNESS.md, per snapshot / scenario):
//   1. rel_Linf  = max|test - ref| / max|ref|              <= 1e-3
//      (cells where BOTH fields < 1 mm never count — abs floor)
//   2. rel_L2(wet) = rms(test - ref over wet) / max|ref|   <= 1e-4
//      with wet = (ref > 0.02) | (test > 0.02)
//   3. inundation extent Jaccard distance XOR/OR           <= 0.02
//
// The desktop is canonical: a failure here means the BROWSER is wrong.
// Never widen a tolerance or regenerate the reference to make it pass.

import { createContext, loadShaderSources } from "./gl.js";
import { loadScenario, loadJSON, loadField, createSolverForScenario } from "./scenario.js";
import { getHazardFields, inundationExtent } from "./hazard.js";

export const TOL = {
    relLinf: 1e-3,
    relL2Wet: 1e-4,
    jaccard: 0.02,
    absFloorM: 1e-3,   // both-below-1mm cells never count for criterion 1
    wetM: 0.02,
};

const SCENARIO_IDS = [
    "a_deep_propagation",
    "b_shelf_shoaling",
    "c_nearfield_inundation",
];

/** Compare a browser h field (packed RGBA state) against a reference h. */
function compareSnapshot(state, ref, n) {
    let scale = 0;
    for (let i = 0; i < n * n; i++) {
        const a = Math.abs(ref[i]);
        if (a > scale) scale = a;
    }
    if (scale < 1e-9) scale = 1e-9;
    let linf = 0, sum2 = 0, wetCount = 0;
    for (let i = 0; i < n * n; i++) {
        const t = state[i * 4];
        const r = ref[i];
        const d = Math.abs(t - r);
        if (!(t < TOL.absFloorM && r < TOL.absFloorM) && d > linf) linf = d;
        if (r > TOL.wetM || t > TOL.wetM) {
            sum2 += d * d;
            wetCount += 1;
        }
    }
    return {
        relLinf: linf / scale,
        relL2Wet: wetCount ? Math.sqrt(sum2 / wetCount) / scale : 0,
        wetCount,
    };
}

function jaccardDistance(test, ref) {
    let xor = 0, or = 0;
    for (let i = 0; i < test.length; i++) {
        const a = test[i] !== 0, b = ref[i] !== 0;
        if (a !== b) xor += 1;
        if (a || b) or += 1;
    }
    return { jaccard: xor / Math.max(or, 1), mismatch: xor, union: or };
}

const yieldToBrowser = () => new Promise(r => setTimeout(r, 0));

/**
 * Run one scenario against its reference. `onProgress(text)` keeps the page
 * honest during the long stepping loops.
 */
export async function runScenarioParity(gl, shaders, id, onProgress) {
    const sc = await loadScenario(id);
    const n = sc.params.grid.n;
    const { solver, postBed } = createSolverForScenario(gl, shaders, sc);
    const snapshots = [];
    try {
        const requested = sc.params.snapshots.map(s => s.t_requested_s)
            .sort((x, y) => x - y);
        const endS = sc.params.end_s;
        const remaining = [...requested];

        const take = async (tNow) => {
            const T = remaining.shift();
            const ref = await loadField(`${sc.dir}h_t${String(Math.round(T)).padStart(5, "0")}.json`);
            const state = solver.readState();
            const m = compareSnapshot(state, ref.data, n);
            const refT = sc.params.snapshots.find(s => s.t_requested_s === T);
            snapshots.push({
                tRequested: T, tActual: tNow, tRefActual: refT.t_actual_s,
                ...m,
                pass: m.relLinf <= TOL.relLinf && m.relL2Wet <= TOL.relL2Wet,
            });
            onProgress(`${id}: snapshot T=${T} at t=${tNow.toFixed(2)} s — ` +
                       `L∞ ${m.relLinf.toExponential(2)}, ` +
                       `L2 ${m.relL2Wet.toExponential(2)}`);
        };

        let t = 0.0;
        if (remaining.length && remaining[0] <= 0.0) await take(0.0);
        let sinceYield = 0;
        while (remaining.length && t < endS + 60.0) {
            const d = solver.stableDt();
            solver.step(d);
            t += d;
            if (remaining.length && t >= remaining[0]) await take(t);
            if (++sinceYield >= 400) {
                sinceYield = 0;
                onProgress(`${id}: t = ${t.toFixed(0)} s / ${endS} s`);
                await yieldToBrowser();
            }
        }
        while (t < endS) {
            const d = solver.stableDt();
            solver.step(d);
            t += d;
            if (++sinceYield >= 400) {
                sinceYield = 0;
                onProgress(`${id}: settling to end t = ${t.toFixed(0)} s / ${endS} s`);
                await yieldToBrowser();
            }
        }

        // Final inundation extent through THE accessor (the port contract).
        const fields = getHazardFields(solver);
        const extent = inundationExtent(fields, postBed, 0.1);
        const refExtent = await loadJSON(`${sc.dir}inundation_final.json`);
        const refMask = Uint8Array.from(refExtent.data);
        const j = jaccardDistance(extent, refMask);
        const extentResult = {
            ...j,
            flooded: extent.reduce((a, v) => a + v, 0),
            refFlooded: refExtent.flooded_cells,
            pass: j.jaccard <= TOL.jaccard,
        };

        const pass = snapshots.every(s => s.pass) && extentResult.pass;
        return { id, endT: t, snapshots, extent: extentResult, pass };
    } finally {
        solver.release();
    }
}

export async function runAllParity(canvas, onProgress, onScenarioDone) {
    const { gl } = createContext(canvas);
    const shaders = await loadShaderSources();
    const results = [];
    for (const id of SCENARIO_IDS) {
        onProgress(`=== ${id} ===`);
        const r = await runScenarioParity(gl, shaders, id, onProgress);
        results.push(r);
        onScenarioDone(r);
    }
    const pass = results.every(r => r.pass);
    return { pass, results, tolerances: TOL };
}
