// getHazardFields() contract tests — the JS mirror of the desktop
// tests/test_hazard.py section 5 (plus the section-3 analytic momentum
// pin), which the desktop declares as THE accessor contract for this port.
// The future damage-model phase builds on exactly this shape.
//
// Differences from the desktop test, and why:
//  * The "accessor equals the raw solver reads" equivalence check is
//    omitted: in this codebase getHazardFields() IS the only wrapper over
//    those reads (hazard.js), and tests/test_invariants.py statically
//    forbids any other module from touching them — the property holds by
//    construction, not by sampling.
//  * Field arrays are flat Float32Array(n*n) (row-major, j=0 south), the
//    JS equivalent of the desktop's (n, n) float32.

import { GPUNonlinearSWESolver } from "./solver.js";
import { Simulation } from "./sim.js";
import { getHazardFields, arrivalRange, inundationExtent } from "./hazard.js";

export async function runContractChecks(gl, shaders) {
    const checks = [];
    const check = (ok, name) => checks.push({ ok: !!ok, name });

    // --- 1. Analytic momentum pin (desktop test_hazard section 3) --------
    // A hand-set uniform flow: depth 4 m, speed 3 m/s -> h*u^2 = 36.
    {
        const n = 17;
        const bed = new Float32Array(n * n).fill(-10.0);
        const s = new GPUNonlinearSWESolver(gl, shaders, bed, n, 100.0,
                                            { manningN: 0.0 });
        try {
            s.enableMaxTracking();
            const h = new Float32Array(n * n).fill(4.0);
            const hu = new Float32Array(n * n).fill(12.0);   // u = 3 m/s
            s.loadState(h, hu, null);
            s.timeS = 1.0;
            s.snapshotMax();
            let gf = getHazardFields(s);
            let maxSpeed = 0, maxMom = 0;
            for (let i = 0; i < n * n; i++) {
                if (gf.speed[i] > maxSpeed) maxSpeed = gf.speed[i];
                if (gf.momentum[i] > maxMom) maxMom = gf.momentum[i];
            }
            check(Math.abs(maxSpeed - 3.0) < 1e-4,
                  `max speed of the uniform flow is 3 m/s (${maxSpeed.toFixed(4)})`);
            check(Math.abs(maxMom - 36.0) < 1e-3,
                  `momentum flux = h*u^2 = 36 m^3/s^2 (${maxMom.toFixed(4)})`);
            // Running max: a calmer later state must not lower it.
            const hu2 = new Float32Array(n * n).fill(4.0);   // u = 1 -> 4
            s.loadState(h, hu2, null);
            s.timeS = 2.0;
            s.snapshotMax();
            gf = getHazardFields(s);
            maxMom = 0;
            for (let i = 0; i < n * n; i++) {
                if (gf.momentum[i] > maxMom) maxMom = gf.momentum[i];
            }
            check(Math.abs(maxMom - 36.0) < 1e-3,
                  "momentum flux is a running maximum (a calmer state can't lower it)");
        } finally {
            s.release();
        }
    }

    // --- 2. The accessor contract on a live beach run (section 4+5) ------
    {
        const nb = 129;
        const dx = 100.0;
        const bed = new Float32Array(nb * nb);
        for (let j = 0; j < nb; j++) {
            for (let i = 0; i < nb; i++) {
                const x = (i - (nb - 1) / 2) * dx;
                bed[j * nb + i] = Math.max((x - 2000.0) * 0.004, -30.0);
            }
        }
        const solver = new GPUNonlinearSWESolver(gl, shaders, bed, nb, dx,
                                                 { openEdges: ["west"] });
        try {
            solver.enableMaxTracking();

            const hz0 = getHazardFields(solver);
            check(arrivalRange(hz0) === null,
                  "arrivalRange is null before the wave arrives");

            solver.addGaussian(-3000.0, 0.0, 3.0, 1800.0);
            solver.snapshotMax();
            // 800 s: the wave needs ~300 s to reach the shore and run-up
            // starts after ~500 s (measured: 0 flooded cells at t=400,
            // 144 at t=600, 258 at t=800) — the desktop's 400 s stops at
            // "arrived", this test also wants "flooded" for the extent.
            const sim = new Simulation(solver, 64.0);
            while (sim.simTime < 800.0) sim.advance(0.05);

            const gf = getHazardFields(solver);
            const n2 = nb * nb;
            check(["depth", "speed", "momentum", "arrival"].every(
                      k => gf[k] instanceof Float32Array && gf[k].length === n2),
                  "contract: four Float32Array(n*n) fields named depth/speed/momentum/arrival");
            let maxDepth = 0, maxMom = 0;
            let nonNeg = true, arrivalSentinel = true, dryNoArrival = true;
            for (let i = 0; i < n2; i++) {
                if (gf.depth[i] > maxDepth) maxDepth = gf.depth[i];
                if (gf.momentum[i] > maxMom) maxMom = gf.momentum[i];
                if (gf.depth[i] < 0 || gf.speed[i] < 0 || gf.momentum[i] < 0)
                    nonNeg = false;
                if (!(gf.arrival[i] >= 0.0 || gf.arrival[i] === -1.0))
                    arrivalSentinel = false;
                if (gf.depth[i] <= 0.0 && gf.arrival[i] !== -1.0)
                    dryNoArrival = false;
            }
            check(maxDepth > 0.1 && maxMom > 0.0,
                  "the accessor sees the wave (depth and momentum are live)");
            check(nonNeg,
                  "contract: depth/speed/momentum are non-negative running maxima");
            check(arrivalSentinel,
                  "contract: arrival is seconds >= 0, with -1 = never arrived");
            check(dryNoArrival,
                  "contract: cells the water never reached have no arrival time");
            const rng = arrivalRange(gf);
            check(rng !== null && rng[0] < rng[1],
                  `arrivalRange is a proper interval after arrival (${rng})`);
            check(rng[0] >= 0.0 && rng[1] <= sim.simTime + 1e-3,
                  "arrival times fall within the run");

            // Inundation extent: on land only, thresholded on max depth.
            const ext = inundationExtent(gf, solver.b, 0.1);
            let extOnLandOnly = true, extMatchesRule = true, flooded = 0;
            for (let i = 0; i < n2; i++) {
                const should = (solver.b[i] > 0.0 && gf.depth[i] > 0.1) ? 1 : 0;
                if (ext[i] !== should) extMatchesRule = false;
                if (ext[i] && solver.b[i] <= 0.0) extOnLandOnly = false;
                flooded += ext[i];
            }
            check(extOnLandOnly, "extent marks land cells only");
            check(extMatchesRule,
                  "extent = (max depth > 0.1 m) & (bed > 0), exactly");
            check(flooded > 0,
                  `the 3 m beach wave floods some land (${flooded} cells)`);
        } finally {
            solver.release();
        }
    }

    return { pass: checks.every(c => c.ok), checks };
}
