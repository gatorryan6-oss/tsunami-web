// The wavemaker: a tsunami that enters the map from OUTSIDE it.
//
// Direct port of the desktop core/sources/wavemaker.py (pinned by the
// desktop tests/test_wavemaker.py). The incident signal is a
// sin^2-enveloped wave train,
//
//     eta_inc(t) = A' * sin(2*pi*tau/T) * sin(pi*tau/(nT))^2,  tau = t - t0
//
// active only for 0 <= tau <= n*T. Exactly zero mean over the window (no
// net volume through the boundary), smooth ramp at both ends (no startup
// shock), and A' peak-normalized so the train tops out at the requested
// amplitude. SIGNED amplitude: > 0 leads with a crest, < 0 with a drawback.
// t_start_s is on the SOLVER's clock.

export class WavemakerSpec {
    // A real tsunami train is a handful of waves; the cap is also a
    // numerical guard on the fixed-resolution peak scan below (desktop
    // review-caught aliasing at absurd n).
    static MAX_WAVES = 64;

    constructor(amplitudeM, periodS, nWaves = 1, tStartS = 0.0) {
        if (!Number.isFinite(amplitudeM)) {
            throw new Error("wavemaker amplitude must be finite");
        }
        if (!(periodS > 0.0 && Number.isFinite(periodS))) {
            throw new Error("wavemaker period must be finite and > 0");
        }
        if (!Number.isInteger(nWaves) || nWaves < 1
                || nWaves > WavemakerSpec.MAX_WAVES) {
            throw new Error(
                `n_waves must be a whole number in 1..${WavemakerSpec.MAX_WAVES}`);
        }
        if (!(tStartS >= 0.0 && Number.isFinite(tStartS))) {
            throw new Error("t_start_s must be finite and >= 0");
        }
        this.amplitudeM = amplitudeM;
        this.periodS = periodS;
        this.nWaves = nWaves;
        this.tStartS = tStartS;

        // Peak of sin(2*pi*x*n) * sin(pi*x)^2 on x in [0,1] (x = tau/nT).
        // 4097 samples pin it to ~1e-7 — far below solver truncation.
        // (Same scan as the desktop's numpy linspace(0, 1, 4097).)
        let peak = 0.0;
        for (let k = 0; k <= 4096; k++) {
            const x = k / 4096;
            const env = Math.sin(Math.PI * x);
            const v = Math.abs(Math.sin(2.0 * Math.PI * x * nWaves) * env * env);
            if (v > peak) peak = v;
        }
        this._norm = 1.0 / peak;
    }

    get tEndS() {
        return this.tStartS + this.nWaves * this.periodS;
    }

    // Is the boundary in wavemaker form at solver time t? Outside the
    // window the solver runs its EXACT legacy open-edge path.
    active(t) {
        return this.tStartS < t && t < this.tEndS;
    }

    // Incident surface elevation (m) at the west edge at time t.
    eta(t) {
        const tau = t - this.tStartS;
        const dur = this.nWaves * this.periodS;
        if (tau <= 0.0 || tau >= dur) return 0.0;
        const env = Math.sin(Math.PI * tau / dur);
        return this.amplitudeM * this._norm
            * Math.sin(2.0 * Math.PI * tau / this.periodS) * env * env;
    }
}
