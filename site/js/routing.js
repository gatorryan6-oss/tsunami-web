// Evacuation routing over the road network — the JS mirror of the desktop
// core/damage/routing.py (M12b). A walker goes
//   building --(off-road, SLOW)--> nearest useful road point
//            --(along the graph, full pace)--> the best exit node
//            --(off-road)--> the refuge nearest that exit,
// unless a pure off-road beeline is genuinely faster. The route's time is
// what the lead-time gate races against the wave, and the route-cut gate
// (casualties.js) samples the ACTUAL polyline — one low flooded link cuts
// everyone routed through it.
//
// PARITY DISCIPLINE — this file reproduces the desktop float64 math
// BIT-FOR-BIT so the contract page holds both engines to machine epsilon.
// JS Numbers ARE IEEE-754 float64, and +, -, *, /, Math.sqrt are all
// correctly rounded, so identical op-order gives identical bits. The
// rules (see routing.py for the why):
//   - distances are Math.sqrt(dx*dx + dy*dy), NEVER Math.hypot (its ulp
//     differences could flip an argmin and reroute a walker);
//   - shortest paths use deterministic BELLMAN-FORD sweeps in baked edge
//     order with STRICT improvement (<), never a heap;
//   - every argmin is first-wins over a FIXED enumeration order (refuge
//     frontier row-major then extra refuges; edges in baked order).

/** Round half-to-EVEN, matching numpy's np.round / Python's round().
 *  Math.round is half-UP, so at an exact .5 the two engines would pick
 *  different grid cells for a building or a route sample. No current
 *  sample sits within 1e-5 of a tie, so this is a no-op on the frozen
 *  canon — it just removes the landmine. Lives here, the lower-level
 *  module, so casualties.js can import it without a cycle. */
export function rnd(v) {
    const f = Math.floor(v);
    const d = v - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
}

/** {mask, rx, ry}: the refuge-cell mask (Uint8Array n*n) and every
 *  candidate refuge POINT — frontier cells of the mask (row-major scan)
 *  then the extra refuges (towers) in list order. Mirrors
 *  routing.refuge_points EXACTLY; bed is the post-event bed. */
export function refugePoints(grid, bed, params) {
    const { n, dx, xmin, ymin } = grid;
    const elev = params.refugeMinElevM;
    const mask = new Uint8Array(n * n);
    let anyMask = false;
    for (let i = 0; i < n * n; i++) {
        if (bed[i] >= elev) { mask[i] = 1; anyMask = true; }
    }
    const rx = [], ry = [];
    if (anyMask) {
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < n; i++) {
                if (!mask[j * n + i]) continue;
                let interior = false;
                if (j > 0 && j < n - 1 && i > 0 && i < n - 1) {
                    interior = mask[(j - 1) * n + i] === 1 &&
                               mask[(j + 1) * n + i] === 1 &&
                               mask[j * n + (i - 1)] === 1 &&
                               mask[j * n + (i + 1)] === 1;
                }
                if (!interior) { rx.push(xmin + i * dx); ry.push(ymin + j * dx); }
            }
        }
    }
    for (const p of params.extraRefuges) { rx.push(p[0]); ry.push(p[1]); }
    return { mask, rx: Float64Array.from(rx), ry: Float64Array.from(ry) };
}

/** Build the full route plan for every building. Mirror of
 *  routing.plan_evacuation. Returns
 *    { neededBaseS: Float64Array(nB),  // route time at base speeds; ∞ = none
 *      refugeXY:    Float64Array(nB*2),// route end point; NaN = none
 *      paths:       Array(nB),         // per building [x,y,tBase] rows, or null
 *      onRefuge:    Uint8Array(nB) }   // standing on refuge ground
 */
export function planEvacuation(town, grid, bed, params) {
    const nB = town.buildings.length;
    const needed = new Float64Array(nB).fill(Infinity);
    const refugeXY = new Float64Array(nB * 2).fill(NaN);
    const paths = new Array(nB).fill(null);
    const onRef = new Uint8Array(nB);
    const plan = { neededBaseS: needed, refugeXY, paths, onRefuge: onRef };
    if (nB === 0) return plan;

    const { n, dx, xmin, ymin } = grid;
    const { mask, rx, ry } = refugePoints(grid, bed, params);
    const bx = new Float64Array(nB), by = new Float64Array(nB);
    for (let k = 0; k < nB; k++) {
        const b = town.buildings[k];
        bx[k] = b.x; by[k] = b.y;
        const bi = Math.min(n - 1, Math.max(0, rnd((b.x - xmin) / dx)));
        const bj = Math.min(n - 1, Math.max(0, rnd((b.y - ymin) / dx)));
        if (mask[bj * n + bi]) {
            onRef[k] = 1;
            needed[k] = 0.0;
            refugeXY[2 * k] = b.x; refugeXY[2 * k + 1] = b.y;
        }
    }
    if (rx.length === 0) return plan;   // nowhere to go, for anyone

    const vRoad = Math.max(params.walkSpeedMS, 0.1);
    const vOff = Math.max(params.walkSpeedMS * params.offroadSpeedFactor, 0.05);

    const roads = town.roads;
    const haveNet = roads && roads.edges.length > 0;

    // --- direct (pure off-road) beeline, the baseline option ----------
    const dDirect = new Float64Array(nB);
    const mDirect = new Int32Array(nB);
    for (let k = 0; k < nB; k++) {
        let best = Infinity, m = 0;
        for (let q = 0; q < rx.length; q++) {
            const ex = rx[q] - bx[k], ey = ry[q] - by[k];
            const d2 = ex * ex + ey * ey;
            if (d2 < best) { best = d2; m = q; }   // first-wins
        }
        mDirect[k] = m;
        dDirect[k] = Math.sqrt(best);
    }
    const tDirect = new Float64Array(nB);
    for (let k = 0; k < nB; k++) tDirect[k] = dDirect[k] / vOff;

    if (!haveNet) {
        for (let k = 0; k < nB; k++) {
            if (onRef[k]) continue;
            needed[k] = tDirect[k];
            const m = mDirect[k];
            refugeXY[2 * k] = rx[m]; refugeXY[2 * k + 1] = ry[m];
            paths[k] = [[bx[k], by[k], 0.0], [rx[m], ry[m], tDirect[k]]];
        }
        return plan;
    }

    // --- node exit legs: nearest refuge point per road node -----------
    const nodes = roads.nodes;
    const nNodes = nodes.length;
    const nx = new Float64Array(nNodes), ny = new Float64Array(nNodes);
    for (let m = 0; m < nNodes; m++) { nx[m] = nodes[m][0]; ny[m] = nodes[m][1]; }
    const fIdx = new Int32Array(nNodes);
    const fDist = new Float64Array(nNodes);
    for (let m = 0; m < nNodes; m++) {
        let best = Infinity, q0 = 0;
        for (let q = 0; q < rx.length; q++) {
            const ex = rx[q] - nx[m], ey = ry[q] - ny[m];
            const d2 = ex * ex + ey * ey;
            if (d2 < best) { best = d2; q0 = q; }
        }
        fIdx[m] = q0;
        fDist[m] = Math.sqrt(best);
    }

    // --- network times: deterministic Bellman-Ford to a fixed point ---
    const edges = roads.edges;
    const nEdges = edges.length;
    const eu = new Int32Array(nEdges), ev = new Int32Array(nEdges);
    const ex0 = new Float64Array(nEdges), ey0 = new Float64Array(nEdges);
    const ex1 = new Float64Array(nEdges), ey1 = new Float64Array(nEdges);
    const edx = new Float64Array(nEdges), edy = new Float64Array(nEdges);
    const eT = new Float64Array(nEdges), eL2 = new Float64Array(nEdges);
    for (let e = 0; e < nEdges; e++) {
        const u = edges[e][0], v = edges[e][1];
        eu[e] = u; ev[e] = v;
        ex0[e] = nx[u]; ey0[e] = ny[u];
        ex1[e] = nx[v]; ey1[e] = ny[v];
        const ddx = nx[v] - nx[u], ddy = ny[v] - ny[u];
        edx[e] = ddx; edy[e] = ddy;
        eL2[e] = ddx * ddx + ddy * ddy;
        eT[e] = Math.sqrt(ddx * ddx + ddy * ddy) / vRoad;
    }
    const T = new Float64Array(nNodes);
    const parent = new Int32Array(nNodes).fill(-1);
    const parentDt = new Float64Array(nNodes);
    for (let m = 0; m < nNodes; m++) T[m] = fDist[m] / vOff;
    for (let iter = 0; iter < nNodes; iter++) {
        let changed = false;
        for (let e = 0; e < nEdges; e++) {
            const u = eu[e], v = ev[e];
            let t = T[v] + eT[e];
            if (t < T[u]) { T[u] = t; parent[u] = v; parentDt[u] = eT[e]; changed = true; }
            t = T[u] + eT[e];
            if (t < T[v]) { T[v] = t; parent[v] = u; parentDt[v] = eT[e]; changed = true; }
        }
        if (!changed) break;
    }

    // --- per building: best road access vs the direct beeline ----------
    for (let k = 0; k < nB; k++) {
        if (onRef[k]) continue;
        let tBest = Infinity, eBest = 0, useUBest = true;
        let pxBest = 0, pyBest = 0, dAccBest = 0, dUBest = 0, dVBest = 0;
        for (let e = 0; e < nEdges; e++) {
            // Degenerate edge: skip it. Mirrors routing.py forcing t_via to
            // +inf there — without this the NaN it produces would be handled
            // OPPOSITELY by the two engines (numpy's argmin picks the first
            // NaN; this loop's first-wins < never picks it), and one bad edge
            // would reroute the entire town in the browser only.
            if (!(eL2[e] > 0.0)) continue;
            let s = ((bx[k] - ex0[e]) * edx[e] + (by[k] - ey0[e]) * edy[e]) / eL2[e];
            if (s < 0.0) s = 0.0; else if (s > 1.0) s = 1.0;
            const px = ex0[e] + s * edx[e];
            const py = ey0[e] + s * edy[e];
            const dax = bx[k] - px, day_ = by[k] - py;
            const dAcc = Math.sqrt(dax * dax + day_ * day_);
            const dux = px - ex0[e], duy = py - ey0[e];
            const dU = Math.sqrt(dux * dux + duy * duy);
            const dvx = px - ex1[e], dvy = py - ey1[e];
            const dV = Math.sqrt(dvx * dvx + dvy * dvy);
            const tU = dAcc / vOff + dU / vRoad + T[eu[e]];
            const tV = dAcc / vOff + dV / vRoad + T[ev[e]];
            const useU = tU <= tV;             // tie -> the u endpoint
            const tVia = useU ? tU : tV;
            if (tVia < tBest) {                // first-wins, edge order
                tBest = tVia; eBest = e; useUBest = useU;
                pxBest = px; pyBest = py; dAccBest = dAcc; dUBest = dU; dVBest = dV;
            }
        }
        if (tBest < tDirect[k]) {
            const verts = [[bx[k], by[k], 0.0]];
            let t = dAccBest / vOff;
            verts.push([pxBest, pyBest, t]);
            let node;
            if (useUBest) { node = eu[eBest]; t = t + dUBest / vRoad; }
            else { node = ev[eBest]; t = t + dVBest / vRoad; }
            verts.push([nx[node], ny[node], t]);
            while (parent[node] !== -1) {
                t = t + parentDt[node];
                node = parent[node];
                verts.push([nx[node], ny[node], t]);
            }
            const q = fIdx[node];
            t = t + fDist[node] / vOff;
            verts.push([rx[q], ry[q], t]);
            needed[k] = tBest;                 // the selection value
            refugeXY[2 * k] = rx[q]; refugeXY[2 * k + 1] = ry[q];
            paths[k] = verts;
        } else {
            const m = mDirect[k];
            needed[k] = tDirect[k];
            refugeXY[2 * k] = rx[m]; refugeXY[2 * k + 1] = ry[m];
            paths[k] = [[bx[k], by[k], 0.0], [rx[m], ry[m], tDirect[k]]];
        }
    }
    return plan;
}
