// Tsunami fragility curves: local hazard -> expected damage fraction.
// A faithful port of the desktop core/damage/fragility.py — same lognormal
// curves, same momentum-flux term on the severe states, same A&S-7.1.26
// erf, same constants. Verified against desktop-computed canon
// (phase2_canon.json) to float precision. Physics-canonical numbers live in
// the DESKTOP repo; if these disagree, this port is wrong.
//
// THE SCIENCE (abbreviated — see the desktop docstring): post-tsunami
// surveys (Suppasri 2013, Koshimura 2009) fit lognormal curves to
// P(damage state >= k | flow depth); near shore, momentum flux h*u^2
// predicts destruction better than depth, so the two severe states can be
// raised by a flux term. Expected fraction = sum_k loss_increment_k *
// P(state >= k) — the smooth, reproducible reading a risk model reports.

export const DAMAGE_STATES = ["minor", "moderate", "major", "collapse"];

// Cumulative loss ratios 0.10/0.30/0.60/1.00 as INCREMENTS, so that
// E[fraction] = increments . P(state >= k) (the telescoping sum).
export const STATE_LOSS_INCREMENTS = [0.10, 0.20, 0.30, 0.40];

// (limit, name) — most-likely state for an expected fraction (display).
const STATE_BY_FRACTION = [
    [0.05, "none"], [0.20, "minor"], [0.45, "moderate"],
    [0.80, "major"], [Infinity, "collapse"],
];

// name -> {d50:[4], betaD, m50Collapse, betaM}. Verbatim from the desktop
// FRAGILITY table.
export const FRAGILITY = {
    wood:    { d50: [0.5, 1.2, 2.0, 4.0], betaD: 0.55, m50Collapse: 20.0, betaM: 0.7 },
    masonry: { d50: [0.7, 1.5, 2.8, 5.5], betaD: 0.55, m50Collapse: 45.0, betaM: 0.7 },
    rc:      { d50: [1.2, 2.8, 6.0, 10.0], betaD: 0.55, m50Collapse: 150.0, betaM: 0.7 },
    steel:   { d50: [1.0, 2.2, 4.5, 8.5], betaD: 0.55, m50Collapse: 120.0, betaM: 0.7 },
};

// The momentum-flux term also raises "major", at a lower median.
const MAJOR_M50_FACTOR = 1.0 / 2.5;

const SQRT2 = Math.SQRT2;

/** Error function, Abramowitz & Stegun 7.1.26 (|err| < 1.5e-7) — the exact
 *  rational approximation the desktop uses, so both sides agree bit-close.
 *  JS has no Math.erf. */
export function erf(x) {
    const sign = Math.sign(x);
    const ax = Math.abs(x);
    const t = 1.0 / (1.0 + 0.3275911 * ax);
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (
        1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    return sign * (1.0 - poly * Math.exp(-ax * ax));
}

/** P(X <= x) for lognormal(median, beta); 0 wherever x <= 0. */
export function lognormalCdf(x, median, beta) {
    if (x <= 0.0) return 0.0;
    const z = (Math.log(x) - Math.log(median)) / beta;
    return 0.5 * (1.0 + erf(z / SQRT2));
}

/** P(state >= k) for the four states, as a length-4 array. depth in m,
 *  mflux in m^3/s^2 (or null for the depth-only model). The flux term
 *  raises only the two severe states, then the vector is re-monotonized
 *  (P(>=minor) can never fall below P(>=collapse)). Scalar port of the
 *  desktop's vectorized exceedance_probabilities. */
export function exceedanceProbabilities(cls, depth, mflux = null) {
    const p = cls.d50.map(m => lognormalCdf(depth, m, cls.betaD));
    if (mflux !== null) {
        // Drag can only wreck a building the water actually reached — gate
        // on wet so a spurious flux can't damage a never-wet building.
        const wet = depth > 0.0 ? 1.0 : 0.0;
        const pCol = lognormalCdf(mflux, cls.m50Collapse, cls.betaM) * wet;
        const pMaj = lognormalCdf(mflux, cls.m50Collapse * MAJOR_M50_FACTOR,
                                  cls.betaM) * wet;
        p[3] = Math.max(p[3], pCol);
        p[2] = Math.max(p[2], pMaj);
        for (const k of [2, 1, 0]) p[k] = Math.max(p[k], p[k + 1]);
    }
    return p;
}

/** Expected damage fraction (0..1) of replacement value. */
export function expectedFraction(cls, depth, mflux = null) {
    const p = exceedanceProbabilities(cls, depth, mflux);
    let f = 0.0;
    for (let k = 0; k < 4; k++) f += p[k] * STATE_LOSS_INCREMENTS[k];
    return f;
}

/** Most-likely damage-state name for an expected fraction. */
export function stateLabel(fraction) {
    for (const [limit, name] of STATE_BY_FRACTION) {
        if (fraction < limit) return name;
    }
    return "collapse";
}
