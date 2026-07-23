#version 300 es
// 3D road ribbons (NOT physics — display; port of the desktop
// render/shaders/road.vert). Pre-draped triangles: z is sampled from the
// terrain on the CPU when the mesh is built, so the vertex shader only
// transforms. Flat per-kind color.
precision highp float;

layout(location = 0) in vec3 in_pos;
layout(location = 1) in vec3 in_color;

uniform mat4 u_view;
uniform mat4 u_proj;

out vec3 v_color;

void main() {
    v_color = in_color;
    gl_Position = u_proj * u_view * vec4(in_pos, 1.0);
}
