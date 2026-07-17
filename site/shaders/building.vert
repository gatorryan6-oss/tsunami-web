#version 300 es
// 3D view buildings (NOT physics — free-form; port of the desktop
// render/shaders/building.vert). Instanced: one unit cube (base at z=0),
// stamped per building with position, footprint/height scale, street-grid
// rotation, and color. Explicit attribute locations replace the desktop's
// name-based binding (locations 0-1 per-vertex, 2-5 per-instance).
precision highp float;

layout(location = 0) in vec3 in_pos;   // unit cube, xy in [-0.5, 0.5], z in [0, 1]
layout(location = 1) in vec3 in_norm;

layout(location = 2) in vec3 i_center; // world x, y, base z (slightly sunk)
layout(location = 3) in vec3 i_scale;  // footprint x, footprint y, height
layout(location = 4) in vec2 i_rot;    // cos, sin of the street-grid rotation
layout(location = 5) in vec3 i_color;

uniform mat4 u_view;
uniform mat4 u_proj;
uniform vec3 u_sun_dir;

out vec3 v_color;

void main() {
    vec3 p = in_pos * i_scale;
    vec2 r = vec2(p.x * i_rot.x - p.y * i_rot.y,
                  p.x * i_rot.y + p.y * i_rot.x);
    vec3 world = vec3(i_center.xy + r, i_center.z + p.z);
    vec3 nrm = normalize(vec3(in_norm.x * i_rot.x - in_norm.y * i_rot.y,
                              in_norm.x * i_rot.y + in_norm.y * i_rot.x,
                              in_norm.z));
    float diff = max(dot(nrm, normalize(u_sun_dir)), 0.0);
    v_color = i_color * (0.40 + 0.65 * diff);
    gl_Position = u_proj * u_view * vec4(world, 1.0);
}
