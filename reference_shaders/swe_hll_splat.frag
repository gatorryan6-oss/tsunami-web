#version 330

// Add a Gaussian bump of WATER DEPTH to currently-wet cells — the click
// 'pebble' for the nonlinear solver (state R channel = h).

uniform sampler2D u_state;
uniform vec2 u_center;   // bump center in texel coordinates
uniform float u_radius;  // 1/e radius in texels
uniform float u_amp;     // amplitude (m)

out vec4 f_state;

// Matches NonlinearSWESolver.SPLAT_MIN_DEPTH: only visibly-wet cells take
// the bump, so clicks never dump water onto dry-looking beach films.
const float SPLAT_MIN_DEPTH = 0.02;

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 s = texelFetch(u_state, p, 0);
    vec2 d = gl_FragCoord.xy - u_center;
    float bump = u_amp * exp(-dot(d, d) / (u_radius * u_radius));
    if (s.r > SPLAT_MIN_DEPTH) {
        s.r += bump;
    }
    f_state = s;
}
