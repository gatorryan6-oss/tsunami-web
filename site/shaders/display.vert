#version 300 es
// Display pass (NOT physics — free-form). Fullscreen quad with UVs.
//
// u_uv0/u_uv1 define the texture window this draw shows: (0,0)..(1,1) is
// the whole domain (the main view); a sub-rectangle is the zoomed town
// inset. The app computes windows with texel-CENTER mapping
// (uv = ((x - xmin)/dx + 0.5)/n) so a zoomed view lines up exactly with
// overlay geometry drawn in world coordinates.
precision highp float;

uniform vec2 u_uv0;   // window lower-left  (texture space)
uniform vec2 u_uv1;   // window upper-right (texture space)

in vec2 in_position;
out vec2 v_uv;

void main() {
    v_uv = mix(u_uv0, u_uv1, in_position * 0.5 + 0.5);
    gl_Position = vec4(in_position, 0.0, 1.0);
}
