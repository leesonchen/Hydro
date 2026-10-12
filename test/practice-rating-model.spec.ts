import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TrainingObservation } from '../packages/hydrooj/src/lib/practice-rating/episodes';
import { completionProbability, fitPracticeRating, MODEL_PARAMETERS } from '../packages/hydrooj/src/lib/practice-rating/model';
import { fitPracticeRatingAsync } from '../packages/hydrooj/src/lib/practice-rating/runner';

const row = (uid: number, pid: number, y: 0 | 1, domainId = 'fixture'): TrainingObservation => ({
    domainId, uid, pid, y, episodeKey: `${uid}/${pid}`, windowEnd: 1000, revision: null,
});

describe('practice rating joint 1PL', () => {
    it('has the specified probability semantics and handles extreme scores', () => {
        assert.equal(completionProbability(1500, 1500), 0.5);
        assert.ok(Math.abs(completionProbability(1900, 1500) - 10 / 11) < 1e-14);
        assert.ok(Math.abs(completionProbability(1100, 1500) - 1 / 11) < 1e-14);
        assert.equal(completionProbability(1e100, 0), 1);
        assert.equal(completionProbability(-1e100, 0), 0);
        assert.throws(() => completionProbability(NaN, 1500), RangeError);
    });

    it('T11: empty data have no invented 1500 or zero estimates', () => {
        const fit = fitPracticeRating([], 'fixture');
        assert.equal(fit.status, 'insufficient');
        assert.deepEqual(fit.users, []);
        assert.deepEqual(fit.problems, []);
        assert.equal(fit.objective, 0);
    });

    it('T11: all success/failure are finite prior-dependent provisional estimates', () => {
        for (const y of [0, 1] as const) {
            const rows = Array.from({ length: 30 }, (_, u) => Array.from({ length: 20 }, (__, p) => row(u + 1, p + 1, y))).flat();
            const fit = fitPracticeRating(rows, 'fixture');
            assert.equal(fit.status, 'ok');
            assert.ok([...fit.users, ...fit.problems].every((e) => e.status === 'provisional' && Number.isFinite(e.value)));
            assert.ok(Number.isFinite(fit.objective));
            assert.ok((fit.users[0].value - fit.problems[0].value) * (y === 1 ? 1 : -1) > 0);
        }
    });

    it('estimates stronger users higher and harder problems higher within one graph', () => {
        const fit = fitPracticeRating([row(1, 1, 1), row(1, 2, 1), row(2, 1, 1), row(2, 2, 0)], 'fixture');
        assert.equal(fit.status, 'ok');
        assert.ok(fit.users[0].value > fit.users[1].value);
        assert.ok(fit.problems[1].value > fit.problems[0].value);
        const estimates = [...fit.users, ...fit.problems];
        assert.ok(Math.abs(estimates.reduce((sum, e) => sum + e.value, 0) / estimates.length - 1500) < 1e-8);
        assert.ok(estimates.every((e) => e.status === 'provisional' && e.conditionalSe > 0));
    });

    it('T12: input permutation and repeated fitting do not accumulate evidence', () => {
        const rows = Array.from({ length: 30 }, (_, u) => Array.from({ length: 20 }, (__, p) => row(u + 1, p + 1, (u + p) % 3 ? 1 : 0))).flat();
        const before = structuredClone(rows);
        const fit = fitPracticeRating(rows, 'fixture');
        assert.equal(fit.status, 'ok');
        assert.ok(fit.users.every((e) => e.status === 'estimated'));
        assert.deepEqual(fit, fitPracticeRating([...rows].reverse(), 'fixture'));
        assert.deepEqual(fit, fitPracticeRating(rows, 'fixture'));
        assert.deepEqual(rows, before);
    });

    it('reports disconnected components and keeps versions distinct', () => {
        const fit = fitPracticeRating([row(1, 1, 1), { ...row(2, 1, 0), revision: 'v2' }], 'fixture');
        assert.equal(fit.components, 2);
        assert.notEqual(fit.users[0].component, fit.users[1].component);
        assert.equal(fit.problems.length, 2);
    });

    it('rejects duplicate user/problem pairs, mixed scopes and invalid binary inputs', () => {
        assert.throws(() => fitPracticeRating([row(1, 1, 1), { ...row(1, 1, 0), episodeKey: 'different-id' }], 'fixture'), RangeError);
        assert.throws(() => fitPracticeRating([row(1, 1, 1, 'other')], 'fixture'), RangeError);
        assert.throws(() => fitPracticeRating([{ ...row(1, 1, 1), y: NaN as any }], 'fixture'), RangeError);
    });

    it('nonconvergence withholds usable scores and standard errors', () => {
        const fit = fitPracticeRating([row(1, 1, 1), row(1, 2, 1), row(2, 1, 1), row(2, 2, 0)], 'fixture', 1);
        assert.equal(fit.status, 'numerical_failure');
        assert.ok([...fit.users, ...fit.problems].every((e) => e.value === null && e.conditionalSe === null));
    });

    it('agrees with an independent simultaneous dense Newton reference', () => {
        const rows = [row(1, 1, 1), row(1, 2, 1), row(2, 1, 1), row(2, 2, 0)];
        const fit = fitPracticeRating(rows, 'fixture');
        const { slope: a, priorSd } = MODEL_PARAMETERS;
        const x = [1500, 1500, 1500, 1500];
        for (let iteration = 0; iteration < 30; iteration++) {
            const gradient = x.map((v) => (v - 1500) / priorSd ** 2);
            const hessian = x.map((_, i) => x.map((__, j) => i === j ? 1 / priorSd ** 2 : 0));
            for (const o of rows) {
                const u = o.uid - 1;
                const p = o.pid + 1;
                const probability = 1 / (1 + Math.exp(-a * (x[u] - x[p])));
                const g = a * (probability - o.y);
                const h = a * a * probability * (1 - probability);
                gradient[u] += g;
                gradient[p] -= g;
                hessian[u][u] += h;
                hessian[p][p] += h;
                hessian[u][p] -= h;
                hessian[p][u] -= h;
            }
            // Gaussian elimination of the complete joint Hessian (not alternating fits).
            const matrix = hessian.map((r, i) => [...r, gradient[i]]);
            for (let i = 0; i < x.length; i++) {
                const pivot = matrix[i][i];
                for (let j = i; j <= x.length; j++) matrix[i][j] /= pivot;
                for (let k = 0; k < x.length; k++) {
                    if (k === i) continue;
                    const factor = matrix[k][i];
                    for (let j = i; j <= x.length; j++) matrix[k][j] -= factor * matrix[i][j];
                }
            }
            for (let i = 0; i < x.length; i++) x[i] -= matrix[i][x.length];
        }
        const actual = [...fit.users, ...fit.problems].map((e) => e.value);
        for (const [i, v] of actual.entries()) assert.ok(Math.abs(v - x[i]) < 1e-4, `${v} vs ${x[i]}`);
    });

    it('fits off-thread with the same results and propagates worker failures', async () => {
        const rows = [row(1, 1, 1), row(1, 2, 0), row(2, 1, 1), row(2, 2, 1)];
        let callbackRan = false;
        setImmediate(() => { callbackRan = true; });
        assert.deepEqual(await fitPracticeRatingAsync(rows, 'fixture'), fitPracticeRating(rows, 'fixture'));
        assert.equal(callbackRan, true);
        await assert.rejects(fitPracticeRatingAsync([row(1, 1, 1, 'wrong-scope')], 'fixture'), /cross-domain/);
    });
});
