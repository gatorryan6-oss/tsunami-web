#version 300 es
// 3D view water optics (NOT physics — free-form; port of the desktop
// render/shaders/water.frag). The wave field is untouched underneath:
//   * Schlick Fresnel between a REFLECTED procedural sky (same function as
//     sky.frag — KEEP IN SYNC) and the refracted view of the bed below
//     (alpha blending against the already-drawn terrain).
//   * Per-channel light absorption: red dies in meters, green in tens of
//     meters, blue last — which is WHY shallows are turquoise.
//   * Animated procedural ripples on the normal (display only).
//   * Foam driven by the SIMULATION state: the state texture carries
//     momentum (G=hu, B=hv), so breaking fronts and run-up edges compute
//     their own Froude number and whiten where the physics says.
precision highp float;
precision highp sampler2D;

in vec3 v_world;
in vec2 v_uv;

uniform sampler2D u_height;   // bed elevation (unit 0)
uniform sampler2D u_water;    // R = depth h, G = hu, B = hv (unit 1)
uniform sampler2D u_structure;// man-made-structure mask (unit 2): 1 = concrete
uniform float u_size;
uniform float u_texn;
uniform float u_slope_boost;  // display-only tilt amplification
uniform float u_time;
uniform vec3 u_camera_pos;
uniform vec3 u_sun_dir;

out vec4 f_color;

const float G = 9.81;

// ---- sky (duplicated from sky.frag — KEEP IN SYNC) ----------------------
// `glow` scales the broad atmospheric halo: 1.0 for the real sky; the sea
// passes less, because a rippled surface smears the halo into nothing
// while the sharp disc survives as glitter.
vec3 sky_color(vec3 dir, vec3 sun, float glow) {
    float up = clamp(dir.z, -1.0, 1.0);
    vec3 zenith  = vec3(0.22, 0.45, 0.80);
    vec3 horizon = vec3(0.74, 0.85, 0.95);
    vec3 base = mix(horizon, zenith, pow(max(up, 0.0), 0.55));
    if (up < 0.0) {
        base = mix(horizon, vec3(0.55, 0.65, 0.75), min(-up * 3.0, 1.0));
    }
    float sundot = max(dot(dir, sun), 0.0);
    base += vec3(1.0, 0.92, 0.75) * pow(sundot, 900.0) * 12.0;
    base += vec3(1.0, 0.85, 0.60) * pow(sundot, 10.0) * 0.18 * glow;
    return base;
}

// ---- cheap value noise ----------------------------------------------------
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x),
               mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p) {
    return 0.6 * vnoise(p) + 0.3 * vnoise(p * 2.7) + 0.1 * vnoise(p * 6.1);
}

// Ripple height for the detail normal (meters, small).
float ripple_h(vec2 p, float t) {
    return vnoise(p * 0.020 + vec2(t * 0.50, t * 0.35)) * 0.6
         + vnoise(p * 0.055 - vec2(t * 0.70, -t * 0.45)) * 0.4;
}

void main() {
    vec4 state = texture(u_water, v_uv);
    float column = state.r;
    if (column <= 0.02) {
        discard;
    }
    float bed = texture(u_height, v_uv).r;
    float surf0 = bed + column;

    // ---- wave normal (boosted gradient of the true surface) -------------
    float texel = 1.0 / u_texn;
    float dx_world = u_size / (u_texn - 1.0);
    float eL_h = texture(u_water, v_uv - vec2(texel, 0.0)).r;
    float eR_h = texture(u_water, v_uv + vec2(texel, 0.0)).r;
    float eS_h = texture(u_water, v_uv - vec2(0.0, texel)).r;
    float eN_h = texture(u_water, v_uv + vec2(0.0, texel)).r;
    float surf_or0 = surf0;  // dry neighbors fall back to our own surface
    float eL = (eL_h > 0.02) ? texture(u_height, v_uv - vec2(texel, 0.0)).r + eL_h : surf_or0;
    float eR = (eR_h > 0.02) ? texture(u_height, v_uv + vec2(texel, 0.0)).r + eR_h : surf_or0;
    float eS = (eS_h > 0.02) ? texture(u_height, v_uv - vec2(0.0, texel)).r + eS_h : surf_or0;
    float eN = (eN_h > 0.02) ? texture(u_height, v_uv + vec2(0.0, texel)).r + eN_h : surf_or0;

    vec3 normal = vec3((eL - eR) / (2.0 * dx_world) * u_slope_boost,
                       (eS - eN) / (2.0 * dx_world) * u_slope_boost, 1.0);

    // ---- animated ripple detail (fades with camera distance) ------------
    // The host wraps u_time at 3600 s for float32 precision; the aperiodic
    // noise would visibly re-roll at the wrap, so animated detail fades
    // out/in over the surrounding ~2 s instead (once per hour, invisible).
    float wrap_fade = clamp(min(u_time, 3600.0 - u_time), 0.0, 1.0);
    float cam_dist = length(u_camera_pos - v_world);
    float ripple_amp = 0.35 * clamp(9000.0 / cam_dist, 0.05, 1.0) * wrap_fade;
    vec2 rp = v_world.xy;
    float r0 = ripple_h(rp, u_time);
    float rx = ripple_h(rp + vec2(9.0, 0.0), u_time);
    float ry = ripple_h(rp + vec2(0.0, 9.0), u_time);
    normal.xy += vec2(r0 - rx, r0 - ry) * ripple_amp;
    normal = normalize(normal);

    vec3 sun = normalize(u_sun_dir);
    vec3 to_camera = normalize(u_camera_pos - v_world);

    // ---- Fresnel between reflected sky and the absorbed view down -------
    float cosv = clamp(dot(to_camera, normal), 0.0, 1.0);
    float f0 = 0.02;
    float fresnel = f0 + (1.0 - f0) * pow(1.0 - cosv, 5.0);

    vec3 refl_dir = reflect(-to_camera, normal);
    refl_dir.z = abs(refl_dir.z);            // the sea reflects sky, not sea
    vec3 reflection = sky_color(refl_dir, sun, 0.30);

    // Per-channel absorption sets the TRANSPARENCY (red dies in meters,
    // blue last), while the body color runs turquoise -> deep navy with
    // depth — the classic clear-water look.
    vec3 transmit = exp(-column * vec3(0.16, 0.045, 0.020));
    float alpha = clamp(1.0 - dot(transmit, vec3(0.3333)), 0.12, 0.97);
    vec3 body = mix(vec3(0.10, 0.48, 0.46), vec3(0.012, 0.10, 0.24),
                    1.0 - exp(-column / 50.0));

    vec3 color = mix(body, reflection, fresnel);

    // Soft sun diffuse so broad wave faces shade.
    color *= 0.75 + 0.25 * max(dot(normal, sun), 0.0);

    // Crest brightening keyed to the surface ANOMALY (above calm sea over
    // the ocean, above the ground over flooded land) so old waves stay
    // readable at map scale.
    float anomaly = surf0 - max(bed, 0.0);
    color *= 1.0 + 0.30 * clamp(anomaly / 0.75, -1.0, 1.0);

    // ---- foam ------------------------------------------------------------
    // Physics drives it: Froude number (supercritical = breaking/bore),
    // fast thin run-up sheets, and sharp crest curvature.
    float hh = max(column, 0.05);
    float speed = length(state.gb) / hh;
    float froude = speed / sqrt(G * hh);
    float curv = abs(eL + eR + eS + eN - 4.0 * surf0) / dx_world;

    // A man-made structure (future defenses) is a bed step one cell thick;
    // LINEAR-filtered, it fakes an infinitely sharp "crest", so the
    // curvature term would whiten it permanently even at rest. Gate that
    // term off within one cell of a structure (NEAREST mask, so max over
    // the 5-tap neighborhood = "wall adjacent"). Flow-driven foam (Froude
    // and speed) is untouched, so a wave truly overtopping the wall still
    // breaks and whitens — only the static artifact is removed.
    float wall = texture(u_structure, v_uv).r;
    wall = max(wall, texture(u_structure, v_uv - vec2(texel, 0.0)).r);
    wall = max(wall, texture(u_structure, v_uv + vec2(texel, 0.0)).r);
    wall = max(wall, texture(u_structure, v_uv - vec2(0.0, texel)).r);
    wall = max(wall, texture(u_structure, v_uv + vec2(0.0, texel)).r);
    float curv_gate = 1.0 - smoothstep(0.1, 0.6, wall);

    // (1 - smoothstep) rather than reversed edges: reversed-edge
    // smoothstep is undefined by the GLSL spec (the desktop left this note
    // for exactly this port — preserved).
    float drive = smoothstep(0.7, 1.4, froude)
                + smoothstep(1.5, 4.0, speed) * (1.0 - smoothstep(1.5, 6.0, column))
                + smoothstep(0.004, 0.015, curv) * curv_gate;
    drive = clamp(drive, 0.0, 1.2);

    float foam_pat = fbm(v_world.xy * 0.045 + vec2(u_time * 0.8, -u_time * 0.5));
    foam_pat = mix(0.5, foam_pat, wrap_fade);   // see wrap_fade above
    float foam = smoothstep(0.55, 0.95, foam_pat * 0.55 + drive * 0.6);
    color = mix(color, vec3(0.93, 0.96, 0.97), foam);
    alpha = max(alpha, foam * 0.9);

    // Thin run-up sheets stay translucent so the beach shows through.
    alpha *= smoothstep(0.02, 0.12, column) * 0.65 + 0.35;

    f_color = vec4(color, alpha);
}
