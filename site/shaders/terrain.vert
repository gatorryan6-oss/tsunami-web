#version 300 es
// 3D view terrain (NOT physics — free-form; port of the desktop
// render/shaders/terrain.vert). Runs once per mesh vertex: reads this
// point's elevation from the height texture and lifts the flat (x, y)
// grid into 3D terrain.
precision highp float;
precision highp sampler2D;

in vec2 in_position;        // world x (east), y (north), meters

uniform sampler2D u_height; // bed elevation b(x, y), meters
uniform vec2 u_origin;      // world coords of the height texture's SW corner
uniform float u_size;       // domain edge length, meters
uniform float u_texn;       // height texture size in texels per side
uniform mat4 u_view;
uniform mat4 u_proj;

out vec3 v_world;
out vec2 v_uv;

// Map world (x, y) onto the height texture so grid point i lands exactly on
// texel center i — the 0.5/n shift is what lines mesh and texture up.
vec2 world_to_uv(vec2 p) {
    vec2 t = (p - u_origin) / u_size;
    return t * ((u_texn - 1.0) / u_texn) + 0.5 / u_texn;
}

void main() {
    vec2 uv = world_to_uv(in_position);
    float z = textureLod(u_height, uv, 0.0).r;
    v_world = vec3(in_position, z);
    v_uv = uv;
    gl_Position = u_proj * u_view * vec4(v_world, 1.0);
}
