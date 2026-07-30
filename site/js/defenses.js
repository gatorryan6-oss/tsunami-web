// Buildable defenses (M15): the seawall + the construction budget.
//
// A seawall here is LITERALLY a terrain edit — the bed along a drawn line
// is raised to the crest elevation and the frozen solver does everything
// else: waves below the crest reflect, a wave taller than the crest
// overtops naturally (the well-balanced HLL scheme handles a one-cell
// barrier exactly). There is no special-case wall physics anywhere, so
// the physics shaders and the parity/accessor contracts are untouched.
// It fails the way real seawalls failed in 2011 — by being shorter than
// the wave.
//
// Everything numeric mirrors the desktop (canonical) implementation:
//   core/defenses/seawall.py  — cell sampling, cost, max() apply
//   app/main.py               — SCENARIO_BUDGET_USD ($250M pot)
// QoL (the desktop's "nobody wants a wall on their beach" index) is NOT
// ported: the web town has no land-use zone map. Logged in BUILDLOG.
//
// THE DESKTOP CONTRACT this module keeps (core/defenses/base.py):
//   CHARGE BEFORE APPLY — a wall is quoted against the world as it
//     stands (pristine bed + earlier walls), then charged, then applied.
//   REMOVAL IS A WORLD REBUILD — apply() raises with max() and cannot
//     know the old ground, so there is no undo. Removing a wall means
//     re-applying the survivors, in build order, onto the pristine bed
//     (applyDefenses below). Order matters: a wall crossing another's
//     raised ground was quoted cheaper.

import { rnd } from "./routing.js";

// $ per meter of length per meter of BUILT height (crest minus existing
// ground) — illustrative, anchored to Japan's post-Tōhoku program
// (~$2-3M per km per meter of height). Desktop Seawall.COST_RATE.
export const SEAWALL_COST_RATE = 2_500.0;

// The town's fixed construction pot — desktop SCENARIO_BUDGET_USD.
export const BUDGET_TOTAL_USD = 250e6;

// Crest picker bounds (m above sea level — how real walls are specced).
// The cap stays below the 15 m refuge line on purpose: a wall must never
// masquerade as refuge high ground to the evacuation router. (Real-world
// anchor: Fudai's famous gate crested at 15.5 m; most walls are lower.)
export const CREST_MIN_M = 3;
export const CREST_MAX_M = 12;
export const CREST_DEFAULT_M = 6;

/** True length of a wall segment {x0,y0,x1,y1,crest} in meters. */
export function wallLength(w) {
    return Math.hypot(w.x1 - w.x0, w.y1 - w.y0);
}

/** Grid cells under the wall line, as flat row-major indices (j*n+i,
 *  j=0 = SOUTH row — repo convention). Port of desktop Seawall._cells:
 *  sampled at dx/2 so no cell on the segment is skipped, deduplicated
 *  preserving order. Samples OUTSIDE the domain are DROPPED, not
 *  clamped — clamping would materialize an off-map wall along the
 *  border and bill for it. (A diagonal chain of raised cells is only
 *  corner-adjacent, but it still blocks this solver: water crosses cell
 *  FACES, and no face crosses an 8-connected chain.) */
export function wallCells(w, grid) {
    const { n, dx, xmin, ymin } = grid;
    const length = wallLength(w);
    // Non-finite endpoints would make nS Infinity and hang the tab (or
    // NaN and fall through as a zero-cell wall) — an empty cell list is
    // the loud, checkable answer either way (commitWall refuses it).
    if (!Number.isFinite(length)) return [];
    const nS = Math.max(2, Math.ceil(length / (dx * 0.5)) + 1);
    const seen = new Set();
    const cells = [];
    for (let s = 0; s < nS; s++) {
        const t = s / (nS - 1);
        // rnd = half-to-EVEN (routing.js), matching the desktop's
        // np.round in seawall.py _cells — Math.round is half-UP, and at
        // an exact .5 the two engines would put the same wall in
        // DIFFERENT bed columns (verified: x = -59414.0625 on the
        // canonical grid is a tie). Same landmine-removal as routing.
        const fi = rnd((w.x0 + (w.x1 - w.x0) * t - xmin) / dx);
        const fj = rnd((w.y0 + (w.y1 - w.y0) * t - ymin) / dx);
        if (fi < 0 || fi >= n || fj < 0 || fj >= n) continue;
        const flat = fj * n + fi;
        if (!seen.has(flat)) {
            seen.add(flat);
            cells.push(flat);
        }
    }
    return cells;
}

/** Construction cost against `bed` (the world as it stands): mean built
 *  height × TRUE length × rate. Pricing by cell count would make
 *  diagonal walls ~29% cheaper than the same wall drawn north-south —
 *  an orientation exploit, not a discount (desktop Seawall.cost). */
export function wallCost(w, bed, grid) {
    const cells = wallCells(w, grid);
    if (cells.length === 0) return 0.0;
    let builtSum = 0.0;
    for (const c of cells) builtSum += Math.max(w.crest - bed[c], 0.0);
    return (builtSum / cells.length) * wallLength(w) * SEAWALL_COST_RATE;
}

/** Raise the bed to the crest along the line — never lower it.
 *  Idempotent: re-applying an existing wall changes nothing. Mutates
 *  `bed` in place (a Float32Array, so the crest auto-rounds to f32
 *  exactly like the desktop's np.float32 store). */
export function applyWall(w, bed, grid) {
    for (const c of wallCells(w, grid)) {
        bed[c] = Math.max(bed[c], w.crest);
    }
}

/** The replay contract in one call: start from the PRISTINE bed, then
 *  quote + apply every wall in build order. Returns the defended bed
 *  (a fresh Float32Array — the pristine input is never touched; it is
 *  frozen canon) plus each wall's honest re-quote and the total spent.
 *  Deterministic: same walls, same order, same quotes — which is what
 *  makes "remove = rebuild without it" refund exactly what was paid. */
export function applyDefenses(walls, pristineBed, grid) {
    const bed = Float32Array.from(pristineBed);
    const quotes = [];
    let spent = 0.0;
    for (const w of walls) {
        const q = wallCost(w, bed, grid);   // quote BEFORE apply
        quotes.push(q);
        spent += q;
        applyWall(w, bed, grid);
    }
    return { bed, quotes, spent };
}

/** Human label for a wall: "1.4 km, crest 6 m — $38M". */
export function describeWall(w, quote) {
    const km = (wallLength(w) / 1000).toFixed(1);
    return `${km} km, crest ${w.crest.toFixed(0)} m — ${fmtM(quote)}`;
}

/** Compact $M formatter for budget strings (walls price in the
 *  $10M-$300M range; sub-$1M walls are display noise, show <$1M). */
export function fmtM(v) {
    if (v < 0) return `-${fmtM(-v)}`;   // overdrawn pot reads "-$12M left"
    if (v < 1e6 && v > 0) return "<$1M";
    return `$${Math.round(v / 1e6)}M`;
}
