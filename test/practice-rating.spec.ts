import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STATUS } from '@hydrooj/common/status';
import legacyDifficulty from '../packages/hydrooj/src/lib/difficulty';
import {
    ActivityMetadata, EPISODE_WINDOW_MS, extractPracticeEpisodes, PracticeSubmission, RECENT_WINDOW_MS,
} from '../packages/hydrooj/src/lib/practice-rating/episodes';

// Synthetic IDs and times; no production accounts, code or private activity data.
const BASE = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
const at = (day: number) => BASE + day * DAY;
const AC = STATUS.STATUS_ACCEPTED;
const WA = STATUS.STATUS_WRONG_ANSWER;
const id = (n: number) => (n + 100).toString(16).padStart(24, '0');
const metadata = (revision: string) => ({ knownAt: BASE - 1, revision });

function submission(n: number, day: number, status = WA, extra: Partial<PracticeSubmission> = {}): PracticeSubmission {
    return {
        id: id(n), domainId: 'fixture-domain', pid: 100, uid: 1,
        submittedAt: at(day), status, judgeAt: at(day) + 1000, ...extra,
    };
}

function labels(records: readonly PracticeSubmission[], asOf = at(10)) {
    return extractPracticeEpisodes(records, asOf).observations.map((o) => o.y);
}

describe('practice-rating M0: existing pure difficulty baseline', () => {
    it('preserves zero-submission and all-accepted examples', () => {
        assert.equal(legacyDifficulty(0, 0), null);
        assert.equal(legacyDifficulty(100, 0), 10);
        assert.equal(legacyDifficulty(100, 100), 1);
    });
});

describe('practice-rating M1: seven-day episodes (T01–T10)', () => {
    it('T01: 19 WA then AC create one positive observation', () => {
        const records = Array.from({ length: 19 }, (_, n) => submission(n, n / 10));
        records.push(submission(19, 6, AC));
        const result = extractPracticeEpisodes(records, at(10));
        assert.equal(result.episodes.length, 1);
        assert.deepEqual(result.observations.map((o) => o.y), [1]);
        assert.equal(result.episodes[0].recordIds.length, 20);
    });

    it('T02: repeated AC and reopening a task never restart the episode', () => {
        const records = Array.from({ length: 20 }, (_, n) => submission(n, n / 10, AC));
        records.push(submission(20, 20, AC), submission(21, 30, AC));
        const result = extractPracticeEpisodes(records, at(40));
        assert.equal(result.episodes.length, 1);
        assert.equal(result.episodes[0].t0, BASE);
        assert.deepEqual(result.observations.map((o) => o.y), [1]);
    });

    it('T03: AC at or after the exclusive endpoint does not change the label', () => {
        assert.deepEqual(labels([submission(1, 0), submission(2, 7, AC), submission(3, 8, AC)]), [0]);
        assert.deepEqual(labels([submission(1, 0), submission(2, 7 - 1 / DAY, AC)]), [1]);
    });

    it('T04: an expired window with a pending submission is not a failure', () => {
        for (const status of [STATUS.STATUS_WAITING, STATUS.STATUS_FETCHED, STATUS.STATUS_COMPILING, STATUS.STATUS_JUDGING]) {
            const result = extractPracticeEpisodes([
                submission(1, 0), submission(2, 6, status, { judgeAt: null }),
            ], at(10));
            assert.deepEqual(result.observations, []);
            assert.equal(result.episodes[0].state, 'pending');
            assert.equal(result.diagnostics.pendingEpisodes, 1);
        }
    });

    it('T05: no submissions create no episodes or negatives', () => {
        assert.deepEqual(extractPracticeEpisodes([], at(10)).episodes, []);
        assert.deepEqual(labels([]), []);
    });

    it('T06: course, homework and practice share one episode with source references', () => {
        const activities: ActivityMetadata[] = [
            { domainId: 'fixture-domain', id: 'course-1', rule: 'course', knownAt: BASE - 1 },
            { domainId: 'fixture-domain', id: 'homework-1', rule: 'homework', knownAt: BASE - 1 },
        ];
        const result = extractPracticeEpisodes([
            submission(1, 0, WA, { contest: 'course-1' }),
            submission(2, 1, WA, { contest: 'homework-1' }),
            submission(3, 2, AC, { contest: null }),
        ], at(10), activities);
        assert.deepEqual(result.observations.map((o) => o.y), [1]);
        assert.deepEqual(result.episodes[0].sources, [
            { kind: 'COURSE', activityId: 'course-1' },
            { kind: 'HOMEWORK', activityId: 'homework-1' },
            { kind: 'FREE_PRACTICE', activityId: null },
        ]);
    });

    it('T07: contest metadata alone cannot create failures for untouched problems or members', () => {
        const activities = [{ domainId: 'fixture-domain', id: 'team-contest', rule: 'oi', knownAt: BASE - 1 }];
        assert.deepEqual(extractPracticeEpisodes([], at(10), activities).observations, []);
        const result = extractPracticeEpisodes([submission(1, 0, WA, { contest: 'team-contest', uid: 2 })], at(10), activities);
        assert.deepEqual(result.observations.map((o) => [o.uid, o.pid, o.y]), [[2, 100, 0]]);
    });

    it('T08: contest WA and post-contest AC three days later count as practice success', () => {
        const records = [
            submission(1, 0, WA, { contest: 'contest-1' }),
            submission(2, 3, AC, { practiceContest: 'contest-1' }),
        ];
        const before = structuredClone(records);
        const result = extractPracticeEpisodes(records, at(10), [
            { domainId: 'fixture-domain', id: 'contest-1', rule: 'oi', knownAt: BASE - 1 },
        ]);
        assert.deepEqual(result.observations.map((o) => o.y), [1]);
        assert.deepEqual(result.episodes[0].sources, [
            { kind: 'CONTEST', activityId: 'contest-1' },
            { kind: 'POST_CONTEST_PRACTICE', activityId: 'contest-1' },
        ]);
        assert.deepEqual(records, before);
    });

    it('T09: identical pid and uid in different domains remain separate', () => {
        const result = extractPracticeEpisodes([
            submission(1, 0, AC, { domainId: 'domain-a' }),
            submission(2, 0, WA, { domainId: 'domain-b' }),
        ], at(10));
        assert.deepEqual(result.observations.map((o) => [o.domainId, o.y]), [['domain-a', 1], ['domain-b', 0]]);
        assert.equal(new Set(result.episodes.map((e) => e.key)).size, 2);
    });

    it('T10: current rejudge changes a new extraction without mutating frozen results', () => {
        const record = submission(1, 0, AC);
        const frozen = extractPracticeEpisodes([record], at(10));
        record.status = WA;
        record.judgeAt = at(9);
        assert.deepEqual(labels([record]), [0]);
        assert.deepEqual(frozen.observations.map((o) => o.y), [1]);
        record.judgeAt = at(11);
        assert.deepEqual(labels([record]), []);
        assert.equal(extractPracticeEpisodes([record], at(10)).episodes[0].state, 'pending');
    });
});

describe('practice-rating M1: maturity, revisions, exclusions and cutoff', () => {
    it('waits for the full window even if the first submission is AC', () => {
        for (const status of [AC, WA]) {
            const result = extractPracticeEpisodes([submission(1, 0, status)], at(7) - 1);
            assert.deepEqual(result.observations, []);
            assert.equal(result.episodes[0].state, 'open');
            assert.equal(result.diagnostics.openEpisodes, 1);
        }
        assert.deepEqual(labels([submission(1, 0, AC)], at(7)), [1]);
    });

    it('waits for pending judgements even when another in-window submission is AC', () => {
        assert.deepEqual(labels([
            submission(1, 0, AC), submission(2, 6, STATUS.STATUS_JUDGING, { judgeAt: null }),
        ]), []);
    });

    it('does not let out-of-window pending submissions block a mature episode', () => {
        assert.deepEqual(labels([
            submission(1, 0), submission(2, 7, STATUS.STATUS_WAITING, { judgeAt: null }),
        ]), [0]);
    });

    it('system faults and unjudgeable results alone are missing, never negatives', () => {
        for (const status of [STATUS.STATUS_SYSTEM_ERROR, STATUS.STATUS_ETC, STATUS.STATUS_HACKED]) {
            const result = extractPracticeEpisodes([submission(1, 0, status)], at(10));
            assert.equal(result.episodes[0].state, 'missing');
            assert.equal(result.diagnostics.missingEpisodes, 1);
            assert.deepEqual(result.observations, []);
        }
        assert.deepEqual(labels([submission(1, 0, STATUS.STATUS_SYSTEM_ERROR), submission(2, 1, WA)]), [0]);
    });

    it('uses normal CE/WA/TLE/MLE/OLE/RE as failure evidence, independent of score', () => {
        for (const status of [WA, STATUS.STATUS_COMPILE_ERROR, STATUS.STATUS_TIME_LIMIT_EXCEEDED,
            STATUS.STATUS_MEMORY_LIMIT_EXCEEDED, STATUS.STATUS_OUTPUT_LIMIT_EXCEEDED, STATUS.STATUS_RUNTIME_ERROR]) {
            assert.deepEqual(labels([submission(1, 0, status)]), [0]);
        }
    });

    it('does not use a result before its known time or invent one without judgeAt', () => {
        for (const status of [AC, WA]) {
            assert.deepEqual(labels([submission(1, 0, status, { judgeAt: at(11) })]), []);
            const result = extractPracticeEpisodes([submission(1, 0, status, { judgeAt: null })], at(10));
            assert.deepEqual(result.observations, []);
            assert.deepEqual(result.diagnostics.resultTimeMissing, [id(1)]);
        }
        assert.deepEqual(labels([submission(1, 0, AC, { judgeAt: at(10) })]), [1]);
    });

    it('a later canceled rejudge is unavailable rather than removing the original t0', () => {
        const result = extractPracticeEpisodes([
            submission(1, 0, STATUS.STATUS_CANCELED, { judgeAt: at(11) }), submission(2, 1, WA),
        ], at(10));
        assert.equal(result.episodes[0].t0, BASE);
        assert.equal(result.episodes[0].state, 'pending');
    });

    it('filters recent observations by window end after deriving t0 from full history', () => {
        const result = extractPracticeEpisodes([submission(1, 0), submission(2, 110, AC)], at(120));
        assert.equal(result.episodes[0].t0, BASE);
        assert.equal(result.episodes[0].y, 0);
        assert.deepEqual(result.observations, []);
        assert.equal(result.diagnostics.outsideRecentWindow, 1);
        assert.deepEqual(labels([submission(1, 0)], at(97)), [0]);
        assert.deepEqual(labels([submission(1, 0)], at(97) + 1), []);
        assert.equal(EPISODE_WINDOW_MS, 7 * DAY);
        assert.equal(RECENT_WINDOW_MS, 90 * DAY);
    });

    it('confirmed revisions separate episodes and unknown versions are included and counted', () => {
        const result = extractPracticeEpisodes([
            submission(1, 0, AC, { metadata: metadata('v1') }),
            submission(2, 0, WA, { metadata: metadata('v2') }),
            submission(3, 0, WA),
        ], at(10));
        assert.equal(result.episodes.length, 3);
        assert.deepEqual(result.observations.map((o) => o.revision).sort(), ['v1', 'v2', null].sort());
        assert.equal(result.diagnostics.unknownRevisionEpisodes, 1);
        assert.equal(result.episodes.find((e) => e.revision === null).revisionStatus, 'unknown');
    });

    it('excludes explicit revision conflicts without guessing a replacement revision', () => {
        const result = extractPracticeEpisodes([
            submission(1, 0, AC, { metadata: { ...metadata('v1'), revisionConflict: true } }),
        ], at(10));
        assert.deepEqual(result.episodes, []);
        assert.deepEqual(result.diagnostics.excluded, [{ recordId: id(1), reason: 'revision_conflict' }]);
    });

    it('does not apply future revision, exclusion or activity metadata at the cutoff', () => {
        const record = submission(1, 0, WA, {
            contest: 'later-course', metadata: { knownAt: at(11), revision: 'future', exclusion: 'unsuitable' },
        });
        const result = extractPracticeEpisodes([record], at(10), [
            { domainId: 'fixture-domain', id: 'later-course', rule: 'course', knownAt: at(11) },
        ]);
        assert.deepEqual(result.observations.map((o) => [o.revision, o.y]), [[null, 0]]);
        assert.deepEqual(result.diagnostics.metadataUnavailable, [id(1)]);
        assert.deepEqual(result.episodes[0].sources, [{ kind: 'UNKNOWN', activityId: 'later-course' }]);
    });

    it('pretest/generate, invalid statuses and AI/hack events do not become attempts', () => {
        const records = [
            submission(1, 0, AC, { contest: '000000000000000000000000' }),
            submission(2, 0, AC, { contest: '000000000000000000000001' }),
            ...[STATUS.STATUS_CANCELED, STATUS.STATUS_IGNORED, STATUS.STATUS_FORMAT_ERROR,
                STATUS.STATUS_AI_ANSWER, STATUS.STATUS_AI_ERROR, STATUS.STATUS_HACK_SUCCESSFUL,
                STATUS.STATUS_HACK_UNSUCCESSFUL, 999 as STATUS].map((status, n) => submission(n + 3, 0, status)),
        ];
        const result = extractPracticeEpisodes(records, at(10));
        assert.deepEqual(result.episodes, []);
        assert.equal(result.diagnostics.excluded.length, records.length);
    });

    it('explicitly identified test/service accounts, invalid data and team aggregates are excluded', () => {
        for (const exclusion of ['test_account', 'service_account', 'invalid', 'unsuitable', 'team_aggregate'] as const) {
            const result = extractPracticeEpisodes([
                submission(1, 0, AC, { metadata: { knownAt: BASE - 1, exclusion } }),
            ], at(10));
            assert.deepEqual(result.episodes, []);
            assert.deepEqual(result.diagnostics.excluded, [{ recordId: id(1), reason: exclusion }]);
        }
    });

    it('invalid or excluded earlier records do not start t0; future submissions are not evidence', () => {
        const result = extractPracticeEpisodes([
            submission(1, 0, STATUS.STATUS_CANCELED), submission(2, 1, WA), submission(3, 11, AC),
            submission(4, 0, AC, { pid: NaN }), submission(5, 0, AC, { id: 'truncated' }),
            submission(6, 0, AC, { judgeAt: BASE - 1 }),
        ], at(10));
        assert.equal(result.episodes[0].t0, at(1));
        assert.deepEqual(result.observations.map((o) => o.y), [0]);
        assert.deepEqual(result.diagnostics.excluded.map((e) => e.reason).sort(), [
            'invalid_status', 'future_submission', 'invalid_record', 'invalid_record', 'invalid_record',
        ].sort());
        assert.throws(() => extractPracticeEpisodes([], NaN), RangeError);
    });

    it('absent/null contests are practice and unresolved activity references remain unknown', () => {
        const result = extractPracticeEpisodes([
            submission(1, 0), submission(2, 1, WA, { contest: null }), submission(3, 2, WA, { contest: 'unresolved' }),
        ], at(10));
        assert.deepEqual(result.episodes[0].sources, [
            { kind: 'FREE_PRACTICE', activityId: null }, { kind: 'UNKNOWN', activityId: 'unresolved' },
        ]);
    });

    it('uses domain-scoped activity metadata and separates different users', () => {
        const result = extractPracticeEpisodes([
            submission(1, 0, WA, { uid: 1, contest: 'same-id' }),
            submission(2, 0, AC, { uid: 2, contest: 'same-id' }),
        ], at(10), [{ domainId: 'another-domain', id: 'same-id', rule: 'course', knownAt: BASE - 1 }]);
        assert.equal(result.episodes.length, 2);
        assert.ok(result.episodes.every((e) => e.sources[0].kind === 'UNKNOWN'));
    });

    it('full IDs break same-time ties deterministically, with immutable inputs and fresh outputs', () => {
        const records = [submission(2, 0, AC), submission(1, 0), submission(3, 1, WA, { metadata: metadata('v1') })];
        const before = structuredClone(records);
        for (const record of records) {
            if (record.metadata) Object.freeze(record.metadata);
            Object.freeze(record);
        }
        Object.freeze(records);
        const first = extractPracticeEpisodes(records, at(10));
        assert.deepEqual(first, extractPracticeEpisodes([...records].reverse(), at(10)));
        assert.deepEqual(first.episodes.find((e) => e.revision === null).recordIds, [id(1), id(2)]);
        assert.deepEqual(records, before);
        first.episodes[0].sources[0].kind = 'UNKNOWN';
        first.observations[0].y = 0;
        assert.deepEqual(extractPracticeEpisodes(records, at(10)), extractPracticeEpisodes(before, at(10)));
    });
});
