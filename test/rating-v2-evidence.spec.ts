/* eslint-disable no-await-in-loop -- Database fixtures and replay assertions use ordered writes. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { after, before, beforeEach, test } from 'node:test';
import ts from 'typescript';
import { contestSignature, isOfficialRecordEligible, isRatingContestEligible } from '../packages/hydrooj/src/lib/rating-v2/eligibility';
import { isClassroomBindingCurrent, resolveClassroomBinding } from '../packages/hydrooj/src/lib/rating-v2/classroom';
import { runShadowReplay } from '../packages/hydrooj/src/lib/rating-v2/shadow-replay';
import { resolveProblemEvidence } from '../packages/hydrooj/src/lib/submission-provenance';

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: any;
const beginAt = new Date('2020-01-01T10:00:00.500Z');
const endAt = new Date('2020-01-01T12:00:00.500Z');
const judgeAt = new Date('2020-01-01T12:01:00Z');

before(async () => {
    mongod = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongod.getUri());
    db = client.db('rating-v2-evidence');
});
after(async () => {
    await client?.close();
    await mongod?.stop();
});
beforeEach(async () => {
    for (const name of ['document', 'document.status', 'record', 'domain.user', 'ratingv2_shadow', 'ratingv2_certification_lock']) {
        await db.collection(name).deleteMany({});
    }
});

async function fixture(problemOverrides: Record<string, unknown> = {}) {
    const tid = new ObjectId();
    await db.collection('document').insertOne({
        docType: 10, docId: 1, domainId: 'd', owner: 99, hidden: false, content: 'question',
        config: 'subtasks:\n  - score: 200\n    cases:\n      - input: a.in\n        output: a.out',
        data: [{ name: 'a.in', etag: 'in-v1' }, { name: 'a.out', etag: 'out-v1' }],
        ...problemOverrides,
    });
    const evidence = await resolveProblemEvidence(db, 'd', 1);
    const contest: any = {
        _id: tid, docId: tid, domainId: 'd', docType: 30, rule: 'oi', rated: true,
        beginAt, endAt, pids: [1], assign: [], attend: 999,
    };
    contest.ratingPolicy = {
        enabled: true, eventKind: 'timed_individual_contest', mode: 'synchronous', poolId: 'certified-test',
        ruleVersion: 'hydro-local-cf-v1', eligibilityVersion: 'timed-contest-v1',
        approvedBy: 99, approvedAt: new Date(beginAt.getTime() - 1000), minParticipants: 2,
        resultRelease: 'manual', resultsReleasedAt: judgeAt, contestSignature: contestSignature(contest),
        problemRevisions: { 1: evidence.problemRevisionId },
    };
    await db.collection('document').insertOne(contest);
    const record = (uid: number, score: number, extra: any = {}) => ({
        _id: new ObjectId(), domainId: 'd', uid, pid: 1, contest: tid,
        submittedAt: new Date(beginAt.getTime() + uid * 1000), judgeAt,
        submissionKind: 'normal', participationMode: 'official', ingressVersion: 'record-v1',
        submissionContext: { domainId: 'd', uid, pid: 1, contestId: tid.toString() },
        ...evidence, status: score === evidence.problemFullScore ? 1 : 2, score, ...extra,
    });
    return { contest, record, evidence };
}

test('official records use server time, preserve normal rejudges, and reject uncertain or altered evidence', async () => {
    const { contest, record } = await fixture();
    const valid = record(2, 200);
    assert.equal(isOfficialRecordEligible(contest, valid).allowed, true);
    assert.equal(isOfficialRecordEligible(contest, { ...valid, rejudged: true } as any).allowed, true);
    for (const [extra, reason] of [
        [{ submittedAt: undefined }, 'MISSING_TIME_EVIDENCE'],
        [{ submittedAt: new Date(beginAt.getTime() - 1) }, 'OUT_OF_WINDOW'],
        [{ submittedAt: endAt }, 'OUT_OF_WINDOW'],
        [{ submissionKind: 'rejudge' }, 'NON_NORMAL_SUBMISSION'],
        [{ participationMode: 'virtual' }, 'NON_OFFICIAL_ENTRY'],
        [{ practiceContest: contest.docId }, 'NON_OFFICIAL_ENTRY'],
        [{ submissionContext: { domainId: 'other', uid: 2, pid: 1 } }, 'CONTEST_MISMATCH'],
        [{ problemRevisionId: 'changed' }, 'PROBLEM_REVISION_MISMATCH'],
        [{ status: 20 }, 'UNFINALIZED_JUDGEMENT'],
        [{ status: 11 }, 'UNFINALIZED_JUDGEMENT'],
    ] as const) {
        assert(isOfficialRecordEligible(contest, { ...valid, ...extra }).reasonCodes.includes(reason));
    }
    assert.equal(isOfficialRecordEligible(contest, { ...valid, submittedAt: beginAt }).allowed, true);
});

test('certified policy checks frozen configuration, manual result release and valid distinct participants', async () => {
    const { contest } = await fixture();
    assert.equal(isRatingContestEligible(contest, 2, 'certified-test').allowed, true);
    assert(isRatingContestEligible(contest, 1, 'certified-test').reasonCodes.includes('INSUFFICIENT_FIELD'));
    assert(isRatingContestEligible(contest, 2, 'wrong-pool').reasonCodes.includes('POOL_MISMATCH'));
    assert(isRatingContestEligible({ ...contest, duration: 1 }, 2, 'certified-test').reasonCodes.includes('PERSONAL_START_MODE'));
    assert(isRatingContestEligible({ ...contest, pids: [2] }, 2, 'certified-test').reasonCodes.includes('CONTEST_CHANGED'));
    assert(isRatingContestEligible({ ...contest, keepScoreboardHidden: true }, 2, 'certified-test').reasonCodes.includes('RESULTS_NOT_RELEASED'));
    const policy = { ...contest.ratingPolicy, approvedAt: beginAt };
    assert(isRatingContestEligible({ ...contest, ratingPolicy: policy }, 2, 'certified-test').reasonCodes.includes('POLICY_NOT_FROZEN_BEFORE_START'));
    assert(isRatingContestEligible({ ...contest, rule: 'ioi' }, 2, 'certified-test').reasonCodes.includes('UNSUPPORTED_RULE'));
    assert(isRatingContestEligible({ ...contest, langs: ['python'] }, 2, 'certified-test').reasonCodes.includes('CONTEST_CHANGED'));
    assert(isRatingContestEligible({ ...contest, autoHide: true }, 2, 'certified-test').reasonCodes.includes('CONTEST_CHANGED'));
});

test('certification CLI authorizes an administrator and freezes future facts without publishing a ranking', async () => {
    const { contest, record } = await fixture({ config: 'time: 1s\nmemory: 256m',
        data: [{ name: '1.in', etag: 'in-v1' }, { name: '1.out', etag: 'out-v1' }] });
    const tid = contest.docId;
    await db.collection('document').updateOne({ docId: tid }, { $set: {
        beginAt, endAt,
    }, $unset: { ratingPolicy: '' } });
    let administrator = false;
    let clock = beginAt.getTime() - 60000;
    class TestDate extends Date {
        constructor() { super(clock); }
    }
    class ValidationError extends Error {}
    const code = ts.transpileModule(readFileSync('packages/hydrooj/src/script/rating-v2-certify.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const exports: any = {};
    const mocks = {
        '../error': { ValidationError },
        '../lib/course-assessment-access': { assertCourseAssessmentAccess: async () => false },
        '../lib/rating-v2/classroom': { isClassroomBindingCurrent, resolveClassroomBinding },
        '../model/builtin': { PRIV: { PRIV_EDIT_SYSTEM: 1 } },
        '../model/user': { getById: async () => ({ _id: 99, hasPriv: () => administrator }) },
        '../model/contest': {
            get: async () => db.collection('document').findOne({ docId: tid }),
            edit: async (_domain, _tid, update, expected, expectedFields) => {
                assert.equal(expected.docId.toString(), tid.toString());
                for (const field of ['langs', 'content', 'pids', 'beginAt', 'keepScoreboardHidden', 'unlocked']) {
                    assert(expectedFields.includes(field));
                }
                return db.collection('document').updateOne({ docId: tid }, { $set: update });
            },
        },
        '../service/db': db,
        '../lib/submission-provenance': { resolveProblemEvidence },
        '../lib/rating-v2/eligibility': require('../packages/hydrooj/src/lib/rating-v2/eligibility'),
    };
    vm.runInNewContext(code, { exports, Date: TestDate, require: (name) => mocks[name] || require(name) });
    const options = { domainId: 'd', tid: tid.toString(), approvedBy: 99,
        operation: 'certify', poolId: 'certified-test', minParticipants: 2 };
    await assert.rejects(exports.run(options, () => {}), ValidationError);
    administrator = true;
    const concurrent = await Promise.allSettled([exports.run(options, () => {}), exports.run(options, () => {})]);
    assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(await db.collection('ratingv2_certification_lock').countDocuments({}), 0);
    let saved = await db.collection('document').findOne({ docId: tid });
    assert.equal(saved.ratingPolicy.contestSignature, contestSignature(saved));
    assert.equal(saved.ratingPolicy.approvedBy, 99);
    assert(saved.ratingPolicy.problemRevisions[1]);
    clock = endAt.getTime() + 120000;
    await db.collection('document').updateOne({ docId: tid }, { $set: { beginAt, endAt, keepScoreboardHidden: true } });
    await assert.rejects(exports.run(options, () => {}), ValidationError);
    await assert.rejects(exports.run({ ...options, operation: 'release' }, () => {}), ValidationError);
    saved = await db.collection('document').findOne({ docId: tid });
    await db.collection('document').updateOne({ docId: tid }, { $set: {
        keepScoreboardHidden: false, 'ratingPolicy.contestSignature': contestSignature(saved),
    } });
    await assert.rejects(exports.run({ ...options, operation: 'release' }, () => {}), ValidationError);
    await db.collection('record').insertMany([record(2, 100), record(3, 50)]);
    await db.collection('record').updateOne({ uid: 3 }, { $set: { score: 101 } });
    await assert.rejects(exports.run({ ...options, operation: 'release' }, () => {}), ValidationError);
    await db.collection('record').updateOne({ uid: 3 }, { $set: { score: 50 } });
    await exports.run({ ...options, operation: 'release' }, () => {});
    saved = await db.collection('document').findOne({ docId: tid });
    assert(saved.ratingPolicy.resultsReleasedAt instanceof Date);
    assert.equal(await db.collection('ratingv2_shadow').countDocuments({}), 0);
});

async function classroomFixture() {
    const { contest, record } = await fixture();
    const courseId = new ObjectId();
    await db.collection('document').insertOne({ docType: 30, domainId: 'd', docId: courseId, rule: 'course', owner: 99,
        beginAt: new Date(beginAt.getTime() - 3600000), endAt: new Date(endAt.getTime() + 3600000), assign: ['class'],
        dag: [{ _id: 1, kind: 'assessment', pids: [1], assessment: {
            contestTid: String(contest.docId), rule: 'oi', beginAt: beginAt.toISOString(), endAt: endAt.toISOString(),
        } }] });
    await db.collection('document').updateOne({ docId: contest.docId }, { $set: {
        rated: false, sourceType: 'course_assessment', sourceCourseTid: courseId, sourceNodeId: 1,
    }, $unset: { ratingPolicy: '' } });
    await db.collection('document.status').insertMany([2, 3].flatMap((uid) => [
        { docType: 30, domainId: 'd', docId: courseId, uid, attend: 1, allow: { 1: true } },
    ]));
    const { PERM, PRIV } = require('../packages/common/permission');
    let teacher = false;
    let archived = false;
    let clock = beginAt.getTime() - 1000;
    const users = { getById: async (_domain, uid) => [2, 3, 99].includes(uid) ? {
        _id: uid, own: (doc) => doc.owner === uid || doc.maintainer?.includes(uid),
        hasPriv: (priv) => priv === PRIV.PRIV_USER_PROFILE || uid === 99,
        hasPerm: (perm) => uid === 99
            ? perm === PERM.PERM_EDIT_HOMEWORK_SELF
            : perm === PERM.PERM_VIEW_HOMEWORK
                || (teacher && uid === 3 && perm === PERM.PERM_EDIT_HOMEWORK),
    } : null, listGroup: async () => [{ name: 'class', class: true, archive: archived,
        students: [2, 3], teachers: [99], uids: [2, 3, 99] }] };
    const contests = {
        get: async (_domain, tid) => db.collection('document').findOne({ domainId: 'd', docId: tid }),
        getStatus: async (_domain, tid, uid) => db.collection('document.status').findOne({ domainId: 'd', docId: tid, uid }),
        edit: async (_domain, tid, update, _expected, fields) => {
            assert(fields.includes('sourceCourseTid') && fields.includes('sourceNodeId'));
            return db.collection('document').updateOne({ docId: tid }, { $set: update });
        },
    };
    const load = (file, mocks, globals = {}) => {
        const exports: any = {};
        const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
            module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
        } }).outputText;
        vm.runInNewContext(code, { exports, require: (name) => mocks[name] || require(name), ...globals });
        return exports;
    };
    class ValidationError extends Error {}
    const access = load('packages/hydrooj/src/lib/course-assessment-access.ts', {
        '../error': { NotAssignedError: ValidationError }, '../model/builtin': { PERM },
        '../model/contest': contests, '../model/user': users,
    });
    class TestDate extends Date { constructor() { super(clock); } }
    const cli = load('packages/hydrooj/src/script/rating-v2-certify.ts', {
        '../error': { ValidationError }, '../model/builtin': { PRIV }, '../model/user': users,
        '../model/contest': contests, '../service/db': db, '../lib/course-assessment-access': access,
        '../lib/rating-v2/classroom': { isClassroomBindingCurrent, resolveClassroomBinding },
        '../lib/submission-provenance': { resolveProblemEvidence },
        '../lib/rating-v2/eligibility': require('../packages/hydrooj/src/lib/rating-v2/eligibility'),
    }, { Date: TestDate });
    const options = { domainId: 'd', tid: String(contest.docId), approvedBy: 99, operation: 'certify',
        poolId: 'certified-test', minParticipants: 2, participantUids: [2, 3] };
    return { contest, record, courseId, options, cli, get: () => contests.get('d', contest.docId),
        attend: async (uids: number[]) => db.collection('document.status').insertMany(uids.map((uid) => ({
            docType: 30, domainId: 'd', docId: contest.docId, uid, attend: 1, startAt: beginAt,
        }))),
        finish: () => { clock = endAt.getTime() + 1000; }, setTeacher: (value) => { teacher = value; },
        setArchived: (value) => { archived = value; }, ValidationError };
}

test('classroom certification freezes an admitted student session and releases only finalized valid results', async () => {
    const f = await classroomFixture();
    for (const participantUids of [undefined, [2, 2], [2, 99], [2, 42]]) {
        await assert.rejects(f.cli.run({ ...f.options, participantUids }, () => {}));
    }
    f.setTeacher(true);
    await assert.rejects(f.cli.run(f.options, () => {}));
    f.setTeacher(false); f.setArchived(true);
    await assert.rejects(f.cli.run(f.options, () => {}));
    f.setArchived(false);
    await db.collection('document.status').updateOne({ docId: f.courseId, uid: 3 }, { $set: { 'allow.1': false } });
    await assert.rejects(f.cli.run(f.options, () => {}));
    await db.collection('document.status').updateOne({ docId: f.courseId, uid: 3 }, { $set: { 'allow.1': true } });
    await f.cli.run(f.options, () => {});
    assert.equal(await db.collection('document.status').countDocuments({ docId: f.contest.docId, attend: { $gt: 0 } }), 0);
    const saved = await f.get();
    assert.equal(saved.rated, false);
    assert.equal(saved.ratingPolicy.eventKind, 'classroom_assessment');
    const session = saved.ratingPolicy.classroom;
    assert.deepEqual(session.participantUids, [2, 3]);
    const classroomSession = { courseId: session.courseId, nodeId: session.nodeId, sessionId: session.sessionId };
    await f.attend([2, 3]);
    await db.collection('record').insertMany([
        f.record(2, 200, { classroomSession, rejudged: true }), f.record(3, 50, { classroomSession }),
        f.record(4, 200, { classroomSession }), f.record(3, 100),
    ]);
    let replay = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test' });
    assert.equal(replay.contests.processed, 0);
    assert(replay.exclusions.RESULTS_NOT_RELEASED);
    f.finish();
    await db.collection('record').updateOne({ uid: 2 }, { $set: { status: 0, judgeAt: null } });
    await assert.rejects(f.cli.run({ ...f.options, operation: 'release' }, () => {}));
    await db.collection('record').updateOne({ uid: 2 }, { $set: { status: 1, judgeAt } });
    await f.cli.run({ ...f.options, operation: 'release' }, () => {});
    replay = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test', write: true });
    assert.equal(replay.contests.processed, 1);
    assert.equal(replay.ratingUsers, 2);
    assert(replay.exclusions.CLASSROOM_SESSION_MISMATCH >= 1);
    assert.equal((await runShadowReplay(db)).contests.processed, 0);
    assert.equal(await db.collection('domain.user').countDocuments({}), 0);
    assert.equal((await f.get()).rated, false);
});

test('certified classroom replay requires attendance recorded during the test window', async () => {
    const f = await classroomFixture();
    await f.cli.run(f.options, () => {});
    const saved = await f.get();
    const session = saved.ratingPolicy.classroom;
    const classroomSession = { courseId: session.courseId, nodeId: session.nodeId, sessionId: session.sessionId };
    await f.attend([2]);
    await db.collection('record').insertMany([
        f.record(2, 200, { classroomSession }), f.record(3, 50, { classroomSession }),
    ]);
    f.finish();
    await f.cli.run({ ...f.options, operation: 'release' }, () => {});
    let replay = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test' });
    assert.equal(replay.contests.processed, 0);
    assert(replay.exclusions.INSUFFICIENT_FIELD);
    await f.attend([3]);
    replay = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test' });
    assert.equal(replay.contests.processed, 1);
    assert.equal(replay.ratingUsers, 2);
});

test('classroom binding changes, forged sessions and insufficient fields fail closed', async () => {
    const f = await classroomFixture();
    await f.cli.run(f.options, () => {});
    await f.attend([2, 3]);
    const saved = await f.get();
    const session = saved.ratingPolicy.classroom;
    const classroomSession = { courseId: session.courseId, nodeId: session.nodeId, sessionId: session.sessionId };
    await db.collection('record').insertMany([
        f.record(2, 200, { classroomSession }), f.record(3, 50, { classroomSession: { ...classroomSession, sessionId: 'forged' } }),
    ]);
    f.finish();
    await assert.rejects(f.cli.run({ ...f.options, operation: 'release' }, () => {}));
    const known = isOfficialRecordEligible(saved, f.record(3, 50, { classroomSession }));
    assert.equal(known.allowed, true);
    await db.collection('document').updateOne({ docId: f.courseId }, { $set: { assign: ['changed-class'] } });
    assert.notEqual((await resolveClassroomBinding(db, saved)).courseSignature, session.courseSignature);
    await assert.rejects(f.cli.run({ ...f.options, operation: 'release' }, () => {}));
    let replay = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test' });
    assert(replay.exclusions.CLASSROOM_BINDING_CHANGED);
    await db.collection('document').updateOne({ docId: f.courseId }, { $set: { 'dag.0.assessment.contestTid': String(new ObjectId()) } });
    assert.equal(await resolveClassroomBinding(db, saved), null);
    replay = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test' });
    assert.equal(replay.contests.processed, 0);
    assert.equal(await db.collection('ratingv2_certification_lock').countDocuments({}), 0);
});

test('certified classroom and ordinary contests share a pool without admitting courses or unsupported assessment modes', async () => {
    const f = await classroomFixture();
    for (const patch of [{ rule: 'course' }, { rule: 'homework' }, { rule: 'ioi' }, { allowTeam: true }, { duration: 1 }]) {
        const previous = await f.get();
        await db.collection('document').updateOne({ docId: f.contest.docId }, { $set: patch });
        await assert.rejects(f.cli.run(f.options, () => {}));
        await db.collection('document').replaceOne({ docId: f.contest.docId }, previous);
    }
    await f.cli.run(f.options, () => {});
    await f.attend([2, 3]);
    const session = (await f.get()).ratingPolicy.classroom;
    const classroomSession = { courseId: session.courseId, nodeId: session.nodeId, sessionId: session.sessionId };
    await db.collection('record').insertMany([f.record(2, 200, { classroomSession }), f.record(3, 50, { classroomSession })]);
    f.finish();
    await assert.rejects(f.cli.run(f.options, () => {})); // No certification after the start.
    await f.cli.run({ ...f.options, operation: 'release' }, () => {});
    const ordinary = await fixture();
    ordinary.contest.beginAt = new Date(endAt.getTime() + 3600000);
    ordinary.contest.endAt = new Date(endAt.getTime() + 7200000);
    ordinary.contest.ratingPolicy.resultsReleasedAt = new Date(ordinary.contest.endAt.getTime() + 1000);
    ordinary.contest.ratingPolicy.contestSignature = contestSignature(ordinary.contest);
    await db.collection('document').replaceOne({ docId: ordinary.contest.docId }, ordinary.contest);
    await db.collection('record').insertMany([2, 3].map((uid) => ordinary.record(uid, 100, {
        submittedAt: new Date(ordinary.contest.beginAt.getTime() + uid * 1000),
        judgeAt: ordinary.contest.ratingPolicy.resultsReleasedAt,
    })));
    const replay = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test', write: true });
    assert.equal(replay.contests.processed, 2);
    assert.equal(replay.ratingUsers, 2);
    assert.equal((await f.get()).rated, false);
    assert.equal(await db.collection('domain.user').countDocuments({}), 0);
});

test('certified replay uses server timestamps instead of ObjectId time and records exclusion reasons', async () => {
    const { record } = await fixture();
    await db.collection('record').insertMany([
        record(2, 200), record(3, 50), record(4, 200, { participationMode: 'staff' }),
        record(5, 200, { submittedAt: endAt }), record(6, 200, { submissionKind: 'hack' }),
        record(7, 200, { submittedAt: undefined, ingressVersion: undefined }),
    ]);
    const result = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test', write: true });
    assert.equal(result.contests.processed, 1);
    assert.equal(result.ratingUsers, 2);
    assert(result.exclusions.NON_OFFICIAL_ENTRY >= 1);
    assert(result.exclusions.OUT_OF_WINDOW >= 1);
    assert(result.exclusions.NON_NORMAL_SUBMISSION >= 1);
    assert(result.exclusions.MISSING_TIME_EVIDENCE >= 1);
    assert.equal(await db.collection('ratingv2_shadow').countDocuments({ kind: 'rating_state' }), 2);
    assert.equal(await db.collection('document').countDocuments({}), 2);
});

test('default trial still accepts legacy records while certified mode rejects them', async () => {
    const { contest } = await fixture();
    await db.collection('record').insertMany([1, 2].map((uid) => ({
        _id: ObjectId.createFromTime(Math.floor(beginAt.getTime() / 1000) + uid),
        domainId: 'd', uid, pid: 1, contest: contest.docId, status: uid === 1 ? 1 : 2, score: uid === 1 ? 100 : 0,
    })));
    const trial = await runShadowReplay(db);
    const strict = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test' });
    assert.equal(trial.eligibilityMode, 'trial');
    assert.equal(trial.contests.processed, 1);
    assert.equal(strict.contests.processed, 0);
    assert(strict.exclusions.MISSING_TIME_EVIDENCE);
    assert(strict.exclusions.INSUFFICIENT_FIELD);
});

test('changed problem evidence invalidates certification instead of mixing revisions', async () => {
    const { record } = await fixture();
    const first = record(2, 200);
    await db.collection('record').insertMany([first, record(3, 50)]);
    await db.collection('document.status').insertOne({ docType: 10, domainId: 'd', uid: 2, docId: 1, rid: first._id });
    await db.collection('document').updateOne({ domainId: 'd', docId: 1 }, { $set: { content: 'new question' } });
    const result = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test' });
    assert.equal(result.contests.processed, 0);
    assert(result.exclusions.PROBLEM_REVISION_MISMATCH);
    assert.equal(result.achievement.users, 0);
    assert(result.exclusions.MISSING_PROBLEM_EVIDENCE);
});

test('scores above the verified problem full score cannot affect certified replay', async () => {
    const { record } = await fixture();
    await db.collection('record').insertMany([record(2, 200), record(3, 50), record(4, 201)]);
    const result = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test' });
    assert.equal(result.contests.processed, 0);
    assert(result.exclusions.INVALID_SCORE);
    assert.equal(result.ratingUsers, 0);
});

test('pending or invalid official scores block the whole contest even with enough other participants', async () => {
    const { record } = await fixture();
    await db.collection('record').insertMany([record(2, 200), record(3, 50), record(4, 100, { status: 0, judgeAt: null })]);
    let result = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test' });
    assert.equal(result.contests.processed, 0);
    assert(result.exclusions.UNFINALIZED_JUDGEMENT);
    await db.collection('record').updateOne({ uid: 4 }, { $set: { status: 2, judgeAt, score: Infinity } });
    result = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test' });
    assert.equal(result.contests.processed, 0);
    assert(result.exclusions.INVALID_SCORE);
});

test('certified replay rejects overlapping contests and mixed-domain pools', async () => {
    const { contest, record } = await fixture();
    await db.collection('record').insertMany([record(2, 200), record(3, 50)]);
    const second = { ...contest, _id: new ObjectId(), docId: new ObjectId() };
    await db.collection('document').insertOne(second);
    const result = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test' });
    assert.equal(result.contests.processed, 0);
    assert.equal(result.exclusions.OVERLAPPING_CONTESTS, 2);
    await db.collection('document').updateOne({ _id: second._id }, { $set: { domainId: 'other' } });
    await assert.rejects(runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test', write: true }), /cannot mix domains/);
    assert.equal(await db.collection('ratingv2_shadow').countDocuments({}), 0);
});

test('formal difficulty uses the frozen question list and actual full score for positive evidence', async () => {
    const { record } = await fixture();
    await db.collection('record').insertMany([record(2, 200), record(3, 150)]);
    const result = await runShadowReplay(db, {
        eligibilityMode: 'certified', poolId: 'certified-test', difficultyMinPriorEvents: 0, write: true,
    });
    assert.equal(result.contests.processed, 1);
    const observations = await db.collection('ratingv2_shadow').find({ kind: 'observation' }).toArray();
    assert.equal(observations.find((o) => o.uid === 2).solved, true);
    assert.equal(observations.find((o) => o.uid === 3).solved, false);
    assert(observations.every((o) => typeof o.pid === 'string' && o.pid.startsWith('d/1@sha256:')));
});

test('case-weighted full score drives certified solve evidence and partial achievement normalization', async () => {
    const { record } = await fixture({ config: { cases: [
        { input: '1.in', output: '1.out', score: 20 }, { input: '2.in', output: '2.out', score: 30 },
    ] }, data: ['1.in', '1.out', '2.in', '2.out'].map((name) => ({ name, etag: 'v1' })) });
    const accepted = record(2, 50);
    // A record captured before the case-score fix keeps its immutable but incorrect full-score field.
    const partial = record(3, 20, { problemFullScore: 100 });
    await db.collection('record').insertMany([accepted, partial]);
    await db.collection('document.status').insertOne({ docType: 10, domainId: 'd', uid: 3, docId: 1, rid: partial._id });
    const result = await runShadowReplay(db, {
        eligibilityMode: 'certified', poolId: 'certified-test', difficultyMinPriorEvents: 0, write: true,
    });
    assert.equal(result.contests.processed, 1);
    const observations = await db.collection('ratingv2_shadow').find({ kind: 'observation' }).toArray();
    assert.equal(observations.find((o) => o.uid === 2).solved, true);
    assert.equal(observations.find((o) => o.uid === 3).solved, false);
    assert.equal((await db.collection('ratingv2_shadow').findOne({ kind: 'projection', uid: 3 })).a, 0.2);
    assert.equal((await db.collection('record').findOne({ _id: partial._id })).problemFullScore, 100);
});

test('certified achievements deduplicate references, exclude owners/private questions, and use actual full scores', async () => {
    const { record } = await fixture();
    await db.collection('document').insertMany([
        { docType: 10, domainId: 'd', docId: 2, owner: 99, hidden: false, content: 'copy', reference: { domainId: 'd', pid: 1 } },
        { docType: 10, domainId: 'd', docId: 3, owner: 99, hidden: true, content: 'private', config: 'subtasks:\n  - score: 100\n    cases: []' },
        { docType: 10, domainId: 'other', docId: 1, owner: 99, hidden: false, content: 'other domain',
            config: { type: 'objective', answers: { 1: ['yes', 100] } }, data: [] },
    ]);
    for (const [uid, pid, score] of [[2, 1, 100], [2, 2, 150], [99, 1, 200], [2, 3, 100]]) {
        const evidence = await resolveProblemEvidence(db, 'd', pid);
        const rdoc = record(uid, score, { pid, ...evidence, submissionContext: { domainId: 'd', uid, pid } });
        await db.collection('record').insertOne(rdoc);
        await db.collection('document.status').insertOne({ docType: 10, domainId: 'd', uid, docId: pid, rid: rdoc._id, score, status: rdoc.status });
    }
    const otherEvidence = await resolveProblemEvidence(db, 'other', 1);
    const otherRecord = record(2, 100, { domainId: 'other', ...otherEvidence,
        submissionContext: { domainId: 'other', uid: 2, pid: 1 } });
    await db.collection('record').insertOne(otherRecord);
    await db.collection('document.status').insertOne({ docType: 10, domainId: 'other', uid: 2, docId: 1, rid: otherRecord._id });
    const result = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test', write: true });
    const projection = await db.collection('ratingv2_shadow').findOne({ kind: 'projection', uid: 2 });
    assert.equal(projection.problems, 1);
    assert.equal(projection.a, 0.38); // max(100/200, 150/200) * 0.5, rounded by projection
    assert.equal(await db.collection('ratingv2_shadow').findOne({ kind: 'projection', uid: 99 }), null);
    assert(result.exclusions.PROBLEM_OWNER);
    assert(result.exclusions.PRIVATE_NOT_RELEASED);
    assert.equal(await db.collection('ratingv2_shadow').findOne({ kind: 'projection', domainId: 'other' }), null);
});

test('an achievement score exceeding verified full score cannot earn certified credit', async () => {
    const { record } = await fixture();
    const rdoc = record(2, 201, { submissionContext: { domainId: 'd', uid: 2, pid: 1 } });
    await db.collection('record').insertOne(rdoc);
    await db.collection('document.status').insertOne({ docType: 10, domainId: 'd', uid: 2, docId: 1, rid: rdoc._id, score: 201 });
    const result = await runShadowReplay(db, { eligibilityMode: 'certified', poolId: 'certified-test', write: true });
    assert(result.exclusions.MISSING_PROBLEM_EVIDENCE);
    assert.equal(await db.collection('ratingv2_shadow').findOne({ kind: 'projection', uid: 2 }), null);
});

test('shadow calibration explicitly reports conditional diagnostics, including empty samples', async () => {
    const empty = await runShadowReplay(db);
    assert.equal(empty.difficulty.calibrationDiagnostic.kind, 'conditional_calibration');
    assert.equal(empty.difficulty.calibrationDiagnostic.independentPredictionValidation, false);
    assert.equal(empty.difficulty.calibrationDiagnostic.observationN, 0);
    assert.equal(empty.difficulty.calibrationDiagnostic.n, 0);
    assert.equal('calibrationHeldOut' in empty.difficulty, false);
    const { record } = await fixture();
    await db.collection('record').insertMany([record(2, 200), record(3, 150)]);
    const result = await runShadowReplay(db, {
        eligibilityMode: 'certified', poolId: 'certified-test', difficultyMinPriorEvents: 0,
    });
    assert.equal(result.difficulty.calibrationDiagnostic.difficultyFit, 'all_observations');
    assert.equal(result.difficulty.calibrationDiagnostic.observationN, 2);
    assert(result.difficulty.calibrationDiagnostic.n + result.difficulty.calibrationDiagnostic.slopeFitN
        + result.difficulty.calibrationDiagnostic.unavailableDifficultyN <= 2);
});
