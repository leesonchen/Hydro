import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EpisodeSnapshot } from '../packages/hydrooj/src/lib/practice-rating/store';
import { evaluateRetrospectiveQuality } from '../tools/practice-rating-quality';

const DAY = 86400000;
const scope = 'quality-fixture';

function snapshot(t0: number, uid: number, pid: number, y: 0 | 1, windowEnd = t0 + 7 * DAY, revision: string | null = null): EpisodeSnapshot {
    const key = `${uid}-${pid}-${revision ?? 'unknown'}-${t0}`;
    return {
        episode: { key, uid, pid, revision, t0, windowEnd, y },
        observation: { episodeKey: key, domainId: scope, uid, pid, revision, windowEnd, y },
    };
}

function fixture(holdoutY = [0, 1, 1, 0] as (0 | 1)[]) {
    const early = [
        [2, 10, 1], [2, 11, 0], [3, 11, 1], [3, 12, 1], [4, 12, 0], [4, 10, 1],
    ] as [number, number, 0 | 1][];
    const rows = early.map(([uid, pid, y], i) => snapshot(i * DAY, uid, pid, y));
    rows.push(snapshot(39 * DAY, 4, 14, 1, 46 * DAY));
    for (const [i, [uid, pid]] of [[2, 12], [3, 10], [5, 10], [4, 13]].entries()) {
        rows.push(snapshot(40 * DAY, uid, pid, holdoutY[i]));
    }
    return rows;
}

describe('retrospective practice rating quality', () => {
    it('purges crossing windows, keeps ties in holdout, and uses training baselines', () => {
        const rows = fixture();
        const before = structuredClone(rows);
        const result = evaluateRetrospectiveQuality(scope, rows);
        assert.deepEqual(rows, before);
        assert.equal(result.kind, 'retrospective-current-state-edge-holdout');
        assert.equal(result.splitAt, 40 * DAY);
        assert.equal(result.training, 6);
        assert.equal(result.purged, 1);
        assert.equal(result.holdout, 4);
        assert.equal(result.skipped.missingUser, 1);
        assert.equal(result.skipped.missingProblem, 1);
        assert.equal(result.skipped.componentMismatch, 0);
        assert.equal(result.skipped.unavailableFitValue, 0);
        assert.equal(result.metrics.samples, 2);
        assert.equal(result.metrics.overallBaselineBrier, 5 / 18);
        assert.equal(result.metrics.problemBaselineBrier, 1 / 8);
        assert.equal(result.scoredPositives, 1);
        assert.equal(result.scoredNegatives, 1);
        assert.equal(result.scoredProvisionalAny, 2);
        assert.equal(result.scoredEstimatedBoth, 0);
        assert.deepEqual(result.unknownRevision, { training: 6, holdout: 4, scored: 2 });
        assert.equal(result.training + result.purged + result.holdout, rows.length);
        assert.equal(result.metrics.samples + Object.values(result.skipped).reduce((sum, count) => sum + count, 0), result.holdout);
        assert.equal(result.scoredPositives + result.scoredNegatives, result.metrics.samples);
    });

    it('requires exact revisions and same training component', () => {
        const mismatch = [
            snapshot(0, 2, 10, 1), snapshot(0, 3, 11, 0), snapshot(8 * DAY, 2, 11, 1),
        ];
        const component = evaluateRetrospectiveQuality(scope, mismatch);
        assert.equal(component.training, 2);
        assert.equal(component.holdout, 1);
        assert.equal(component.skipped.componentMismatch, 1);

        const revision = [
            snapshot(0, 2, 10, 1, 7 * DAY, 'v1'), snapshot(0, 3, 10, 0, 7 * DAY, 'v1'),
            snapshot(8 * DAY, 2, 10, 1, 15 * DAY, 'v2'),
        ];
        const exact = evaluateRetrospectiveQuality(scope, revision);
        assert.equal(exact.skipped.missingProblem, 1);
        assert.equal(exact.metrics.samples, 0);
        assert.deepEqual(exact.unknownRevision, { training: 0, holdout: 0, scored: 0 });
    });

    it('returns null split and metrics for empty or tied timestamps', () => {
        const empty = evaluateRetrospectiveQuality(scope, []);
        assert.equal(empty.splitAt, null);
        assert.equal(empty.metrics.brier, null);
        assert.equal(empty.meanPredicted, null);
        assert.equal(empty.meanActual, null);

        const tied = evaluateRetrospectiveQuality(scope, [snapshot(10, 2, 10, 1), snapshot(10, 3, 11, 0)]);
        assert.equal(tied.training, 0);
        assert.equal(tied.holdout, 2);
        assert.equal(tied.metrics.brier, null);
        assert.equal(tied.skipped.unavailableFitValue, 2);
    });

    it('does not let holdout outcomes change the fit or training baselines', () => {
        const first = evaluateRetrospectiveQuality(scope, fixture([0, 1, 1, 0]));
        const second = evaluateRetrospectiveQuality(scope, fixture([1, 0, 0, 1]));
        assert.equal(first.meanPredicted, second.meanPredicted);
        assert.deepEqual(first.metrics.bins.map((bin) => bin.predicted), second.metrics.bins.map((bin) => bin.predicted));
        assert.equal(first.trainingProvisional.users, second.trainingProvisional.users);
        assert.equal(first.trainingProvisional.problems, second.trainingProvisional.problems);
        assert.equal(second.metrics.overallBaselineBrier, 5 / 18);
        assert.equal(second.metrics.problemBaselineBrier, 5 / 8);
    });
});
