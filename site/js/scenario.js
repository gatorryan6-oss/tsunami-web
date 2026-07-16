// Scenario loading: the reference data under data/ ships the exact
// bathymetry (and, for the earthquake case, the coseismic displacement dz)
// as JSON — the browser does NOT port the terrain generator or the Okada
// source in phase 1 (DATAFLOW.md §4). This module turns those files into
// a ready-to-run solver, applying the source exactly the way the desktop
// reference generator did (make_reference.py).

import { GPUNonlinearSWESolver } from "./solver.js";
import { WavemakerSpec } from "./wavemaker.js";

export const SCENARIOS = [
    { id: "a_deep_propagation", label: "A — Deep-water pulse" },
    { id: "b_shelf_shoaling", label: "B — Regional wave shoaling" },
    { id: "c_nearfield_inundation", label: "C — Near-field earthquake" },
];

export async function loadJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
    return resp.json();
}

/** Load a flat field file ({shape, data} row-major, j=0 = SOUTH row). */
export async function loadField(url) {
    const payload = await loadJSON(url);
    const [rows, cols] = payload.shape;
    const data = Float32Array.from(payload.data);
    if (data.length !== rows * cols) {
        throw new Error(`${url}: data length ${data.length} != shape ` +
                        `${rows}x${cols} — corrupt or truncated download`);
    }
    return { rows, cols, data, meta: payload };
}

/** Everything one scenario needs, fetched from data/<id>/. */
export async function loadScenario(id, base = "data/") {
    const dir = `${base}${id}/`;
    const params = await loadJSON(dir + "params.json");
    const bed = await loadField(dir + "bed.json");
    let dz = null;
    if (params.source.kind === "coseismic_dz") {
        dz = await loadField(dir + "dz.json");
    }
    const n = params.grid.n;
    if (bed.rows !== n || bed.cols !== n) {
        throw new Error(`${id}: bed is ${bed.rows}x${bed.cols}, ` +
                        `params say ${n}x${n}`);
    }
    return { id, params, bed: bed.data, dz: dz ? dz.data : null, dir };
}

/** Build a solver for a loaded scenario and fire its source, mirroring
 *  make_reference.py's order exactly: construct at rest on the PRE-event
 *  bed → enable tracking → apply source → reset tracking → snapshot.
 *  Returns { solver, postBed } (postBed = bed after dz, for land masks). */
export function createSolverForScenario(gl, shaders, sc, opts = {}) {
    const { params, bed, dz } = sc;
    const solver = new GPUNonlinearSWESolver(
        gl, shaders, bed, params.grid.n, params.grid.dx_m,
        {
            gravity: params.physics.g,
            manningN: params.physics.manning_n,
            openEdges: params.open_edges,
            floatLinear: !!opts.floatLinear,
        });
    solver.enableMaxTracking();

    const src = params.source;
    if (src.kind === "gaussian") {
        solver.addGaussian(src.x_m, src.y_m, src.amplitude_m, src.radius_m);
    } else if (src.kind === "wavemaker") {
        solver.setWavemaker(new WavemakerSpec(
            src.amplitude_m, src.period_s, src.n_waves, src.t_start_s));
    } else if (src.kind === "coseismic_dz") {
        solver.applyCoseismic(dz);
    } else {
        throw new Error(`unknown source kind: ${src.kind}`);
    }
    solver.resetMaxTracking();
    solver.snapshotMax();

    // Post-event land mask basis (bed after the quake, or unchanged).
    return { solver, postBed: solver.b };
}
