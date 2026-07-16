#version 300 es
// Top-down scientific view (NOT physics — free-form). Colors deliberately
// match the desktop reference-harness renders (make_reference.py
// render_png): green/brown terrain shading on land, blue/red diverging
// surface anomaly over water, so a browser frame can be eyeballed against
// the reference PNGs directly.
precision highp float;
precision highp sampler2D;

uniform sampler2D u_bed;     // R32F bed elevation (m)
uniform sampler2D u_state;   // RGBA32F: R = water depth h
uniform float u_range_m;     // anomaly display range (+- m)

in vec2 v_uv;
out vec4 f_color;

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
        if (a >= 0.0) {
            rgb = vec3(0.15 + 0.85 * a, 0.25 + 0.2 * (1.0 - a),
                       0.55 * (1.0 - a) + 0.1);
        } else {
            rgb = vec3(0.05 * (1.0 + a), 0.2 + 0.3 * (1.0 + a),
                       0.45 - 0.5 * a);
        }
    }
    f_color = vec4(rgb, 1.0);
}
