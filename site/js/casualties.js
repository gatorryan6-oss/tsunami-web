// Casualties: evacuation against the clock — the JS port of the desktop
// core/damage/casualties.py. Same model, same constants, verified against
// desktop-computed canon (phase2_canon.json, casualty section).
//
//   expected deaths at building k =
//       people_k * P(fatal | hazard at k) * (1 - evacuation_success_k)
//
// P(fatal) is a lognormal in max flow depth with the median pulled DOWN
// where the flow is fast (moving water sweeps people off their feet long
// before it would drown them standing). Evacuation success turns on three
// gates: LEAD TIME (people start at quake + detection + reaction and need
// route-time seconds to reach refuge; the margin vs the wave's arrival at
// their building sets success through a soft logistic), REFUGE (nearest
// ground >= refuge_min_elev, recomputed after the quake since subsidence
// can drown a refuge), and ROUTE (the path is sampled against the arrival
// field; if the water gets there first the route is cut to a scramble
// floor). Fatalities are reported SEPARATELY from dollar losses, always.
//
// M12b — ROADS CARRY THE EVACUATION. A town with a road graph routes every
// walker over it (routing.js): off-road to the best access point (SLOW),
// along the network at full pace, then off-road up to refuge — with a pure
// beeline still winning where it is genuinely faster. The route-cut gate
// samples the ACTUAL polyline, so one low flooded link cuts everyone routed
// through it. A town WITHOUT roads keeps the legacy full-speed beeline so
// older data tells its original story.
//
// HOW EXACTLY THIS MATCHES THE DESKTOP (measured, not aspirational):
//   * the routing/geometry layer is BIT-FOR-BIT — see routing.js's rules;
//   * the fatality and logistic layer agrees to ~1 ulp only, because
//     Math.log/Math.exp are not correctly-rounded IEEE operations and V8's
//     differ from numpy's in the last bit;
//   * the headline totals are summed sequentially here but pairwise by
//     numpy, another sub-ulp difference.
// The contract's 1e-9 tolerance is therefore deliberate, not slack.
//
// Hazards arrive through getHazardFields() only; the bed is the POST-event
// bed (solver.b after coseismic) so refuge heights are the ground people
// actually stand on.

import { erf } from "./fragility.js";
import { planEvacuation, refugePoints, rnd } from "./routing.js";

const SQRT2 = Math.SQRT2;

// People are swept/drowned per this lognormal in max depth (m). Calm
// median ~2 m (Jonkman flood-fatality territory); fast flow pulls it to
// knee depth.
export const FATAL_D50_CALM = 2.0;
export const FATAL_D50_SWEPT = 0.8;
export const FATAL_BETA = 0.6;
export const SWEEP_SPEED = 3.0;   // m/s of max flow for the full pull-down

/** The evacuation knobs (the desktop's EvacuationParams defaults). The P5
 *  defense catalog edits THESE — none of it exists in the web port yet, so
 *  the defaults ARE the model. */
export function defaultEvacuationParams() {
    return {
        detectionDelayS: 180.0,     // quake -> sirens
        reactionDelayS: 300.0,      // sirens -> feet moving
        walkSpeedMS: 1.2,           // evacuation pace
        criticalSpeedFactor: 0.5,   // hospitals/schools move slower
        refugeMinElevM: 15.0,       // ground this high counts as safe
        spreadS: 90.0,              // crowd spread (logistic timescale)
        routeCutFloor: 0.15,        // success left when the path floods
        routeCutDepthM: 0.3,        // water this deep blocks a route
        injuriesPerFatality: 2.0,
        extraRefuges: [],           // [[x, y], ...] (P5 towers; none here)
        // Off-road pace as a fraction of walkSpeedMS (M12b): the slow
        // yard/brush/scramble legs of a network route. Only towns WITH a
        // road graph use it — roadless ones keep the full-speed beeline.
        offroadSpeedFactor: 0.5,
    };
}

/** Nearest-refuge world xy for every building, as a Float64Array(nB*2)
 *  ([x0,y0, x1,y1, ...]); NaN pair = nowhere to go. Frontier-only search
 *  (from outside a region the nearest member is on its boundary — exact,
 *  ~20x fewer candidates). A building already on refuge ground is its own
 *  refuge. Port of nearest_refuges(). bed = flat post-event bed. */
export function nearestRefuges(town, grid, bed, params) {
    const nB = town.buildings.length;
    const out = new Float64Array(nB * 2).fill(NaN);
    if (nB === 0) return out;
    const { n, dx, xmin, ymin } = grid;
    // Same refuge points (frontier row-major + extra refuges) the network
    // planner uses — one source of truth, matching the desktop.
    const { mask, rx, ry } = refugePoints(grid, bed, params);
    if (rx.length === 0) return out;

    for (let k = 0; k < nB; k++) {
        const b = town.buildings[k];
        const bi = Math.min(n - 1, Math.max(0, rnd((b.x - xmin) / dx)));
        const bj = Math.min(n - 1, Math.max(0, rnd((b.y - ymin) / dx)));
        if (mask[bj * n + bi]) {
            out[2 * k] = b.x; out[2 * k + 1] = b.y;   // already safe
            continue;
        }
        let best = Infinity, bx = NaN, by = NaN;
        for (let m = 0; m < rx.length; m++) {
            const d2 = (rx[m] - b.x) ** 2 + (ry[m] - b.y) ** 2;
            if (d2 < best) { best = d2; bx = rx[m]; by = ry[m]; }
        }
        out[2 * k] = bx; out[2 * k + 1] = by;
    }
    return out;
}

/** Water-beats-walker along the ACTUAL route polyline (M12b). Port of
 *  _route_cut_along. path rows are [x, y, tBaseS]; a critical building's
 *  slower pace scales the clock (t / factor), not the geometry. */
function routeCutAlong(grid, hazard, path, departS, factor, params) {
    const { n, dx, xmin, ymin } = grid;
    for (let s = 0; s < path.length - 1; s++) {
        const [x0, y0, t0] = path[s];
        const [x1, y1, t1] = path[s + 1];
        const ddx = x1 - x0, ddy = y1 - y0;
        const length = Math.sqrt(ddx * ddx + ddy * ddy);
        const nS = Math.max(2, Math.ceil(length / dx) + 1);
        for (let q = 0; q < nS; q++) {
            const u = q / (nS - 1);
            const x = x0 + ddx * u;
            const y = y0 + ddy * u;
            const i = Math.min(n - 1, Math.max(0, rnd((x - xmin) / dx)));
            const j = Math.min(n - 1, Math.max(0, rnd((y - ymin) / dx)));
            const cell = j * n + i;
            const arr = hazard.arrival[cell];
            if (arr < 0.0) continue;
            const walkerT = departS + (t0 + (t1 - t0) * u) / factor;
            if (arr < walkerT && hazard.depth[cell] > params.routeCutDepthM) {
                return true;
            }
        }
    }
    return false;
}

/** Does the water beat the walker to any point of the straight path?
 *  Port of _route_cut — ceil sampling (spacing <= dx). */
function routeCut(grid, hazard, x0, y0, x1, y1, departS, speed, params) {
    const { n, dx, xmin, ymin } = grid;
    // Plain sqrt, not Math.hypot — the parity rules in routing.js forbid
    // hypot because the two implementations disagree by ulps.
    const _dxl = x1 - x0, _dyl = y1 - y0;
    const length = Math.sqrt(_dxl * _dxl + _dyl * _dyl);
    const nS = Math.max(2, Math.ceil(length / dx) + 1);
    const v = Math.max(speed, 0.1);
    for (let s = 0; s < nS; s++) {
        const t = s / (nS - 1);
        const x = x0 + (x1 - x0) * t;
        const y = y0 + (y1 - y0) * t;
        const i = Math.min(n - 1, Math.max(0, rnd((x - xmin) / dx)));
        const j = Math.min(n - 1, Math.max(0, rnd((y - ymin) / dx)));
        const cell = j * n + i;
        const arr = hazard.arrival[cell];
        const walkerT = departS + (length * t) / v;
        if (arr >= 0.0 && arr < walkerT && hazard.depth[cell] > params.routeCutDepthM) {
            return true;
        }
    }
    return false;
}

/** Expected casualties for the accumulated event, one evacuation run.
 *  Port of assess_casualties. Returns { daytime, present, fatalities,
 *  injuries, evacSuccess, atRisk, perBuilding, summary() }.
 *
 *  tQuakeS: rupture time on the solver clock (evac clock starts here).
 *  null => the wave's own first arrival (correct for a near-field quake,
 *  whose rupture and first wave coincide). Never later than first arrival. */
export function assessCasualties(town, grid, bed, hazard, params, daytime,
                                 refuges = null, tQuakeS = null) {
    const nB = town.buildings.length;
    const per = new Float64Array(nB);
    if (nB === 0) return makeReport(daytime, 0, 0, 0, 1.0, 0, per);
    // A town WITH roads evacuates over the network (M12b); a roadless one
    // keeps the legacy full-speed beeline. `refuges` is the app's shared
    // cache slot — an EvacPlan (detected by .neededBaseS) or a Float64Array
    // of nearest-refuge xy; recompute if it's the wrong shape or stale.
    const useNet = town.roads && town.roads.edges.length > 0;
    let plan = null;
    if (useNet) {
        plan = (refuges && refuges.neededBaseS) ? refuges : null;
        if (!plan || plan.neededBaseS.length !== nB) {
            plan = planEvacuation(town, grid, bed, params);
        }
    } else if (!refuges || refuges.neededBaseS || refuges.length !== nB * 2) {
        refuges = nearestRefuges(town, grid, bed, params);
    }
    const { n, dx, xmin, ymin } = grid;

    // People present in this mode.
    let present = 0;
    const people = new Float64Array(nB);
    for (let k = 0; k < nB; k++) {
        const bt = town.buildings[k].type;
        people[k] = daytime ? bt.occupancy_day : bt.occupancy_night;
        present += people[k];
    }
    present = Math.trunc(present);   // int() on the desktop: truncate

    // First stamped arrival over the whole field (the wave's map entry).
    let stampedMin = Infinity;
    for (let i = 0; i < hazard.arrival.length; i++) {
        const a = hazard.arrival[i];
        if (a >= 0.0 && a < stampedMin) stampedMin = a;
    }
    if (stampedMin === Infinity) {
        // No wave yet: nobody at risk.
        return makeReport(daytime, present, 0, 0, 1.0, 0, per);
    }
    const tQuake = tQuakeS === null ? stampedMin
                                    : Math.min(tQuakeS, stampedMin);
    const depart = tQuake + params.detectionDelayS + params.reactionDelayS;

    let fatalities = 0, atRisk = 0, peopleEvac = 0, peopleSum = 0;
    for (let k = 0; k < nB; k++) {
        const b = town.buildings[k];
        const cell = Math.min(n - 1, Math.max(0, rnd((b.y - ymin) / dx))) * n
                   + Math.min(n - 1, Math.max(0, rnd((b.x - xmin) / dx)));
        const depth = hazard.depth[cell];
        const speed = hazard.speed[cell];
        const arrival = hazard.arrival[cell];
        peopleSum += people[k];

        // P(fatal | caught): lognormal in depth, median pulled down by the
        // local max flow speed.
        let pFatal = 0.0;
        if (depth > 0.0) {
            const pull = Math.min(1.0, Math.max(0.0, speed / SWEEP_SPEED));
            const d50 = FATAL_D50_CALM - (FATAL_D50_CALM - FATAL_D50_SWEPT) * pull;
            const z = (Math.log(depth) - Math.log(d50)) / FATAL_BETA;
            pFatal = 0.5 * (1.0 + erf(z / SQRT2));
            atRisk += people[k];
        }

        // Evacuation success. A critical building rides the same route on
        // a slower clock (factor divides the time, never the geometry).
        let e = 1.0;
        const factor = Math.max(
            b.type.critical ? params.criticalSpeedFactor : 1.0, 0.05);
        const noRefuge = useNet ? !Number.isFinite(plan.neededBaseS[k])
                                : !Number.isFinite(refuges[2 * k]);
        if (depth <= 0.0) {
            e = 1.0;                                   // never wet
        } else if (noRefuge) {
            e = 0.0;                                   // nowhere to go
        } else {
            let needed;
            if (useNet) {
                needed = plan.neededBaseS[k] / factor;
            } else {
                const v = params.walkSpeedMS * factor;
                const _rdx = refuges[2 * k] - b.x;   // plain sqrt, never
                const _rdy = refuges[2 * k + 1] - b.y;  // Math.hypot
                const dist = Math.sqrt(_rdx * _rdx + _rdy * _rdy);
                needed = dist / Math.max(v, 0.1);
            }
            const margin = arrival >= 0.0
                ? (arrival - depart) - needed
                : 6.0 * params.spreadS;               // wave never reached
            const m = Math.min(40.0, Math.max(-40.0, margin / params.spreadS));
            e = 1.0 / (1.0 + Math.exp(-m));
            if (e > params.routeCutFloor) {
                if (useNet) {
                    const path = plan.paths[k];
                    if (path && routeCutAlong(grid, hazard, path, depart,
                                              factor, params)) {
                        e = params.routeCutFloor;
                    }
                } else if (routeCut(grid, hazard, b.x, b.y, refuges[2 * k],
                                    refuges[2 * k + 1], depart,
                                    params.walkSpeedMS * factor, params)) {
                    e = params.routeCutFloor;
                }
            }
        }
        peopleEvac += people[k] * e;
        per[k] = people[k] * pFatal * (1.0 - e);
        fatalities += per[k];
    }
    const weightedE = peopleSum > 0 ? peopleEvac / peopleSum : 1.0;
    return makeReport(daytime, present, fatalities,
                      fatalities * params.injuriesPerFatality,
                      weightedE, Math.trunc(atRisk), per);
}

function makeReport(daytime, present, fatalities, injuries, evacSuccess,
                    atRisk, perBuilding) {
    return {
        daytime, present, fatalities, injuries, evacSuccess, atRisk,
        perBuilding,
        summary() {
            const mode = daytime ? "day" : "night";
            return `casualties (${mode}): ~${Math.round(fatalities).toLocaleString("en-US")} ` +
                   `dead ~${Math.round(injuries).toLocaleString("en-US")} hurt of ` +
                   `${present.toLocaleString("en-US")}   ` +
                   `evac ${(100 * evacSuccess).toFixed(0)}%`;
        },
    };
}
