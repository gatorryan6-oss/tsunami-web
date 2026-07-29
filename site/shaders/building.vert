#version 300 es
// 3D view buildings (NOT physics — free-form; port of the desktop
// render/shaders/building.vert, extended with gable roofs in web M13a).
// Instanced: one unit building (walls z in [0, 1], roof ridge at z = 2),
// stamped per building with position, footprint/height scale, street-grid
// rotation, color, and roof rise. Explicit attribute locations replace the
// desktop's name-based binding (locations 0-1 per-vertex, 2-6 per-instance).
precision highp float;

layout(location = 0) in vec3 in_pos;   // xy in [-0.5, 0.5]; z: 0 base, 1 eave, 2 ridge
layout(location = 1) in vec3 in_norm;  // roof slopes carry MARKER (0, ±1, 1)

layout(location = 2) in vec3 i_center; // world x, y, base z (slightly sunk)
layout(location = 3) in vec3 i_scale;  // footprint x, footprint y, height
layout(location = 4) in vec2 i_rot;    // cos, sin of the street-grid rotation
layout(location = 5) in vec3 i_color;
layout(location = 6) in float i_roof;  // gable ridge rise in METERS; 0 = flat top

uniform mat4 u_view;
uniform mat4 u_proj;
uniform vec3 u_sun_dir;

out vec3 v_color;

// Pitched roofs read darker than the walls under them (shingle over
// siding). Flat tops keep full albedo so civic colors stay readable
// from the orbit view.
const float ROOF_TINT = 0.65;

void main() {
    // Unit z in [0, 1] is wall, scaled by the building height; the unit
    // above 1 is ridge rise in raw meters. i_roof = 0 therefore collapses
    // the roof into exactly the old flat top.
    float wall  = min(in_pos.z, 1.0);
    float ridge = max(in_pos.z - 1.0, 0.0);
    vec3 p = vec3(in_pos.xy * i_scale.xy,
                  wall * i_scale.z + ridge * i_roof);
    vec2 r = vec2(p.x * i_rot.x - p.y * i_rot.y,
                  p.x * i_rot.y + p.y * i_rot.x);
    vec3 world = vec3(i_center.xy + r, i_center.z + p.z);

    // Roof slopes: the true normal depends on the per-instance pitch
    // (rise i_roof over half the footprint), so rebuild it from the
    // marker. Every other face keeps its mesh normal.
    vec3 nl = in_norm;
    float tint = 1.0;
    if (in_norm.z > 0.5 && abs(in_norm.y) > 0.5) {
        nl = vec3(0.0, sign(in_norm.y) * i_roof, 0.5 * i_scale.y);
        if (i_roof > 0.0) tint = ROOF_TINT;
    }
    vec3 nrm = normalize(vec3(nl.x * i_rot.x - nl.y * i_rot.y,
                              nl.x * i_rot.y + nl.y * i_rot.x,
                              nl.z));
    float diff = max(dot(nrm, normalize(u_sun_dir)), 0.0);
    v_color = i_color * tint * (0.40 + 0.65 * diff);
    gl_Position = u_proj * u_view * vec4(world, 1.0);
}
