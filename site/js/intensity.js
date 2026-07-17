// The four canonical hazard fields — the JS mirror of the desktop
// core/hazard/intensity.py HAZARD_FIELDS. This is the SINGLE source of the
// overlay ramps, ranges, units, and paint domains: the map shader gets the
// ramp as uniforms and the HTML legend samples the same stops, so the map
// and its key can never disagree (exactly the desktop's contract).
//
// Channel select (matches the accumulator layout the overlay shaders read):
//   0 depth    = acc0.R   (land only)
//   1 speed    = acc0.B   (land only)
//   2 momentum = acc1.R   (land only)
//   3 arrival  = acc0.A   (everywhere the wave reached; auto-ranged)

export const HAZARD_FIELDS = [
    {
        key: "depth", channel: 0, name: "Max depth", unit: "m",
        vrange: [0.05, 8.0], everywhere: false,
        // Warm ramp: shallow/calm pale yellow -> deep/violent dark red.
        stops: [[0.0, [1.00, 0.95, 0.55]], [0.35, [1.00, 0.62, 0.16]],
                [0.70, [0.90, 0.16, 0.10]], [1.0, [0.55, 0.00, 0.06]]],
    },
    {
        key: "speed", channel: 1, name: "Max flow speed", unit: "m/s",
        vrange: [0.0, 8.0], everywhere: false,
        // Cool ramp: slow pale green -> fast blue-violet.
        stops: [[0.0, [0.80, 0.96, 0.70]], [0.5, [0.15, 0.72, 0.72]],
                [1.0, [0.24, 0.12, 0.82]]],
    },
    {
        key: "momentum", channel: 2, name: "Momentum flux  h·v²",
        unit: "m³/s²", vrange: [0.0, 200.0], everywhere: false,
        // Danger ramp: pale -> magenta -> deep purple (the drag that wrecks).
        stops: [[0.0, [1.00, 0.92, 0.72]], [0.4, [0.92, 0.32, 0.60]],
                [0.72, [0.60, 0.08, 0.52]], [1.0, [0.28, 0.00, 0.26]]],
    },
    {
        key: "arrival", channel: 3, name: "Arrival time", unit: "min",
        vrange: null, everywhere: true,   // auto-ranged from the field
        // Time ramp: earliest arrival red -> latest blue.
        stops: [[0.0, [0.92, 0.10, 0.10]], [0.25, [1.00, 0.55, 0.12]],
                [0.5, [0.96, 0.90, 0.32]], [0.75, [0.32, 0.80, 0.34]],
                [1.0, [0.22, 0.50, 0.95]]],
    },
];

export const FIELD_BY_KEY = Object.fromEntries(
    HAZARD_FIELDS.map(f => [f.key, f]));

// The shader's fixed-size ramp uniform arrays.
export const MAX_STOPS = 6;

const to255 = (c) => `${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0}`;

/** A CSS `linear-gradient(...)` matching the field's ramp — for the legend. */
export function rampCss(field) {
    const parts = field.stops.map(
        ([t, c]) => `rgb(${to255(c)}) ${(t * 100).toFixed(1)}%`);
    return `linear-gradient(to right, ${parts.join(", ")})`;
}

/** Pack a field's ramp into the shader uniform layout: fixed-size arrays of
 *  MAX_STOPS floats (t) and MAX_STOPS*3 floats (rgb), plus the count. Unused
 *  slots repeat the last stop so a short ramp reads cleanly past its end. */
export function rampUniforms(field) {
    const n = field.stops.length;
    const t = new Float32Array(MAX_STOPS);
    const c = new Float32Array(MAX_STOPS * 3);
    for (let k = 0; k < MAX_STOPS; k++) {
        const s = field.stops[Math.min(k, n - 1)];
        t[k] = s[0];
        c[k * 3] = s[1][0]; c[k * 3 + 1] = s[1][1]; c[k * 3 + 2] = s[1][2];
    }
    return { nstops: n, t, c };
}

/** Label text for the two ends of a field's legend, given the effective
 *  range [lo, hi] (raw units). Arrival is displayed in minutes. */
export function legendLabels(field, lo, hi) {
    if (field.key === "arrival") {
        return [`${(lo / 60).toFixed(0)} min`, `${(hi / 60).toFixed(0)} min`];
    }
    const fmt = (v) => (v >= 100 ? v.toFixed(0)
                        : v >= 1 ? v.toFixed(1) : v.toFixed(2));
    return [`${fmt(lo)} ${field.unit}`, `${fmt(hi)} ${field.unit}`];
}
