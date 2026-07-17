#version 300 es
// Top-down scientific view (NOT physics — free-form). Green/brown terrain
// shading on land; a diverging surface-anomaly ramp over water whose ZERO
// (calm sea) is a light, central tone — so the resting ocean never reads
// as "below zero" and any wave (cool drawdown / warm crest) stands out
// against it.
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D u_bed;     // R32F bed elevation (m)
uniform sampler2D u_state;   // RGBA32F: R = water depth h
uniform float u_range_m;     // anomaly display range (+- m)

// Hazard overlay (M9): when u_overlay==1, the selected accumulated field
// replaces the base map where it is valid (land-only for depth/speed/
// momentum, everywhere the wave reached for arrival). Same field specs and
// ramps as the 3D terrain overlay and the legend (js/intensity.js).
uniform sampler2D u_ov_max;    // acc0: R=depth, G=surf, B=speed, A=arrival
uniform sampler2D u_ov_max2;   // acc1: R=momentum
uniform int u_overlay;         // 0 off, 1 on
uniform int u_ov_channel;      // 0 depth, 1 speed, 2 momentum, 3 arrival
uniform int u_ov_everywhere;   // 0 land only, 1 wherever the wave reached
uniform vec2 u_ov_range;       // (vmin, vmax) for normalization
uniform int u_ov_nstops;
uniform float u_ov_stop_t[6];
uniform vec3 u_ov_stop_c[6];

in vec2 v_uv;
out vec4 f_color;

vec3 hazard_ramp(float t) {
    t = clamp(t, 0.0, 1.0);
    for (int k = 0; k < u_ov_nstops - 1; k++) {
        if (t <= u_ov_stop_t[k + 1]) {
            float t0 = u_ov_stop_t[k];
            float f = (t - t0) / max(u_ov_stop_t[k + 1] - t0, 1e-6);
            return mix(u_ov_stop_c[k], u_ov_stop_c[k + 1], clamp(f, 0.0, 1.0));
        }
    }
    return u_ov_stop_c[u_ov_nstops - 1];
}

// Diverging sea-surface-anomaly ramp, a in [-1, 1] (a = anomaly/range).
// Five stops — KEEP IN SYNC with the #colorbar gradient in index.html:
//   -1 deep navy (drawdown)  -0.5 blue  0 light ocean blue (CALM)
//   +0.5 amber  +1 red (crest).
// Polarity: warm = positive (crest, the hazard), cool = negative
// (drawdown). This matches the standard sea-surface-height / tsunami
// convention. A future option is to FLIP it to dramatize the receding-sea
// warning — logged in BUILDLOG (2026-07-17). If flipped, invert here AND
// the #colorbar gradient AND swap the -2 m / +2 m legend labels together.
vec3 anomalyColor(float a) {
    vec3 c0 = vec3(0.039, 0.192, 0.380);  // -1.0  #0a3161  deep drawdown
    vec3 c1 = vec3(0.141, 0.373, 0.612);  // -0.5  #245f9c
    vec3 c2 = vec3(0.384, 0.639, 0.839);  //  0.0  #62a3d6  calm sea
    vec3 c3 = vec3(0.933, 0.604, 0.302);  // +0.5  #ee9a4d
    vec3 c4 = vec3(0.776, 0.184, 0.122);  // +1.0  #c62f1f  crest
    if (a < -0.5) return mix(c0, c1, (a + 1.0) * 2.0);
    if (a <  0.0) return mix(c1, c2, (a + 0.5) * 2.0);
    if (a <  0.5) return mix(c2, c3, a * 2.0);
    return mix(c3, c4, (a - 0.5) * 2.0);
}

void main() {
    float bed = texture(u_bed, v_uv).r;
    float h = texture(u_state, v_uv).r;

    vec3 rgb;
    if (h <= 0.02) {
        // Land (or dry film): elevation-shaded earth tones.
        float shade = clamp(bed / 800.0, 0.0, 1.0);
        rgb = vec3(0.55 + 0.3 * shade, 0.52 + 0.25 * shade,
                   0.42 + 0.2 * shade);
    } else {
        // Water: surface anomaly vs the local reference (sea level over
        // ocean, the ground over flooded land).
        float anomaly = (bed + h) - max(bed, 0.0);
        float a = clamp(anomaly / u_range_m, -1.0, 1.0);
        rgb = anomalyColor(a);
    }

    // Hazard overlay: the selected accumulated field replaces the base map
    // where it is valid + in-domain (the instrument reading; the legend is
    // the key). Same channel select as the 3D terrain overlay.
    if (u_overlay == 1) {
        vec4 a0 = texture(u_ov_max, v_uv);
        float val;
        bool valid;
        if (u_ov_channel == 0)      { val = a0.r; valid = val > 0.05; }
        else if (u_ov_channel == 1) { val = a0.b; valid = val > 0.05; }
        else if (u_ov_channel == 2) { val = texture(u_ov_max2, v_uv).r;
                                      valid = val > 0.10; }
        else                        { val = a0.a; valid = val >= 0.0; } // arrival
        bool in_domain = (u_ov_everywhere == 1) ? true : (bed > 0.0);
        if (valid && in_domain) {
            float t = (val - u_ov_range.x)
                      / max(u_ov_range.y - u_ov_range.x, 1e-6);
            rgb = hazard_ramp(t);
        }
    }
    f_color = vec4(rgb, 1.0);
}
