// The economic layer (M11): return periods + the early-warning cost, and
// the annualized-risk math. "Design for which wave?" — the risk a hazard
// poses is its consequence times its FREQUENCY, so a rare monster can
// matter LESS per year than a frequent nuisance. Dollars and lives are
// annualized SEPARATELY (never merged — the divergence is the lesson).
//
// The rates are ILLUSTRATIVE classroom figures, mapped from the desktop
// core/events/catalog.py annual_rate tags (which are themselves declared
// illustrative). Scenario B is that catalog's Regional Mw 8.3 @ 350 km
// (1/75 yr); scenario C its Near-field Mw 9.0 (1/500 yr). Scenario A is a
// common far-source pulse that misses this coast.

export const EWS_COST_USD = 15e6;    // one-time early-warning system (desktop)

export const SCENARIO_RATE = {
    a_deep_propagation: 1 / 30,      // common far pulse — misses this coast
    b_shelf_shoaling: 1 / 75,        // the regional — frequent enough to lead
    c_nearfield_inundation: 1 / 500, // the rare near-field monster
};

export function returnPeriodYr(id) {
    const r = SCENARIO_RATE[id];
    return r ? Math.round(1 / r) : null;
}

/** rate × per-event outcome = the expected amount per year. */
export function annualize(id, perEvent) {
    return (SCENARIO_RATE[id] || 0) * perEvent;
}

/** Human $/yr (or $/event): compact currency. */
export function fmtUsd(v) {
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
    return `$${v.toFixed(0)}`;
}
