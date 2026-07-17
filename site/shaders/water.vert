#version 300 es
// 3D view sea surface (NOT physics — free-form; port of the desktop
// render/shaders/water.vert). The state texture carries water DEPTH h, and
// the surface you see is bed + h — so a wave flooding up the beach renders
// automatically (there, bed > 0 and h > 0). Display height is exaggerated
// (waves meters tall would be invisible from a map-scale camera), less so
// in shallow water. Physics is never touched.
precision highp float;
precision highp sampler2D;

in vec2 in_position;        // world x (east), y (north), meters

uniform sampler2D u_height; // bed elevation b(x, y), meters (unit 0)
uniform sampler2D u_water;  // R = water depth h, meters (unit 1)
uniform vec2 u_origin;      // world coords of the textures' SW corner
uniform float u_size;       // domain edge length, meters
uniform float u_texn;       // texture size in texels per side
uniform float u_exagg_shallow;
uniform float u_exagg_deep;
uniform mat4 u_view;
uniform mat4 u_proj;

out vec3 v_world;
out vec2 v_uv;

vec2 world_to_uv(vec2 p) {
    vec2 t = (p - u_origin) / u_size;
    return t * ((u_texn - 1.0) / u_texn) + 0.5 / u_texn;
}

void main() {
    vec2 uv = world_to_uv(in_position);
    float bed = textureLod(u_height, uv, 0.0).r;
    float h = textureLod(u_water, uv, 0.0).r;

    float still_depth = max(-bed, 0.0);
    float exagg = mix(u_exagg_shallow, u_exagg_deep,
                      smoothstep(20.0, 250.0, still_depth));

    float z_display;
    if (h > 0.02) {
        float surface = bed + h;      // sea-surface elevation
        // Exaggerate only the ANOMALY relative to the local reference:
        // calm sea level (0) over the ocean, the GROUND over flooded land.
        // Exaggerating absolute elevation instead would hoist flood water
        // 8x the land height into the air. Clamps: never below the seabed
        // (fake "drained bay" holes), always a hair above it so the depth
        // test resolves in water's favor.
        float ref = max(bed, 0.0);
        z_display = max(ref + (surface - ref) * exagg, bed + 1.0);
    } else {
        // Dry cell: tuck the vertex just under the terrain so shoreline
        // triangles stay small instead of spiking with the exaggeration.
        z_display = bed - 2.0;
    }

    v_world = vec3(in_position, z_display);
    v_uv = uv;
    gl_Position = u_proj * u_view * vec4(v_world, 1.0);
}
