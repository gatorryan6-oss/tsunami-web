// WebGL2 port of the desktop GPUNonlinearSWESolver (solver_gpu_hll.py) —
// method-for-method, so anyone can read the two side by side.
//
// Same ping-pong pattern: the whole substep fits in ONE fragment pass (two
// draws, one per RK stage); THREE state textures rotate because SSP-RK2
// needs U^n, the stage-1 result, and the output alive at once.
//
// The CFL time step depends on the STATE (|u| + sqrt(gh)), which lives on
// the GPU. Reading it back every substep would stall the pipeline, so
// stableDt() serves a cached value refreshed by an exact readback every
// REFRESH_EVERY calls (and after disturbances), with a safety margin
// covering growth in between.
//
// State texel: R = water depth h (m), G = hu, B = hv (m^2/s).

import { compileProgram, createQuad } from "./gl.js";

export class GPUNonlinearSWESolver {
    // Must match the desktop solver exactly — parity depends on it.
    // (0.35: the wet/dry positivity bound is CFL 3/8.)
    static CFL_SAFETY = 0.35;
    static H_DRY = 1e-3;
    static SPLAT_MIN_DEPTH = 0.02;

    static REFRESH_EVERY = 30;  // stableDt readback cadence (calls ~= frames)
    static DT_MARGIN = 0.9;     // extra headroom between readbacks

    /**
     * @param gl        WebGL2 context (EXT_color_buffer_float verified)
     * @param shaders   {vert, step, splat, acc} GLSL ES sources
     * @param bed       Float32Array(n*n), row-major, j=0 = SOUTH row
     * @param n         grid points per side
     * @param dx        grid spacing (m)
     */
    constructor(gl, shaders, bed, n, dx,
                { gravity = 9.81, manningN = 0.025,
                  openEdges = ["west", "east", "south", "north"],
                  floatLinear = false } = {}) {
        this.gl = gl;
        this.n = n;
        this.dx = dx;
        this.g = gravity;
        this.manningN = manningN;
        this.openEdges = new Set(openEdges);
        this.b = new Float32Array(bed);           // CPU master copy
        this._floatLinear = floatLinear;

        // Bed texture (the solver's own copy).
        this.bedTexture = this._makeTexture1(this.b, gl.NEAREST);

        // Rotating state set (R=h, G=hu, B=hv), initialized at rest.
        const init = new Float32Array(n * n * 4);
        for (let i = 0; i < n * n; i++) {
            init[i * 4] = Math.max(-this.b[i], 0.0);
        }
        // LINEAR on the state textures serves the DISPLAY path only
        // (texelFetch in the physics shaders is filter-independent);
        // without OES_texture_float_linear it must be NEAREST.
        const stateFilter = floatLinear ? gl.LINEAR : gl.NEAREST;
        this._state = [];
        this._fbos = [];
        for (let k = 0; k < 3; k++) {
            const tex = this._makeTexture4(init, stateFilter);
            this._state.push(tex);
            this._fbos.push(this._makeFbo([tex]));
        }
        this._cur = 0;

        this._quad = createQuad(gl);

        const build = (fragSrc, name) => {
            const prog = compileProgram(gl, shaders.vert, fragSrc, name);
            return { prog, uni: {} };
        };
        this._step = build(shaders.step, "swe_hll_step");
        this._splat = build(shaders.splat, "swe_hll_splat");
        this._acc = build(shaders.acc, "swe_max_acc");

        const uni = (p, name) => gl.getUniformLocation(p.prog, name);
        for (const name of ["u_dt", "u_dx", "u_g", "u_n", "u_open", "u_stage",
                            "u_wm", "u_wm_eta", "u_state", "u_bed", "u_prev",
                            "u_manning"]) {
            this._step.uni[name] = uni(this._step, name);
        }
        for (const name of ["u_state", "u_center", "u_radius", "u_amp"]) {
            this._splat.uni[name] = uni(this._splat, name);
        }
        for (const name of ["u_acc", "u_state", "u_bed", "u_acc2", "u_now"]) {
            this._acc.uni[name] = uni(this._acc, name);
        }

        // Static uniforms (sampler units + constants), set once like the
        // desktop constructor does.
        gl.useProgram(this._acc.prog);
        gl.uniform1i(this._acc.uni.u_acc, 0);
        gl.uniform1i(this._acc.uni.u_state, 1);
        gl.uniform1i(this._acc.uni.u_bed, 2);
        gl.uniform1i(this._acc.uni.u_acc2, 3);

        this._accTex = [];    // acc0: depth/surf/speed/arrival (lazy)
        this._accTex2 = [];   // acc1: momentum flux (+ spare channels)
        this._accFbos = [];   // each binds acc0[k] + acc1[k] (MRT)
        this._accCur = 0;
        this.trackMax = false;

        // Roughness is a per-cell map; uniform at construction (vegetation
        // editing is a later phase). NEAREST like the bed: a physics field.
        this.manningMap = new Float32Array(n * n).fill(manningN);
        this.manningTexture = this._makeTexture1(this.manningMap, gl.NEAREST);

        gl.useProgram(this._step.prog);
        gl.uniform1f(this._step.uni.u_dx, this.dx);
        gl.uniform1f(this._step.uni.u_g, this.g);
        gl.uniform1i(this._step.uni.u_manning, 3);
        gl.uniform1i(this._step.uni.u_n, n);
        gl.uniform4i(this._step.uni.u_open,
            this.openEdges.has("west") ? 1 : 0,
            this.openEdges.has("east") ? 1 : 0,
            this.openEdges.has("south") ? 1 : 0,
            this.openEdges.has("north") ? 1 : 0);
        gl.uniform1i(this._step.uni.u_state, 0);
        gl.uniform1i(this._step.uni.u_bed, 1);
        gl.uniform1i(this._step.uni.u_prev, 2);
        gl.useProgram(this._splat.prog);
        gl.uniform1i(this._splat.uni.u_state, 0);

        const half = (n - 1) * this.dx / 2.0;
        this._xmin = -half;

        this._dtCache = null;
        this._dtCalls = 0;

        // The solver's own clock (s), advanced per substep — timestamps the
        // first-arrival field exactly, not at frame granularity.
        this.timeS = 0.0;

        // Wavemaker: an incident wave train prescribed at the west edge
        // (null = the edge is a plain absorber, exactly as before).
        this.wavemaker = null;

        this._readBuf = new Float32Array(n * n * 4);   // reusable readback
    }

    // ------------------------------------------------------------------
    // The WaveSolver contract
    // ------------------------------------------------------------------

    /** Cached CFL dt (see class docstring for the refresh scheme). */
    stableDt() {
        if (this._dtCache === null
                || this._dtCalls >= GPUNonlinearSWESolver.REFRESH_EVERY) {
            this._dtCache = this._exactStableDt()
                * GPUNonlinearSWESolver.DT_MARGIN;
            this._dtCalls = 0;
        }
        this._dtCalls += 1;
        return this._dtCache;
    }

    /** Install (spec) or clear (null) the incident-wave boundary condition
     *  on the west edge. */
    setWavemaker(spec) {
        if (spec !== null && !this.openEdges.has("west")) {
            throw new Error("the wavemaker needs an open west edge " +
                            "(it drives the boundary, not a wall)");
        }
        this.wavemaker = spec;
        // State is untouched at install time, but the growing train will
        // raise speeds between the dt refreshes — re-measure now.
        this._dtCache = null;
    }

    /** (active flag, incident eta) for the RK stage at solver time t. */
    _wmStage(t) {
        const w = this.wavemaker;
        if (w === null || !w.active(t)) return [0, 0.0];
        return [1, w.eta(t)];
    }

    /** One substep = two RK stages = two draws (SSP-RK2). */
    step(dt) {
        const gl = this.gl;
        gl.disable(gl.BLEND);
        gl.viewport(0, 0, this.n, this.n);
        gl.useProgram(this._step.prog);
        gl.uniform1f(this._step.uni.u_dt, dt);
        const cur = this._cur;
        const stage1 = (cur + 1) % 3;
        const final = (cur + 2) % 3;
        // Wavemaker forcing per RK stage (stage 0 at t, stage 1 at t + dt),
        // matching the desktop solver's second-order-in-time boundary.
        const [wm0, eta0] = this._wmStage(this.timeS);
        const [wm1, eta1] = this._wmStage(this.timeS + dt);

        gl.uniform1i(this._step.uni.u_stage, 0);
        gl.uniform1i(this._step.uni.u_wm, wm0);
        gl.uniform1f(this._step.uni.u_wm_eta, eta0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbos[stage1]);
        this._bindTex(0, this._state[cur]);
        this._bindTex(1, this.bedTexture);
        // u_prev is unused in stage 0, but the sampler is statically active,
        // and unit 2 may still hold LAST step's binding — which can be this
        // draw's render target (a GL feedback loop, undefined behavior by
        // spec). Point it at the read source, which is never the target.
        this._bindTex(2, this._state[cur]);
        this._bindTex(3, this.manningTexture);
        this._drawQuad();

        gl.uniform1i(this._step.uni.u_stage, 1);
        gl.uniform1i(this._step.uni.u_wm, wm1);
        gl.uniform1f(this._step.uni.u_wm_eta, eta1);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbos[final]);
        this._bindTex(0, this._state[stage1]);
        this._bindTex(1, this.bedTexture);
        this._bindTex(2, this._state[cur]);   // U^n for the RK average
        this._bindTex(3, this.manningTexture);
        this._drawQuad();

        this._cur = final;
        this.timeS += dt;

        // Per-SUBSTEP hazard-field accumulation (the instrumentation seam).
        if (this.trackMax) this._accumulate();
    }

    /** One accumulation from the CURRENT state — call after instantaneous
     *  events (quake, splat) so peaks are correct while paused. */
    snapshotMax() {
        if (this.trackMax) {
            this.gl.disable(this.gl.BLEND);
            this._accumulate();
        }
    }

    /** One hazard-accumulation ping-pong pass (maxima + arrival). The MRT
     *  framebuffer writes both accumulator textures in a single draw. */
    _accumulate() {
        const gl = this.gl;
        gl.viewport(0, 0, this.n, this.n);
        gl.useProgram(this._acc.prog);
        gl.uniform1f(this._acc.uni.u_now, this.timeS);
        const dst = 1 - this._accCur;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._accFbos[dst]);
        this._bindTex(0, this._accTex[this._accCur]);
        this._bindTex(1, this._state[this._cur]);
        this._bindTex(2, this.bedTexture);
        this._bindTex(3, this._accTex2[this._accCur]);
        this._drawQuad();
        this._accCur = dst;
    }

    /** Gaussian depth bump (the click "pebble"; scenario (a)'s source). */
    addGaussian(x, y, amplitude, radius) {
        const gl = this.gl;
        gl.disable(gl.BLEND);
        gl.viewport(0, 0, this.n, this.n);
        const cx = (x - this._xmin) / this.dx + 0.5;
        const cy = (y - this._xmin) / this.dx + 0.5;
        gl.useProgram(this._splat.prog);
        gl.uniform2f(this._splat.uni.u_center, cx, cy);
        gl.uniform1f(this._splat.uni.u_radius, radius / this.dx);
        gl.uniform1f(this._splat.uni.u_amp, amplitude);
        const dst = (this._cur + 1) % 3;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbos[dst]);
        this._bindTex(0, this._state[this._cur]);
        this._drawQuad();
        this._cur = dst;
        this._dtCache = null;  // amplitude changed; re-measure the CFL limit
    }

    /** EARTHQUAKE bed change: ground and water column move TOGETHER.
     *  The bed shifts by dz while every water column keeps its depth h —
     *  the state textures are untouched, so over the ocean the surface
     *  b + h instantly copies the seafloor displacement (the standard
     *  tsunami initial condition). No readback needed: only the bed moves. */
    applyCoseismic(dz) {
        for (let i = 0; i < this.b.length; i++) {
            this.b[i] = Math.fround(this.b[i] + dz[i]);
        }
        this._uploadTexture1(this.bedTexture, this.b);
        // Belt-and-suspenders like the desktop: stableDt depends only on
        // the (untouched) state today.
        this._dtCache = null;
    }

    // ------------------------------------------------------------------
    // Max-depth / hazard tracking (inundation extent, peak readouts)
    // ------------------------------------------------------------------

    /** Start accumulating the per-cell hazard fields once per substep. */
    enableMaxTracking() {
        const gl = this.gl;
        if (this._accTex.length === 0) {
            const n = this.n;
            const blank = new Float32Array(n * n * 4);
            for (let i = 0; i < n * n; i++) {
                blank[i * 4 + 1] = -1e9;  // max surface starts "never wet"
                blank[i * 4 + 3] = -1.0;  // arrival time starts "not yet"
            }
            const zero = new Float32Array(n * n * 4);
            for (let k = 0; k < 2; k++) {
                // NEAREST: these are INSTRUMENTS. Linear filtering would
                // bleed sea maxima one texel onto land and paint a false
                // flooded fringe along every coast.
                const tex = this._makeTexture4(blank, gl.NEAREST);
                const tex2 = this._makeTexture4(zero, gl.NEAREST);
                this._accTex.push(tex);
                this._accTex2.push(tex2);
                this._accFbos.push(this._makeFbo([tex, tex2]));
            }
        }
        this.trackMax = true;
    }

    resetMaxTracking() {
        const n = this.n;
        const blank = new Float32Array(n * n * 4);
        for (let i = 0; i < n * n; i++) {
            blank[i * 4 + 1] = -1e9;
            blank[i * 4 + 3] = -1.0;
        }
        const zero = new Float32Array(n * n * 4);
        for (const tex of this._accTex) this._uploadTexture4(tex, blank);
        for (const tex of this._accTex2) this._uploadTexture4(tex, zero);
    }

    /** The acc0 hazard fields as Float32Arrays:
     *  {depth, surface, speed, arrival} (arrival -1 = not yet). */
    readHazards() {
        const raw = this._readFbo(this._accFbos[this._accCur], 0);
        const n2 = this.n * this.n;
        const depth = new Float32Array(n2), surface = new Float32Array(n2);
        const speed = new Float32Array(n2), arrival = new Float32Array(n2);
        for (let i = 0; i < n2; i++) {
            depth[i] = raw[i * 4];
            surface[i] = raw[i * 4 + 1];
            speed[i] = raw[i * 4 + 2];
            arrival[i] = raw[i * 4 + 3];
        }
        return { depth, surface, speed, arrival };
    }

    /** Max momentum-flux field h*|u|^2 (m^3/s^2) as a Float32Array. */
    readMomentum() {
        const raw = this._readFbo(this._accFbos[this._accCur], 1);
        const n2 = this.n * this.n;
        const momentum = new Float32Array(n2);
        for (let i = 0; i < n2; i++) momentum[i] = raw[i * 4];
        return momentum;
    }

    // ------------------------------------------------------------------
    // State access
    // ------------------------------------------------------------------

    /** Live state texture (R = water depth h) — the display samples this
     *  directly, zero copies. */
    get stateTexture() {
        return this._state[this._cur];
    }

    /** Upload a full state (h, and optionally hu, hv) to the CURRENT
     *  texture. Invalidates the dt cache like the desktop. */
    loadState(h, hu = null, hv = null) {
        const n2 = this.n * this.n;
        const packed = new Float32Array(n2 * 4);
        for (let i = 0; i < n2; i++) {
            packed[i * 4] = h[i];
            if (hu) packed[i * 4 + 1] = hu[i];
            if (hv) packed[i * 4 + 2] = hv[i];
        }
        this._uploadTexture4(this._state[this._cur], packed);
        this._dtCache = null;
    }

    /** Full state readback as one packed RGBA Float32Array
     *  (i*4 = h, +1 = hu, +2 = hv). Stalls the pipeline — for tests and
     *  occasional instrument reads, not per-frame use. */
    readState() {
        return this._readFbo(this._fbos[this._cur], 0, this._readBuf);
    }

    /** Free all GL objects (the parity page builds one solver per
     *  scenario in a single context). */
    release() {
        const gl = this.gl;
        for (const f of this._fbos) gl.deleteFramebuffer(f);
        for (const f of this._accFbos) gl.deleteFramebuffer(f);
        for (const t of this._state) gl.deleteTexture(t);
        for (const t of this._accTex) gl.deleteTexture(t);
        for (const t of this._accTex2) gl.deleteTexture(t);
        gl.deleteTexture(this.bedTexture);
        gl.deleteTexture(this.manningTexture);
        gl.deleteProgram(this._step.prog);
        gl.deleteProgram(this._splat.prog);
        gl.deleteProgram(this._acc.prog);
        gl.deleteVertexArray(this._quad.vao);
        gl.deleteBuffer(this._quad.vbo);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    _velocityAbs(h, q) {
        // Desingularized |velocity| — must match vel() in the shaders.
        h = Math.max(h, 0.0);
        const h4 = (h * h) * (h * h);
        const eps4 = 1e-12;  // H_DRY^4
        return Math.abs(Math.SQRT2 * h * q / Math.sqrt(h4 + Math.max(h4, eps4)));
    }

    _exactStableDt() {
        const s = this.readState();
        let smax = 1.0;
        for (let i = 0; i < this.n * this.n; i++) {
            const h = s[i * 4];
            const c = Math.sqrt(this.g * Math.max(h, 0.0));
            const u = this._velocityAbs(h, s[i * 4 + 1]);
            const v = this._velocityAbs(h, s[i * 4 + 2]);
            const sp = Math.max(u, v) + c;
            if (sp > smax) smax = sp;
        }
        return GPUNonlinearSWESolver.CFL_SAFETY * this.dx / smax;
    }

    _drawQuad() {
        const gl = this.gl;
        gl.bindVertexArray(this._quad.vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    _bindTex(unit, tex) {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
    }

    _makeTexture4(data, filter) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.n, this.n, 0,
                      gl.RGBA, gl.FLOAT, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    _makeTexture1(data, filter) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.n, this.n, 0,
                      gl.RED, gl.FLOAT, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    _uploadTexture4(tex, data) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.n, this.n,
                         gl.RGBA, gl.FLOAT, data);
    }

    _uploadTexture1(tex, data) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.n, this.n,
                         gl.RED, gl.FLOAT, data);
    }

    _makeFbo(textures) {
        const gl = this.gl;
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        const buffers = [];
        textures.forEach((tex, k) => {
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k,
                                    gl.TEXTURE_2D, tex, 0);
            buffers.push(gl.COLOR_ATTACHMENT0 + k);
        });
        gl.drawBuffers(buffers);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error(
                `Float framebuffer incomplete (status 0x${status.toString(16)}) ` +
                "— this GPU cannot render to RGBA32F despite advertising " +
                "EXT_color_buffer_float.");
        }
        return fbo;
    }

    _readFbo(fbo, attachment, dst = null) {
        const gl = this.gl;
        const out = dst || new Float32Array(this.n * this.n * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
        gl.readPixels(0, 0, this.n, this.n, gl.RGBA, gl.FLOAT, out);
        if (attachment !== 0) gl.readBuffer(gl.COLOR_ATTACHMENT0);
        return out;
    }
}
