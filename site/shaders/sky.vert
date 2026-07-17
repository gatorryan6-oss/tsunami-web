#version 300 es
// 3D view sky (NOT physics — free-form; port of the desktop
// render/shaders/sky.vert). Fullscreen sky pass: emits a screen-covering
// triangle pair at the far plane; the fragment shader turns each pixel
// into a view ray.
precision highp float;

in vec2 in_position;   // NDC corners

out vec2 v_ndc;

void main() {
    v_ndc = in_position;
    gl_Position = vec4(in_position, 0.9999999, 1.0);  // behind everything
}
