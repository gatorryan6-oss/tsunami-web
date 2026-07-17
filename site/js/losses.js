// Aggregate per-building damage into the numbers people argue about — the
// JS port of the desktop core/damage/losses.py::assess_town. Samples the
// hazard fields at every building (nearest cell, the probe/gauge
// convention), runs the fragility model, and returns a DamageReport:
// expected fractions, dollar losses total and by type, damage-state counts,
// and critical facilities listed SEPARATELY (losing the hospital is a
// different kind of loss than losing a warehouse — never buried in the sum).
//
// Hazards arrive through getHazardFields() only (flat Float32Arrays,
// row-major, j=0 south). Verified against phase2_canon.json.

import { FRAGILITY, expectedFraction, stateLabel } from "./fragility.js";

/** Nearest-cell index of a world position on the solver grid (round, like
 *  the desktop's np.round + clip). */
function cellIndex(grid, x, y) {
    const i = Math.min(grid.n - 1, Math.max(0,
        Math.round((x - grid.xmin) / grid.dx)));
    const j = Math.min(grid.n - 1, Math.max(0,
        Math.round((y - grid.ymin) / grid.dx)));
    return j * grid.n + i;
}

/** Expected damage for every building from the accumulated hazard.
 *  grid = {n, dx, xmin, ymin}; hazard = getHazardFields() output. Returns
 *  { fractions, totalValue, totalLoss, lossPct, byType, critical, counts,
 *    summary() }. */
export function assessTown(town, grid, hazard) {
    const nB = town.buildings.length;
    const fractions = new Float64Array(nB);
    if (nB === 0) {
        return makeReport(fractions, 0.0, 0.0, {}, [], {});
    }

    // Loud, like the desktop: an unknown fragility class would silently be
    // an INVULNERABLE building (never matched) — fail instead.
    const unknown = new Set();
    for (const b of town.buildings) {
        if (!FRAGILITY[b.type.fragility]) unknown.add(b.type.fragility);
    }
    if (unknown.size) {
        throw new Error("unknown fragility classes: " +
                        [...unknown].sort().join(", "));
    }

    let totalValue = 0.0, totalLoss = 0.0;
    const byType = {};        // type_name -> [loss, value]
    const critical = [];      // [type_name, fraction, x, y]
    const counts = {};        // state name -> count

    for (let k = 0; k < nB; k++) {
        const b = town.buildings[k];
        const cell = cellIndex(grid, b.x, b.y);
        const depth = hazard.depth[cell];
        const mflux = hazard.momentum[cell];
        const cls = FRAGILITY[b.type.fragility];
        const frac = expectedFraction(cls, depth, mflux);
        fractions[k] = frac;

        const value = b.type.value_usd;
        const loss = value * frac;
        totalValue += value;
        totalLoss += loss;

        const bt = byType[b.t] || [0.0, 0.0];
        bt[0] += loss; bt[1] += value;
        byType[b.t] = bt;

        if (b.type.critical) critical.push([b.t, frac, b.x, b.y]);
        const state = stateLabel(frac);
        counts[state] = (counts[state] || 0) + 1;
    }
    return makeReport(fractions, totalValue, totalLoss, byType, critical,
                      counts);
}

// Damage tint ramp (verbatim from the desktop _refresh_town_colors):
// undamaged keeps base albedo; hurt blends base -> amber -> red by fraction.
const DAMAGE_AMBER = [0.95, 0.72, 0.12];
const DAMAGE_RED = [0.80, 0.07, 0.05];

/** base [r,g,b] in 0..1, fraction 0..1 -> [r,g,b] in 0..1. The ONE damage
 *  ramp — the 2D overlay's css colors and the 3D instance colors both
 *  derive from this, so the two views can never tint differently. */
export function damageColorRgb(base, fraction) {
    if (fraction < 0.02) return base;
    const t1 = Math.min(1, Math.max(0, fraction / 0.5));
    const t2 = Math.min(1, Math.max(0, (fraction - 0.5) / 0.5));
    return base.map((b, i) => {
        const amber = b * (1 - t1) + DAMAGE_AMBER[i] * t1;
        return amber * (1 - t2) + DAMAGE_RED[i] * t2;
    });
}

/** base [r,g,b] in 0..1, fraction 0..1 -> css "rgb(...)" for the overlay. */
export function damageColorCss(base, fraction) {
    const c = damageColorRgb(base, fraction);
    return `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
}

function makeReport(fractions, totalValue, totalLoss, byType, critical,
                    counts) {
    const lossPct = totalValue ? 100.0 * totalLoss / totalValue : 0.0;
    return {
        fractions, totalValue, totalLoss, lossPct, byType, critical, counts,
        summary() {
            const critHit = critical.filter(c => c[1] >= 0.2).length;
            return `loss $${(totalLoss / 1e9).toFixed(2)}B of ` +
                   `$${(totalValue / 1e9).toFixed(2)}B (${lossPct.toFixed(0)}%), ` +
                   `critical damaged ${critHit}/${critical.length}`;
        },
    };
}
