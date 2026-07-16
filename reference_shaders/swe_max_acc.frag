#version 330

// HAZARD-FIELD accumulator, updated once per SUBSTEP (not per frame —
// peaks between frames must not be missed). Two render targets:
//   acc0 (f_acc):  R = max water depth h ever seen
//                  G = max sea-surface elevation (bed + h) while visibly wet
//                  B = max flow speed (desingularized, like the solver)
//                  A = FIRST-ARRIVAL time (s of solver clock), -1 until the
//                      wave arrives. Arrival = |surface anomaly| > 5 cm; a
//                      drawback trough counts — the receding sea IS the
//                      tsunami arriving.
//   acc1 (f_acc2): R = max MOMENTUM FLUX h*|u|^2 (m^3/s^2), the best single
//                      predictor of structural damage (the drag the flow
//                      exerts). Peaks at its OWN instant, not at max depth
//                      or max speed, so it must be tracked per-substep.
//                  G,B,A = reserved for future hazard fields.
// These feed the hazard overlays, the HUD readouts, and the probe. Keep
// semantics identical to the CPU solver's _accumulate().

uniform sampler2D u_acc;    // previous accumulator state (acc0)
uniform sampler2D u_acc2;   // previous momentum accumulator (acc1)
uniform sampler2D u_state;  // current solver state (R=h, G=hu, B=hv)
uniform sampler2D u_bed;
uniform float u_now;        // solver clock at the end of this substep (s)

layout(location = 0) out vec4 f_acc;
layout(location = 1) out vec4 f_acc2;

const float H_DRY = 1e-3;
const float ARRIVE_ANOMALY = 0.05;

// Desingularized velocity — must match the step shader / CPU solver.
vec2 vel(float h, float qn, float qt) {
    h = max(h, 0.0);
    float h4 = (h * h) * (h * h);
    float eps4 = H_DRY * H_DRY * H_DRY * H_DRY;
    return sqrt(2.0) * h * vec2(qn, qt) / sqrt(h4 + max(h4, eps4));
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 a = texelFetch(u_acc, p, 0);
    vec4 s = texelFetch(u_state, p, 0);
    float h = s.r;
    float bed = texelFetch(u_bed, p, 0).r;

    float surf = (h > 0.02) ? bed + h : -1e9;
    float speed = length(vel(h, s.g, s.b));
    float mflux = h * speed * speed;   // momentum flux h*|u|^2
    // Anomaly relative to the local reference: calm sea level over the
    // ocean, the ground over (flooded) land.
    float anomaly = (h > 0.02) ? (bed + h) - max(bed, 0.0) : 0.0;
    float arrival = (a.a >= 0.0) ? a.a
                    : ((abs(anomaly) > ARRIVE_ANOMALY) ? u_now : -1.0);

    f_acc = vec4(max(a.r, h), max(a.g, surf), max(a.b, speed), arrival);
    float a2 = texelFetch(u_acc2, p, 0).r;
    f_acc2 = vec4(max(a2, mflux), 0.0, 0.0, 0.0);
}
