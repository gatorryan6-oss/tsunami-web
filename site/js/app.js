// App shell: boot the GL context, load a scenario, run the frame loop.
// Frame structure mirrors the desktop on_render (DATAFLOW.md §1), minus
// everything that is a later phase (town, HUD panels, gauges, defenses).

import { createContext, loadShaderSources, compileProgram, createQuad } from "./gl.js";
import { Simulation } from "./sim.js";
import { SCENARIOS, loadScenario, createSolverAtRest, fireScenarioSource } from "./scenario.js";

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
    // The event is ARMED at load and fired on the first Run press, so the
    // user sees the calm pre-event ocean first and the rupture/pulse/train
    // reads as an event, not as "the map starts red".
    let armed = false;
    let pendingFire = false;

    async function setScenario(id) {
        $("status").textContent = `loading ${id} ...`;
        pendingFire = false;           // cancels any not-yet-fired trigger
        if (solver) { solver.release(); solver = null; }
        scenarioData = await loadScenario(id);
        solver = createSolverAtRest(gl, shaders, scenarioData,
                                    { floatLinear });
        sim = new Simulation(solver, parseFloat($("speed").value));
        sim.paused = true;
        armed = true;
        $("run").textContent = "Run";
        // Debug/console handle (also used by automated checks).
        window.__app = { solver, sim, scenarioData, draw,
                         triggerEvent: () => triggerEvent(0) };
        $("status").textContent =
            `${id} ready — calm ocean, ${solver.n}x${solver.n} grid. ` +
            `Run triggers the event.`;
        $("desc").textContent = scenarioData.params.description;
        sizeScaleBar();
    }

    function eventNarration(src) {
        if (src.kind === "coseismic_dz") {
            const f = src.fault || {};
            return `Mw ${f.magnitude ?? "?"} rupture! The seafloor jumps — ` +
                   `and the sea surface above copies it instantly.`;
        }
        if (src.kind === "wavemaker") {
            return "A distant tsunami's wave train starts arriving at the " +
                   "west (offshore) edge…";
        }
        return "Displacing the sea surface offshore…";
    }

    // Fire the armed event after a short beat (the solver clock stays at
    // 0 — no stepping happens while we wait, so the source still lands at
    // t = 0 exactly like the reference recipe).
    function triggerEvent(delayMs = 900) {
        armed = false;
        pendingFire = true;
        const mySolver = solver;
        $("run").textContent = "…";
        $("status").textContent = eventNarration(scenarioData.params.source);
        setTimeout(() => {
            if (!pendingFire || solver !== mySolver) return;
            pendingFire = false;
            fireScenarioSource(solver, scenarioData);
            sim.paused = false;
            $("run").textContent = "Pause";
        }, delayMs);
    }

    // The scale bar: the canvas spans the whole domain, so pixels-per-
    // meter comes straight from its displayed width.
    const SCALE_KM = 20;
    function sizeScaleBar() {
        if (!scenarioData) return;
        const domainM = scenarioData.params.grid.domain_m;
        const px = canvas.clientWidth * (SCALE_KM * 1000 / domainM);
        document.querySelector("#scalebar .bar").style.width = `${px.toFixed(0)}px`;
        $("scalelabel").textContent = `${SCALE_KM} km`;
    }
    window.addEventListener("resize", sizeScaleBar);

    // Teachers think in minutes: "12 min 05 s", seconds-only below 1 min.
    function fmtSimTime(s) {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return m > 0 ? `${m} min ${String(sec).padStart(2, "0")} s` : `${sec} s`;
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
                    `simulated time ${fmtSimTime(solver.timeS)} | ` +
                    `speed x${sim.timeScale} | ${fpsShown} fps` +
                    (steps >= 24 ? " | running below requested speed" : "");
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
        if (!sim || pendingFire) return;   // ignore clicks during the beat
        if (armed) { triggerEvent(); return; }
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
