#version 300 es
// 3D road ribbons fragment (port of desktop render/shaders/road.frag).
precision highp float;

in vec3 v_color;
out vec4 f_color;

void main() {
    f_color = vec4(v_color, 1.0);
}
