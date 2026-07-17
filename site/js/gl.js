// GL plumbing: context creation, required-extension checks (loud, never
// silent), shader fetching/compilation. Everything here is boring on
// purpose — the physics lives in the shaders and solver.js.

// Required: float render targets are the simulation substrate (RGBA32F
// ping-pong). Wanted (display only): linear filtering on float textures.
export function createContext(canvas) {
    const gl = canvas.getContext("webgl2", {
        antialias: false,
        preserveDrawingBuffer: false,
        // depth: the 3D view (M8) depth-tests terrain/water/sky on the
        // DEFAULT framebuffer, so the context needs a depth buffer.
        // Physics is unaffected: the solver renders into its own FBOs,
        // whose attachments this flag never touches; the 2D display pass
        // simply doesn't enable DEPTH_TEST.
        depth: true,
        stencil: false,
    });
    if (!gl) {
        throw new Error(
            "This browser does not support WebGL2. The simulator needs " +
            "WebGL2 (any recent Chrome, Edge, Firefox, or Safari — " +
            "including Chromebooks).");
    }
    const extFloat = gl.getExtension("EXT_color_buffer_float");
    if (!extFloat) {
        // CONSTRAINTS.md: fail loudly, never degrade to 8-bit "physics".
        throw new Error(
            "This GPU/browser is missing the EXT_color_buffer_float " +
            "extension (float render targets), which the simulation " +
            "requires. Running without it would produce wrong physics, " +
            "so the simulator refuses to start.");
    }
    const floatLinear = !!gl.getExtension("OES_texture_float_linear");
    if (!floatLinear) {
        console.info(
            "OES_texture_float_linear is unavailable: the water display " +
            "falls back to unfiltered (slightly blocky) sampling. " +
            "Physics is unaffected.");
    }
    return { gl, floatLinear };
}

export async function fetchText(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${resp.status}`);
    }
    return resp.text();
}

// All shader sources the app uses, fetched once at boot.
export async function loadShaderSources(base = "shaders/") {
    const names = {
        vert: "fullscreen.vert",
        step: "swe_hll_step.frag",
        splat: "swe_hll_splat.frag",
        acc: "swe_max_acc.frag",
        displayVert: "display.vert",
        displayFrag: "display.frag",
        // 3D view (M8) — display shaders, not physics.
        skyVert: "sky.vert",
        skyFrag: "sky.frag",
        terrainVert: "terrain.vert",
        terrainFrag: "terrain.frag",
    };
    const out = {};
    await Promise.all(Object.entries(names).map(async ([key, file]) => {
        out[key] = await fetchText(base + file);
    }));
    return out;
}

export function compileProgram(gl, vsSrc, fsSrc, name) {
    const compile = (type, src, label) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(sh);
            throw new Error(`${name}/${label} failed to compile:\n${log}`);
        }
        return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSrc, "vert");
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc, "frag");
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    // Every program's quad attribute lands on location 0 so one shared VAO
    // serves all passes.
    gl.bindAttribLocation(prog, 0, "in_position");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(`${name} failed to link:\n${gl.getProgramInfoLog(prog)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
}

// The one full-screen quad every pass draws (matches fullscreen.vert).
export function createQuad(gl) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, vbo };
}
