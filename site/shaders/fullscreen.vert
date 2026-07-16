#version 300 es
// === ES 3.00 header (the ONLY allowed difference from reference_shaders/) ===
precision highp float;
precision highp int;
// === end ES header ===

// Solver passes draw one full-screen quad so the fragment shader runs
// exactly once per grid cell. No matrices — the quad IS the grid.

in vec2 in_position;  // corners in normalized device coords

void main() {
    gl_Position = vec4(in_position, 0.0, 1.0);
}
