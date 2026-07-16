#version 300 es
// Display pass (NOT physics — free-form). Fullscreen quad with UVs.
precision highp float;

in vec2 in_position;
out vec2 v_uv;

void main() {
    v_uv = in_position * 0.5 + 0.5;
    gl_Position = vec4(in_position, 0.0, 1.0);
}
