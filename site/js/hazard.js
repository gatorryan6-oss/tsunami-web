// THE canonical hazard accessor — the JS mirror of the desktop
// get_hazard_fields() (core/hazard/intensity.py). The future damage-model
// phase consumes hazards through this shape and NOTHING else; no other
// module may read the accumulator textures back (enforced by
// tests/test_invariants.py).
//
// Fields (each a Float32Array of n*n, row-major, j=0 = SOUTH row):
//   depth     max inundation depth (m)            — how deep the water got
//   speed     max flow speed (m/s)                — how fast it moved
//   momentum  max momentum flux h*|u|^2 (m^3/s^2) — the drag it exerted
//   arrival   first-arrival time (s); -1 where the wave never arrived

export function getHazardFields(solver) {
    const { depth, speed, arrival } = solver.readHazards();
    const momentum = solver.readMomentum();
    return { depth, speed, momentum, arrival, n: solver.n };
}

/** (tMin, tMax) over cells the wave reached, for auto-scaling an arrival
 *  display. Returns null if nothing has arrived yet. */
export function arrivalRange(fields) {
    let lo = Infinity, hi = -Infinity;
    const a = fields.arrival;
    for (let i = 0; i < a.length; i++) {
        if (a[i] >= 0.0) {
            if (a[i] < lo) lo = a[i];
            if (a[i] > hi) hi = a[i];
        }
    }
    if (lo === Infinity) return null;
    return [lo, hi > lo ? hi : lo + 1.0];
}

/** Inundation extent: max depth beyond `thresholdM` on post-event LAND
 *  (bed > 0), as a Uint8Array mask — the teaching-relevant output the
 *  reference harness compares (make_reference.py uses 0.1 m). */
export function inundationExtent(fields, bed, thresholdM = 0.1) {
    const out = new Uint8Array(fields.depth.length);
    for (let i = 0; i < out.length; i++) {
        out[i] = (bed[i] > 0.0 && fields.depth[i] > thresholdM) ? 1 : 0;
    }
    return out;
}
