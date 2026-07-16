// App shell: boot the GL context, load a scenario, run the frame loop.
// Frame structure mirrors the desktop on_render (DATAFLOW.md §1), minus
// everything that is a later phase (town, HUD panels, gauges, defenses).

import { createContext, loadShaderSources, compileProgram, createQuad } from "./gl.js";
import { Simulation } from "./sim.js";
import { SCENARIOS, loadScenario, createSolverForScenario } from "./scenario.js";

const $ = (id) => document.getElementById(id);

function fatal(message) {
    const el = $("fatal");
    el.textContent = message;
    el.style.display = "flex";
    throw new Error(message);
}

async function main() {
    const canvas = $("view");
    let ctx;
    try {
        ctx = createContext(canvas);
    } catch (e) {
        fatal(e.message);
    }
    const { gl, floatLinear } = ctx;
    const shaders = await loadShaderSources();

    // Display pass (free-form; physics never renders to screen).
    const displayProg = compileProgram(gl, shaders.displayVert,
                                       shaders.displayFrag, "display");
    const dUni = {
        bed: gl.getUniformLocation(displayProg, "u_bed"),
        state: gl.getUniformLocation(displayProg, "u_state"),
        range: gl.getUniformLocation(displayProg, "u_range_m"),
    };
    gl.useProgram(displayProg);
    gl.uniform1i(dUni.bed, 0);
    gl.uniform1i(dUni.state, 1);
    const quad = createQuad(gl);

    let solver = null;
    let sim = null;
    let scenarioData = null;

    async function setScenario(id) {
        $("status").textContent = `loading ${id} ...`;
        if (solver) { solver.release(); solver = null; }
        scenarioData = await loadScenario(id);
        ({ solver } = createSolverForScenario(gl, shaders, scenarioData,
                                              { floatLinear }));
        sim = new Simulation(solver, parseFloat($("speed").value));
        sim.paused = true;
        $("run").textContent = "Run";
        // Debug/console handle (also used by automated checks).
        window.__app = { solver, sim, scenarioData, draw };
        $("status").textContent =
            `${id} ready — ${solver.n}x${solver.n} grid, ` +
            `dx ${solver.dx.toFixed(1)} m. Press Run.`;
    }

    function draw() {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(displayProg);
        gl.uniform1f(dUni.range, 2.0);   // +-2 m anomaly, like the ref PNGs
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, solver.bedTexture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, solver.stateTexture);
        gl.bindVertexArray(quad.vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    let lastT = performance.now();
    let fpsAcc = 0, fpsN = 0, fpsShown = 0;
    function frame(now) {
        const wallDt = Math.min((now - lastT) / 1000, 0.1); // desktop cap
        lastT = now;
        if (solver && sim) {
            const steps = sim.advance(wallDt);
            draw();
            fpsAcc += wallDt; fpsN += 1;
            if (fpsAcc >= 0.5) {
                fpsShown = Math.round(fpsN / fpsAcc);
                fpsAcc = 0; fpsN = 0;
            }
            if (!sim.paused) {
                $("status").textContent =
                    `t = ${solver.timeS.toFixed(1)} s | ` +
                    `${steps} substeps | dt ${(solver._dtCache ?? 0).toFixed(3)} s | ` +
                    `${fpsShown} fps | speed x${sim.timeScale}`;
            }
        }
        requestAnimationFrame(frame);
    }

    // Controls
    const sel = $("scenario");
    for (const s of SCENARIOS) {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = s.label;
        sel.appendChild(opt);
    }
    sel.value = SCENARIOS[0].id;
    sel.addEventListener("change", () => setScenario(sel.value).catch(e => fatal(e.message)));
    $("run").addEventListener("click", () => {
        if (!sim) return;
        sim.paused = !sim.paused;
        $("run").textContent = sim.paused ? "Run" : "Pause";
    });
    $("reset").addEventListener("click", () => setScenario(sel.value).catch(e => fatal(e.message)));
    $("speed").addEventListener("input", () => {
        if (sim) sim.timeScale = parseFloat($("speed").value);
        $("speedval").textContent = `x${$("speed").value}`;
    });

    await setScenario(sel.value);
    requestAnimationFrame(frame);
}

main().catch(e => {
    console.error(e);
    const el = document.getElementById("fatal");
    el.textContent = e.message;
    el.style.display = "flex";
});
