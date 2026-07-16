// The time-stepping loop — direct port of the desktop Simulation
// (core/physics/solver.py). Owns simulated time and runs CFL-safe
// sub-steps each rendered frame.
//
// THE CONTRACT (critical for both stability and parity — see BUILDLOG
// standing rule 3): every sub-step uses exactly the same dt. The scheme is
// only energy-neutral at a FIXED step size — feeding it a varying dt (full
// steps plus a different remainder each frame) parametrically pumps energy
// until the field blows up (measured on desktop: NaN within a minute at
// time_scale 512). So fractional leftovers are BANKED for the next frame
// instead of run short.

export class Simulation {
    static MAX_SUBSTEPS_PER_FRAME = 24;  // graceful slow-motion, not a stall

    constructor(solver, timeScale = 30.0) {
        this.solver = solver;
        this.timeScale = timeScale;
        this.simTime = 0.0;    // simulated seconds since the run began
        this.paused = false;
        this._banked = 0.0;    // simulated time owed but not yet stepped
    }

    /** Advance the physics to cover `wallDt` seconds of wall time.
     *  Returns the number of sub-steps taken (0 when paused). */
    advance(wallDt) {
        if (this.paused) return 0;

        this._banked += wallDt * this.timeScale;
        const dt = this.solver.stableDt();
        let steps = 0;
        while (this._banked >= dt
                && steps < Simulation.MAX_SUBSTEPS_PER_FRAME) {
            this.solver.step(dt);
            this.simTime += dt;
            this._banked -= dt;
            steps += 1;
        }

        // If the substep cap engaged, drop the backlog: the sim simply runs
        // slower than requested (simTime stays truthful — it only counts
        // executed steps).
        if (this._banked >= dt) this._banked = 0.0;
        return steps;
    }

    /** Restart the run clock for a NEW experiment. */
    resetClock() {
        this.simTime = 0.0;
        this._banked = 0.0;
    }
}
