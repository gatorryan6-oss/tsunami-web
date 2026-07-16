#version 330

// One RK stage of the MUSCL (second-order) nonlinear shallow-water scheme —
// the GLSL port of NonlinearSWESolver (solver_cpu_hll.py is the reference;
// any change there must be mirrored here).
//
// Each fragment = one cell. It rebuilds the limited linear reconstruction
// (depth h, surface w = h + b, velocities; generalized minmod theta 1.3)
// for itself and its neighbors, evaluates HLL fluxes on the EDGE values at
// its four faces (with hydrostatic reconstruction and dry-bed wave-speed
// corrections), and applies the well-balanced sources.
//
// Time stepping is SSP-RK2, driven by u_stage:
//   stage 0:  out = U + dt L(U)                     (U from u_state)
//   stage 1:  out = (Uprev + U + dt L(U)) / 2 + friction
//             (U = stage-0 result in u_state, Uprev = U^n in u_prev)
//
// State texel: R = water depth h (m), G = hu, B = hv (m^2/s).

uniform sampler2D u_state;
uniform sampler2D u_prev;   // U^n, read only in stage 1
uniform sampler2D u_bed;
uniform float u_dt;
uniform float u_dx;
uniform float u_g;
uniform sampler2D u_manning;  // per-cell Manning n (R32F): vegetation
                              // belts raise the drag locally (P5)
uniform int u_n;
uniform ivec4 u_open;       // open edges: x=west, y=east, z=south, w=north
uniform int u_stage;
uniform int u_wm;           // wavemaker active THIS STAGE (west edge)
uniform float u_wm_eta;     // incident surface elevation eta_inc (m)

out vec4 f_state;

const float H_DRY = 1e-3;   // must match NonlinearSWESolver.H_DRY
const float THETA = 1.3;    // generalized-minmod parameter
const float WM_MIN_DEPTH = 1.0;  // must match NonlinearSWESolver.WM_MIN_DEPTH

// Desingularized velocity (Kurganov & Petrova), exactly like the CPU.
vec2 vel(float h, float qn, float qt) {
    h = max(h, 0.0);
    float h4 = (h * h) * (h * h);
    float eps4 = H_DRY * H_DRY * H_DRY * H_DRY;
    return sqrt(2.0) * h * vec2(qn, qt) / sqrt(h4 + max(h4, eps4));
}

// Cell fetch with ghost rules: out-of-range indices clamp to the border
// cell (zero-gradient) and flip the NORMAL velocity at wall edges.
// axis 0 = x-faces (normal = u), axis 1 = y-faces (normal = v).
void fetchc(ivec2 p, int axis, out float h, out float un, out float ut,
            out float b) {
    ivec2 q = clamp(p, ivec2(0), ivec2(u_n - 1));
    vec4 s = texelFetch(u_state, q, 0);
    b = texelFetch(u_bed, q, 0).r;
    float sgn = 1.0;
    if (axis == 0) {
        if ((p.x < 0 && u_open.x == 0) || (p.x >= u_n && u_open.y == 0)) sgn = -1.0;
    } else {
        if ((p.y < 0 && u_open.z == 0) || (p.y >= u_n && u_open.w == 0)) sgn = -1.0;
    }
    vec2 uv = (axis == 0) ? vel(s.r, s.g, s.b) : vel(s.r, s.b, s.g);
    h = s.r;
    un = uv.x * sgn;
    ut = uv.y;

    // THE WAVEMAKER GHOST (west edge, while a train is active) — the
    // GLSL mirror of the CPU's characteristic boundary (see
    // solver_cpu_hll._direction): incoming invariant R+ prescribed by
    // the incident wave, outgoing R- taken from the interior edge cell
    // (which the clamped fetch above already gave us). Rows too shallow
    // to linearize keep the legacy zero-gradient ghost.
    if (u_wm == 1 && axis == 0 && p.x < 0 && u_open.x == 1) {
        float D = max(-b, 0.0);
        if (D > WM_MIN_DEPTH && h > H_DRY) {
            float rgd = sqrt(u_g / D);
            float u_inc = u_wm_eta * rgd;
            float Rp = u_inc + u_wm_eta * rgd;   // prescribed incoming
            float Rm = un - (h + b) * rgd;       // interior outgoing
            float eta_g = 0.5 * (Rp - Rm) / rgd;
            un = 0.5 * (Rp + Rm);
            h = max(eta_g - b, 0.0);
        }
    }
}

float minmod3(float a, float m, float c) {
    if (a > 0.0 && m > 0.0 && c > 0.0) return min(min(a, m), c);
    if (a < 0.0 && m < 0.0 && c < 0.0) return max(max(a, m), c);
    return 0.0;
}

// Limited slopes (sh, sw, sun, sut) of the middle cell given its neighbors.
// `valid` = interior cell with a fully-wet stencil (else first order).
vec4 slopes(float hm, float um, float tm, float bm,
            float h0, float u0, float t0, float b0,
            float hp, float up, float tp, float bp, bool valid) {
    if (!valid) return vec4(0.0);
    float wm = hm + bm, w0 = h0 + b0, wp = hp + bp;
    float sh = minmod3(THETA * (h0 - hm), 0.5 * (hp - hm), THETA * (hp - h0));
    sh = clamp(sh, -2.0 * h0, 2.0 * h0);   // both edges stay >= 0
    float sw = minmod3(THETA * (w0 - wm), 0.5 * (wp - wm), THETA * (wp - w0));
    float su = minmod3(THETA * (u0 - um), 0.5 * (up - um), THETA * (up - u0));
    float st = minmod3(THETA * (t0 - tm), 0.5 * (tp - tm), THETA * (tp - t0));
    return vec4(sh, sw, su, st);
}

// HLL flux with hydrostatic reconstruction and dry-bed corrections.
// Returns (mass, normal-mom, tangential-mom); hLs/hRs for the source term.
vec3 face_flux(float hL, float bL, float uL, float vL,
               float hR, float bR, float uR, float vR,
               out float hLs, out float hRs) {
    float bF = max(bL, bR);
    hLs = max(hL + bL - bF, 0.0);
    hRs = max(hR + bR - bF, 0.0);

    float cL = sqrt(u_g * hLs);
    float cR = sqrt(u_g * hRs);
    float sL = min(uL - cL, uR - cR);
    float sR = max(uL + cL, uR + cR);
    if (hLs <= 0.0) { sL = uR - 2.0 * cR; sR = uR + cR; }
    if (hRs <= 0.0) { sR = uL + 2.0 * cL; sL = uL - cL; }
    sL = min(sL, 0.0);
    sR = max(sR, 0.0);

    float qL = hLs * uL;
    float qR = hRs * uR;
    vec3 FL = vec3(qL, qL * uL + 0.5 * u_g * hLs * hLs, qL * vL);
    vec3 FR = vec3(qR, qR * uR + 0.5 * u_g * hRs * hRs, qR * vR);

    float denom = sR - sL;
    if (denom <= 1e-8) return vec3(0.0);
    vec3 dU = vec3(hRs - hLs, qR - qL, hRs * vR - hLs * vL);
    return (sR * FL - sL * FR + sL * sR * dU) / denom;
}

// Fluxes through this cell's two faces along one axis, plus the momentum
// source. e = unit step (1,0) or (0,1); axis selects the normal component.
void direction(ivec2 p, ivec2 e, int axis,
               out vec3 fW, out vec3 fE, out float src) {
    float h[5], un[5], ut[5], b[5];
    for (int k = -2; k <= 2; k++) {
        fetchc(p + k * e, axis, h[k + 2], un[k + 2], ut[k + 2], b[k + 2]);
    }
    int k0 = (axis == 0) ? p.x : p.y;

    // Slopes for cells k0-1, k0, k0+1. A cell's slope is zero at the domain
    // border or when its 3-cell stencil touches dry (first-order fallback).
    bool ok_m = (k0 - 1 >= 1) && (h[0] > H_DRY) && (h[1] > H_DRY) && (h[2] > H_DRY);
    bool ok_0 = (k0 >= 1) && (k0 <= u_n - 2)
                && (h[1] > H_DRY) && (h[2] > H_DRY) && (h[3] > H_DRY);
    bool ok_p = (k0 + 1 <= u_n - 2) && (h[2] > H_DRY) && (h[3] > H_DRY) && (h[4] > H_DRY);
    vec4 sm = slopes(h[0], un[0], ut[0], b[0], h[1], un[1], ut[1], b[1],
                     h[2], un[2], ut[2], b[2], ok_m);
    vec4 s0 = slopes(h[1], un[1], ut[1], b[1], h[2], un[2], ut[2], b[2],
                     h[3], un[3], ut[3], b[3], ok_0);
    vec4 sp = slopes(h[2], un[2], ut[2], b[2], h[3], un[3], ut[3], b[3],
                     h[4], un[4], ut[4], b[4], ok_p);

    // Edge values. L = low-index edge, R = high-index edge; the bed at an
    // edge is implied by surface minus depth (the well-balancing trick).
    float hRe_m = h[1] + 0.5 * sm.x;
    float bRe_m = (h[1] + b[1] + 0.5 * sm.y) - hRe_m;
    float uRe_m = un[1] + 0.5 * sm.z;
    float vRe_m = ut[1] + 0.5 * sm.w;

    float hLe_0 = h[2] - 0.5 * s0.x, hRe_0 = h[2] + 0.5 * s0.x;
    float bLe_0 = (h[2] + b[2] - 0.5 * s0.y) - hLe_0;
    float bRe_0 = (h[2] + b[2] + 0.5 * s0.y) - hRe_0;
    float uLe_0 = un[2] - 0.5 * s0.z, uRe_0 = un[2] + 0.5 * s0.z;
    float vLe_0 = ut[2] - 0.5 * s0.w, vRe_0 = ut[2] + 0.5 * s0.w;

    float hLe_p = h[3] - 0.5 * sp.x;
    float bLe_p = (h[3] + b[3] - 0.5 * sp.y) - hLe_p;
    float uLe_p = un[3] - 0.5 * sp.z;
    float vLe_p = ut[3] - 0.5 * sp.w;

    float hLsW, hRsW, hLsE, hRsE;
    fW = face_flux(hRe_m, bRe_m, uRe_m, vRe_m,
                   hLe_0, bLe_0, uLe_0, vLe_0, hLsW, hRsW);
    fE = face_flux(hRe_0, bRe_0, uRe_0, vRe_0,
                   hLe_p, bLe_p, uLe_p, vLe_p, hLsE, hRsE);

    // Face corrections + centered bed-slope term (cancel exactly at rest).
    src = 0.5 * u_g / u_dx * ((hLsE * hLsE - hRe_0 * hRe_0)
                              + (hLe_0 * hLe_0 - hRsW * hRsW))
          - u_g / u_dx * 0.5 * (hLe_0 + hRe_0) * (bRe_0 - bLe_0);
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 s = texelFetch(u_state, p, 0);

    vec3 fxW, fxE, fyS, fyN;
    float src_x, src_y;
    direction(p, ivec2(1, 0), 0, fxW, fxE, src_x);
    direction(p, ivec2(0, 1), 1, fyS, fyN, src_y);

    // L(U): note y-direction "normal" is v and "tangential" is u.
    float rdx = 1.0 / u_dx;
    float rh  = -rdx * (fxE.x - fxW.x + fyN.x - fyS.x);
    float rhu = -rdx * (fxE.y - fxW.y + fyN.z - fyS.z) + src_x;
    float rhv = -rdx * (fxE.z - fxW.z + fyN.y - fyS.y) + src_y;

    float h_new, hu_new, hv_new;
    if (u_stage == 0) {
        h_new = s.r + u_dt * rh;
        hu_new = s.g + u_dt * rhu;
        hv_new = s.b + u_dt * rhv;
    } else {
        vec4 s0 = texelFetch(u_prev, p, 0);
        h_new = 0.5 * (s0.r + s.r + u_dt * rh);
        hu_new = 0.5 * (s0.g + s.g + u_dt * rhu);
        hv_new = 0.5 * (s0.b + s.b + u_dt * rhv);
    }

    // Wet/dry bookkeeping (momentum deleted only in truly-dry cells).
    h_new = max(h_new, 0.0);
    if (h_new <= 0.0) {
        hu_new = 0.0;
        hv_new = 0.0;
    }

    // Manning friction, semi-implicit, once per full step (final stage).
    // n sampled PER CELL, squared in float32 exactly like the CPU map.
    if (u_stage == 1) {
        float n_man = texelFetch(u_manning, p, 0).r;
        if (n_man > 0.0) {
            float hh = max(h_new, H_DRY);
            float spd = length(vec2(hu_new, hv_new)) / hh;
            float fac = 1.0 + u_dt * u_g * (n_man * n_man) * spd
                        / pow(hh, 4.0 / 3.0);
            hu_new /= fac;
            hv_new /= fac;
        }
    }

    f_state = vec4(h_new, hu_new, hv_new, 0.0);
}
