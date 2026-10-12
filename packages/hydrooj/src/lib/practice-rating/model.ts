import { TrainingObservation } from './episodes';

export const MODEL_VERSION = 'practice-rating-1pl-v1';
export const MODEL_PARAMETERS = Object.freeze({
    priorMean: 1500, priorSd: 600, slope: Math.log(10) / 400,
    maxIterations: 300, tolerance: 1e-5, minimumUserSamples: 10, minimumProblemSamples: 20,
});

export interface Estimate {
    value: number | null;
    status: 'provisional' | 'estimated' | 'numerical_failure';
    samples: number;
    successes: number;
    conditionalSe: number | null;
    component: string;
}

export interface UserEstimate extends Estimate { uid: number }
export interface ProblemEstimate extends Estimate { pid: number, revision: string | null }
export interface JointFit {
    scope: string;
    modelVersion: string;
    parameters: typeof MODEL_PARAMETERS;
    status: 'ok' | 'insufficient' | 'numerical_failure';
    iterations: number;
    objective: number;
    components: number;
    users: UserEstimate[];
    problems: ProblemEstimate[];
}

export const problemKey = (pid: number, revision: string | null) => JSON.stringify([pid, revision]);

export function completionProbability(r: number, d: number) {
    if (!Number.isFinite(r) || !Number.isFinite(d)) throw new RangeError('Scores must be finite');
    const z = MODEL_PARAMETERS.slope * (r - d);
    return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/** Joint MAP fit from scratch. No previous posterior is used as a prior. */
export function fitPracticeRating(
    input: readonly TrainingObservation[], scope: string, maxIterations: number = MODEL_PARAMETERS.maxIterations,
): JointFit {
    if (!scope || !Number.isSafeInteger(maxIterations) || maxIterations < 1) throw new RangeError('Invalid fit scope or iteration limit');
    const seen = new Set<string>();
    const rows = [...input].sort((a, b) => a.uid - b.uid || (problemKey(a.pid, a.revision) < problemKey(b.pid, b.revision) ? -1 : 1));
    for (const row of rows) {
        const key = JSON.stringify([row.uid, row.pid, row.revision]);
        if (row.domainId !== scope || !Number.isSafeInteger(row.uid) || row.uid <= 0
            || !Number.isSafeInteger(row.pid) || row.pid <= 0 || ![0, 1].includes(row.y)
            || !Number.isSafeInteger(row.windowEnd) || row.windowEnd < 0
            || (row.revision !== null && (typeof row.revision !== 'string' || !row.revision)) || seen.has(key)) {
            throw new RangeError('Invalid, duplicate or cross-domain training observation');
        }
        seen.add(key);
    }
    const uids = [...new Set(rows.map((r) => r.uid))].sort((a, b) => a - b);
    const keys = [...new Set(rows.map((r) => problemKey(r.pid, r.revision)))].sort();
    const ui = new Map(uids.map((uid, i) => [uid, i]));
    const pi = new Map(keys.map((key, i) => [key, i]));
    const byUser = uids.map(() => [] as { other: number, y: number }[]);
    const byProblem = keys.map(() => [] as { other: number, y: number }[]);
    const parent = Array.from({ length: uids.length + keys.length }, (_, i) => i);
    const root = (index: number): number => {
        let i = index;
        while (parent[i] !== i) i = parent[i];
        while (parent[index] !== index) {
            const next = parent[index];
            parent[index] = i;
            index = next;
        }
        return i;
    };
    for (const row of rows) {
        const u = ui.get(row.uid);
        const p = pi.get(problemKey(row.pid, row.revision));
        byUser[u].push({ other: p, y: row.y });
        byProblem[p].push({ other: u, y: row.y });
        const a = root(u);
        const b = root(uids.length + p);
        parent[Math.max(a, b)] = Math.min(a, b);
    }
    const roots = [...new Set(parent.map((_, i) => root(i)))];
    const componentSizes = new Map(roots.map((r) => [r, { users: 0, problems: 0 }]));
    for (let i = 0; i < parent.length; i++) {
        const size = componentSizes.get(root(i));
        if (i < uids.length) size.users++;
        else size.problems++;
    }
    const { priorMean, priorSd, slope: a } = MODEL_PARAMETERS;
    const precision = 1 / priorSd ** 2;
    const r: number[] = uids.map(() => priorMean);
    const d: number[] = keys.map(() => priorMean);
    // Each conditional objective is strictly convex. Safeguarded Newton stays
    // inside a bracket derived from the bounded likelihood gradient and prior.
    const optimize = (current: number, observations: { other: number, y: number }[], others: number[], user: boolean) => {
        const bound = a * observations.length / precision;
        let low = priorMean - bound;
        let high = priorMean + bound;
        let x = current;
        for (let i = 0; i < 60; i++) {
            let gradient = precision * (x - priorMean);
            let information = precision;
            for (const o of observations) {
                const p = user ? completionProbability(x, others[o.other]) : completionProbability(others[o.other], x);
                gradient += (user ? 1 : -1) * a * (p - o.y);
                information += a * a * p * (1 - p);
            }
            if (Math.abs(gradient) < 1e-10) break;
            if (gradient < 0) low = x;
            else high = x;
            const next = x - gradient / information;
            const candidate = next > low && next < high ? next : (low + high) / 2;
            if (Math.abs(candidate - x) < 1e-7) break;
            x = candidate;
        }
        return x;
    };
    let converged = !rows.length;
    let iterations = 0;
    for (; rows.length && iterations < maxIterations;) {
        iterations++;
        const previous = [...r, ...d];
        for (let i = 0; i < r.length; i++) {
            r[i] = optimize(r[i], byUser[i], d, true);
        }
        for (let i = 0; i < d.length; i++) {
            d[i] = optimize(d[i], byProblem[i], r, false);
        }
        // A common shift leaves the likelihood unchanged. Minimize the prior
        // exactly along that direction in each component to avoid slow drift.
        const shifts = new Map(roots.map((component) => [component, 0]));
        for (let i = 0; i < previous.length; i++) {
            const component = root(i);
            shifts.set(component, shifts.get(component) + (i < r.length ? r[i] : d[i - r.length]) - priorMean);
        }
        for (let i = 0; i < previous.length; i++) {
            const size = componentSizes.get(root(i));
            const shift = shifts.get(root(i)) / (size.users + size.problems);
            if (i < r.length) r[i] -= shift;
            else d[i - r.length] -= shift;
        }
        const change = [...r, ...d].reduce((largest, x, i) => Math.max(largest, Math.abs(x - previous[i])), 0);
        if (change < MODEL_PARAMETERS.tolerance) {
            converged = true;
            break;
        }
    }
    let objective = [...r, ...d].reduce((sum, x) => sum + precision * (x - priorMean) ** 2 / 2, 0);
    for (const row of rows) {
        const z = a * (r[ui.get(row.uid)] - d[pi.get(problemKey(row.pid, row.revision))]);
        objective += Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z))) - row.y * z;
    }
    converged &&= Number.isFinite(objective) && [...r, ...d].every(Number.isFinite);
    const estimate = (index: number, observations: { other: number, y: number }[], user: boolean): Estimate => {
        const own = user ? r : d;
        const others = user ? d : r;
        const component = root(user ? index : uids.length + index);
        const size = componentSizes.get(component);
        const successes = observations.reduce((sum, o) => sum + o.y, 0);
        const samples = observations.length;
        const information = observations.reduce((sum, o) => {
            const p = user ? completionProbability(own[index], others[o.other]) : completionProbability(others[o.other], own[index]);
            return sum + a * a * p * (1 - p);
        }, precision);
        return {
            value: converged ? own[index] : null,
            status: !converged ? 'numerical_failure'
                : samples >= (user ? MODEL_PARAMETERS.minimumUserSamples : MODEL_PARAMETERS.minimumProblemSamples)
                    && successes > 0 && successes < samples && size.users >= 2 && size.problems >= 2
                    ? 'estimated' : 'provisional',
            samples,
            successes,
            conditionalSe: converged ? Math.sqrt(1 / information) : null,
            component: `component-${component}`,
        };
    };
    return {
        scope, modelVersion: MODEL_VERSION, parameters: MODEL_PARAMETERS,
        status: !rows.length ? 'insufficient' : converged ? 'ok' : 'numerical_failure',
        iterations, objective, components: roots.length,
        users: uids.map((uid, i) => ({ uid, ...estimate(i, byUser[i], true) })),
        problems: keys.map((key, i) => {
            const [pid, revision] = JSON.parse(key);
            return { pid, revision, ...estimate(i, byProblem[i], false) };
        }),
    };
}
