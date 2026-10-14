const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { before, after, beforeEach, test } = require('node:test');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const ts = require('typescript');

function load(file, mocks = {}) {
    const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, esModuleInterop: true },
    }).outputText;
    const exports = {};
    vm.runInNewContext(code, {
        exports, global: { Hydro: { model: {} } }, Date, Array, Object, Set, Map, structuredClone,
        console: { log() {}, error: console.error },
        require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    }, { filename: file });
    return exports;
}
const errors = new Proxy({}, { get: (obj, key) => obj[key] ||= class extends Error {
    constructor(...args) { super(args.join(' ')); this.name = key; }
} });
const { PERM } = load('packages/common/permission.ts');
const { STATUS } = load('packages/common/status.ts');
const utils = { Counter: () => new Proxy({}, { get: (obj, key) => obj[key] || 0 }), Time: { hour: 3600000, day: 86400000 } };
let mongod, client, db, monitor, assessment, contest, document, access, MonitorHandler;
let fault;
let groups = [];
let team;
let testProblemType = 'default';
const listeners = {};
const bus = { parallel: async (name, ...args) => {
    for (const fn of listeners[name] || []) await fn(...args);
} };
const userModel = { listGroup: async () => groups };
function reloadContestModel() {
    return load('packages/hydrooj/src/model/contest.ts', {
        '../error': errors, '../service/db': { collection: (name) => db.collection(name) }, '../service/bus': bus, './document': document,
        './builtin': { PERM, STATUS, STATUS_SHORT_TEXTS: {} }, './user': userModel,
        '../lib/avatar': () => '', '../lib/contest-participation': { hasTeamParticipation: async () => false },
        './problem': {}, './record': {}, './message': {}, '@hydrooj/utils/lib/utils': utils,
    });
}
const actor = (uid, perms = []) => ({ _id: uid, group: groups.map((g) => g.name),
    own: (doc) => doc.owner === uid, hasPerm: (...items) => items.some((p) => perms.includes(p)) });

before(async () => {
    mongod = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongod.getUri());
    db = client.db('pr13-pr14-integration');
    const database = {
        collection: (name) => new Proxy(db.collection(name), { get: (target, prop) => {
            if (prop === 'updateOne') return async (query, update, options) => {
                if (fault?.(name, query, update)) { fault = null; throw new Error('injected database failure'); }
                return target.updateOne(query, update, options);
            };
            return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
        } }),
        ensureIndexes: (coll, ...indexes) => coll.createIndexes(indexes),
    };
    const context = {
        db: database, on: (name, fn) => { (listeners[name] ||= []).push(fn); },
        i18n: { load() {} }, inject() {}, Route() {}, injectUI() {},
    };
    document = load('packages/hydrooj/src/model/document.ts', {
        '../error': errors, '../service/db': database, '../service/bus': bus,
        '../utils': { buildProjection: (fields) => Object.fromEntries(fields.map((f) => [f, 1])) },
    });
    contest = load('packages/hydrooj/src/model/contest.ts', {
        '../error': errors, '../service/db': database, '../service/bus': bus, './document': document,
        './builtin': { PERM, STATUS, STATUS_SHORT_TEXTS: {} }, './user': userModel,
        '../lib/avatar': () => '', '../lib/contest-participation': { hasTeamParticipation: async () => false },
        './problem': {}, './record': {}, './message': {}, '@hydrooj/utils/lib/utils': utils,
    });
    const problemApi = {
        PROJECTION_CONTEST_LIST: ['config'],
        getList: async (_domainId, pids) => Object.fromEntries(pids.map((pid) => [
            pid, { docId: pid, config: { type: testProblemType } },
        ])),
    };
    const api = { ContestModel: contest, DocumentModel: document, ProblemModel: problemApi, ObjectId, PERM, STATUS, ...utils, ...errors };
    // Proxy error exports are deliberately selected: spreading a Proxy doesn't enumerate them.
    Object.assign(api, { BadRequestError: errors.BadRequestError, ForbiddenError: errors.ForbiddenError });
    const structure = load('packages/hydrooj/src/builtin/course-management/model/structure.ts');
    load('packages/hydrooj/src/builtin/course-management/model/course.ts', { '../../../plugin-api': api, './structure': structure });
    assessment = load('packages/hydrooj/src/builtin/course-management/model/assessment.ts', { '../../../plugin-api': api });
    const plugin = load('packages/hydrooj/src/builtin/course-management/index.ts', {
        '../../plugin-api': api, '../../lib/referenceCode': {}, './model/course': {},
        './model/assessment': assessment, './handler/class': {}, './handler/course': {},
    });
    await plugin.apply(context, { enable: true });
    monitor = load('packages/hydrooj/src/model/contestMonitor.ts', { '../service/db': database, '../error': errors });
    await monitor.initializeMonitor(context);
    access = load('packages/hydrooj/src/lib/course-assessment-access.ts', {
        '../error': errors, '../model/builtin': { PERM }, '../model/contest': contest, '../model/user': userModel,
    });
    class Handler {}
    MonitorHandler = load('packages/hydrooj/src/handler/contest-monitor.ts', {
        '../error': errors, '../model/builtin': { PERM }, '../model/contest': { ...contest, getTeamVid: async () => team },
        '../model/contestMonitor': monitor, '../lib/course-assessment-access': access,
        '../service/server': { Handler, param: () => () => {}, Types: {} },
    }).ContestMonitorHandler;
});
after(async () => { await client?.close(); await mongod?.stop(); });
beforeEach(async () => {
    fault = null; groups = []; team = undefined; testProblemType = 'default';
    for (const name of ['document', 'document.status', 'contest.monitor', 'contest.monitor.sessions']) await db.collection(name).deleteMany({});
});

const input = (eventType, sequence, extra = {}) => ({ domainId: 'test', contestTid: new ObjectId('0123456789abcdef01234567'),
    uid: 42, sessionId: 'session-123456', pageInstanceId: 'page-123456', eventType, sequence, ...extra });

for (const stage of ['session-transition', 'event-commit', 'session-clear']) {
    test(`monitor retries recover a failure at ${stage} without repeating the transition`, async () => {
        await monitor.recordEvent(input('page_hidden', 1, { clientAt: new Date(100000) }));
        fault = (name, query, update) => stage === 'session-transition'
            ? name.endsWith('.sessions') && !!update.$set?.pendingEvent
            : stage === 'event-commit' ? name === 'contest.monitor' && !!update.$set?.processedAt
                : name.endsWith('.sessions') && update.$unset && Object.hasOwn(update.$unset, 'pendingEvent');
        const visible = input('page_visible', 2, { clientAt: new Date(105000) });
        await assert.rejects(monitor.recordEvent(visible), /injected database failure/);
        await monitor.recordEvent(visible);
        await monitor.recordEvent(input('page_hidden', 3, { clientAt: new Date(110000) }));
        await monitor.recordEvent(visible);
        const event = await monitor.events.findOne({ sequence: 2 });
        assert.equal(event.durationMs, 5000);
        const session = await monitor.sessions.findOne({});
        assert.equal(session.hiddenSince.getTime(), 110000);
        assert.equal(session.pendingEvent, undefined);
        assert.equal(await monitor.events.countDocuments({}), 3);
    });
}
test('concurrent retries commit one event and preserve the new page sequence', async () => {
    await Promise.all(Array.from({ length: 12 }, () => monitor.recordEvent(input('page_hidden', 1))));
    await monitor.recordEvent(input('paste_detected', 1, { pageInstanceId: 'next-page-123456' }));
    assert.equal(await monitor.events.countDocuments({}), 2);
    assert.equal(await monitor.sessions.countDocuments({}), 1);
    assert.equal((await monitor.sessions.findOne({})).pendingEvent, undefined);
});
test('heartbeats remain bounded and do not clear an unfinished hidden interval', async () => {
    await monitor.recordEvent(input('page_hidden', 1));
    for (let sequence = 2; sequence < 15; sequence++) await monitor.recordEvent(input('heartbeat', sequence));
    assert.equal(await monitor.events.countDocuments({}), 1);
    assert.equal(await monitor.sessions.countDocuments({}), 1);
    assert.ok((await monitor.sessions.findOne({})).hiddenSince);
});
test('reusing an event identity with a different event type is rejected', async () => {
    await monitor.recordEvent(input('page_hidden', 1));
    await assert.rejects(monitor.recordEvent(input('page_visible', 1)), errors.BadRequestError);
});

async function monitoredContest(extra = {}) {
    const now = Date.now();
    const tid = await contest.add('test', 'Exam', '', 7, 'oi', new Date(now - 10000), new Date(now + 600000), [1], false,
        { monitorMode: 'browser', ...extra });
    return tid;
}
function handler(uid = 42) {
    const h = new MonitorHandler(); h.user = actor(uid); h.response = {}; h.limitRate = async () => {}; return h;
}
test('an admitted team member is monitored under their actual user ID', async () => {
    team = -100;
    const tid = await monitoredContest({ allowTeam: true });
    await contest.setStatus('test', tid, team, { attend: 1, members: [42] });
    const h = handler();
    await h.post('test', tid, 'paste_detected', 'session-123456', 'page-123456', 1);
    assert.equal(h.response.body.ok, true);
    assert.equal((await monitor.events.findOne({})).uid, 42);
});
test('nonparticipants, expired individual duration and outsiders cannot report events', async () => {
    const tid = await monitoredContest({ duration: 0.001 });
    await assert.rejects(handler().post('test', tid, 'heartbeat', 'session-123456', 'page-123456', 1), errors.ContestNotAttendedError);
    await contest.setStatus('test', tid, 42, { attend: 1, startAt: new Date(Date.now() - 60000) });
    await assert.rejects(handler().post('test', tid, 'heartbeat', 'session-123456', 'page-123456', 1), errors.ForbiddenError);
    await contest.edit('test', tid, { assign: ['another-class'] });
    await assert.rejects(handler().post('test', tid, 'heartbeat', 'session-123456', 'page-123456', 1), errors.ForbiddenError);
});
test('only authorized invigilators can read monitoring records; stale sessions are excluded', async () => {
    const tid = await monitoredContest();
    await assert.rejects(handler().get('test', tid), errors.ForbiddenError);
    const h = handler(7);
    await db.collection('contest.monitor.sessions').insertOne({ domainId: 'test', contestTid: tid, lastSeenAt: new Date(0) });
    await h.get('test', tid);
    assert.equal(h.response.body.sessions.length, 0);
});

async function courseFixture(rule = 'oi', future = true, passScore = 1) {
    const now = Date.now();
    const tid = await contest.add('test', 'Course', '', 7, 'course', new Date(now - 7200000), new Date(now + 7200000), [], false,
        { assign: ['class-a'], dagRevision: 1 });
    const dag = [{ _id: 1, title: 'Test', pids: [1], kind: 'assessment', assessment: {
        rule, passScore, beginAt: new Date(now + (future ? 600000 : -3600000)).toISOString(),
        endAt: new Date(now + (future ? 1200000 : -600000)).toISOString(), monitorMode: 'browser',
    } }];
    await contest.edit('test', tid, { dag });
    const course = await contest.get('test', tid);
    const exam = await contest.get('test', new ObjectId(course.dag[0].assessment.contestTid));
    return { course, exam };
}
test('classroom monitor rejects file-only questions before writing a contest', async () => {
    testProblemType = 'submit_answer';
    await assert.rejects(courseFixture(), /课堂测试监控模式不支持文件提交题/);
    assert.equal(await document.coll.countDocuments({ sourceType: 'course_assessment' }), 0);
});
test('course synchronization is idempotent and updates class assignment and invigilators', async () => {
    const { course, exam } = await courseFixture();
    await contest.edit('test', course.docId, { title: 'Renamed', assign: ['class-b', '42'], maintainer: [9] });
    const synced = await contest.get('test', exam.docId);
    assert.equal(synced.title, 'Renamed - Test');
    assert.deepEqual(synced.assign, ['class-b', '42']);
    assert.deepEqual(synced.maintainer, [9]);
    assert.equal(synced.monitorMode, 'browser');
    assert.equal(synced.rated, false);
    assert.equal(await document.coll.countDocuments({ sourceType: 'course_assessment' }), 1);
});
test('course synchronization preserves explicit certification and invalidates changed classroom conditions', async () => {
    const { course, exam } = await courseFixture();
    const { resolveClassroomBinding, isClassroomBindingCurrent } = load('packages/hydrooj/src/lib/rating-v2/classroom.ts');
    const binding = await resolveClassroomBinding(db, exam);
    const ratingPolicy = { enabled: true, classroom: { courseSignature: binding.courseSignature } };
    await contest.edit('test', exam.docId, { ratingPolicy }, exam, ['sourceType', 'sourceCourseTid', 'sourceNodeId']);
    assert.equal(await isClassroomBindingCurrent(db, await contest.get('test', exam.docId)), true);
    await contest.edit('test', course.docId, { assign: ['class-b'] });
    const synced = await contest.get('test', exam.docId);
    assert.equal(synced.rated, false);
    assert.deepEqual(synced.ratingPolicy, ratingPolicy);
    assert.equal(await isClassroomBindingCurrent(db, synced), false);
    await assert.rejects(contest.edit('test', exam.docId, { rated: true }), errors.ForbiddenError);
});
test('active classroom tests cannot change questions or rules, or enter Rating without certification', async () => {
    const { course, exam } = await courseFixture('oi', false);
    const changed = structuredClone(course.dag); changed[0].pids = [2];
    await assert.rejects(contest.edit('test', course.docId, { dag: changed }), errors.ForbiddenError);
    await assert.rejects(contest.edit('test', course.docId, { dag: [] }), errors.ForbiddenError);
    await assert.rejects(contest.edit('test', course.docId, { endAt: new Date(Date.now() - 700000) }), errors.BadRequestError);
    await assert.rejects(contest.edit('test', exam.docId, { rated: true }), errors.ForbiddenError);
    assert.deepEqual((await contest.get('test', course.docId)).dag[0].pids, [1]);
});
test('ended classroom tests can reopen, record the editor and recalculate ACM time', async () => {
    const { course, exam } = await courseFixture('acm', false);
    const rid = ObjectId.createFromTime(Math.floor((exam.beginAt.getTime() + 1200000) / 1000));
    await contest.attend('test', exam.docId, 42);
    await contest.updateStatus('test', exam.docId, 42, rid, 1, { status: STATUS.STATUS_ACCEPTED, score: 100 });
    const before = await contest.getStatus('test', exam.docId, 42);
    const dag = structuredClone(course.dag);
    dag[0].assessment.beginAt = new Date(exam.beginAt.getTime() - 600000).toISOString();
    dag[0].assessment.endAt = new Date(Date.now() + 600000).toISOString();
    await contest.editIfAssigned('test', course.docId, course.assign, { dag }, {}, 9);
    const reopened = await contest.get('test', exam.docId);
    const after = await contest.getStatus('test', exam.docId, 42);
    assert.equal(reopened.docId.toString(), exam.docId.toString());
    assert.equal(after.time, before.time + 600);
    assert.equal(contest.isOngoing(reopened), true);
    assert.equal(reopened.timeChangeHistory.length, 1);
    const entry = reopened.timeChangeHistory[0];
    assert.equal(entry.uid, 9);
    assert.equal(entry.state, 'ended');
    assert.equal(entry.attend, 1);
    assert.equal(entry.before.beginAt.getTime(), exam.beginAt.getTime());
    assert.equal(entry.after.endAt.toISOString(), dag[0].assessment.endAt);
    assert.equal((await assessment.getAssessmentResults('test', await contest.get('test', course.docId), 42))[1].completed, false);
    await contest.edit('test', course.docId, { title: 'Unrelated edit' });
    assert.equal((await contest.get('test', exam.docId)).timeChangeHistory.length, 1);
});
test('classroom time correction to the future keeps question and deletion protections', async () => {
    const { course, exam } = await courseFixture('oi', false);
    const dag = structuredClone(course.dag);
    dag[0].assessment.beginAt = new Date(Date.now() + 600000).toISOString();
    dag[0].assessment.endAt = new Date(Date.now() + 1200000).toISOString();
    await contest.edit('test', course.docId, { dag }, undefined, [], 7);
    const changed = structuredClone(dag); changed[0].pids = [2];
    await assert.rejects(contest.edit('test', course.docId, { dag: changed }), errors.ForbiddenError);
    const newRule = structuredClone(dag); newRule[0].assessment.rule = 'acm';
    await assert.rejects(contest.edit('test', course.docId, { dag: newRule }), errors.ForbiddenError);
    await assert.rejects(contest.edit('test', course.docId, { dag: [] }), errors.ForbiddenError);
    assert.equal((await contest.get('test', exam.docId)).timeChangeHistory[0].uid, 7);
});
test('contest time changes are atomic, keep history and reject stale editors', async () => {
    const tid = await monitoredContest();
    await contest.edit('test', tid, { rated: true });
    const original = await contest.get('test', tid);
    const firstEnd = new Date(original.endAt.getTime() + 600000);
    await contest.edit('test', tid, { endAt: firstEnd }, original, [], 7);
    await assert.rejects(contest.edit('test', tid, {
        endAt: new Date(firstEnd.getTime() + 600000),
    }, original, [], 9), errors.BadRequestError);
    const first = await contest.get('test', tid);
    assert.equal(first.endAt.getTime(), firstEnd.getTime());
    assert.equal(first.timeChangeHistory.length, 1);
    assert.equal(first.timeChangeHistory[0].ratingEnabled, true);
    await contest.edit('test', tid, { endAt: firstEnd }, undefined, [], 9);
    assert.equal((await contest.get('test', tid)).timeChangeHistory.length, 1);
    // findOneAndUpdate is one operation: reject a failed conditional write without an audit append.
    const failed = await contest.editIfAssigned('test', tid, ['missing-group'], {
        endAt: new Date(firstEnd.getTime() + 600000),
    }, {}, 9);
    assert.equal(failed, null);
    assert.equal((await contest.get('test', tid)).timeChangeHistory.length, 1);
    await contest.edit('test', tid, { duration: 1 }, undefined, [], 9);
    const second = await contest.get('test', tid);
    assert.equal(second.timeChangeHistory.length, 2);
    assert.equal(second.timeChangeHistory[1].uid, 9);
    assert.equal(second.timeChangeHistory[1].before.endAt.getTime(), firstEnd.getTime());
    assert.equal(second.timeChangeHistory[1].after.duration, 1);
});
test('classroom time changes retain certification evidence and flag it for review', async () => {
    const { course, exam } = await courseFixture();
    const { resolveClassroomBinding, isClassroomBindingCurrent } = load('packages/hydrooj/src/lib/rating-v2/classroom.ts');
    const binding = await resolveClassroomBinding(db, exam);
    const ratingPolicy = { enabled: true, classroom: { courseSignature: binding.courseSignature } };
    await contest.edit('test', exam.docId, { ratingPolicy });
    const dag = structuredClone(course.dag);
    dag[0].assessment.endAt = new Date(exam.endAt.getTime() + 600000).toISOString();
    await contest.edit('test', course.docId, { dag }, undefined, [], 9);
    const synced = await contest.get('test', exam.docId);
    assert.equal(await isClassroomBindingCurrent(db, synced), false);
    assert.deepEqual(synced.ratingPolicy, ratingPolicy);
    assert.equal(synced.timeChangeHistory[0].ratingEnabled, true);
});

test('failed classroom recalculation persists across saves and is recovered only by manual retry', async () => {
    const { course, exam } = await courseFixture('acm', false);
    const rid = ObjectId.createFromTime(Math.floor((exam.beginAt.getTime() + 1200000) / 1000));
    await contest.attend('test', exam.docId, 42);
    await contest.updateStatus('test', exam.docId, 42, rid, 1, { status: STATUS.STATUS_ACCEPTED, score: 100 });
    const before = await contest.getStatus('test', exam.docId, 42);
    const dag = structuredClone(course.dag);
    dag[0].assessment.beginAt = new Date(exam.beginAt.getTime() - 600000).toISOString();
    const original = document.revSetStatus;
    let attempts = 0;
    document.revSetStatus = async () => { attempts++; throw new Error('injected recalculation failure'); };
    try {
        await contest.edit('test', course.docId, { dag }, undefined, [], 9);
        await contest.edit('test', course.docId, { dag }, undefined, [], 9);
        assert.equal(attempts, 1, 'an unrelated save must not automatically retry a failed attempt');
    } finally { document.revSetStatus = original; }
    const failed = await contest.get('test', exam.docId);
    assert.equal(failed.statsRecalc.state, 'failed');
    assert.equal(failed.statsRecalc.settingsSaved, true);
    assert.equal(failed.statsRevision, 1);
    assert.equal(failed.timeChangeHistory.length, 1);
    assert.equal(failed.beginAt.toISOString(), dag[0].assessment.beginAt);
    const pending = (await assessment.getAssessmentResults('test', await contest.get('test', course.docId), 42))[1];
    assert.equal(pending.updating, true);
    assert.equal(pending.score, null);
    // Reload the model without any process-local state to reproduce recovery after restart.
    const restarted = reloadContestModel();
    await restarted.recalcStatus('test', exam.docId, failed.statsRevision);
    const recovered = await contest.get('test', exam.docId);
    assert.equal(recovered.statsRecalc, undefined);
    assert.equal(recovered.timeChangeHistory.length, 1);
    assert.equal((await contest.getStatus('test', exam.docId, 42)).time, before.time + 600);
    await restarted.recalcStatus('test', exam.docId, recovered.statsRevision);
    assert.equal((await contest.get('test', exam.docId)).timeChangeHistory.length, 1);
});

test('an old judge statistics write cannot overwrite recalculation for a newer start time', async () => {
    const { course, exam } = await courseFixture('acm', false);
    const rid = ObjectId.createFromTime(Math.floor((exam.beginAt.getTime() + 1200000) / 1000));
    await contest.attend('test', exam.docId, 42);
    await contest.updateStatus('test', exam.docId, 42, rid, 1, { status: STATUS.STATUS_ACCEPTED, score: 100 });
    const before = await contest.getStatus('test', exam.docId, 42);
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    const original = document.revSetStatus;
    let pause = true;
    document.revSetStatus = async (...args) => {
        if (pause && args[5].statsRevision === 0) { pause = false; enter(); await resume; }
        return original(...args);
    };
    const judging = contest.updateStatus('test', exam.docId, 42, rid, 1, { status: STATUS.STATUS_ACCEPTED, score: 100 });
    try {
        await entered;
        const dag = structuredClone(course.dag);
        dag[0].assessment.beginAt = new Date(exam.beginAt.getTime() - 600000).toISOString();
        await contest.edit('test', course.docId, { dag }, undefined, [], 9);
        assert.equal((await contest.getStatus('test', exam.docId, 42)).time, before.time + 600);
        release();
        await judging;
        const after = await contest.getStatus('test', exam.docId, 42);
        assert.equal(after.time, before.time + 600);
        assert.equal(after.statsRevision, 1);
        assert.equal((await contest.get('test', exam.docId)).statsRecalc, undefined);
    } finally { release(); document.revSetStatus = original; await judging; }
});

test('a superseded recalculation cannot clear a newer configuration attempt', async () => {
    const { course, exam } = await courseFixture('oi', false);
    await contest.attend('test', exam.docId, 42);
    await contest.updateStatus('test', exam.docId, 42, new ObjectId(), 1, { status: STATUS.STATUS_ACCEPTED, score: 80 });
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    const original = document.revSetStatus;
    let pause = true;
    document.revSetStatus = async (...args) => {
        if (pause && args[5].statsRevision === 1) { pause = false; enter(); await resume; }
        return original(...args);
    };
    const first = structuredClone(course.dag);
    first[0].assessment.endAt = new Date(Date.now() + 600000).toISOString();
    const saving = contest.edit('test', course.docId, { dag: first }, undefined, [], 9);
    try {
        await entered;
        const second = structuredClone(first);
        second[0].assessment.endAt = new Date(Date.now() + 1200000).toISOString();
        await contest.edit('test', course.docId, { dag: second }, undefined, [], 9);
        release();
        await saving;
        const latest = await contest.get('test', exam.docId);
        assert.equal(latest.statsRevision, 2);
        assert.equal(latest.statsRecalc, undefined);
        assert.equal(latest.endAt.toISOString(), second[0].assessment.endAt);
        assert.equal((await contest.getStatus('test', exam.docId, 42)).statsRevision, 2);
        assert.equal(latest.timeChangeHistory.length, 2);
    } finally { release(); document.revSetStatus = original; await saving; }
});

test('a preparation failure keeps the old time and can recover without inventing a time history entry', async () => {
    const { exam } = await courseFixture('oi', false);
    const original = document.collStatus.updateMany;
    document.collStatus.updateMany = async () => { throw new Error('injected preparation failure'); };
    try {
        await assert.rejects(contest.edit('test', exam.docId, {
            endAt: new Date(Date.now() + 600000),
        }, exam, [], 9), /injected preparation failure/);
    } finally { document.collStatus.updateMany = original; }
    const interrupted = await contest.get('test', exam.docId);
    assert.equal(interrupted.endAt.getTime(), exam.endAt.getTime());
    assert.equal(interrupted.statsRecalc.state, 'failed');
    assert.equal(interrupted.statsRecalc.settingsSaved, false);
    assert.equal(interrupted.timeChangeHistory, undefined);
    await contest.recalcStatus('test', exam.docId, 0);
    const recovered = await contest.get('test', exam.docId);
    assert.equal(recovered.statsRecalc, undefined);
    assert.equal(recovered.endAt.getTime(), exam.endAt.getTime());
    assert.equal(recovered.timeChangeHistory, undefined);
});

test('conditional statistics write misses are retried and cannot silently complete a recalculation', async () => {
    const tid = await monitoredContest();
    await contest.attend('test', tid, 42);
    const original = document.revSetStatus;
    let calls = 0;
    document.revSetStatus = async (...args) => {
        if (++calls <= 2) return null;
        return original(...args);
    };
    try { await contest.recalcStatus('test', tid); } finally { document.revSetStatus = original; }
    assert.equal(calls, 3);
    assert.equal((await contest.get('test', tid)).statsRecalc, undefined);
    document.revSetStatus = async () => null;
    try {
        await assert.rejects(contest.recalcStatus('test', tid), errors.BadRequestError);
    } finally { document.revSetStatus = original; }
    assert.equal((await contest.get('test', tid)).statsRecalc.state, 'failed');
    await contest.recalcStatus('test', tid);
    assert.equal((await contest.get('test', tid)).statsRecalc, undefined);
});

test('a concurrent judge failure cannot be hidden by successful completion of another recalculation writer', async () => {
    const { exam } = await courseFixture('oi', false);
    const rid = new ObjectId();
    for (const uid of [42, 43]) {
        await contest.attend('test', exam.docId, uid);
        await contest.updateStatus('test', exam.docId, uid, rid, 1, { status: STATUS.STATUS_WRONG_ANSWER, score: 80 });
    }
    await contest.edit('test', exam.docId, { endAt: new Date(Date.now() + 600000) });
    let enter43, done42, release;
    const paused43 = new Promise((resolve) => { enter43 = resolve; });
    const updated42 = new Promise((resolve) => { done42 = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    const original = document.revSetStatus;
    let fail42 = false;
    document.revSetStatus = async (...args) => {
        if (args[3] === 43) { enter43(); await resume; }
        if (args[3] === 42 && fail42) throw new Error('injected concurrent judge failure');
        const result = await original(...args);
        if (args[3] === 42) done42();
        return result;
    };
    const recalc = contest.recalcStatus('test', exam.docId);
    try {
        await Promise.all([paused43, updated42]);
        fail42 = true;
        await assert.rejects(contest.updateStatus('test', exam.docId, 42, rid, 1, {
            status: STATUS.STATUS_WRONG_ANSWER, score: 20,
        }), /injected concurrent judge failure/);
        release();
        await assert.rejects(recalc, errors.BadRequestError);
        const failed = await contest.get('test', exam.docId);
        assert.equal(failed.statsRecalc.state, 'failed');
        assert.equal(contest.isStatsReady(failed, await contest.getStatus('test', exam.docId, 42)), false);
    } finally { release(); document.revSetStatus = original; await recalc.catch(() => {}); }
    await contest.recalcStatus('test', exam.docId);
    const current = await contest.get('test', exam.docId);
    const status = await contest.getStatus('test', exam.docId, 42);
    assert.equal(status.score, 20);
    assert.equal(status.statsJournalRevision, status.rev);
    assert.equal(contest.isStatsReady(current, status), true);
    assert.equal(contest.isStatsReady(current), true, 'a teacher without an exam enrollment is not permanently shown as updating');
});

test('manual recovery supersedes an interrupted running attempt without leaving per-user read fences', async () => {
    const { exam } = await courseFixture('oi', false);
    await contest.attend('test', exam.docId, 42);
    await contest.updateStatus('test', exam.docId, 42, new ObjectId(), 1, { status: STATUS.STATUS_ACCEPTED, score: 80 });
    await contest.edit('test', exam.docId, { endAt: new Date(Date.now() + 600000) });
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    const original = document.revSetStatus;
    let pause = true;
    document.revSetStatus = async (...args) => {
        if (pause) { pause = false; enter(); await resume; }
        return original(...args);
    };
    const interrupted = contest.recalcStatus('test', exam.docId);
    try {
        await entered;
        const running = await contest.get('test', exam.docId);
        assert.equal(running.statsRecalc.state, 'running');
        assert.equal(running._assessmentStatusUpdates?.[42], undefined);
        const restarted = reloadContestModel();
        await restarted.recalcStatus('test', exam.docId, running.statsRevision);
        release();
        await assert.rejects(interrupted, errors.BadRequestError);
        const recovered = await contest.get('test', exam.docId);
        const status = await contest.getStatus('test', exam.docId, 42);
        assert.equal(recovered.statsRecalc, undefined);
        assert.equal(recovered._assessmentStatusUpdates?.[42], undefined);
        assert.equal(contest.isStatsReady(recovered, status), true);
    } finally { release(); document.revSetStatus = original; await interrupted.catch(() => {}); }
});
test('certification rejects a concurrent frozen configuration change before writing the policy', async () => {
    const tid = await monitoredContest({ langs: ['cpp'] });
    const expected = await contest.get('test', tid);
    await contest.edit('test', tid, { langs: ['python'] });
    await assert.rejects(
        contest.edit('test', tid, { ratingPolicy: { enabled: true } }, expected, ['langs', 'keepScoreboardHidden']),
        errors.BadRequestError,
    );
    assert.equal((await contest.get('test', tid)).ratingPolicy, undefined);
    const current = await contest.get('test', tid);
    await contest.edit('test', tid, { ratingPolicy: { enabled: true } }, current, ['langs', 'keepScoreboardHidden']);
    assert.equal((await contest.get('test', tid)).ratingPolicy.enabled, true);
});
test('removing an unused future test deletes its contest and monitor data', async () => {
    const { course, exam } = await courseFixture();
    await monitor.recordEvent(input('paste_detected', 1, { contestTid: exam.docId }));
    await contest.edit('test', course.docId, { dag: [] });
    assert.equal(await document.coll.countDocuments({ sourceType: 'course_assessment' }), 0);
    assert.equal(await monitor.events.countDocuments({ contestTid: exam.docId }), 0);
});
test('recovery reuses an existing contest even when the parent binding write was interrupted', async () => {
    const { course, exam } = await courseFixture();
    const dag = structuredClone(course.dag); delete dag[0].assessment.contestTid;
    await document.coll.updateOne({ docId: course.docId }, { $set: { dag } });
    await contest.edit('test', course.docId, { title: 'Retry' });
    assert.equal((await contest.get('test', course.docId)).dag[0].assessment.contestTid, exam.docId.toString());
    assert.equal(await document.coll.countDocuments({ sourceType: 'course_assessment' }), 1);
});
for (const rule of ['acm', 'oi', 'ioi', 'strictioi']) {
    test(`${rule} uses finalized results and the correct passing metric`, async () => {
        const { course, exam } = await courseFixture(rule, false, 1);
        const journal = [{ rid: ObjectId.createFromTime(Math.floor((exam.beginAt.getTime() + 1000) / 1000)),
            pid: 1, score: 100, status: STATUS.STATUS_ACCEPTED, subtasks: { 1: { score: 100, status: STATUS.STATUS_ACCEPTED } } }];
        const stat = contest.RULES[rule].stat(exam, journal);
        await contest.setStatus('test', exam.docId, 42, { attend: 1, journal, ...stat });
        const result = (await assessment.getAssessmentResults('test', course, 42))[1];
        assert.equal(result.score, rule === 'acm' ? 1 : 100);
        assert.equal(result.metric, rule === 'acm' ? 'accepted' : 'score');
        assert.equal(result.completed, true);
    });
}
test('OI scores remain hidden before the personal or global contest end', async () => {
    const { course, exam } = await courseFixture();
    await contest.setStatus('test', exam.docId, 42, { attend: 1, score: 100, journal: [{}] });
    const result = (await assessment.getAssessmentResults('test', course, 42))[1];
    assert.equal(result.score, null); assert.equal(result.completed, false);
});
test('classroom access requires parent enrollment, an unlocked chapter, and an active assignment', async () => {
    const { course, exam } = await courseFixture();
    groups = [{ name: 'class-a' }];
    await assert.rejects(access.assertCourseAssessmentAccess(actor(42), exam), errors.NotAssignedError);
    await contest.setStatus('test', course.docId, 42, { attend: 1, allow: { 1: false } });
    await assert.rejects(access.assertCourseAssessmentAccess(actor(42), exam), errors.NotAssignedError);
    await contest.setStatus('test', course.docId, 42, { allow: { 1: true } });
    await access.assertCourseAssessmentAccess(actor(42), exam);
    groups = [{ name: 'class-a', archive: true }];
    await assert.rejects(access.assertCourseAssessmentAccess(actor(42), exam), errors.NotAssignedError);
    assert.equal(await access.assertCourseAssessmentAccess(actor(7), exam), true);
});
test('a forged chapter binding does not grant access to another contest', async () => {
    const { course, exam } = await courseFixture();
    await document.coll.updateOne({ docId: course.docId }, { $set: { 'dag.0.assessment.contestTid': new ObjectId().toString() } });
    await assert.rejects(access.assertCourseAssessmentAccess(actor(7), exam), errors.NotAssignedError);
});

function clientHarness() {
    const html = fs.readFileSync(path.resolve(__dirname, '../packages/ui-default/templates/partials/contest_monitor_client.html'), 'utf8');
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    const storage = new Map(), listeners = new Map(), requests = [], intervals = new Map();
    let tick = 100000, timer = 0, uuid = 0;
    const target = {
        addEventListener(name, fn) { (listeners.get(name) || listeners.set(name, new Set()).get(name)).add(fn); },
        removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    };
    const window = { ...target, crypto: { randomUUID: () => `random-id-123456-${++uuid}` } };
    const document = { ...target, hidden: false, getElementById: () => null };
    vm.runInNewContext(script, {
        window, document, Date: { now: () => tick },
        sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, val) => storage.set(key, val) },
        fetch: (_, opts) => new Promise((resolve, reject) => requests.push({ body: JSON.parse(opts.body), resolve, reject })),
        setInterval: (fn) => { intervals.set(++timer, fn); return timer; }, clearInterval: (id) => intervals.delete(id),
    });
    const emit = (name, event = {}, elapsed = 1100) => { tick += elapsed; for (const fn of [...(listeners.get(name) || [])]) fn(event); };
    const queue = () => JSON.parse([...storage].find(([key]) => key.startsWith('hydro-monitor-queue:'))[1]);
    return { emit, queue, requests, intervals, listeners, window, document };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
test('a delayed ACK removes only its matching event after bounded queue overflow', async () => {
    const h = clientHarness();
    for (let i = 0; i < 125; i++) h.emit('paste');
    const before = h.queue(); assert.equal(before.length, 120);
    h.requests[0].resolve({ ok: true, json: async () => ({ ok: true }) }); await flush();
    const acknowledged = h.requests[0].body;
    assert.deepEqual(h.queue(), before.filter((event) => event.sequence !== acknowledged.sequence));
    assert.equal(h.requests[1].body.sequence, h.queue()[0].sequence);
});
test('page navigation preserves pending events and bfcache restores one set of listeners', async () => {
    const h = clientHarness(); h.emit('paste'); h.emit('pagehide');
    const pending = h.queue(); assert.ok(pending.some((event) => event.eventType === 'page_leave'));
    assert.equal(h.intervals.size, 0);
    h.requests[0].resolve({ ok: true, json: async () => ({ ok: true }) }); await flush();
    assert.deepEqual(h.queue(), pending);
    h.emit('pageshow', { persisted: true });
    assert.equal(h.intervals.size, 2); assert.equal(h.listeners.get('paste').size, 1);
    assert.equal(h.requests[1].body.sequence, pending[0].sequence);
});


test('class schedule updates shift future assessment windows and keep their binding', async () => {
    const { course, exam } = await courseFixture();
    await contest.edit('test', course.docId, { beginAt: new Date(course.beginAt.getTime() + 3600000) });
    const after = await contest.get('test', exam.docId);
    assert.equal(after.beginAt.getTime(), exam.beginAt.getTime() + 3600000);
    assert.equal(after.endAt.getTime(), exam.endAt.getTime() + 3600000);
    assert.equal((await contest.get('test', course.docId)).dag[0].assessment.contestTid, exam.docId.toString());
});

for (const [name, first, second, setState] of [
    ['visibilitychange', 'page_hidden', 'page_visible', (h, active) => { h.document.hidden = active; }],
    ['blur', 'window_blur', 'window_focus', () => {}],
    ['fullscreenchange', 'fullscreen_enter', 'fullscreen_exit', (h, active) => { h.document.fullscreenElement = active ? {} : null; }],
]) {
    test(`subsecond ${first} transitions survive retries and adjacent duplicates are ignored`, async () => {
        const h = clientHarness();
        const opposite = name === 'blur' ? 'focus' : name;
        setState(h, true); h.emit(name, {}, 0); h.emit(name, {}, 10);
        setState(h, false); h.emit(opposite, {}, 90);
        setState(h, true); h.emit(name, {}, 100);
        setState(h, false); h.emit(opposite, {}, 30000);
        assert.deepEqual(h.queue().filter((e) => e.eventType !== 'heartbeat').map((e) => e.eventType), [first, second, first, second]);
        h.requests[0].reject(new Error('offline')); await flush();
        for (const fn of h.intervals.values()) fn();
        assert.deepEqual(h.requests[1].body, h.requests[0].body);
        const queued = h.queue().filter((e) => e.eventType === first || e.eventType === second);
        for (const event of queued) await monitor.recordEvent(input(event.eventType, event.sequence, { clientAt: new Date(event.clientAt) }));
        const final = await monitor.events.findOne({ sequence: queued[3].sequence });
        if (first !== 'fullscreen_enter') assert.equal(final.durationMs, 30000);
        h.window.__contestMonitorCleanup();
    });
}
