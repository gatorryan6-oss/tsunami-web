#version 300 es
// Flat-shaded color computed in the vertex shader; passthrough here.
// (Port of the desktop render/shaders/building.frag.)
precision highp float;

in vec3 v_color;
out vec4 f_color;

void main() {
    f_color = vec4(v_color, 1.0);
}
