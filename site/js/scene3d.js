// The 3D scene (NOT physics — pure display): terrain mesh + procedural
// sky, ported from the desktop render/{terrain_render,sky}.py. The water
// surface and the town join in M8b/M8c.
//
// The mesh trick (same as the desktop): the mesh is a flat grid of (x, y)
// points; elevation lives in a float TEXTURE and the vertex shader lifts
// each point. Here that texture is the solver's own bedTexture — the
// terrain IS the physics' world by construction (scenario C's coseismic
// drop shows up the frame it fires), and there is no separate upload path
// to go stale.
//
// Coordinates: x east, y north, z up, meters (the repo convention).
// Texture row 0 = south row = mesh row 0 — no flips anywhere.

import { compileProgram, createQuad } from "./gl.js";
import { multiply, invert } from "./mat4.js";
import { rampUniforms } from "./intensity.js";

// Afternoon sun from the southwest (desktop app/main.py SUN_DIR).
export const SUN_DIR = [0.45, 0.35, 0.82];

/** Flat (x, y) vertex grid + triangle indices for n x n quads covering
 *  `size` meters centered on the origin. z comes from the height texture
 *  in the vertex shader, so positions are 2D. One mesh vertex per
 *  heightfield texel — nothing is interpolated at the vertex stage. */
function makeGridMesh(nQuads, size) {
    const nv = nQuads + 1;
    const positions = new Float32Array(nv * nv * 2);
    for (let j = 0; j < nv; j++) {
        const y = -size / 2 + (size * j) / nQuads;
        for (let i = 0; i < nv; i++) {
            positions[(j * nv + i) * 2] = -size / 2 + (size * i) / nQuads;
            positions[(j * nv + i) * 2 + 1] = y;
        }
    }
    const indices = new Uint32Array(nQuads * nQuads * 6);
    let k = 0;
    for (let j = 0; j < nQuads; j++) {
        for (let i = 0; i < nQuads; i++) {
            const a = j * nv + i;         // SW corner of the cell
            const b = a + 1;              // SE
            const c = a + nv;             // NW
            const d = c + 1;              // NE
            indices[k++] = a; indices[k++] = b; indices[k++] = c;
            indices[k++] = c; indices[k++] = b; indices[k++] = d;
        }
    }
    return { positions, indices };
}

// How far a building sinks below its ground point, so boxes never float
// on sloped terrain (desktop town_render.SINK_M).
const SINK_M = 1.5;

/** 36 vertices (position xyz + normal xyz) of a unit cube, base at z = 0 —
 *  the desktop _unit_cube(), row for row. */
function unitCube() {
    const faces = [
        [[0, 0, -1], [[-.5, -.5, 0], [.5, .5, 0], [.5, -.5, 0],
                      [-.5, -.5, 0], [-.5, .5, 0], [.5, .5, 0]]],
        [[0, 0, 1], [[-.5, -.5, 1], [.5, -.5, 1], [.5, .5, 1],
                     [-.5, -.5, 1], [.5, .5, 1], [-.5, .5, 1]]],
        [[0, -1, 0], [[-.5, -.5, 0], [.5, -.5, 0], [.5, -.5, 1],
                      [-.5, -.5, 0], [.5, -.5, 1], [-.5, -.5, 1]]],
        [[0, 1, 0], [[-.5, .5, 0], [.5, .5, 1], [.5, .5, 0],
                     [-.5, .5, 0], [-.5, .5, 1], [.5, .5, 1]]],
        [[-1, 0, 0], [[-.5, -.5, 0], [-.5, .5, 1], [-.5, .5, 0],
                      [-.5, -.5, 0], [-.5, -.5, 1], [-.5, .5, 1]]],
        [[1, 0, 0], [[.5, -.5, 0], [.5, .5, 0], [.5, .5, 1],
                     [.5, -.5, 0], [.5, .5, 1], [.5, -.5, 1]]],
    ];
    const out = new Float32Array(36 * 6);
    let k = 0;
    for (const [norm, verts] of faces) {
        for (const v of verts) {
            out[k++] = v[0]; out[k++] = v[1]; out[k++] = v[2];
            out[k++] = norm[0]; out[k++] = norm[1]; out[k++] = norm[2];
        }
    }
    return out;
}

export class Scene3D {
    constructor(gl, shaders, n, sizeM) {
        this.gl = gl;
        this.n = n;
        this.sizeM = sizeM;

        this.terrainProg = compileProgram(gl, shaders.terrainVert,
                                          shaders.terrainFrag, "terrain3d");
        this.skyProg = compileProgram(gl, shaders.skyVert,
                                      shaders.skyFrag, "sky3d");
        this.waterProg = compileProgram(gl, shaders.waterVert,
                                        shaders.waterFrag, "water3d");
        this.buildingProg = compileProgram(gl, shaders.buildingVert,
                                           shaders.buildingFrag, "building3d");

        // Terrain mesh: one vertex per heightfield texel.
        const { positions, indices } = makeGridMesh(n - 1, sizeM);
        this.indexCount = indices.length;
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);
        this.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        this.ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        gl.bindVertexArray(null);

        this.quad = createQuad(gl);   // sky's fullscreen pair

        // Town: one unit cube + a per-instance buffer (11 floats each:
        // center xyz, scale xyz, rot cos/sin, color rgb) — the whole town
        // in a single instanced draw, exactly the desktop TownRenderer.
        this.cubeVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeVbo);
        gl.bufferData(gl.ARRAY_BUFFER, unitCube(), gl.STATIC_DRAW);
        this.instVbo = gl.createBuffer();
        this.townVao = gl.createVertexArray();
        gl.bindVertexArray(this.townVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeVbo);
        gl.enableVertexAttribArray(0);                          // in_pos
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(1);                          // in_norm
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instVbo);
        const STRIDE = 44;   // 11 floats
        for (const [loc, size, off] of [[2, 3, 0],   // i_center
                                        [3, 3, 12],  // i_scale
                                        [4, 2, 24],  // i_rot
                                        [5, 3, 32]]) // i_color
        {
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, off);
            gl.vertexAttribDivisor(loc, 1);
        }
        gl.bindVertexArray(null);
        this.townCount = 0;
        this._townData = null;   // CPU copy: color updates rewrite cols 8-10

        // No man-made structures in the web port yet: a 1x1 zero mask.
        // (The desktop falls back to binding the height texture when no
        // mask exists, but heights > 0.5 m would read as "concrete" — an
        // explicit zero texture is the correct quiet default.)
        this.zeroTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.zeroTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT,
                      new Float32Array([0]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);

        // One-time terrain uniforms (program state persists across frames).
        gl.useProgram(this.terrainProg);
        const tu = (name) => gl.getUniformLocation(this.terrainProg, name);
        this._t = {
            view: tu("u_view"), proj: tu("u_proj"), sun: tu("u_sun_dir"),
            overlay: tu("u_overlay"), ovChannel: tu("u_ov_channel"),
            ovEverywhere: tu("u_ov_everywhere"), ovRange: tu("u_ov_range"),
            ovNstops: tu("u_ov_nstops"), ovStopT: tu("u_ov_stop_t"),
            ovStopC: tu("u_ov_stop_c"),
        };
        gl.uniform1i(tu("u_height"), 0);
        gl.uniform1i(tu("u_max"), 2);
        gl.uniform1i(tu("u_max2"), 3);
        gl.uniform1i(tu("u_structure"), 4);
        gl.uniform2f(tu("u_origin"), -sizeM / 2, -sizeM / 2);
        gl.uniform1f(tu("u_size"), sizeM);
        gl.uniform1f(tu("u_texn"), n);
        gl.uniform1i(tu("u_overlay"), 0);
        // Valid ramp defaults so nothing is ever uninitialized.
        gl.uniform1i(tu("u_ov_channel"), 0);
        gl.uniform1i(tu("u_ov_everywhere"), 0);
        gl.uniform2f(tu("u_ov_range"), 0.0, 1.0);
        gl.uniform1i(tu("u_ov_nstops"), 2);
        gl.uniform1fv(tu("u_ov_stop_t"), [0, 1, 1, 1, 1, 1]);
        gl.uniform3fv(tu("u_ov_stop_c"), new Float32Array(18));

        gl.useProgram(this.skyProg);
        const su = (name) => gl.getUniformLocation(this.skyProg, name);
        this._s = { invVp: su("u_inv_vp"), camPos: su("u_camera_pos"),
                    sun: su("u_sun_dir") };

        // One-time water uniforms. The water mesh IS the terrain mesh (same
        // grid, same VAO — a WebGL2 VAO is program-independent); only the
        // vertex shader's lift differs. Display-only exaggeration knobs;
        // tilt x700 (the terrain itself stays 1:1 — honest-display rule).
        //
        // UNIFORM 10x anomaly exaggeration (2026-07-18, user decision): a
        // single vertical scale everywhere so the 3D height a viewer reads
        // is comparable across the whole scene. The old depth-dependent
        // 8x-shallow / 60x-deep taught the WRONG lesson — it rendered
        // open-ocean waves ~7.5x taller than the same anomaly at the coast,
        // which reads as "waves are bigger in deep water" (the exact
        // inverse of shoaling: real waves GROW toward shore, Green's law).
        // With one factor, any growth you SEE as the wave nears the coast
        // is real. At 10x the deep-ocean pulse stays a barely-visible blip
        // (deep anomalies ~0.1-1 m) and the wave "pops up" as it hits the
        // slope — which is the real behavior; full-length propagation is
        // for the 2D map. Both knobs equal, so the vertex shader's depth
        // blend collapses to a constant.
        gl.useProgram(this.waterProg);
        const wu = (name) => gl.getUniformLocation(this.waterProg, name);
        this._w = {
            view: wu("u_view"), proj: wu("u_proj"), sun: wu("u_sun_dir"),
            camPos: wu("u_camera_pos"), time: wu("u_time"),
            exaggS: wu("u_exagg_shallow"), exaggD: wu("u_exagg_deep"),
        };
        gl.uniform1i(wu("u_height"), 0);
        gl.uniform1i(wu("u_water"), 1);
        gl.uniform1i(wu("u_structure"), 2);
        gl.uniform2f(wu("u_origin"), -sizeM / 2, -sizeM / 2);
        gl.uniform1f(wu("u_size"), sizeM);
        gl.uniform1f(wu("u_texn"), n);
        gl.uniform1f(wu("u_slope_boost"), 700.0);
        // Wave-height exaggeration, set PER FRAME (below) so a view can
        // change it: 10x for the map-scale orbit (deep anomalies are ~0.1-1
        // m and would be invisible at 1x), 1x for the beach view where the
        // camera is at eye height and a real 6-12 m wave should tower.
        this.waveExagg = 10.0;

        gl.useProgram(this.buildingProg);
        const bu = (name) => gl.getUniformLocation(this.buildingProg, name);
        this._b = { view: bu("u_view"), proj: bu("u_proj"),
                    sun: bu("u_sun_dir") };
        gl.useProgram(null);
    }

    /** (Re)build the instance buffer from the frozen town. Buildings never
     *  move in the web port (no sculpting), so this runs once per scene. */
    setTown(town) {
        const gl = this.gl;
        if (!town || town.buildings.length === 0) {
            this.townCount = 0;
            this._townData = null;
            return;
        }
        const count = town.buildings.length;
        const data = new Float32Array(count * 11);
        for (let k = 0; k < count; k++) {
            const b = town.buildings[k];
            const o = k * 11;
            data[o + 0] = b.x;
            data[o + 1] = b.y;
            data[o + 2] = b.gz - SINK_M;
            data[o + 3] = b.type.footprint_m;
            data[o + 4] = b.type.footprint_m;
            data[o + 5] = b.h + SINK_M;
            data[o + 6] = Math.cos(b.rot);
            data[o + 7] = Math.sin(b.rot);
            data[o + 8] = b.type.color[0];
            data[o + 9] = b.type.color[1];
            data[o + 10] = b.type.color[2];
        }
        this._townData = data;
        this.townCount = count;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instVbo);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    /** Overwrite per-building colors (the damage seam): colors is a
     *  Float32Array(count*3). The caller computes the tint
     *  (damageColorRgb) — this module stays pure display. Base albedo is
     *  restored by setTown(), which every scenario load/reset runs. */
    setTownColors(colors) {
        const gl = this.gl;
        if (!this._townData || colors.length !== this.townCount * 3) return;
        for (let k = 0; k < this.townCount; k++) {
            const o = k * 11;
            this._townData[o + 8] = colors[k * 3];
            this._townData[o + 9] = colors[k * 3 + 1];
            this._townData[o + 10] = colors[k * 3 + 2];
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instVbo);
        gl.bufferData(gl.ARRAY_BUFFER, this._townData, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    /** Draw the scene into the default framebuffer. `overlay` is null (off)
     *  or {field, range} — the SAME field spec + range the 2D map uses, so
     *  both views paint one hazard field identically. */
    render(solver, camera, width, height, sunDir = SUN_DIR, overlay = null) {
        const gl = this.gl;
        const view = camera.viewMatrix();
        const proj = camera.projectionMatrix(width / height);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // Terrain. The overlay (when on) paints the selected accumulated
        // field as a heatmap ON the terrain, sampling the solver's live
        // accumulator textures (units 2/3). Off: bind the bed there so the
        // samplers stay valid (the branch is skipped anyway).
        const ht = overlay ? solver.hazardTextures : null;
        gl.useProgram(this.terrainProg);
        gl.uniformMatrix4fv(this._t.view, false, view);
        gl.uniformMatrix4fv(this._t.proj, false, proj);
        gl.uniform3f(this._t.sun, sunDir[0], sunDir[1], sunDir[2]);
        if (overlay && ht) {
            const f = overlay.field;
            const { nstops, t, c } = rampUniforms(f);
            gl.uniform1i(this._t.overlay, 1);
            gl.uniform1i(this._t.ovChannel, f.channel);
            gl.uniform1i(this._t.ovEverywhere, f.everywhere ? 1 : 0);
            gl.uniform2f(this._t.ovRange, overlay.range[0], overlay.range[1]);
            gl.uniform1i(this._t.ovNstops, nstops);
            gl.uniform1fv(this._t.ovStopT, t);
            gl.uniform3fv(this._t.ovStopC, c);
        } else {
            gl.uniform1i(this._t.overlay, 0);
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, solver.bedTexture);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, ht ? ht.acc0 : solver.bedTexture);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, ht ? ht.acc1 : solver.bedTexture);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, this.zeroTex);
        gl.bindVertexArray(this.vao);
        gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);

        // Town: the whole settlement in ONE instanced draw (opaque, so
        // before sky and before the translucent water — a flooded
        // building shows through the sea surface above it).
        if (this.townCount > 0) {
            gl.useProgram(this.buildingProg);
            gl.uniformMatrix4fv(this._b.view, false, view);
            gl.uniformMatrix4fv(this._b.proj, false, proj);
            gl.uniform3f(this._b.sun, sunDir[0], sunDir[1], sunDir[2]);
            gl.bindVertexArray(this.townVao);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.townCount);
            gl.bindVertexArray(null);
        }

        // Sky: far-plane pass, LEQUAL so it fills exactly the pixels
        // nothing else claimed (its z = 0.9999999 vs clear depth 1.0).
        gl.useProgram(this.skyProg);
        gl.uniformMatrix4fv(this._s.invVp, false, invert(multiply(proj, view)));
        const cp = camera.position;
        gl.uniform3f(this._s.camPos, cp[0], cp[1], cp[2]);
        gl.uniform3f(this._s.sun, sunDir[0], sunDir[1], sunDir[2]);
        gl.depthFunc(gl.LEQUAL);
        gl.bindVertexArray(this.quad.vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
        gl.depthFunc(gl.LESS);

        // Water LAST (desktop order: terrain → sky → water): a translucent
        // surface alpha-blends over whatever is behind it — terrain below
        // sea level, or sky where a tall exaggerated crest crosses the
        // horizon line. Same grid VAO; the state texture (R=h, G=hu, B=hv)
        // is the live solver state, zero copies. Wall clock drives the
        // ripples/foam animation (the desktop app's clock runs
        // continuously too); wrapped at 3600 s for float32 precision, with
        // the shader's fade at the wrap.
        gl.useProgram(this.waterProg);
        gl.uniformMatrix4fv(this._w.view, false, view);
        gl.uniformMatrix4fv(this._w.proj, false, proj);
        gl.uniform3f(this._w.sun, sunDir[0], sunDir[1], sunDir[2]);
        gl.uniform3f(this._w.camPos, cp[0], cp[1], cp[2]);
        gl.uniform1f(this._w.time, (performance.now() / 1000) % 3600);
        gl.uniform1f(this._w.exaggS, this.waveExagg);
        gl.uniform1f(this._w.exaggD, this.waveExagg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, solver.bedTexture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, solver.stateTexture);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.zeroTex);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindVertexArray(this.vao);
        gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);

        gl.disable(gl.DEPTH_TEST);   // leave GL how the 2D path expects it
        gl.useProgram(null);
    }

    release() {
        const gl = this.gl;
        gl.deleteBuffer(this.vbo);
        gl.deleteBuffer(this.ibo);
        gl.deleteVertexArray(this.vao);
        gl.deleteTexture(this.zeroTex);
        gl.deleteBuffer(this.cubeVbo);
        gl.deleteBuffer(this.instVbo);
        gl.deleteVertexArray(this.townVao);
        gl.deleteProgram(this.terrainProg);
        gl.deleteProgram(this.skyProg);
        gl.deleteProgram(this.waterProg);
        gl.deleteProgram(this.buildingProg);
        gl.deleteBuffer(this.quad.vbo);
        gl.deleteVertexArray(this.quad.vao);
    }
}
