// Prediction-layer calibration for solve probabilities. Pure computation.
//
// The spot check (2026-09-19) showed the fixed-slope logistic is slightly
// overconfident at the extremes (mu far from D). A single global slope
// multiplier k on the log-odds, fitted once per replay, flattens the tails
// while keeping every 50% point (mu = D) exactly where the model put it:
//   p_calibrated(mu, D) = sigmoid(k * a * (mu - D)),  a = ln(10)/400.
// k applies uniformly to all (mu, D) pairs, so ability ratings and difficulty
// scores remain on one shared, self-consistent scale.

const LOG10_DIV_400 = Math.log(10) / 400;

export interface CalibrationObservation {
    mu: number;
    d: number;
    solved: boolean;
}

export interface CalibrationFit {
    /** Multiplier on the standard log-odds; 1 = uncalibrated. */
    slope: number;
    iterations: number;
    converged: boolean;
    /** Observations actually used (finite mu/d). */
    used: number;
}

export function rawLogOdds(mu: number, d: number): number {
    return LOG10_DIV_400 * (mu - d);
}

/** Uncalibrated model probability. */
export function rawProbability(mu: number, d: number): number {
    return 1 / (1 + Math.exp(-rawLogOdds(mu, d)));
}

/** Calibrated probability; slope comes from fitSolveCalibration (default 1). */
export function calibratedProbability(mu: number, d: number, slope = 1): number {
    const z = rawLogOdds(mu, d) * slope;
    if (z > 40) return 1;
    if (z < -40) return 0;
    return 1 / (1 + Math.exp(-z));
}

/**
 * Fit the single slope multiplier by Newton on log-loss, slope constrained to
 * (0, 5]. Independent prediction validation requires the caller to also fit
 * ability and difficulty without the evaluation labels; splitting only this
 * slope fit yields conditional calibration diagnostics.
 */
export function fitSolveCalibration(obs: CalibrationObservation[], opts: { maxSlope?: number, maxIterations?: number } = {}): CalibrationFit {
    const maxSlope = opts.maxSlope ?? 5;
    const maxIterations = opts.maxIterations ?? 50;
    const clean = obs.filter((o) => Number.isFinite(o.mu) && Number.isFinite(o.d));
    if (clean.length < 30) return { slope: 1, iterations: 0, converged: true, used: clean.length };
    let k = 1;
    let converged = false;
    let iterations = 0;
    for (let i = 0; i < maxIterations; i++) {
        iterations = i + 1;
        let grad = 0;
        let hess = 0;
        for (const o of clean) {
            const z = rawLogOdds(o.mu, o.d);
            const p = 1 / (1 + Math.exp(-Math.max(-40, Math.min(40, k * z))));
            const y = o.solved ? 1 : 0;
            grad += z * (p - y);
            hess += z * z * p * (1 - p);
        }
        if (!Number.isFinite(grad) || !Number.isFinite(hess) || hess <= 0) {
            return { slope: k, iterations, converged: false, used: clean.length };
        }
        let step = grad / hess;
        // trust region: the optimum is near 1 for a sane model
        if (step > 0.5) step = 0.5;
        if (step < -0.5) step = -0.5;
        k -= step;
        if (k < 0.05) k = 0.05;
        if (k > maxSlope) k = maxSlope;
        if (Math.abs(step) < 1e-6) {
            converged = true;
            break;
        }
    }
    return { slope: k, iterations, converged, used: clean.length };
}

export interface CalibrationReport {
    n: number;
    brier: number;
    logLoss: number;
    /** Mean absolute bucket deviation, for the buckets used by the spot check. */
    meanAbsDeviation: number;
    buckets: { label: string, n: number, expected: number, actual: number }[];
}

const BUCKET_BOUNDS = [-400, -200, -100, 0, 100, 200, 400];
const BUCKET_LABELS = ['<-400', '-400~-200', '-200~-100', '-100~0', '0~100', '100~200', '200~400', '>=400'];

/** Evaluate (un)calibrated probabilities over the fixed spot-check buckets. */
export function evaluateCalibration(obs: CalibrationObservation[], slope: number): CalibrationReport {
    const buckets = BUCKET_LABELS.map((label) => ({ label, n: 0, exp: 0, act: 0, expected: 0, actual: 0 }));
    let brier = 0;
    let logLoss = 0;
    let used = 0;
    for (const o of obs) {
        if (!Number.isFinite(o.mu) || !Number.isFinite(o.d)) continue;
        const p = calibratedProbability(o.mu, o.d, slope);
        const y = o.solved ? 1 : 0;
        brier += (p - y) * (p - y);
        logLoss -= y * Math.log(Math.max(1e-12, p)) + (1 - y) * Math.log(Math.max(1e-12, 1 - p));
        used++;
        const diff = o.mu - o.d;
        let idx = BUCKET_BOUNDS.findIndex((b) => diff < b);
        if (idx === -1) idx = buckets.length - 1;
        const b = buckets[idx];
        b.n++;
        b.exp += p;
        b.act += y;
    }
    let mad = 0;
    let madN = 0;
    for (const b of buckets) {
        if (b.n === 0) continue;
        b.expected = b.exp / b.n;
        b.actual = b.act / b.n;
        mad += Math.abs(b.expected - b.actual);
        madN++;
    }
    return {
        n: used,
        brier: used ? brier / used : 0,
        logLoss: used ? logLoss / used : 0,
        meanAbsDeviation: madN ? mad / madN : 0,
        buckets: buckets.map(({ label, n, expected, actual }) => ({ label, n, expected, actual })),
    };
}
