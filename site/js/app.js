// App shell: boot the GL context, load a scenario, run the frame loop.
// Frame structure mirrors the desktop on_render (DATAFLOW.md §1), minus
// everything that is a later phase (town, HUD panels, gauges, defenses).

import { createContext, loadShaderSources, compileProgram, createQuad } from "./gl.js";
import { Simulation } from "./sim.js";
import { SCENARIOS, loadScenario, createSolverAtRest, fireScenarioSource } from "./scenario.js";
import { loadTown } from "./town.js";
import { TownOverlay, computeInsetWindow, uvWindow } from "./overlay.js";
import { getHazardFields } from "./hazard.js";
import { assessTown, damageColorCss, damageColorRgb } from "./losses.js";
import { assessCasualties, nearestRefuges, defaultEvacuationParams } from "./casualties.js";
import { planEvacuation } from "./routing.js";
import { evacTimingFor, SCENARIO_EVENTS } from "./events.js";
import { SCENARIO_RATE, returnPeriodYr, annualize, EWS_COST_USD, fmtUsd } from "./economy.js";
import { BUDGET_TOTAL_USD, applyDefenses, wallCost, wallLength,
         describeWall, fmtM } from "./defenses.js";
import { OrbitCamera } from "./camera.js";
import { Scene3D } from "./scene3d.js";
import { HAZARD_FIELDS, FIELD_BY_KEY, rampCss, rampUniforms, legendLabels } from "./intensity.js";
import { arrivalRange } from "./hazard.js";

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
        overlay: gl.getUniformLocation(displayProg, "u_overlay"),
        ovChannel: gl.getUniformLocation(displayProg, "u_ov_channel"),
        ovEverywhere: gl.getUniformLocation(displayProg, "u_ov_everywhere"),
        ovRange: gl.getUniformLocation(displayProg, "u_ov_range"),
        ovNstops: gl.getUniformLocation(displayProg, "u_ov_nstops"),
        ovStopT: gl.getUniformLocation(displayProg, "u_ov_stop_t"),
        ovStopC: gl.getUniformLocation(displayProg, "u_ov_stop_c"),
    };
    gl.useProgram(displayProg);
    gl.uniform1i(dUni.bed, 0);
    gl.uniform1i(dUni.state, 1);
    gl.uniform1i(gl.getUniformLocation(displayProg, "u_ov_max"), 2);
    gl.uniform1i(gl.getUniformLocation(displayProg, "u_ov_max2"), 3);
    // Valid ramp defaults so the samplers/arrays are never uninitialized.
    gl.uniform1i(dUni.overlay, 0);
    gl.uniform1i(dUni.ovNstops, 2);
    gl.uniform1fv(dUni.ovStopT, [0, 1, 1, 1, 1, 1]);
    gl.uniform3fv(dUni.ovStopC, new Float32Array(18));
    const quad = createQuad(gl);

    // The town (phase 2): frozen data shared by all three scenarios. A
    // missing/corrupt file must not brick the physics sim — warn LOUDLY in
    // the UI instead, and the damage milestones simply have no subject.
    let town = null;
    try {
        town = await loadTown();
        $("popNum").textContent = town.population.toLocaleString("en-US");
        $("popSub").textContent =
            `${town.buildings.length} buildings · ` +
            `$${(town.totalValue / 1e9).toFixed(2)}B value`;
    } catch (e) {
        console.error(e);
        $("popNum").textContent = "—";
        $("popSub").textContent = `⚠ town data unavailable — ${e.message}`;
        $("cardPop").classList.add("warn");
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
    let townGrid = null;       // {n, dx, xmin, ymin} for the current scenario
    let damageReport = null;   // latest assess_town result (null until fired)
    let casualtyReport = null; // latest assess_casualties result
    let refuges = null;        // cached per terrain epoch (post-fire bed)
    let assessTick = 0;        // frame counter for the 30-frame cadence
    let daytime = true;        // day/night occupancy toggle
    let ewsOn = false;         // early-warning system on/off (M9.x)
    const evacParams = defaultEvacuationParams();

    // Economic risk bank (M11): each scenario's settled outcome, banked as
    // it is run — property loss + deaths in all day/night × warned/unwarned
    // combos, so the annualized risk table re-prices instantly on any
    // toggle without re-running. Keyed by scenario id; accumulates across
    // scenarios (the "portfolio you build by facing each event").
    // M15: each entry is stamped with the defenseEpoch it was priced
    // under — a wall change makes older rows STALE (shown dimmed until
    // that scenario is re-run), because the outcome was measured on a
    // world that no longer exists.
    const riskBank = {};

    // Buildable defenses (M15): the seawalls the town has committed to,
    // in BUILD ORDER (order matters — a wall crossing another's raised
    // ground was quoted cheaper). They are WORLD state, not scenario
    // state: all three scenarios share one bed, so a wall stands in all
    // of them. Any change rebuilds the world (desktop contract: apply()
    // is destructive, removal = rebuild from the pristine bed).
    let walls = [];            // [{x0,y0,x1,y1,crest}]
    let wallQuotes = [];       // honest re-quote per wall, from applyDefenses
    let budgetSpent = 0;       // sum of quotes
    let defenseEpoch = 0;      // bumped on every wall change
    let designBed = null;      // pristine bed + walls (PRE-event) — quoting base
    let wallDraw = null;       // draw mode: null | {x0,y0}|{} (awaiting clicks)

    // Hazard overlay (M9): null = off, else a HAZARD_FIELDS entry. Drives
    // BOTH the 2D map (display.frag branch) and the 3D terrain
    // (terrain.frag branch) from one control + one legend.
    let overlayField = null;
    let ovRange = [0, 1];      // effective (vmin, vmax); arrival auto-fits

    const ANOM_TITLE = "Sea-surface anomaly (m above/below normal)";
    function updateLegend() {
        const title = document.querySelector("#colorbar .title");
        const bar = document.querySelector("#colorbar .bar");
        const labels = document.querySelector("#colorbar .labels");
        if (!overlayField) {
            title.textContent = ANOM_TITLE;
            bar.style.background = "";     // restore the CSS anomaly gradient
            labels.innerHTML = "<span>−2 m</span><span>0</span><span>+2 m</span>";
            return;
        }
        title.textContent = `${overlayField.name} (${overlayField.unit})`;
        bar.style.background = rampCss(overlayField);
        const [lo, hi] = legendLabels(overlayField, ovRange[0], ovRange[1]);
        labels.innerHTML = `<span>${lo}</span><span>${hi}</span>`;
    }

    // Arrival auto-ranges to the field (near- vs far-field differ ~100x).
    // Refreshed through getHazardFields() — the accessor, one readback, at
    // the assessment cadence. The other fields have fixed ranges.
    function refreshOverlayRange() {
        if (!overlayField) return;
        if (overlayField.vrange) { ovRange = overlayField.vrange; return; }
        if (solver) {
            const r = arrivalRange(getHazardFields(solver));
            if (r) ovRange = r;
        }
    }

    // Push the field's static ramp + channel to the display program once
    // per selection (the range updates per-frame for arrival).
    function applyOverlayUniforms() {
        if (!overlayField) return;
        const { nstops, t, c } = rampUniforms(overlayField);
        gl.useProgram(displayProg);
        gl.uniform1i(dUni.ovChannel, overlayField.channel);
        gl.uniform1i(dUni.ovEverywhere, overlayField.everywhere ? 1 : 0);
        gl.uniform1i(dUni.ovNstops, nstops);
        gl.uniform1fv(dUni.ovStopT, t);
        gl.uniform3fv(dUni.ovStopC, c);
    }

    function setOverlay(key) {
        overlayField = key ? FIELD_BY_KEY[key] : null;
        refreshOverlayRange();
        applyOverlayUniforms();
        updateLegend();
    }

    // 3D view (M8): one camera for the session, one scene per grid shape.
    // The scene holds no solver reference — render() takes the live solver
    // each frame, so scenario swaps never leave it stale.
    let view3d = false;
    let beachView = false;     // first-person "stand on the shore" camera
    let scene3d = null;
    const camera = new OrbitCamera();
    const BACKING_2D = 513;    // the shipped 2D backing size — restored on toggle
    function syncBacking3d() {
        // 3D renders at display resolution (the 2D map stays at its exact
        // 513² texel-for-texel backing). Cap for the iGPU's sake.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.min(1600, Math.round((canvas.clientWidth || BACKING_2D) * dpr));
        const h = Math.min(1600, Math.round((canvas.clientHeight || BACKING_2D) * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
    }

    // The overlay's building color: base albedo until damage exists, then
    // the desktop's amber->red tint by expected fraction.
    function buildingColor(k, b) {
        if (!damageReport || k >= damageReport.fractions.length) return null;
        return damageColorCss(b.type.color, damageReport.fractions[k]);
    }

    // Assess the town from the accumulated hazard (one GPU readback through
    // getHazardFields — the ONLY hazard consumer). Cheap at the 30-frame
    // cadence; mirrors the desktop's _peak_refresh. Damage (dollars) and
    // casualties (lives) are computed and reported on SEPARATE lines —
    // property and life are different axes, and the divergence is the lesson.
    function assessDamage() {
        if (!town || !townGrid || !solver) return;
        const hz = getHazardFields(solver);

        damageReport = assessTown(town, townGrid, hz);
        const r = damageReport;
        // Push the tint to the 3D instances (the 2D overlay recolors via
        // its colorOf hook each draw; both derive from damageColorRgb, so
        // the two views can never disagree).
        if (scene3d && scene3d.townCount === town.buildings.length) {
            const cols = new Float32Array(town.buildings.length * 3);
            for (let k = 0; k < town.buildings.length; k++) {
                const c = damageColorRgb(town.buildings[k].type.color,
                                         r.fractions[k]);
                cols[k * 3] = c[0]; cols[k * 3 + 1] = c[1]; cols[k * 3 + 2] = c[2];
            }
            scene3d.setTownColors(cols);
        }
        const critHit = r.critical.filter(c => c[1] >= 0.2).length;
        $("dmgNum").textContent = `$${(r.totalLoss / 1e9).toFixed(2)}B`;
        $("dmgSub").textContent =
            `${r.lossPct.toFixed(0)}% of value · ` +
            `${r.counts.collapse || 0} collapsed · ` +
            `${critHit}/${r.critical.length} critical`;
        $("cardDamage").classList.toggle(
            "warn", r.lossPct >= 1.0 && r.lossPct < 40.0);
        $("cardDamage").classList.toggle("bad", r.lossPct >= 40.0);

        // The evacuation lookup depends only on the (post-event) bed +
        // town — compute once per terrain epoch and reuse across cadence
        // ticks and day/night flips (it is independent of the detection/
        // EWS knobs, which change only the clock). A town with roads gets
        // the network route PLAN (M12b); a roadless one the legacy
        // nearest-refuge array.
        if (!refuges) {
            refuges = (town.roads && town.roads.edges.length > 0)
                ? planEvacuation(town, townGrid, solver.b, evacParams)
                : nearestRefuges(town, townGrid, solver.b, evacParams);
        }
        // Early-warning: the detection delay and the rupture time depend on
        // the source (near-field vs regional) and the EWS toggle — the
        // desktop _assessment_evac() rule. A regional source's rupture
        // precedes the wave's map entry (t_quake < 0), which is what credits
        // the long warning window a distant quake buys (the EWS lesson).
        const timing = evacTimingFor(scenarioData.id, ewsOn);
        evacParams.detectionDelayS = timing.detection;
        casualtyReport = assessCasualties(town, townGrid, solver.b, hz,
                                          evacParams, daytime, refuges,
                                          timing.tQuake);
        renderCasualtyLine();

        // Bank this scenario's economic outcome for the risk table: the
        // property loss (EWS/day-night independent) plus deaths in all four
        // day/night × warned/unwarned combos — re-assessed from the SAME
        // hazard fields (no re-run), so day/night and warning toggles
        // re-price the whole annualized table instantly. t_quake depends
        // only on the source kind, not the EWS state.
        const tqWarned = evacTimingFor(scenarioData.id, true);
        const tqUnwarned = evacTimingFor(scenarioData.id, false);
        const deathsFor = (day, det, tq) => {
            evacParams.detectionDelayS = det;
            return assessCasualties(town, townGrid, solver.b, hz, evacParams,
                                    day, refuges, tq).fatalities;
        };
        riskBank[scenarioData.id] = {
            loss: r.totalLoss,
            epoch: defenseEpoch,   // the defense state this was priced under
            deaths: {
                day: { warned: deathsFor(true, tqWarned.detection, tqWarned.tQuake),
                       unwarned: deathsFor(true, tqUnwarned.detection, tqUnwarned.tQuake) },
                night: { warned: deathsFor(false, tqWarned.detection, tqWarned.tQuake),
                         unwarned: deathsFor(false, tqUnwarned.detection, tqUnwarned.tQuake) },
            },
        };
        evacParams.detectionDelayS = timing.detection;   // restore
        renderRiskPanel();
    }

    // The conditions the casualty numbers were priced under — shown in the
    // evacuation card's sublabel so toggling ☀/☾ or 🚨 visibly re-prices.
    function conditionLabel() {
        return `${daytime ? "☀ day" : "☾ night"} · ` +
               `${ewsOn ? "🚨 warning ON" : "no warning"}`;
    }

    function renderCasualtyLine() {
        $("evacSub").textContent = conditionLabel();
        const c = casualtyReport;
        if (!c) {
            $("deathNum").textContent = "—";
            $("deathSub").textContent = "no event yet";
            $("evacNum").textContent = "—";
            $("evacWhy").textContent = "—";
            $("cardDeaths").classList.remove("bad", "good");
            $("cardEvac").classList.remove("bad", "warn", "good");
            return;
        }
        // M13c: the WHY behind the evacuation number — how long the
        // median walk to refuge takes vs how much lead time people got,
        // and how many escape routes the water itself severed.
        const s = c.stats;
        if (!s || s.wetRouted === 0) {
            $("evacWhy").textContent = "no one in the water's path";
        } else {
            const w = Math.round(s.medianWalkS / 60);
            const lead = s.medianLeadS === null
                ? "wave never arrives"
                : `~${Math.round(s.medianLeadS / 60)} min of warning`;
            const cut = s.routesCut > 0
                ? ` · ${s.routesCut} routes cut by water` : "";
            $("evacWhy").textContent = `walk ~${w} min vs ${lead}${cut}`;
        }
        $("deathNum").textContent =
            `~${Math.round(c.fatalities).toLocaleString("en-US")}`;
        $("deathSub").textContent =
            `of ${c.present.toLocaleString("en-US")} present · ` +
            `~${Math.round(c.injuries).toLocaleString("en-US")} hurt`;
        $("cardDeaths").classList.toggle("bad", c.fatalities >= 1.0);
        $("cardDeaths").classList.toggle("good", c.fatalities < 1.0);
        const e = 100 * c.evacSuccess;
        $("evacNum").textContent = `${e.toFixed(0)}%`;
        $("cardEvac").classList.toggle("good", e >= 70);
        $("cardEvac").classList.toggle("warn", e >= 30 && e < 70);
        $("cardEvac").classList.toggle("bad", e < 30);
    }

    // The economic risk table (M11): "design for which wave?" — annualized
    // deaths and property loss across every event you've faced, and what
    // the early-warning system buys per year. Dollars and lives stay on
    // SEPARATE axes; lives are never monetized.
    function renderRiskPanel() {
        const body = $("riskBody");
        const rows = [];
        let annDeaths = 0, annDeathsNoEws = 0, annDeathsEws = 0, annLoss = 0;
        let anyBanked = false;
        let anyStale = false;
        for (const s of SCENARIOS) {
            const period = returnPeriodYr(s.id);
            const b = riskBank[s.id];
            const name = s.label;
            if (!b) {
                rows.push(`<tr><td>${name}</td><td>1 in ${period} yr</td>` +
                          `<td class="dim" colspan="2">— run it —</td></tr>`);
                continue;
            }
            // M15: banked before the last wall change — the world it was
            // priced on no longer exists. Show it dimmed (still useful as
            // the before/after comparison) but keep it OUT of the totals:
            // summing two different worlds would be a fake number.
            const stale = (b.epoch ?? 0) !== defenseEpoch;
            const mode = daytime ? "day" : "night";
            const dHere = b.deaths[mode][ewsOn ? "warned" : "unwarned"];
            const perDeaths = Math.round(dHere).toLocaleString("en-US");
            const annD = annualize(s.id, dHere);
            const annDtxt = annD >= 0.1 ? annD.toFixed(1) : annD.toFixed(2);
            if (stale) {
                anyStale = true;
                rows.push(
                    `<tr><td class="stale">${name}</td>` +
                    `<td class="stale">1 in ${period} yr</td>` +
                    `<td class="stale">${perDeaths} · ${fmtUsd(b.loss)} ` +
                    `(pre-change)</td>` +
                    `<td class="stale">— re-run —</td></tr>`);
                continue;
            }
            anyBanked = true;
            const dNoEws = b.deaths[mode].unwarned;
            const dEws = b.deaths[mode].warned;
            annDeaths += annualize(s.id, dHere);
            annDeathsNoEws += annualize(s.id, dNoEws);
            annDeathsEws += annualize(s.id, dEws);
            annLoss += annualize(s.id, b.loss);
            rows.push(
                `<tr><td>${name}</td><td>1 in ${period} yr</td>` +
                `<td>${perDeaths} · ${fmtUsd(b.loss)}</td>` +
                `<td>${annDtxt} · ${fmtUsd(annualize(s.id, b.loss))}</td></tr>`);
        }
        body.innerHTML = rows.join("");
        const staleNote = anyStale
            ? `<br><span class="dim">Defenses changed — dim rows were ` +
              `priced on the old world; re-run them to re-price.</span>`
            : "";
        if (!anyBanked) {
            $("riskTotal").innerHTML = (anyStale
                ? `<span class="dim">Defenses changed — re-run each ` +
                  `scenario to re-price the risk on the new world.</span>`
                : `<span class="dim">Run each scenario to build your risk ` +
                  `profile — the annualized toll appears here.</span>`);
            $("riskEws").textContent = "";
            return;
        }
        $("riskTotal").innerHTML =
            `<b>Expected per year</b> (across events faced): ` +
            `<b>${annDeaths.toFixed(1)}</b> deaths · <b>${fmtUsd(annLoss)}</b> loss` +
            staleNote;
        // The EWS cost-benefit: it cuts the annualized DEATHS (by fixing the
        // frequent regional), but never the property loss — warning saves
        // lives, not buildings.
        const prevented = annDeathsNoEws - annDeathsEws;
        $("riskEws").innerHTML =
            `🚨 <b>Early warning — ${fmtUsd(EWS_COST_USD)} once:</b> ` +
            `annualized deaths ${annDeathsNoEws.toFixed(1)}/yr → ` +
            `<b>${annDeathsEws.toFixed(1)}/yr</b> ` +
            `(prevents ~${prevented.toFixed(1)} deaths a year). ` +
            `Property loss unchanged — warning saves lives, not buildings.`;
    }

    // ---- Buildable defenses (M15) ------------------------------------
    // The desktop contract, kept: CHARGE BEFORE APPLY (a wall is quoted
    // against the world as it stands, gated on the pot, then built) and
    // REMOVAL IS A WORLD REBUILD (no undo — the world reloads pristine
    // and the surviving walls re-apply in build order via setScenario).

    function budgetRemaining() { return BUDGET_TOTAL_USD - budgetSpent; }

    function renderDefensePanel() {
        const bd = $("defBudget");
        bd.innerHTML =
            `Budget: <b>${fmtM(budgetSpent)}</b> spent of ` +
            `${fmtM(BUDGET_TOTAL_USD)} · <b>${fmtM(budgetRemaining())}</b> left`;
        bd.classList.toggle("broke", budgetRemaining() < 25e6);
        const list = $("defList");
        if (walls.length === 0) {
            list.innerHTML =
                `<div class="wrow"><span class="dim" style="font-style:italic">` +
                `no defenses built — the whole pot is available</span></div>`;
            return;
        }
        list.innerHTML = walls.map((w, i) =>
            `<div class="wrow"><span class="wname">Seawall ${i + 1}</span>` +
            `<span>${describeWall(w, wallQuotes[i] ?? w._quote ?? 0)}</span>` +
            `<button class="wx" data-i="${i}" ` +
            `title="Demolish this wall (full refund — the world rebuilds ` +
            `without it)">✕ remove</button></div>`).join("");
    }

    /** Any wall change funnels through here: new defense epoch (stale-
     *  marks the banked risk rows), then a full world rebuild — the same
     *  path as the Reset button, so the event re-arms and the outcome
     *  cards blank honestly. `message` lands on the status line AFTER
     *  the rebuild's own status write. */
    async function rebuildWorld(message) {
        defenseEpoch++;
        await setScenario(sel.value);
        $("status").textContent = message;
    }

    /** Quote → gate on the pot → commit → rebuild. Returns true if the
     *  wall was built. The refusal states are LOUD (status line), never
     *  silent. */
    function commitWall(w) {
        if (!designBed || !townGrid) return false;
        if (wallLength(w) < townGrid.dx) {
            $("status").textContent =
                `too short — a wall must span at least one grid cell ` +
                `(${townGrid.dx.toFixed(0)} m)`;
            return false;
        }
        const quote = wallCost(w, designBed, townGrid);
        if (quote > budgetRemaining() + 1e-6) {
            $("status").textContent =
                `⛔ can't afford it: that wall quotes ${fmtM(quote)} but only ` +
                `${fmtM(budgetRemaining())} of the ${fmtM(BUDGET_TOTAL_USD)} ` +
                `pot is left`;
            return false;
        }
        w._quote = quote;          // the replay self-check's reference price
        walls.push(w);
        rebuildWorld(
            `🧱 seawall built (${describeWall(w, quote)}) — world rebuilt, ` +
            `press Run to face the wave with it`)
            .catch(e => fatal(e.message));
        return true;
    }

    function removeWall(i) {
        if (i < 0 || i >= walls.length) return;
        const refund = wallQuotes[i] ?? walls[i]._quote ?? 0;
        walls.splice(i, 1);
        rebuildWorld(
            `seawall demolished — ${fmtM(refund)} refunded, world rebuilt`)
            .catch(e => fatal(e.message));
    }

    function clearWalls() {
        if (walls.length === 0) return;
        walls = [];
        rebuildWorld("all seawalls demolished — full refund, world rebuilt")
            .catch(e => fatal(e.message));
    }

    // Draw mode: 🧱 arms it (2D only — the map is the drawing surface);
    // click 1 anchors, the mouse rubber-bands a live-quoted dashed line,
    // click 2 commits. Esc or right-click cancels.
    //
    // BOTH 2D views are drawable, and the TOWN CLOSE-UP is the one that
    // makes sense (user call): the whole-domain map puts 120 km across
    // ~660 css px, so one pixel is ~180 m — COARSER than the 234 m grid
    // cell the wall is built from, and the town is a thumbnail. The
    // close-up window is ~10.6 km wide, so a pixel is ~38 m and a cell
    // is ~6 px — the difference between placing a wall and guessing at
    // one. The big map still works for long regional walls.
    function exitWallDraw() {
        wallDraw = null;
        overlay.setPendingWall(null);
        canvas.style.cursor = "";
        $("buildwall").classList.remove("arming");
    }

    function enterWallDraw() {
        if (view3d) setView3d(false);   // the map is the drawing surface
        wallDraw = {};                  // stage 1: waiting for the anchor
        canvas.style.cursor = "crosshair";
        $("buildwall").classList.add("arming");
        $("status").textContent =
            `🧱 seawall, crest ${$("crest").value} m — click in the town ` +
            `close-up (top-left) where the wall STARTS (Esc cancels)`;
    }

    /** Map a mouse event to world meters, as the exact inverse of the
     *  projection overlay.render() drew with (uvOf's texel-CENTER
     *  mapping — a half-texel is invisible on the big map but the
     *  close-up zooms ~25x, where it is a visible slide).
     *
     *  Returns {x, y, view}: "inset" when the pointer is inside the town
     *  close-up, else "main". Pass `lockView` to hold a rubber-band in
     *  the view its anchor was placed in — without that lock, dragging
     *  one pixel past the little window's border would reproject and
     *  throw the endpoint kilometres away. Inside a locked "inset" drag
     *  the pointer is CLAMPED to the window instead, so the line stays
     *  where the user can see it. Null until the grid exists. */
    function eventWorldPoint(e, lockView = null) {
        const r = canvas.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        // The overlay's css box is this canvas's box (both are inset:0 in
        // #viewwrap), but insetRect() is expressed in the overlay's own
        // css units — rescale in case a resize hasn't been synced yet.
        const W = overlay.cssW || r.width, H = overlay.cssH || r.height;
        return worldFromCss((e.clientX - r.left) * (W / r.width),
                            (e.clientY - r.top) * (H / r.height), lockView);
    }

    /** The projection inverse itself, in overlay css pixels — split out
     *  from the event plumbing so automation can probe it (window.__app
     *  .probePoint) without synthesizing mouse events, which the click
     *  path's geometry makes hard to verify on a headless canvas. */
    function worldFromCss(cx, cy, lockView = null) {
        if (!townGrid) return null;
        const W = overlay.cssW, H = overlay.cssH;
        if (!W || !H) return null;
        const ir = insetUV ? overlay.insetRect() : null;
        const inInset = !!ir && cx >= ir.x && cx <= ir.x + ir.w &&
                                cy >= ir.y && cy <= ir.y + ir.h;
        const view = lockView || (inInset ? "inset" : "main");
        let u, v;
        if (view === "inset" && ir) {
            const qx = Math.max(ir.x, Math.min(ir.x + ir.w, cx));
            const qy = Math.max(ir.y, Math.min(ir.y + ir.h, cy));
            const [u0, v0] = insetUV.uv0, [u1, v1] = insetUV.uv1;
            u = u0 + ((qx - ir.x) / ir.w) * (u1 - u0);
            v = v0 + ((ir.y + ir.h - qy) / ir.h) * (v1 - v0);
        } else {
            u = cx / W;
            v = 1 - cy / H;
        }
        const g = townGrid;
        return { x: g.xmin + (u * g.n - 0.5) * g.dx,
                 y: g.ymin + (v * g.n - 0.5) * g.dx,
                 view };
    }

    /** Blank the outcome cards for a fresh scenario (population persists —
     *  the town is the same; conditions persist — they're settings). */
    function resetOutcomeCards() {
        $("clockNum").textContent = "0 s";
        $("clockSub").textContent = "press Run";
        $("dmgNum").textContent = "—";
        $("dmgSub").textContent = "no event yet";
        $("cardDamage").classList.remove("bad", "warn");
        casualtyReport = null;
        renderCasualtyLine();
    }
    // The event is ARMED at load and fired on the first Run press, so the
    // user sees the calm pre-event ocean first and the rupture/pulse/train
    // reads as an event, not as "the map starts red".
    let armed = false;
    let pendingFire = false;

    async function setScenario(id) {
        $("status").textContent = `loading ${id} ...`;
        pendingFire = false;           // cancels any not-yet-fired trigger
        exitWallDraw();                // a half-drawn wall dies with the world
        if (solver) { solver.release(); solver = null; }
        scenarioData = await loadScenario(id);
        // M15: build the committed seawalls into this world BEFORE the
        // solver exists — the desktop replay contract (pristine bed +
        // walls in build order, quote-then-apply). scenarioData.bed is
        // frozen canon and is never touched; the solver gets a defended
        // COPY and its at-rest fill leaves wall cells dry automatically.
        const g0 = scenarioData.params.grid;
        const grid = { n: g0.n, dx: g0.dx_m,
                       xmin: -g0.domain_m / 2, ymin: -g0.domain_m / 2 };
        let bedForSolver = scenarioData.bed;
        if (walls.length > 0) {
            const d = applyDefenses(walls, scenarioData.bed, grid);
            bedForSolver = d.bed;
            wallQuotes = d.quotes;
            budgetSpent = d.spent;
            // Replay self-check (desktop base.py): the rebuild must
            // re-quote each wall to what was charged when it was
            // committed. Drift means the world is not reproducing —
            // say so loudly, never paper over.
            walls.forEach((w, i) => {
                if (w._quote != null &&
                    Math.abs(d.quotes[i] - w._quote) >
                        Math.max(1.0, 1e-3 * w._quote)) {
                    console.warn(
                        `replay drift: wall ${i + 1} re-quotes ` +
                        `${fmtM(d.quotes[i])} vs ${fmtM(w._quote)} charged ` +
                        `at build time — the baseline world is not ` +
                        `reproducing this wall exactly`);
                }
            });
        } else {
            wallQuotes = [];
            budgetSpent = 0;
        }
        designBed = bedForSolver;      // PRE-event defended bed: quoting base
        renderDefensePanel();
        solver = createSolverAtRest(
            gl, shaders,
            walls.length > 0 ? { ...scenarioData, bed: bedForSolver }
                             : scenarioData,
            { floatLinear });
        sim = new Simulation(solver, parseFloat($("speed").value));
        sim.paused = true;
        armed = true;
        $("run").textContent = "Run";
        // Town views ride the scenario grid (all three share one bed, but
        // derive per-scenario anyway — cheap, and never silently stale).
        damageReport = null;       // fresh scenario: no damage yet
        casualtyReport = null;
        refuges = null;            // new bed epoch: refuges recompute
        assessTick = 0;
        resetOutcomeCards();
        townGrid = grid;   // same {n,dx,xmin,ymin} the defenses used
        if (town) {
            overlay.setGrid(townGrid);
            overlay.setWalls(walls);
            const win = computeInsetWindow(scenarioData.bed, townGrid, town);
            overlay.setWindow(win);
            insetUV = uvWindow(win, townGrid);
            // M13b: contours (depth + refuge line) march off the live CPU
            // bed — new scenario, new contour epoch.
            overlay.setBed(solver.b);
        }
        // 3D scene: mesh + programs depend only on the grid shape (all
        // three reference scenarios share 513² / 120 km); rebuild only if
        // that ever changes. The scene reads the live solver each frame.
        const g3 = scenarioData.params.grid;
        if (scene3d && scene3d.n !== g3.n) { scene3d.release(); scene3d = null; }
        if (!scene3d) scene3d = new Scene3D(gl, shaders, g3.n, g3.domain_m);
        scene3d.setTown(town);   // rebuilds instances, restores base colors
        scene3d.setRoads(town, solver.b);   // drape roads on the same bed
        // Frame the camera on the town (the desktop's startup framing:
        // ~2.6x the town radius, afternoon-lit from the southwest).
        if (town) {
            if (beachView) {
                // Re-stand on THIS scenario's shore instead of framing the
                // town — otherwise the town-framing yaw/pitch would hijack
                // the beach gaze and tip it up at the sky (bug fix).
                enterBeachAt();
            } else {
                const fp = town.footprint();
                camera.frame([fp.cx, fp.cy, 0],
                             Math.max(9_000, Math.min(30_000, fp.r * 2.6)),
                             -120, 40);
            }
        }
        // Debug/console handle (also used by automated checks).
        window.__app = { solver, sim, scenarioData, town, overlay, draw,
                         assessDamage, getDamageReport: () => damageReport,
                         getCasualtyReport: () => casualtyReport,
                         setDaytime: (d) => { daytime = d; },
                         setEws: (v) => { ewsOn = v; if (typeof updateEwsButton === "function") updateEwsButton(); },
                         getEws: () => ewsOn,
                         camera, setView3d: (v) => setView3d(v),
                         getScene3d: () => scene3d,
                         setOverlay: (k) => { setOverlay(k); draw(); },
                         getOverlay: () => (overlayField ? overlayField.key : null),
                         getOvRange: () => ovRange,
                         triggerEvent: () => triggerEvent(0),
                         // M15 defenses (programmatic path = the UI path:
                         // same quote gate, same world rebuild).
                         addWall: (x0, y0, x1, y1, crest) =>
                             commitWall({ x0, y0, x1, y1, crest }),
                         removeWall, clearWalls,
                         probePoint: (cx, cy, lockView = null) =>
                             worldFromCss(cx, cy, lockView),
                         getWalls: () => walls.map(w => ({ ...w })),
                         getBudget: () => ({ total: BUDGET_TOTAL_USD,
                                             spent: budgetSpent,
                                             remaining: budgetRemaining() }),
                         getDefenseEpoch: () => defenseEpoch };
        // Overlay persists across scenarios (it's a display mode); refresh
        // its range/legend for the new solver's (empty) accumulator.
        if (overlayField) { refreshOverlayRange(); updateLegend(); }
        renderRiskPanel();   // show the new scenario's row (run it to bank)
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
            // Scenario C's coseismic step rewrites solver.b in place and the
            // 3D terrain lifts its vertices straight from that texture, so
            // the ground drops the frame the quake fires. Re-drape the road
            // ribbons onto the new bed or they hang in the air above it —
            // this is the only place the web port's bed ever changes.
            // Display only: the router reads the graph, never the drape.
            if (scene3d) scene3d.setRoads(town, solver.b);
            // The 2D contours read the same rewritten bed (the coast
            // subsides, so the refuge line and depth lines genuinely
            // move) — new contour epoch.
            overlay.setBed(solver.b);
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
        const ov = overlayField
            ? { field: overlayField, range: ovRange } : null;
        if (view3d && scene3d) {
            syncBacking3d();
            scene3d.render(solver, camera, canvas.width, canvas.height,
                           undefined, ov);
            overlay.render(null);   // clear the 2D building rects/inset chrome
            return;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(displayProg);
        gl.uniform1f(dUni.range, 2.0);   // +-2 m anomaly, like the ref PNGs
        gl.uniform2f(dUni.uv0, 0.0, 0.0);   // whole domain
        gl.uniform2f(dUni.uv1, 1.0, 1.0);
        // Hazard overlay: flag + current range; bind the live accumulator
        // textures (units 2/3) the shader samples. Static ramp/channel were
        // set in applyOverlayUniforms() at selection time.
        gl.uniform1i(dUni.overlay, ov ? 1 : 0);
        if (ov) {
            gl.uniform2f(dUni.ovRange, ovRange[0], ovRange[1]);
            const ht = solver.hazardTextures;
            if (ht) {
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D, ht.acc0);
                gl.activeTexture(gl.TEXTURE3);
                gl.bindTexture(gl.TEXTURE_2D, ht.acc1);
            }
        }
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
        overlay.render(town, buildingColor);
    }

    let lastT = performance.now();
    let fpsAcc = 0, fpsN = 0, fpsShown = 0;
    function frame(now) {
        const wallDt = Math.min((now - lastT) / 1000, 0.1); // desktop cap
        lastT = now;
        if (solver && sim) {
            const steps = sim.advance(wallDt);
            // Reassess damage on the desktop's cadence once the event has
            // fired (solver clock past 0). Every ~30 running frames, plus
            // one final assessment when the sim pauses/settles so a paused
            // frame shows the finished toll, not a stale one.
            if (!sim.paused && solver.timeS > 0) {
                if (assessTick % 30 === 0) {
                    assessDamage();
                    // Arrival auto-ranges as the field grows; refresh its
                    // legend on the same cadence (fixed-range fields no-op).
                    if (overlayField && !overlayField.vrange) {
                        refreshOverlayRange();
                        updateLegend();
                    }
                }
                assessTick++;
            }
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
                // The clock card owns the sim time (the teaching quantity);
                // the status line keeps the technical telemetry.
                $("clockNum").textContent = fmtSimTime(solver.timeS);
                $("clockSub").textContent = `running ×${sim.timeScale}`;
                $("status").textContent =
                    `${fpsShown} fps` +
                    (steps >= 24 ? " · running below requested speed" : "");
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

    // Hazard-overlay picker: None + the four accumulated fields. Drives the
    // 2D map and the 3D terrain from the same selection + legend.
    const ovSel = $("overlaySel");
    for (const [val, label] of [["", "None"],
                                ...HAZARD_FIELDS.map(f => [f.key, f.name])]) {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = label;
        ovSel.appendChild(opt);
    }
    ovSel.addEventListener("change", () => { setOverlay(ovSel.value || null); draw(); });
    $("run").addEventListener("click", () => {
        if (!sim || pendingFire) return;   // ignore clicks during the beat
        if (armed) { triggerEvent(); return; }
        sim.paused = !sim.paused;
        $("run").textContent = sim.paused ? "Run" : "Pause";
        // Pausing: snap the damage readout to the current state (the
        // running cadence may be up to 30 frames stale).
        if (sim.paused) {
            $("clockSub").textContent = "paused";
            if (solver && solver.timeS > 0) assessDamage();
        }
    });
    $("reset").addEventListener("click", () => setScenario(sel.value).catch(e => fatal(e.message)));
    $("speed").addEventListener("input", () => {
        if (sim) sim.timeScale = parseFloat($("speed").value);
        $("speedval").textContent = `x${$("speed").value}`;
    });
    // Day/night: flips who's where. Same wave, different victims — the
    // occupancy toggle re-prices casualties (not damage: buildings don't
    // care what time it is). Re-assess if the event has already fired.
    $("daynight").addEventListener("click", () => {
        daytime = !daytime;
        $("daynight").textContent = daytime ? "☀ Day" : "☾ Night";
        if (casualtyReport && solver) {
            assessDamage();            // refresh casualties for the new mode
        } else {
            renderCasualtyLine();      // nothing fired yet: just the label
            renderRiskPanel();         // re-price banked scenarios' rows
        }
    });

    // Early-warning system: buoys + sirens that detect the source fast. It
    // barely helps a near-field quake (the wave beats any siren) but is
    // decisive for a REGIONAL source (a distant quake with a long travel
    // window the town would otherwise squander) — the regional EWS lesson.
    function updateEwsButton() {
        $("ews").textContent = ewsOn ? "🚨 Warning: ON" : "🚨 Warning: off";
        $("ews").classList.toggle("on", ewsOn);
    }
    $("ews").addEventListener("click", () => {
        ewsOn = !ewsOn;
        updateEwsButton();
        if (casualtyReport && solver) assessDamage();
        else { renderCasualtyLine(); renderRiskPanel(); }
    });
    updateEwsButton();

    // 2D map <-> 3D scene. One page, one running sim; only the render
    // path changes. The 2D map keeps its exact 513² backing; 3D renders
    // at display resolution.
    function setView3d(on) {
        view3d = !!on;
        // Leaving the 3D scene leaves the beach with it.
        if (!view3d && beachView) exitBeachState();
        // Entering 3D abandons a half-drawn wall (the map is the
        // drawing surface).
        if (view3d && wallDraw) exitWallDraw();
        document.body.classList.toggle("view3d", view3d);
        $("viewmode").textContent = view3d ? "2D map" : "3D view";
        if (view3d) {
            syncBacking3d();
        } else {
            canvas.width = BACKING_2D;
            canvas.height = BACKING_2D;
        }
    }
    $("viewmode").addEventListener("click", () => setView3d(!view3d));

    // Beach view: stand on the shore at eye height and watch the sea come
    // in at TRUE height (1x, no exaggeration) — the view the whole lesson
    // is about. It's a first-person camera mode on top of the 3D scene.

    /** Find the water's edge in front of the town and return where to
     *  stand: the FIRST WET cell west of the shoreline, with the eye 2 m
     *  above the water surface (z 0). Standing on the dry sand instead
     *  puts a whole 234 m terrain cell under your feet, which fills the
     *  entire lower screen and squeezes the actual sea into a ~1-degree
     *  sliver at the horizon (user-reported: "sea is a thin line"). At
     *  the water's edge the sea starts at your feet and runs to the
     *  horizon — the real standing-in-the-shallows view — and the run-up
     *  wave comes straight at you. Reads the CPU bed (solver.b). */
    function beachStandingPoint() {
        const g = scenarioData.params.grid;
        const n = g.n, dx = g.dx_m, xmin = -g.domain_m / 2, ymin = -g.domain_m / 2;
        const bed = solver.b;
        const fp = town.footprint();
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const j = clamp(Math.round((fp.cy - ymin) / dx), 0, n - 1);
        let i = clamp(Math.round((fp.cx - xmin) / dx), 0, n - 1);
        // Walk WEST (toward the sea) until we step below sea level: cell i
        // is the first WET cell — the water's edge. Stand there, eye above
        // the SEA SURFACE (groundZ 0), ankle-deep at the shore.
        while (i > 1 && bed[j * n + i] >= 0.0) i--;
        return { x: xmin + i * dx, y: fp.cy, groundZ: 0.0 };
    }
    function enterBeachAt() {
        const p = beachStandingPoint();
        camera.enterBeach(p.x, p.y, p.groundZ, 180.0);  // yaw 180 = look west
        camera.pitchDeg = -12.0;   // gaze slightly down: sea fills the frame
        if (scene3d) { scene3d.waveExagg = 1.0;         // real wave height
                       scene3d.beachSea = 1.0; }        // North-Atlantic sea
    }
    function exitBeachState() {
        beachView = false;
        camera.exitBeach();
        if (scene3d) { scene3d.waveExagg = 10.0;        // back to map-scale
                       scene3d.beachSea = 0.0; }        // clear-water orbit sea
        $("beachview").textContent = "Beach view";
    }
    function setBeachView(on) {
        if (!on) { exitBeachState(); draw(); return; }
        if (!view3d) setView3d(true);            // beach is a 3D camera
        beachView = true;
        enterBeachAt();
        $("beachview").textContent = "Exit beach";
        draw();
    }
    $("beachview").addEventListener("click", () => setBeachView(!beachView));

    // 3D mouse controls: left-drag orbit, right-drag pan, wheel zoom.
    // All inert in 2D mode.
    let dragButton = -1, dragX = 0, dragY = 0;
    canvas.addEventListener("mousedown", (e) => {
        if (!view3d) return;
        dragButton = e.button;
        dragX = e.clientX; dragY = e.clientY;
        e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
        if (!view3d || dragButton < 0) return;
        const dx = e.clientX - dragX, dy = e.clientY - dragY;
        dragX = e.clientX; dragY = e.clientY;
        if (dragButton === 2) camera.pan(dx, dy);
        else camera.orbit(dx, dy);
    });
    window.addEventListener("mouseup", () => { dragButton = -1; });
    canvas.addEventListener("wheel", (e) => {
        if (!view3d) return;
        e.preventDefault();
        camera.zoom(-e.deltaY / 120);   // wheel up = closer
    }, { passive: false });
    canvas.addEventListener("contextmenu", (e) => {
        if (view3d) e.preventDefault();  // right-drag pans, no menu
        if (wallDraw) {                  // right-click = cancel the draw
            e.preventDefault();
            exitWallDraw();
            $("status").textContent = "seawall drawing cancelled";
        }
    });

    // ---- Seawall draw-mode listeners (M15) ---------------------------
    $("buildwall").addEventListener("click", () => {
        if (wallDraw) {
            exitWallDraw();
            $("status").textContent = "seawall drawing cancelled";
        } else {
            enterWallDraw();
        }
    });
    $("crest").addEventListener("input", () => {
        $("crestval").textContent = `${$("crest").value} m`;
        // Re-prompt so the armed status line quotes the new height.
        if (wallDraw && wallDraw.x0 === undefined) enterWallDraw();
    });
    canvas.addEventListener("click", (e) => {
        if (!wallDraw || view3d || !townGrid || !designBed) return;
        if (wallDraw.x0 === undefined) {
            const p = eventWorldPoint(e);
            if (!p) return;
            // The anchor's view owns the whole drag (see eventWorldPoint).
            wallDraw = { x0: p.x, y0: p.y, view: p.view };
            overlay.setPendingWall({ x0: p.x, y0: p.y });
            $("status").textContent =
                `🧱 now click where the wall ENDS — in the ` +
                `${p.view === "inset" ? "close-up" : "big map"}, same as ` +
                `the start (the line quotes live)`;
            return;
        }
        const p = eventWorldPoint(e, wallDraw.view);
        if (!p) return;
        const w = { x0: wallDraw.x0, y0: wallDraw.y0, x1: p.x, y1: p.y,
                    crest: parseFloat($("crest").value) };
        if (wallLength(w) < townGrid.dx) {
            $("status").textContent =
                `too short — click at least ${townGrid.dx.toFixed(0)} m ` +
                `(one grid cell) from the anchor`;
            return;                     // stay armed: pick a farther end
        }
        commitWall(w);                  // refusals report on the status line
        exitWallDraw();
    });
    canvas.addEventListener("mousemove", (e) => {
        if (!wallDraw || wallDraw.x0 === undefined || view3d ||
            !townGrid || !designBed) return;
        const p = eventWorldPoint(e, wallDraw.view);
        if (!p) return;
        const w = { x0: wallDraw.x0, y0: wallDraw.y0, x1: p.x, y1: p.y,
                    crest: parseFloat($("crest").value) };
        overlay.setPendingWall(w);
        const q = wallCost(w, designBed, townGrid);
        const fits = q <= budgetRemaining() + 1e-6;
        $("status").textContent =
            `🧱 ${(wallLength(w) / 1000).toFixed(1)} km, crest ` +
            `${w.crest.toFixed(0)} m — ${fmtM(q)}` +
            (fits ? ` (${fmtM(budgetRemaining())} in the pot)`
                  : ` — ⛔ OVER BUDGET (${fmtM(budgetRemaining())} left)`);
    });
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && wallDraw) {
            exitWallDraw();
            $("status").textContent = "seawall drawing cancelled";
        }
    });
    $("defList").addEventListener("click", (e) => {
        const btn = e.target.closest("button.wx");
        if (btn) removeWall(parseInt(btn.dataset.i, 10));
    });

    // 3D keyboard controls: WASD / arrow keys glide the view across the
    // sea surface (parallel to sea level), so you can travel out to deep
    // water and THEN zoom in on the wave — precise where dragging is
    // fiddly. Step scales with zoom (a press moves ~5% of the view
    // distance). Ignored while typing in a control or in 2D mode.
    const PAN_KEYS = {
        w: [1, 0], s: [-1, 0], a: [0, -1], d: [0, 1],
        arrowup: [1, 0], arrowdown: [-1, 0],
        arrowleft: [0, -1], arrowright: [0, 1],
    };
    window.addEventListener("keydown", (e) => {
        if (!view3d || e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = (e.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "select" || tag === "textarea") return;
        const move = PAN_KEYS[e.key.toLowerCase()];
        if (!move) return;
        e.preventDefault();
        // Beach mode WALKS in fixed strides; orbit mode glides proportional
        // to zoom (the stale orbit distance would make a beach step huge).
        const step = beachView ? 60.0 : camera.distance * 0.05;
        camera.moveGround(move[0] * step, move[1] * step);
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
