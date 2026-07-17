// App shell: boot the GL context, load a scenario, run the frame loop.
// Frame structure mirrors the desktop on_render (DATAFLOW.md §1), minus
// everything that is a later phase (town, HUD panels, gauges, defenses).

import { createContext, loadShaderSources, compileProgram, createQuad } from "./gl.js";
import { Simulation } from "./sim.js";
import { SCENARIOS, loadScenario, createSolverAtRest, fireScenarioSource } from "./scenario.js";
import { loadTown } from "./town.js";
import { TownOverlay, computeInsetWindow, uvWindow } from "./overlay.js";

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
        uv0: gl.getUniformLocation(displayProg, "u_uv0"),
        uv1: gl.getUniformLocation(displayProg, "u_uv1"),
    };
    gl.useProgram(displayProg);
    gl.uniform1i(dUni.bed, 0);
    gl.uniform1i(dUni.state, 1);
    const quad = createQuad(gl);

    // The town (phase 2): frozen data shared by all three scenarios. A
    // missing/corrupt file must not brick the physics sim — warn LOUDLY in
    // the UI instead, and the damage milestones simply have no subject.
    let town = null;
    try {
        town = await loadTown();
        $("town").textContent = `Town: ${town.summary()}`;
    } catch (e) {
        console.error(e);
        $("town").textContent = `⚠ town data unavailable — ${e.message}`;
        $("town").classList.add("warn");
    }
    const overlay = new TownOverlay($("overlay"));
    function syncOverlaySize() {
        // clientWidth is 0 in a hidden/not-yet-laid-out tab — fall back to
        // the GL canvas's attribute size (geometry stays correct; the
        // half-second cadence in frame() re-syncs once layout is real).
        const w = canvas.clientWidth || canvas.width;
        const h = canvas.clientHeight || canvas.height;
        overlay.resize(w, h, window.devicePixelRatio || 1);
    }
    syncOverlaySize();

    let solver = null;
    let sim = null;
    let scenarioData = null;
    let insetUV = null;        // the inset's GL texture window
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
        // Town views ride the scenario grid (all three share one bed, but
        // derive per-scenario anyway — cheap, and never silently stale).
        if (town) {
            const g = scenarioData.params.grid;
            const grid = { n: g.n, dx: g.dx_m,
                           xmin: -g.domain_m / 2, ymin: -g.domain_m / 2 };
            overlay.setGrid(grid);
            const win = computeInsetWindow(scenarioData.bed, grid, town);
            overlay.setWindow(win);
            insetUV = uvWindow(win, grid);
        }
        // Debug/console handle (also used by automated checks).
        window.__app = { solver, sim, scenarioData, town, overlay, draw,
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
    window.addEventListener("resize", () => {
        sizeScaleBar();
        syncOverlaySize();
    });

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
        gl.uniform2f(dUni.uv0, 0.0, 0.0);   // whole domain
        gl.uniform2f(dUni.uv1, 1.0, 1.0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, solver.bedTexture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, solver.stateTexture);
        gl.bindVertexArray(quad.vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        // Town inset: the SAME display pass through a zoomed UV window,
        // scissored into the top-left corner (deep ocean — never covers
        // the coast). Live water in the close-up for free; no readbacks.
        if (town && insetUV && overlay.cssW > 0) {
            const r = overlay.insetRect();
            const bx = Math.round(r.x / overlay.cssW * canvas.width);
            const bw = Math.round(r.w / overlay.cssW * canvas.width);
            const bh = Math.round(r.h / overlay.cssH * canvas.height);
            const by = Math.round(
                (1 - (r.y + r.h) / overlay.cssH) * canvas.height);
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(bx, by, bw, bh);
            gl.viewport(bx, by, bw, bh);
            gl.uniform2f(dUni.uv0, insetUV.uv0[0], insetUV.uv0[1]);
            gl.uniform2f(dUni.uv1, insetUV.uv1[0], insetUV.uv1[1]);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gl.disable(gl.SCISSOR_TEST);
        }
        gl.bindVertexArray(null);
        overlay.render(town);
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
                // Heal the overlay if boot happened before real layout.
                if (canvas.clientWidth &&
                    canvas.clientWidth !== overlay.cssW) syncOverlaySize();
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
