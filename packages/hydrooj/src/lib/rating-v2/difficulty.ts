// hydro-fixed-1pl-v1: fixed-slope 1PL difficulty estimation with a normal prior.
// Pure computation: no database access.

const LOG10_DIV_400 = Math.log(10) / 400;

export interface Observation {
    /** Pre-contest internal ability of the student. */
    mu: number;
    /** 1 = full-score solve under the contest's final scoring rule, 0 otherwise. */
    solved: boolean;
}

export interface DifficultyFit {
    d: number;
    se: number | null;
    iterations: number;
    converged: boolean;
    /**
     * 'degenerate': all-solved or all-unsolved; a point estimate must not be published.
     * 'nonconverged': Newton did not settle (often reverse association or near-flat
     * likelihood); d is kept for diagnostics only and se is withheld. Found by the
     * 2026-09-19 spot check (e.g. pid 239 diverged to -10934).
     */
    status: 'ok' | 'degenerate' | 'nonconverged';
}

export interface FitOptions {
    priorMean?: number;
    priorSd?: number;
    maxIterations?: number;
}

/**
 * MAP estimate of D for logistic p(solved | mu, D) with fixed slope a = ln(10)/400:
 *   maximize sum[y log p + (1-y) log(1-p)] - (D - priorMean)^2 / (2 priorSd^2)
 * Newton-Raphson on the one-dimensional objective; Hessian is negative definite.
 */
export function fitDifficulty(obs: Observation[], opts: FitOptions = {}): DifficultyFit {
    const priorMean = opts.priorMean ?? 1500;
    const priorSd = opts.priorSd ?? 600;
    const maxIterations = opts.maxIterations ?? 100;
    const a = LOG10_DIV_400;
    if (!obs.length) return { d: priorMean, se: null, iterations: 0, converged: true, status: 'degenerate' };
    const anyUnsolved = obs.some((o) => !o.solved);
    const anySolved = obs.some((o) => o.solved);
    if (!anyUnsolved || !anySolved) {
        // Prior keeps the estimate finite, but publishing a normal point value is forbidden.
        return { d: priorMean, se: null, iterations: 0, converged: true, status: 'degenerate' };
    }
    let d = priorMean;
    let converged = false;
    let iterations = 0;
    // Damped Newton: raw Newton steps can overshoot when every p(1-p) is near zero
    // at the current point (the pid-239 divergence found by the 2026-09-19 spot
    // check). Bounding the step keeps the walk inside the data region; the prior
    // gradient then pulls the iterate to the MAP.
    const maxStep = priorSd;
    for (let i = 0; i < maxIterations; i++) {
        iterations = i + 1;
        let grad = -(d - priorMean) / (priorSd * priorSd);
        let hess = -1 / (priorSd * priorSd);
        for (const o of obs) {
            const p = 1 / (1 + Math.exp(-a * (o.mu - d)));
            grad += a * (p - (o.solved ? 1 : 0));
            hess -= a * a * p * (1 - p);
        }
        if (!Number.isFinite(grad) || !Number.isFinite(hess)) return { d, se: null, iterations, converged: false, status: 'nonconverged' };
        let step = grad / hess;
        if (!Number.isFinite(step)) return { d, se: null, iterations, converged: false, status: 'nonconverged' };
        if (step > maxStep) step = maxStep;
        if (step < -maxStep) step = -maxStep;
        d -= step;
        if (Math.abs(step) < 1e-6) {
            converged = true;
            break;
        }
    }
    if (!converged) {
        // Do not attach a standard error to a diverged estimate: it would fake precision.
        return { d, se: null, iterations, converged: false, status: 'nonconverged' };
    }
    let info = 1 / (priorSd * priorSd);
    for (const o of obs) {
        const p = 1 / (1 + Math.exp(-a * (o.mu - d)));
        info += a * a * p * (1 - p);
    }
    const se = Math.sqrt(1 / info);
    return { d, se, iterations, converged: true, status: 'ok' };
}

/** Conditional standard error given pre-contest abilities and the model assumptions (plan §8.4). */
export function conditionalStandardError(obs: Observation[], d: number, priorSd = 600): number {
    const a = LOG10_DIV_400;
    let info = 1 / (priorSd * priorSd);
    for (const o of obs) {
        const p = 1 / (1 + Math.exp(-a * (o.mu - d)));
        info += a * a * p * (1 - p);
    }
    return Math.sqrt(1 / info);
}
