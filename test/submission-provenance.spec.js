require('@hydrooj/register');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { after, before, beforeEach, test } = require('node:test');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ts = require('typescript');

function load(file, mocks = {}, globals = {}) {
    const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const exports = {};
    vm.runInNewContext(code, {
        exports, global: { Hydro: { model: {} } }, Date, Array, Object, Set, Map, structuredClone,
        console, require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), ...globals,
    }, { filename: file });
    return exports;
}

let mongod;
let client;
let db;
let resolveProblemEvidence;
let recordModel;

before(async () => {
    mongod = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
    client = await MongoClient.connect(mongod.getUri());
    db = client.db('submission-provenance');
    ({ resolveProblemEvidence } = load('packages/hydrooj/src/lib/submission-provenance.ts'));
    const database = { collection: (name) => db.collection(name) };
    const { STATUS } = load('packages/common/status.ts');
    recordModel = load('packages/hydrooj/src/model/record.ts', {
        '@hydrooj/common': { STATUS_TEXTS: {} },
        '../context': {},
        '../error': { ProblemNotFoundError: class extends Error {}, ValidationError: class extends Error {} },
        '../lib/submission-provenance': { SUBMISSION_INGRESS_VERSION: 'record-v1', resolveProblemEvidence },
        '../service/db': database,
        '../service/bus': { broadcast() {}, on() {} },
        '../utils': { ArgMethod: (target, name, descriptor) => descriptor, buildProjection: () => ({}), Time: {} },
        './builtin': { STATUS }, './domain': {}, './message': {}, './problem': {}, './system': {},
        './task': { deleteMany: async () => {} },
    }, { bus: { broadcast() {} } }).default;
});

after(async () => {
    await client?.close();
    await mongod?.stop();
});
beforeEach(async () => {
    await db.collection('document').deleteMany({});
    await db.collection('record').deleteMany({});
});
test('resolver follows explicit references and snapshots local plus canonical evidence', async () => {
    await db.collection('document').insertMany([
        {
            docType: 10, domainId: 'source', docId: 7, owner: 9, hidden: false,
            content: 'canonical', config: 'subtasks:\n  - cases:\n      - input: a.in\n        output: a.out',
            data: [{ name: 'a.in', etag: 'in-v1' }, { name: 'a.out', etag: 'out-v1' }],
        },
        {
            docType: 10, domainId: 'copy', docId: 3, owner: 12, hidden: false,
            content: 'local copy', config: 'subtasks: []', data: [],
            reference: { domainId: 'source', pid: 7 },
        },
    ]);
    const result = await resolveProblemEvidence(db, 'copy', 3);
    assert.equal(result.canonicalProblemKey, 'source/7');
    assert.equal(result.problemOwner, 9);
    assert.equal(result.problemReleased, true);
    assert.equal(result.problemFullScore, 100);
    assert.match(result.problemRevisionId, /^sha256:[0-9a-f]{64}$/);
    const changed = await resolveProblemEvidence(db, 'copy', 3);
    assert.equal(changed.problemRevisionId, result.problemRevisionId);
    await db.collection('document').updateOne({ domainId: 'copy', docId: 3 }, { $set: { content: 'changed' } });
    assert.notEqual((await resolveProblemEvidence(db, 'copy', 3)).problemRevisionId, result.problemRevisionId);
});

test('resolver leaves evidence unknown for missing and cyclic references', async () => {
    await db.collection('document').insertMany([
        { docType: 10, domainId: 'd', docId: 1, owner: 2, hidden: false, content: 'one', reference: { domainId: 'd', pid: 2 } },
        { docType: 10, domainId: 'd', docId: 2, owner: 2, hidden: false, content: 'two', reference: { domainId: 'd', pid: 1 } },
        { docType: 10, domainId: 'd', docId: 3, owner: 2, hidden: false, content: 'three', reference: { domainId: 'd', pid: 99 } },
        { docType: 10, domainId: 'd', docId: 4, owner: 2, hidden: false, content: 'four', reference: {} },
    ]);
    const cycle = await resolveProblemEvidence(db, 'd', 1);
    assert.equal(cycle.canonicalProblemKey, undefined);
    assert.equal(cycle.problemOwner, undefined);
    assert.equal(cycle.problemRevisionId, undefined);
    assert.equal((await resolveProblemEvidence(db, 'd', 3)).canonicalProblemKey, undefined);
    assert.equal((await resolveProblemEvidence(db, 'd', 4)).canonicalProblemKey, undefined);
});

test('objective answer alternatives use the maximum attainable score per question', async () => {
    await db.collection('document').insertOne({ docType: 10, domainId: 'd', docId: 1,
        owner: 7, hidden: false, content: 'objective', config: {
            type: 'objective', answers: { 1: { A: 50, B: 30 }, 2: ['yes', 20] },
        }, data: [] });
    const result = await resolveProblemEvidence(db, 'd', 1);
    assert.equal(result.problemFullScore, 70);
    assert.match(result.problemRevisionId, /^sha256:/);
});

test('malformed scoring config stays unknown and top-level cases match the judge precedence', async () => {
    await db.collection('document').insertOne({ docType: 10, domainId: 'd', docId: 1,
        owner: 7, hidden: false, content: 'problem', config: { subtasks: 'bad' },
        data: [{ name: 'a.in', etag: 'data-v1' }] });
    assert.equal((await resolveProblemEvidence(db, 'd', 1)).problemFullScore, undefined);
    await db.collection('document').updateOne({ domainId: 'd', docId: 1 }, { $set: { config: {
        cases: [{ input: 'a.in', output: 'a.out' }], subtasks: [{ score: 200, cases: [] }],
    } } });
    assert.equal((await resolveProblemEvidence(db, 'd', 1)).problemFullScore, 100);
});

test('full scores follow sum, min and max case aggregation without changing revision inputs', async () => {
    const cases = [{ input: '1.in', output: '1.out', score: 20 }, { input: '2.in', output: '2.out', score: 30 }];
    for (const [config, expected] of [
        [{ cases }, 50],
        [{ subtasks: [{ type: 'sum', score: 100, cases }] }, 50],
        [{ subtasks: [{ type: 'min', score: 100, cases }] }, 20],
        [{ subtasks: [{ type: 'max', score: 100, cases }] }, 30],
        [{ subtasks: [{ type: 'sum', score: 80, cases: [cases[0], { input: '2.in', output: '2.out' }] }] }, 80],
    ]) {
        await db.collection('document').deleteMany({});
        await db.collection('document').insertOne({ docType: 10, domainId: 'd', docId: 1,
            owner: 7, hidden: false, content: 'scored cases', config,
            data: ['1.in', '1.out', '2.in', '2.out'].map((name) => ({ name, etag: 'v1' })) });
        const first = await resolveProblemEvidence(db, 'd', 1);
        assert.equal(first.problemFullScore, expected);
        assert.equal((await resolveProblemEvidence(db, 'd', 1)).problemRevisionId, first.problemRevisionId);
        assert.deepEqual((await db.collection('document').findOne({ docId: 1 })).config, config);
    }
});

test('automatic file recognition provides a full score only for recognized testcases', async () => {
    for (const config of ['', 'time: 1s\nmemory: 256m', { subtasks: [] }]) {
        await db.collection('document').deleteMany({});
        await db.collection('document').insertOne({ docType: 10, domainId: 'd', docId: 1,
            owner: 7, hidden: false, config,
            data: ['1.in', '1.out', '2.in', '2.out'].map((name) => ({ name, etag: 'v1' })) });
        assert.equal((await resolveProblemEvidence(db, 'd', 1)).problemFullScore, 100);
        await db.collection('document').updateOne({ docId: 1 }, { $push: { data: { name: 'config.ini', etag: 'v1' } } });
        assert.equal((await resolveProblemEvidence(db, 'd', 1)).problemFullScore, undefined);
        await db.collection('document').updateOne({ docId: 1 }, { $set: { data: [{ name: 'notes.txt', etag: 'v1' }] } });
        assert.equal((await resolveProblemEvidence(db, 'd', 1)).problemFullScore, undefined);
    }
});

test('the submission handler persists source-domain maintainers as staff while preserving ordinary modes', async () => {
    const source = ts.createSourceFile('problem.ts', fs.readFileSync(path.resolve(__dirname,
        '../packages/hydrooj/src/handler/problem.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const helper = source.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'submissionParticipationMode');
    const handler = source.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text === 'ProblemSubmitHandler');
    const post = handler.members.find((s) => s.name?.getText(source) === 'post');
    const { PERM } = load('packages/common/permission.ts');
    const tid = new ObjectId();
    const tdoc = { docId: tid, owner: 99, rule: 'oi', pids: [1] };
    let classroomTeacher = false;
    let attended = true;
    let practiceReady = false;
    const user = (perms = []) => ({ _id: 2,
        own: (doc) => doc.owner === 2 || doc.maintainer?.includes(2), hasPerm: (p) => perms.includes(p) });
    const context = {
        exports: {}, PERM, param: () => () => {}, Types: { ArrayOf: () => {} },
        record: { add: (domainId, pid, uid, lang, code, _addTask, args) => recordModel.add(domainId, pid, uid, lang, code, false, args) },
        contest: { get: async () => tdoc, canAccessAssignedContest: () => true, isOngoing: () => true,
            updateStatus: async () => {}, canShowSelfRecord: () => true, getStatus: async () => ({ attend: attended }) },
        assertCourseAssessmentAccess: async () => classroomTeacher,
        ContestNotAttendedError: class extends Error {},
        canSubmitPractice: async () => practiceReady,
        setting: { langs: { cpp: { pretest: 'cpp' } } }, system: { get: () => 1000 },
    };
    vm.runInNewContext(ts.transpileModule(`${helper.getText(source)}\nclass Submit { ${post.getText(source)} }\nexports.Submit = Submit;`, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
    }).outputText, context);
    for (const [sourceUser, sourcePdoc, expected] of [
        [user([PERM.PERM_EDIT_PROBLEM]), { owner: 99 }, 'staff'],
        [user(), { owner: 2 }, 'staff'],
        [user(), { owner: 99, maintainer: [2] }, 'staff'],
        [user([PERM.PERM_EDIT_PROBLEM_SELF]), { owner: 99 }, 'official'],
        [user(), { owner: 99 }, 'official'],
    ]) {
        const h = new context.exports.Submit();
        Object.assign(h, { user: user(), pdoc: { docId: 1, owner: 99, config: {}, reference: { domainId: 'source', pid: 1 } },
            problemFileUser: sourceUser, problemFilePdoc: sourcePdoc, response: {}, request: {},
            limitRate: async () => {}, url: () => '/record' });
        await h.post('d', 'cpp', 'code', false, [], tid);
        assert.equal((await recordModel.get('d', h.response.body.rid)).participationMode, expected);
        h.response.body = { pdoc: { config: { type: 'default' } } };
        await h.post('d', 'cpp', 'code', true, ['input'], tid);
        assert.equal((await recordModel.get('d', h.response.body.rid)).participationMode, 'practice');
        h.team = -10;
        await h.post('d', 'cpp', 'code', false, [], tid);
        assert.equal((await recordModel.get('d', h.response.body.rid)).participationMode, 'team');
    }
    Object.assign(tdoc, { sourceType: 'course_assessment', ratingPolicy: { enabled: true, classroom: {
        courseId: new ObjectId().toString(), nodeId: 1, sessionId: 'frozen-session', participantUids: [2],
    } } });
    const h = new context.exports.Submit();
    Object.assign(h, { user: user(), pdoc: { docId: 1, owner: 99, config: {} }, response: {}, request: {},
        args: { classroomSession: { sessionId: 'forged' } }, limitRate: async () => {}, url: () => '/record' });
    await h.post('d', 'cpp', 'code', false, [], tid);
    const saved = await recordModel.get('d', h.response.body.rid);
    assert.equal(saved.participationMode, 'official');
    assert.equal(saved.classroomSession.sessionId, 'frozen-session');
    assert.equal(saved.classroomSession.courseId, tdoc.ratingPolicy.classroom.courseId);
    tdoc.ratingPolicy.classroom.participantUids = [3];
    await h.post('d', 'cpp', 'code', false, [], tid);
    assert.equal((await recordModel.get('d', h.response.body.rid)).participationMode, 'unknown');
    classroomTeacher = true;
    await h.post('d', 'cpp', 'code', false, [], tid);
    assert.equal((await recordModel.get('d', h.response.body.rid)).participationMode, 'staff');
    classroomTeacher = false; attended = false;
    await assert.rejects(h.post('d', 'cpp', 'code', false, [], tid), context.ContestNotAttendedError);
    // Chapter-authorized students can practice after the test without official enrollment.
    practiceReady = true;
    await h.post('d', 'cpp', 'code', false, [], tid);
    const practiceRecord = await recordModel.get('d', h.response.body.rid);
    assert.equal(practiceRecord.practiceContest.toString(), tid.toString());
    assert.equal(practiceRecord.contest, undefined);
    assert.equal(practiceRecord.participationMode, 'practice');
    assert.equal(practiceRecord.classroomSession, undefined);
    practiceReady = false;
});

test('record creation, reset and linked rejudge preserve immutable provenance', async () => {
    await db.collection('document').insertOne({
        docType: 10, domainId: 'd', docId: 3, owner: 7, hidden: false,
        content: 'statement', config: 'subtasks:\n  - cases:\n      - input: a.in\n        output: a.out',
        data: [{ name: 'a.in', etag: 'in-v1' }, { name: 'a.out', etag: 'out-v1' }],
    });
    const contest = new ObjectId();
    const rid = await recordModel.add('d', 3, 2, 'cpp', 'code', false, {
        type: 'judge', contest, participationMode: 'official',
        classroomSession: { courseId: 'course', nodeId: 1, sessionId: 'session' },
    });
    const saved = await recordModel.get('d', rid);
    assert.equal(saved.submissionKind, 'normal');
    assert.equal(saved.participationMode, 'official');
    assert.equal(saved.ingressVersion, 'record-v1');
    assert.equal(saved.problemFullScore, 100);
    assert.deepEqual(saved.submissionContext, {
        domainId: 'd', uid: 2, pid: 3, contestId: contest.toHexString(),
    });
    const submittedAt = saved.submittedAt;
    await recordModel.reset('d', rid, true);
    const reset = await recordModel.get('d', rid);
    assert.equal(reset.submittedAt.getTime(), submittedAt.getTime());
    assert.equal(reset.submissionKind, 'normal');
    assert.equal(reset.rejudged, true);
    assert.deepEqual(reset.classroomSession, saved.classroomSession);
    await recordModel.update('d', rid, { 'classroomSession.sessionId': 'forged' }, undefined, { classroomSession: '' });
    assert.deepEqual((await recordModel.get('d', rid)).classroomSession, saved.classroomSession);
    const rejudge = await recordModel.add('d', 3, 2, 'cpp', 'code', false, {
        type: 'rejudge', originalRid: rid,
    });
    const rejudged = await recordModel.get('d', rejudge);
    assert.equal(rejudged.submissionKind, 'rejudge');
    assert.equal(rejudged.originalRid.toHexString(), rid.toHexString());
    assert.equal(rejudged.submittedAt.getTime(), submittedAt.getTime());
    assert.deepEqual(rejudged.submissionContext, saved.submissionContext);
    assert.deepEqual(rejudged.classroomSession, saved.classroomSession);
});

test('legacy linked rejudge keeps missing facts unknown and special kinds are classified', async () => {
    const legacy = new ObjectId();
    await db.collection('record').insertOne({
        _id: legacy, domainId: 'd', uid: 2, pid: 3, code: 'old', lang: 'cpp',
        status: 0, score: 0, time: 0, memory: 0, judgeTexts: [], compilerTexts: [], testCases: [],
        rejudged: false,
    });
    const rejudge = await recordModel.add('d', 3, 2, 'cpp', 'old', false, {
        type: 'rejudge', originalRid: legacy,
    });
    const rejudged = await recordModel.get('d', rejudge);
    assert.equal(rejudged.submissionKind, 'rejudge');
    assert.equal(rejudged.submittedAt, undefined);
    assert.equal(rejudged.ingressVersion, undefined);
    assert.equal(rejudged.originalRid.toHexString(), legacy.toHexString());
    const pretest = await recordModel.add('d', 3, 2, '_', 'answer', false, { type: 'pretest', input: ['1'] });
    assert.equal((await recordModel.get('d', pretest)).submissionKind, 'pretest');
    assert.equal((await recordModel.get('d', pretest)).participationMode, 'practice');
    const generated = await recordModel.add('d', 3, 2, '_', 'files', false, { type: 'generate' });
    assert.equal((await recordModel.get('d', generated)).submissionKind, 'generate');
});

test('record updates keep provenance context while deletion and judge updates remain mutable', async () => {
    const rid = new ObjectId();
    const contest = new ObjectId();
    await db.collection('record').insertOne({
        _id: rid, domainId: 'd', uid: 2, pid: 3, contest,
        practiceContest: new ObjectId(), submittedAt: new Date(1), submissionKind: 'normal',
        participationMode: 'official', problemRevisionId: 'old', ingressVersion: 'record-v1', score: 0,
        submissionContext: { domainId: 'd', uid: 2, pid: 3, contestId: contest.toHexString() }, judgeTexts: [],
    });
    await recordModel.update('d', rid,
        { uid: 9, pid: 8, score: 80, 'problemRevisionId.hash': 'new', problemRevisionId: 'new' },
        { judgeTexts: 'updated' }, { contest: '', submittedAt: '' });
    await recordModel.update('d', rid, undefined, undefined, undefined, { score: 1 });
    const saved = await db.collection('record').findOne({ _id: rid });
    assert.equal(saved.uid, 9);
    assert.equal(saved.pid, 8);
    assert.equal(saved.score, 81);
    assert.equal(saved.problemRevisionId, 'old');
    assert.equal(saved.submittedAt.getTime(), 1);
    assert.equal(saved.contest, undefined);
    assert.deepEqual(saved.submissionContext, { domainId: 'd', uid: 2, pid: 3, contestId: contest.toHexString() });
    await recordModel.update([rid], { submittedAt: new Date(2), uid: 1 });
    assert.equal((await db.collection('record').findOne({ _id: rid })).uid, 9);
    assert.equal(await recordModel.updateMulti('d', { _id: rid }, { ingressVersion: 'bad' }), 0);
});
