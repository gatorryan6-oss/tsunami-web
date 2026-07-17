#version 300 es
// 3D view terrain materials (NOT physics — free-form; port of the desktop
// render/shaders/terrain.frag). Elevation/slope splatting with procedural
// high-frequency detail so close-ups resolve to texture rather than
// blurred grid cells. Zone boundaries are dithered by noise (nature draws
// no contour lines), sand darkens where the sea keeps it wet, and a
// curvature term shades gullies. The hazard-overlay branch is ported and
// plumbed but stays OFF until the overlay milestone; u_structure is a
// zero mask until defenses exist in the web port.
precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 v_world;
in vec2 v_uv;

uniform sampler2D u_height;
uniform sampler2D u_max;    // acc0: R=depth, G=surf, B=speed, A=arrival
uniform sampler2D u_max2;   // acc1: R=momentum flux
uniform sampler2D u_structure;  // man-made-structure mask: 1 = concrete
uniform int u_overlay;      // 0 = off; 1 = paint a hazard overlay
uniform int u_ov_channel;   // 0 depth, 1 speed, 2 momentum, 3 arrival
uniform int u_ov_everywhere;// 0 = land only; 1 = wherever the wave reached
uniform vec2 u_ov_range;    // (vmin, vmax) for normalization
uniform int u_ov_nstops;
uniform float u_ov_stop_t[6];
uniform vec3 u_ov_stop_c[6];
uniform float u_size;
uniform float u_texn;
uniform vec3 u_sun_dir;

out vec4 f_color;

// Sample the uploaded color ramp (piecewise-linear) — identical stops to
// the legend, so map and key never disagree.
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

const vec3 DEEP_FLOOR = vec3(0.16, 0.19, 0.21);
const vec3 SHELF_SED  = vec3(0.34, 0.37, 0.33);
const vec3 SAND       = vec3(0.78, 0.70, 0.52);
const vec3 GRASS      = vec3(0.28, 0.40, 0.19);
const vec3 GRASS_DRY  = vec3(0.46, 0.47, 0.24);
const vec3 ROCK       = vec3(0.46, 0.42, 0.38);
const vec3 SNOW       = vec3(0.93, 0.94, 0.96);

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
    return 0.55 * vnoise(p) + 0.28 * vnoise(p * 2.63)
         + 0.17 * vnoise(p * 6.7);
}

void main() {
    // Surface normal from the heightfield gradient (central differences).
    float texel = 1.0 / u_texn;
    float dx_world = u_size / (u_texn - 1.0);
    float hL = texture(u_height, v_uv - vec2(texel, 0.0)).r;
    float hR = texture(u_height, v_uv + vec2(texel, 0.0)).r;
    float hS = texture(u_height, v_uv - vec2(0.0, texel)).r;
    float hN = texture(u_height, v_uv + vec2(0.0, texel)).r;
    vec3 normal = normalize(vec3(
        (hL - hR) / (2.0 * dx_world),
        (hS - hN) / (2.0 * dx_world),
        1.0
    ));

    float z = v_world.z;

    // Multi-scale material noise: breaks zone edges, varies albedo, and
    // gives close-ups real detail (50 m and ~6 m scales).
    float macro = fbm(v_world.xy * 0.0021);           // ~500 m patchiness
    float mid = fbm(v_world.xy * 0.02);               // ~50 m
    float fine = vnoise(v_world.xy * 0.16);           // ~6 m
    float z_dither = z + (macro - 0.5) * 14.0;        // organic boundaries

    // Underwater materials.
    vec3 wet = mix(DEEP_FLOOR, SHELF_SED, smoothstep(-900.0, -130.0, z_dither));
    wet = mix(wet, SAND * 0.9, smoothstep(-30.0, -4.0, z_dither));
    wet *= 0.92 + 0.16 * mid;                          // sediment mottling

    // Land materials: grass patchiness (lush/dry), rock, snow.
    vec3 grass = mix(GRASS, GRASS_DRY, smoothstep(0.35, 0.75, macro));
    vec3 dry = mix(SAND, grass, smoothstep(3.0, 40.0, z_dither));
    dry = mix(dry, ROCK, smoothstep(320.0, 800.0, z_dither));
    dry = mix(dry, SNOW, smoothstep(950.0 + 180.0 * macro, 1300.0, z));
    dry *= 0.90 + 0.20 * mid;
    dry *= 0.95 + 0.10 * fine;

    // Wet sand: the band the sea keeps damp just above the waterline.
    dry = mix(dry * 0.72, dry, smoothstep(0.0, 2.5, z));

    vec3 color = mix(wet, dry, smoothstep(-1.0, 1.0, z));

    // Steep faces are bare rock regardless of elevation, with striations.
    float rockiness = 1.0 - smoothstep(0.5, 0.72, normal.z);
    vec3 rock_face = ROCK * (0.85 + 0.3 * vnoise(v_world.xy * 0.05 + z * 0.02));
    color = mix(color, rock_face, rockiness);

    // Man-made structures (future defenses) are CONCRETE, not the sand the
    // raw elevation would paint. Weathered marine concrete: cool grey
    // mottled by noise, faint casting lines, darker damp splash zone,
    // flanks shaded darker than the crest so the raised form reads.
    float st = texture(u_structure, v_uv).r;
    if (st > 0.5) {
        vec3 base = vec3(0.42, 0.44, 0.47);
        base *= 0.80 + 0.22 * fbm(v_world.xy * 0.03);          // weathering
        base *= 0.92 + 0.08 * sin(z * 1.3 + fine * 2.0);       // pour lines
        base *= mix(0.62, 1.0, smoothstep(0.35, 0.9, normal.z)); // flanks dark
        base *= mix(0.68, 1.0, smoothstep(0.5, 6.0, z));       // splash stain
        color = base;
    }

    // Lighting: warm sun + cool ambient, plus concavity shading (gullies
    // and the feet of slopes read darker).
    float lap = (hL + hR + hS + hN - 4.0 * z) / dx_world;
    float cavity = clamp(1.0 - lap * 0.35, 0.82, 1.08);
    float diffuse = max(dot(normal, normalize(u_sun_dir)), 0.0);
    vec3 lit = color * (vec3(0.30, 0.34, 0.42) + vec3(1.0, 0.96, 0.88) * 0.75 * diffuse);
    color = lit * cavity;

    // Hazard overlay: one of the four accumulated fields as a heatmap.
    if (u_overlay == 1) {
        vec4 a0 = texture(u_max, v_uv);
        float val;
        bool valid;
        if (u_ov_channel == 0)      { val = a0.r; valid = val > 0.05; }
        else if (u_ov_channel == 1) { val = a0.b; valid = val > 0.05; }
        else if (u_ov_channel == 2) { val = texture(u_max2, v_uv).r;
                                      valid = val > 0.10; }
        else                        { val = a0.a; valid = val >= 0.0; } // arrival
        bool in_domain = (u_ov_everywhere == 1) ? true : (z > 0.0);
        if (valid && in_domain) {
            float t = (val - u_ov_range.x)
                      / max(u_ov_range.y - u_ov_range.x, 1e-6);
            color = mix(color, hazard_ramp(t), 0.62);
        }
    }

    f_color = vec4(color, 1.0);
}
