// The nature of each scenario's source — the JS distillation of the
// desktop core/events/catalog.py, just the part the casualty clock needs.
// This is what makes the regional early-warning lesson possible.
//
// TWO SOURCE FAMILIES (the difference IS the lesson):
//   NEAR-FIELD  the fault ruptures inside the map. Violent shaking is the
//               town's own warning, but the wave is minutes behind it — no
//               siren beats the water. An EWS barely moves the toll.
//   REGIONAL    the fault ruptures hundreds of km offshore; the wave
//               arrives through the boundary travel_time later — ample time
//               to leave — BUT the distant quake is barely felt, so an
//               UNWARNED town doesn't know until the sea draws back. Here an
//               early-warning system is everyone-out vs no-one-out.
//
// The evacuation clock starts at the RUPTURE. For the near-field case the
// rupture is the map event (t_quake = 0). For a regional case the web's
// wavemaker enters the map at t = 0, so the rupture was travel_time EARLIER
// (t_quake = -travel_time) — which credits the same warning window the
// desktop gets by delaying the physics instead.

const G = 9.81;

/** Long-wave travel time over `distanceM` of ocean `depthM` deep: tsunamis
 *  move at c = sqrt(g*depth) (~670 km/h in the deep sea). Sets a regional
 *  source's head start. Verbatim from wavemaker.travel_time_s. */
export function travelTimeS(distanceM, depthM, g = G) {
    if (depthM <= 0) throw new Error("travel time needs water: depthM > 0");
    return distanceM / Math.sqrt(g * depthM);
}

// Detection delay (rupture -> the town knows) once an early-warning system
// is switched ON — buoys + sirens, regardless of the source (desktop
// EarlyWarningSystem detection).
export const EWS_DETECTION_S = 30.0;

// Per-scenario source nature. unwarnedDetectionS = how long an UNWARNED
// town takes to learn THIS event is coming: near-field short (they felt
// it), regional long (they didn't). Regional carries the offshore geometry
// that sets travel_time. (Scenario A floods nothing — no casualty relevance.)
export const SCENARIO_EVENTS = {
    a_deep_propagation: { kind: "offshore" },
    b_shelf_shoaling: {
        kind: "regional", distanceKm: 350, oceanDepthM: 3500,
        unwarnedDetectionS: 2400,      // ~40 min — barely felt, learned late
    },
    c_nearfield_inundation: {
        kind: "nearfield", unwarnedDetectionS: 180,  // felt the ground shake
    },
};

/** The effective (detectionDelayS, tQuakeS) for a scenario given the EWS
 *  state — exactly the desktop _assessment_evac() rule. tQuakeS is null for
 *  a source with no town-casualty relevance (the caller then uses the
 *  wave's own first arrival). */
export function evacTimingFor(scenarioId, ewsOn) {
    const ev = SCENARIO_EVENTS[scenarioId] || { kind: "offshore" };
    const detection = ewsOn ? EWS_DETECTION_S
        : (ev.unwarnedDetectionS ?? 180.0);
    let tQuake;
    if (ev.kind === "regional") {
        tQuake = -travelTimeS(ev.distanceKm * 1000, ev.oceanDepthM);
    } else if (ev.kind === "nearfield") {
        tQuake = 0.0;                  // rupture IS the map event
    } else {
        tQuake = null;                 // no relevance; caller uses arrival
    }
    return { detection, tQuake, kind: ev.kind };
}
