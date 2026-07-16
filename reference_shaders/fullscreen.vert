#version 330

// Solver passes draw one full-screen quad so the fragment shader runs
// exactly once per grid cell. No matrices — the quad IS the grid.

in vec2 in_position;  // corners in normalized device coords

void main() {
    gl_Position = vec4(in_position, 0.0, 1.0);
}
