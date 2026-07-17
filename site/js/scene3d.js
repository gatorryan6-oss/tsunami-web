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

export class Scene3D {
    constructor(gl, shaders, n, sizeM) {
        this.gl = gl;
        this.n = n;
        this.sizeM = sizeM;

        this.terrainProg = compileProgram(gl, shaders.terrainVert,
                                          shaders.terrainFrag, "terrain3d");
        this.skyProg = compileProgram(gl, shaders.skyVert,
                                      shaders.skyFrag, "sky3d");

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
        gl.useProgram(null);
    }

    /** Draw the scene into the default framebuffer. */
    render(solver, camera, width, height, sunDir = SUN_DIR) {
        const gl = this.gl;
        const view = camera.viewMatrix();
        const proj = camera.projectionMatrix(width / height);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // Terrain. The solver's bed texture is the heightfield; it also
        // fills the overlay sampler slots (units 2/3 must stay valid even
        // with the overlay branch off).
        gl.useProgram(this.terrainProg);
        gl.uniformMatrix4fv(this._t.view, false, view);
        gl.uniformMatrix4fv(this._t.proj, false, proj);
        gl.uniform3f(this._t.sun, sunDir[0], sunDir[1], sunDir[2]);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, solver.bedTexture);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, solver.bedTexture);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, solver.bedTexture);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, this.zeroTex);
        gl.bindVertexArray(this.vao);
        gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);

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

        gl.disable(gl.DEPTH_TEST);   // leave GL how the 2D path expects it
        gl.useProgram(null);
    }

    release() {
        const gl = this.gl;
        gl.deleteBuffer(this.vbo);
        gl.deleteBuffer(this.ibo);
        gl.deleteVertexArray(this.vao);
        gl.deleteTexture(this.zeroTex);
        gl.deleteProgram(this.terrainProg);
        gl.deleteProgram(this.skyProg);
        gl.deleteBuffer(this.quad.vbo);
        gl.deleteVertexArray(this.quad.vao);
    }
}
