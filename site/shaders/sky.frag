#version 300 es
// 3D view sky (NOT physics — free-form; port of the desktop
// render/shaders/sky.frag). Procedural gradient sky with a sun. The SAME
// sky_color function is duplicated in water.frag so the water reflects
// exactly this sky — KEEP THE TWO IN SYNC.
precision highp float;

in vec2 v_ndc;

uniform mat4 u_inv_vp;     // inverse(projection * view)
uniform vec3 u_camera_pos;
uniform vec3 u_sun_dir;

out vec4 f_color;

vec3 sky_color(vec3 dir, vec3 sun, float glow) {
    float up = clamp(dir.z, -1.0, 1.0);
    vec3 zenith  = vec3(0.22, 0.45, 0.80);
    vec3 horizon = vec3(0.74, 0.85, 0.95);
    vec3 base = mix(horizon, zenith, pow(max(up, 0.0), 0.55));
    if (up < 0.0) {
        base = mix(horizon, vec3(0.55, 0.65, 0.75), min(-up * 3.0, 1.0));
    }
    float sundot = max(dot(dir, sun), 0.0);
    base += vec3(1.0, 0.92, 0.75) * pow(sundot, 900.0) * 12.0;         // disc
    base += vec3(1.0, 0.85, 0.60) * pow(sundot, 10.0) * 0.18 * glow;   // halo
    return base;
}

void main() {
    vec4 far = u_inv_vp * vec4(v_ndc, 1.0, 1.0);
    vec3 dir = normalize(far.xyz / far.w - u_camera_pos);
    f_color = vec4(sky_color(dir, normalize(u_sun_dir), 1.0), 1.0);
}
