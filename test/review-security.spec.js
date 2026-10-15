const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { before, after, beforeEach, test } = require('node:test');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
const ts = require('typescript');
const Koa = require('koa');
const request = require('supertest');

function load(file, mocks = {}) {
    const filename = path.resolve(__dirname, '..', file);
    const mod = new Module(filename, module);
    mod.filename = filename; mod.paths = module.paths;
    const nativeRequire = Module.createRequire(filename);
    mod.require = (name) => Object.hasOwn(mocks, name) ? mocks[name] : nativeRequire(name);
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
            experimentalDecorators: true, esModuleInterop: true },
    }).outputText, filename);
    return mod.exports;
}
const errors = new Proxy({}, { get: (obj, key) => obj[key] ||= class extends Error {} });
const { PERM } = load('packages/common/permission.ts');
const { STATUS } = load('packages/common/status.ts');
const bus = { on() {}, broadcast() {}, parallel: async () => {} };
const utils = { ArgMethod: (_, __, descriptor) => descriptor,
    buildProjection: (fields) => Object.fromEntries(fields.map((field) => [field, 1])),
    Counter: () => new Proxy({}, { get: (obj, key) => obj[key] || 0 }), Time: { hour: 3600000, day: 86400000 } };
let mongod, client, db, document, contest, users, handlers, hooks, api, assessment, assessmentBarrier, statusWriteBarrier;
let storageWrites;
const actor = (uid, perm = 0n) => ({ _id: uid, group: [],
    own: (doc, checkPerm) => (!checkPerm || (perm & checkPerm) === checkPerm)
        && (doc.owner === uid || doc.maintainer?.includes(uid)),
    hasPerm: (...items) => items.some((p) => (perm & p) === p) });
class Handler {
    checkPerm(...perms) { if (!this.user.hasPerm(...perms)) throw new errors.ForbiddenError(); }
    back() {} url() { return '/test'; } translate(text) { return text; }
}
const handler = (Type, user) => Object.assign(new Type(), {
    user, response: {}, request: { files: { file: { filepath: '/tmp/file', size: 10 } }, headers: {} },
    ctx: { setting: { get() {} } }, args: { domainId: 'd' }, renderHTML: async () => '',
});

before(async () => {
    global.Hydro ||= { model: {}, module: {} };
    Math.sum ||= (values) => values.reduce((sum, value) => sum + value, 0);
    mongod = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongod.getUri()); db = client.db('review-security');
    const database = { collection: (name) => new Proxy(db.collection(name), { get: (target, prop) => {
        if (name === 'document.status' && ['findOneAndUpdate', 'updateOne'].includes(prop)) return async (...args) => {
            await statusWriteBarrier?.(...args);
            return target[prop](...args);
        };
        return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
    } }), ensureIndexes: (coll, ...indexes) => coll.createIndexes(indexes) };
    document = load('packages/hydrooj/src/model/document.ts', {
        '../service/db': database, '../service/bus': bus, '../error': errors, '../utils': utils,
    });
    users = load('packages/hydrooj/src/model/user.ts', {
        '../lib/rating-publication-read': {
            projectUserRating: async (_domain, value) => value,
            projectUserRatings: async (_domain, values) => values,
            publicRatingStore: { active: async () => null },
        },
        '../service/db': database, '../service/bus': bus, '../error': errors, '../utils': utils,
        './builtin': { PERM, PRIV: {} }, '../lib/avatar': () => '', '../lib/hash.hydro': {},
        './domain': { getDomainUser: async (domainId) => ({ domainId, perm: PERM.PERM_ALL }), get: async () => null },
        './setting': { SETTINGS_BY_KEY: {}, DOMAIN_USER_SETTINGS_BY_KEY: {} }, './system': { get: () => '' }, './token': {},
    }).default;
    contest = load('packages/hydrooj/src/model/contest.ts', {
        '../service/db': database, '../service/bus': bus, '../error': errors, './document': document,
        './builtin': { PERM, STATUS, STATUS_SHORT_TEXTS: {} }, './user': users,
        '../lib/avatar': () => '', '../lib/contest-participation': { hasTeamParticipation: async () => false },
        './problem': {}, './record': {}, './message': {}, '@hydrooj/utils/lib/utils': utils,
    });
    api = { ...errors, ...utils, ContestModel: contest, DocumentModel: document, UserModel: { getListForRender: async () => ({}) },
        Handler, PERM, STATUS, ObjectId, PRIV: {}, _: require('lodash'), moment: require('moment'),
        param: () => () => {}, post: () => () => {}, Types: new Proxy({}, { get: () => () => {} }),
        ProblemModel: { getList: async () => ({}) }, SolutionModel: {}, OplogModel: { log: async () => {} },
        SystemModel: { get: (key) => key.endsWith('_size') ? 100000 : 100 }, sortFiles: (files) => files,
        StorageModel: { put: async () => storageWrites++, del: async () => storageWrites++,
            getMeta: async () => ({ size: 10 }), signDownloadLink: async () => '/file' },
    };
    for (const key of ['ForbiddenError', 'NotAssignedError', 'ValidationError', 'ContestNotFoundError', 'BadRequestError', 'ContestAlreadyAttendedError']) api[key] = errors[key];
    const structure = load('packages/hydrooj/src/builtin/course-management/model/structure.ts');
    const courseModel = load('packages/hydrooj/src/builtin/course-management/model/course.ts', { '../../../plugin-api': api, './structure': structure });
    assessment = load('packages/hydrooj/src/builtin/course-management/model/assessment.ts', { '../../../plugin-api': api });
    handlers = load('packages/hydrooj/src/builtin/course-management/handler/course.ts', {
        '../../../plugin-api': api, '../../../service/bus': bus,
        '../../../lib/classroomFeedbackAccess': { canManageFeedback: async () => false },
        '../../../lib/referenceCode': {}, '../../../model/classroomFeedback': { feedbackRepository: {} },
        '../../../model/feedback': {}, '../model/assessment': { ...assessment, getAssessmentResults: async (...args) => {
            const results = await assessment.getAssessmentResults(...args);
            await assessmentBarrier?.();
            return results;
        } },
        '../model/course': courseModel, '../model/structure': structure,
        '../model/class': { ClassModel: {
            getGroupByName: async () => ({ students: [] }), listGroup: async () => [],
        } },
    });
    hooks = {};
    const plugin = load('packages/hydrooj/src/builtin/course-management/index.ts', {
        '../../plugin-api': api, '../../lib/referenceCode': {}, './model/course': {},
        './model/assessment': {}, './handler/class': {}, './handler/course': handlers,
    });
    await plugin.apply({ db: database, on: (name, fn) => (hooks[name] ||= []).push(fn),
        i18n: { load() {} }, inject() {}, Route() {}, injectUI() {} }, {});
    await document.collStatus.createIndex({ domainId: 1, docType: 1, docId: 1, uid: 1 }, { unique: true });
});
after(async () => { await client?.close(); await mongod?.stop(); });
beforeEach(async () => {
    storageWrites = 0; assessmentBarrier = undefined; statusWriteBarrier = undefined; users.cache.clear();
    for (const name of ['document', 'document.status', 'user', 'user.group']) await db.collection(name).deleteMany({});
});
async function courseFixture(extra = {}) {
    const tid = new ObjectId();
    const course = { _id: tid, docId: tid, domainId: 'd', docType: 30, rule: 'course', owner: 1,
        maintainer: [3], assign: ['2'], pids: [], dag: [{ _id: 1, pids: [], title: 'open' }, { _id: 2, pids: [], title: 'closed' }],
        beginAt: new Date(0), endAt: new Date('2099-01-01'), attend: 1,
        lecture: { 1: 'OPEN', 2: 'UNRELEASED_SECRET' }, ...extra };
    await document.coll.insertOne(course);
    await document.collStatus.insertOne({ domainId: 'd', docType: 30, docId: tid, uid: 2,
        attend: 1, allow: { 1: true, 2: false }, progress: 0 });
    return course;
}
async function userFixture() {
    await users.coll.insertOne({ ...users.defaultUser, _id: 2, uname: 'Student', unameLower: 'student',
        mail: 'student@example.com', mailLower: 'student@example.com' });
}

test('user cache preserves each requested scope through all preload paths and concurrent reads', async () => {
    await userFixture();
    const read = PERM.PERM_VIEW_HOMEWORK, write = PERM.PERM_EDIT_HOMEWORK;
    for (const preload of [() => users.getById('d', 2), () => users.getByUname('d', 'student'),
        () => users.getByEmail('d', 'student@example.com'), () => users.getList('d', [2])]) {
        users.cache.clear(); await preload();
        const restricted = await users.getById('d', 2, read.toString());
        assert.equal(restricted.scope, read); assert.equal(restricted.hasPerm(write), false);
        const full = await users.getById('d', 2);
        assert.equal(full.hasPerm(write), true);
        const results = await Promise.all([users.getById('d', 2, read), users.getById('d', 2, read | write)]);
        assert.equal(results[0].hasPerm(write), false); assert.equal(results[1].hasPerm(write), true);
        assert.equal((await restricted.private()).hasPerm(write), false);
    }
    users.cache.clear(); await users.getById('d', 2, read);
    assert.equal((await users.getByUname('d', 'student')).hasPerm(write), true);
    users._deleteUserCache('d', true); assert.equal(users.cache.size, 0);
});

test('real HTTP Bearer middleware honors a restricted token after a full-scope cache warmup', async () => {
    await userFixture(); await users.getById('d', 2);
    const system = { get: (key) => key === 'server.ignoreUA' ? '' : key === 'server.cdn' || key === 'server.ws' ? '/' : 3600 };
    const base = load('packages/hydrooj/src/service/layers/base.ts', {
        '@hydrooj/utils': utils, '../../model/builtin': { PERM }, '../../model/domain': { getVersion: () => 1 }, '../../model/system': system,
        '../../model/token': { get: async (id) => ({ _id: id, uid: 2, scope: PERM.PERM_VIEW_HOMEWORK.toString(), updateAt: new Date() }), update: async () => {} },
    }).default;
    const userLayer = load('packages/hydrooj/src/service/layers/user.ts', {
        '../../model/builtin': { PERM, PRIV: {} }, '../../model/user': users,
    }).default;
    const app = new Koa();
    app.use(async (ctx, next) => {
        ctx.domainId = 'd'; ctx.domainInfo = {}; ctx.originalPath = '/d/d/test'; ctx.params = {};
        ctx.HydroContext = { UiContext: {}, domain: {}, request: { headers: {}, ip: '127.0.0.1', secure: false, host: 'localhost' } };
        await next();
    });
    app.use(base); app.use(userLayer);
    app.use((ctx) => { ctx.status = ctx.HydroContext.user.hasPerm(PERM.PERM_EDIT_HOMEWORK) ? 200 : 403; });
    await request(app.callback()).get('/d/d/test').set('Authorization', 'Bearer readonly').expect(403);
});

test('course lists include teacher-maintained and student-enrolled courses as my courses', async () => {
    const course = await courseFixture({ assign: ['class-a'] });
    const t = handler(handlers.CourseMainHandler, actor(3, PERM.PERM_VIEW_HOMEWORK));
    await t.get('d');
    assert(JSON.stringify(t.response.body.myCourses).includes(course.docId.toString()));
    assert(!JSON.stringify(t.response.body.otherCourses).includes(course.docId.toString()));

    const enrolled = actor(2, PERM.PERM_VIEW_HOMEWORK);
    enrolled.group = ['class-a'];
    const s = handler(handlers.CourseMainHandler, enrolled);
    await s.get('d');
    assert(JSON.stringify(s.response.body.myCourses).includes(course.docId.toString()));

    const outsider = handler(handlers.CourseMainHandler, actor(4, PERM.PERM_VIEW_HOMEWORK));
    await outsider.get('d');
    assert(!JSON.stringify(outsider.response.body.myCourses).includes(course.docId.toString()));
});

test('SELF permission only bypasses assignment and release gates for owners and maintainers', async () => {
    const course = await courseFixture();
    const unrelated = actor(4, PERM.PERM_EDIT_HOMEWORK_SELF);
    for (const Type of [handlers.CourseLectureHandler, handlers.CourseDetailHandler]) {
        await assert.rejects(handler(Type, unrelated).prepare('d', course.docId), errors.NotAssignedError);
    }
    for (const uid of [1, 3]) {
        const h = handler(handlers.CourseLectureHandler, actor(uid, PERM.PERM_EDIT_HOMEWORK_SELF));
        await h.prepare('d', course.docId); await h.readableLecture('d', course.docId, 2, true);
    }
    const assignedSelf = handler(handlers.CourseLectureHandler, actor(2, PERM.PERM_EDIT_HOMEWORK_SELF));
    await assignedSelf.prepare('d', course.docId);
    await assert.rejects(assignedSelf.readableLecture('d', course.docId, 2), errors.ForbiddenError);
    await assert.rejects(assignedSelf.readableLecture('d', course.docId, 1, true), errors.ForbiddenError);
    await assert.rejects(handler(handlers.CourseFileDownloadHandler, unrelated).get('d', course.docId, 'a'), errors.ForbiddenError);
    await assert.rejects(handler(handlers.CourseScoreboardHandler, unrelated).get('d', course.docId, 0), errors.ForbiddenError);
    await assert.rejects(handler(handlers.CourseScoreboardHandler, unrelated).exportScoreboard('d', course.docId, 0, 'csv'), errors.ForbiddenError);
});

test('course edit requires the current scoped write permission even for owner/maintainer', async () => {
    const course = await courseFixture({ owner: 2 });
    await userFixture();
    // Warm the shared cache with full permission, then obtain the actual scoped user.
    await users.getById('d', 2);
    const scopedOwner = await users.getById('d', 2, PERM.PERM_VIEW_HOMEWORK.toString());
    assert.equal(scopedOwner.own(course), true);
    for (const currentUser of [scopedOwner, actor(3, PERM.PERM_VIEW_HOMEWORK)]) {
        const h = handler(handlers.CourseEditHandler, currentUser);
        assert.equal(handlers.canEditCourse(h, course), false);
        await assert.rejects(h.prepare('d', course.docId), errors.ForbiddenError);
    }
    await assert.rejects(
        handler(handlers.CourseEditHandler, actor(4, PERM.PERM_EDIT_HOMEWORK_SELF))
            .prepare('d', course.docId), errors.ForbiddenError,
    );
    for (const currentUser of [
        actor(2, PERM.PERM_EDIT_HOMEWORK_SELF),
        actor(3, PERM.PERM_EDIT_HOMEWORK_SELF),
        actor(5, PERM.PERM_EDIT_HOMEWORK),
    ]) {
        const h = handler(handlers.CourseEditHandler, currentUser);
        await h.prepare('d', course.docId);
        assert.equal(h.tdoc.docId.toString(), course.docId.toString());
    }
});

test('attachment writes reject students and unrelated SELF teachers before any side effect', async () => {
    for (const assign of [['2'], ['teachers']]) {
        const course = await courseFixture({ assign });
        for (const user of [actor(2), actor(4, PERM.PERM_EDIT_HOMEWORK_SELF), actor(1)]) {
            const h = handler(handlers.CourseLectureHandler, user);
            await assert.rejects(h.postUploadFile('d', course.docId, 'a.txt'), errors.ForbiddenError);
            await assert.rejects(h.postDeleteFiles('d', course.docId, ['a.txt']), errors.ForbiddenError);
        }
        assert.equal(storageWrites, 0);
        assert.equal((await contest.get('d', course.docId)).files, undefined);
        for (const user of [actor(1, PERM.PERM_EDIT_HOMEWORK_SELF), actor(3, PERM.PERM_EDIT_HOMEWORK_SELF), actor(5, PERM.PERM_EDIT_HOMEWORK)]) {
            const h = handler(handlers.CourseLectureHandler, user);
            await h.postUploadFile('d', course.docId, 'a.txt'); await h.postUploadFile('d', course.docId, 'a.txt');
            assert.equal((await contest.get('d', course.docId)).files.length, 1);
            await h.postDeleteFiles('d', course.docId, ['a.txt']);
        }
        storageWrites = 0;
    }
});

test('student lecture and detail responses omit unreleased content; response hooks also cover nested secondary exits', async () => {
    const course = await courseFixture();
    for (const Type of [handlers.CourseLectureHandler, handlers.CourseDetailHandler]) {
        const h = handler(Type, actor(2));
        await h.prepare('d', course.docId); await h.get('d', course.docId, 1);
        for (const hook of hooks['handler/after']) await hook(h);
        assert.equal(JSON.stringify(h.response.body).includes('UNRELEASED_SECRET'), false);
        if (Type === handlers.CourseLectureHandler) assert.equal(h.response.body.lecture, 'OPEN');
    }
    for (const user of [actor(2), actor(4, PERM.PERM_EDIT_HOMEWORK_SELF), actor(1, PERM.PERM_EDIT_HOMEWORK_SELF)]) {
        const h = { user, response: { body: { tdoc: course, cdocs: [course], grouped: { tdocs: [course] } } } };
        for (const hook of hooks['handler/after']) await hook(h);
        assert.equal(JSON.stringify(h.response.body).includes('UNRELEASED_SECRET'), user._id === 1);
    }
    assert.equal(course.lecture[2], 'UNRELEASED_SECRET');
});

for (const mutation of ['deny', 'cancel', 'cancel-rejoin', 'judge']) {
    test(`automatic progress preserves concurrent ${mutation} after reading attendance`, async () => {
        const course = await courseFixture({ dag: [{ _id: 1, pids: [], title: 'first' }, { _id: 2, pids: [], title: 'second' }, { _id: 3, pids: [10], title: 'auto' }], pids: [10] });
        let entered; const paused = new Promise((resolve) => { entered = resolve; });
        let release; const resume = new Promise((resolve) => { release = resolve; });
        assessmentBarrier = async () => { entered(); await resume; };
        const updating = handlers.updateAllowedNodes('d', course.docId, 2, course);
        await paused;
        if (mutation === 'deny') await contest.setStatus('d', course.docId, 2, { 'allow.1': false, 'allow.3': false });
        if (mutation.startsWith('cancel')) await contest.cancelAttend('d', course.docId, 2);
        if (mutation === 'cancel-rejoin') await contest.attend('d', course.docId, 2, { allow: { 1: false }, progress: 17 });
        if (mutation === 'judge') await contest.setStatus('d', course.docId, 2, { accept: { 0: 1 }, progress: 100 });
        release(); await updating;
        const status = await contest.getStatus('d', course.docId, 2);
        if (mutation === 'cancel') { assert.equal(status, null); assert.equal((await contest.get('d', course.docId)).attend, 0); }
        if (mutation === 'cancel-rejoin') { assert.equal(status.allow[3], undefined); assert.equal(status.progress, 17); assert.equal((await contest.get('d', course.docId)).attend, 1); }
        if (mutation === 'deny') { assert.equal(status.allow[1], false); assert.equal(status.allow[3], false); }
        if (mutation === 'judge') assert.equal(status.progress, 100);
    });
}


async function scoreGatedCourseFixture() {
    const course = await courseFixture({
        dag: [
            { _id: 1, title: 'prerequisite', pids: [10] },
            { _id: 2, title: 'score gated', pids: [], requireNids: [1],
                completeCondition: { type: 'score', value: 60 } },
        ],
        pids: [10],
    });
    await document.collStatus.updateOne(
        { domainId: 'd', docId: course.docId, uid: 2 },
        { $set: { allow: { 1: true }, score: { 0: 80, 1: 80 }, accept: { 0: 0, 1: 0 } } },
    );
    return course;
}

test('automatic unlock still opens a score-gated chapter when scores are unchanged', async () => {
    const course = await scoreGatedCourseFixture();
    await handlers.updateAllowedNodes('d', course.docId, 2, course);
    const status = await contest.getStatus('d', course.docId, 2);
    assert.equal(status.allow[2], true);
});

test('a stale score prerequisite cannot unlock after a partial-score downgrade without an AC change', async () => {
    const course = await scoreGatedCourseFixture();
    let entered;
    const paused = new Promise((resolve) => { entered = resolve; });
    let release;
    const resume = new Promise((resolve) => { release = resolve; });
    assessmentBarrier = async () => { entered(); await resume; };
    const updating = handlers.updateAllowedNodes('d', course.docId, 2, course);
    await paused;
    // The score changes from 80 to 20, while the accepted count stays at zero.
    await document.collStatus.updateOne(
        { domainId: 'd', docId: course.docId, uid: 2 },
        { $set: { score: { 0: 20, 1: 20 } } },
    );
    release();
    await updating;
    const status = await contest.getStatus('d', course.docId, 2);
    assert.equal(status.score[1], 20);
    assert.equal(status.accept[0], 0);
    assert.equal(status.allow[2], undefined);
});

async function assessmentGatedCourseFixture(condition = { type: 'all' }, rule = 'oi') {
    const examTid = new ObjectId();
    const course = await courseFixture({ pids: [], dag: [
        { _id: 1, kind: 'assessment', title: 'exam', pids: [10], assessment: {
            contestTid: examTid.toString(), rule, passScore: rule === 'acm' ? 1 : 60,
            beginAt: new Date(0).toISOString(), endAt: new Date(1).toISOString(),
        } },
        { _id: 2, title: 'gated lesson', pids: [], requireNids: [1], completeCondition: condition },
    ] });
    await document.coll.insertOne({ _id: examTid, docId: examTid, domainId: 'd', docType: 30,
        rule, owner: 1, pids: [10], attend: 1, sourceType: 'course_assessment',
        sourceCourseTid: course.docId, sourceNodeId: 1, beginAt: new Date(0), endAt: new Date(1) });
    const rid = new ObjectId();
    await document.collStatus.insertOne({ domainId: 'd', docType: 30, docId: examTid, uid: 2,
        attend: 1, rev: 1, score: 80, accept: 1,
        journal: [{ rid, pid: 10, score: 80, status: rule === 'acm' ? STATUS.STATUS_ACCEPTED : STATUS.STATUS_WRONG_ANSWER }] });
    await contest.setStatus('d', course.docId, 2, {
        allow: { 1: true }, progress: 100, assessmentResults: { 1: { score: rule === 'acm' ? 1 : 80, completed: true } },
    });
    return { course, examTid, rid };
}

function pauseNextAssessmentRead() {
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    assessmentBarrier = async () => { assessmentBarrier = undefined; enter(); await resume; };
    return { entered, release };
}

for (const mutation of ['judge-all', 'judge-problem', 'judge-score', 'judge-acm', 'set-score', 'recalc', 'cancel', 'cancel-rejoin', 'reopen']) {
    test(`a stale assessment prerequisite cannot grant access after ${mutation}`, async () => {
        const type = mutation === 'judge-problem' ? 'problem' : mutation === 'judge-score' ? 'score' : 'all';
        const condition = type === 'all' ? { type } : { type, value: type === 'score' ? 60 : 1 };
        const { course, examTid, rid } = await assessmentGatedCourseFixture(condition, mutation === 'judge-acm' ? 'acm' : 'oi');
        if (mutation === 'reopen') {
            await contest.edit('d', examTid, { endAt: new Date(Date.now() + 3600000) });
            await contest.recalcStatus('d', examTid);
            await contest.setStatus('d', examTid, 2, { endAt: new Date(1) });
        }
        const barrier = pauseNextAssessmentRead();
        const stale = handlers.updateAllowedNodes('d', course.docId, 2, course);
        await barrier.entered;
        try {
            if (mutation.startsWith('judge')) await contest.updateStatus('d', examTid, 2, rid, 10, { score: 20, status: STATUS.STATUS_WRONG_ANSWER });
            if (mutation === 'set-score') await contest.setStatus('d', examTid, 2, { score: 20 });
            if (mutation === 'recalc') {
                // A changed OI weight changes stats even though the journal itself is unchanged.
                await contest.edit('d', examTid, { score: { 10: 25 } });
                await contest.recalcStatus('d', examTid);
            }
            if (mutation.startsWith('cancel')) await contest.cancelAttend('d', examTid, 2);
            if (mutation === 'cancel-rejoin') await contest.attend('d', examTid, 2);
            if (mutation === 'reopen') {
                await contest.setStatus('d', examTid, 2, {}, { endAt: '' });
            }
            // Also reproduce the case where a newer progress request has already recorded failure.
            await handlers.updateAllowedNodes('d', course.docId, 2, course);
        } finally {
            barrier.release();
            await stale;
        }
        const status = await contest.getStatus('d', course.docId, 2);
        assert.equal(status.allow[2], undefined);
        assert.equal(status.assessmentResults[1].completed, false);
        assert.equal(status.progress, 0);
    });
}

test('a source downgrade fences a stale unlock even without another progress request', async () => {
    const { course, examTid, rid } = await assessmentGatedCourseFixture();
    const barrier = pauseNextAssessmentRead();
    const stale = handlers.updateAllowedNodes('d', course.docId, 2, course);
    await barrier.entered;
    try { await contest.updateStatus('d', examTid, 2, rid, 10, { score: 20, status: STATUS.STATUS_WRONG_ANSWER }); }
    finally { barrier.release(); await stale; }
    assert.equal((await contest.getStatus('d', course.docId, 2)).allow[2], undefined);
    await handlers.updateAllowedNodes('d', course.docId, 2, course);
    assert.equal((await contest.getStatus('d', course.docId, 2)).assessmentResults[1].score, 20);
});

test('a stale completed test cannot open a new chapter while its time update waits for recalculation', async () => {
    const { course, examTid } = await assessmentGatedCourseFixture();
    const barrier = pauseNextAssessmentRead();
    const stale = handlers.updateAllowedNodes('d', course.docId, 2, course);
    await barrier.entered;
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    const original = contest.recalcStatus;
    contest.recalcStatus = async (...args) => { enter(); await resume; return original(...args); };
    const dag = structuredClone(course.dag);
    dag[0].assessment.endAt = new Date(Date.now() + 3600000).toISOString();
    const saving = assessment.syncAssessmentContests('d', course.docId, dag, course.title, 1, course.assign, [], 1);
    try {
        await entered;
        assert.equal(contest.isOngoing(await contest.get('d', examTid)), true);
        barrier.release();
        await stale;
        assert.equal((await contest.getStatus('d', course.docId, 2)).allow[2], undefined);
        const pending = await handlers.updateAllowedNodes('d', course.docId, 2, course);
        assert.equal(pending[1].updating, true);
        assert.equal(pending[1].score, null);
        release();
        await saving;
        const result = await handlers.updateAllowedNodes('d', course.docId, 2, course);
        assert.equal(result[1].completed, false);
        assert.equal((await contest.getStatus('d', course.docId, 2)).allow[2], undefined);
    } finally { barrier.release(); release(); contest.recalcStatus = original; await saving; }
});

test('classroom manual retries require editing permission and an authoritative chapter binding', async () => {
    const { course, examTid } = await assessmentGatedCourseFixture();
    const denied = handler(handlers.CourseEditHandler, actor(2, PERM.PERM_DEFAULT));
    denied.tdoc = course;
    await assert.rejects(denied.postRetryRecalc('d', 1, 0), errors.ForbiddenError);
    const owner = handler(handlers.CourseEditHandler, actor(1, PERM.PERM_EDIT_HOMEWORK_SELF));
    owner.tdoc = course;
    owner.args.operation = 'retry_recalc';
    // Operation dispatch must not require the ordinary course form's title, dates and DAG fields.
    await owner.post({ domainId: 'd', operation: 'retry_recalc', nodeId: 1, statsRevision: 0 });
    await owner.postRetryRecalc('d', 1, 0);
    assert.equal((await contest.get('d', examTid)).statsRecalc, undefined);
    const foreign = new ObjectId();
    await document.coll.updateOne({ docId: examTid }, { $set: { sourceCourseTid: foreign } });
    await assert.rejects(owner.postRetryRecalc('d', 1, 0), errors.ForbiddenError);
});

test('reads during a judgement cannot unlock from old stats, including a new parent enrollment', async () => {
    const { course, examTid, rid } = await assessmentGatedCourseFixture();
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    statusWriteBarrier = async (filter) => {
        if (!filter.docId.equals(examTid) || filter.rev === undefined) return;
        statusWriteBarrier = undefined; enter(); await resume;
    };
    const judging = contest.updateStatus('d', examTid, 2, rid, 10, { score: 20, status: STATUS.STATUS_WRONG_ANSWER });
    await entered;
    try {
        assert.equal((await contest.getStatus('d', examTid, 2)).score, 80);
        for (const rejoin of [false, true]) {
            if (rejoin) {
                await contest.cancelAttend('d', course.docId, 2);
                await contest.attend('d', course.docId, 2, { allow: { 1: true } });
            }
            const results = await handlers.updateAllowedNodes('d', course.docId, 2, course);
            assert.equal(results[1].score, null);
            assert.equal((await contest.getStatus('d', course.docId, 2)).allow[2], undefined);
        }
    } finally { release(); await judging; }
    await handlers.updateAllowedNodes('d', course.docId, 2, course);
    assert.equal((await contest.getStatus('d', course.docId, 2)).allow[2], undefined);
    await contest.updateStatus('d', examTid, 2, rid, 10, { score: 80, status: STATUS.STATUS_WRONG_ANSWER });
    await handlers.updateAllowedNodes('d', course.docId, 2, course);
    const status = await contest.getStatus('d', course.docId, 2);
    assert.equal(status.allow[2], true);
    assert.equal(status.progress, 100);
    // A grant committed against a valid prerequisite remains valid after later rejudging.
    await contest.updateStatus('d', examTid, 2, rid, 10, { score: 20, status: STATUS.STATUS_WRONG_ANSWER });
    await handlers.updateAllowedNodes('d', course.docId, 2, course);
    assert.equal((await contest.getStatus('d', course.docId, 2)).allow[2], true);
});

test('overlapping assessment writes retain their own markers and preserve manual decisions', async () => {
    const { course, examTid } = await assessmentGatedCourseFixture();
    const releases = new Map();
    let enter;
    const entered = new Promise((resolve) => { enter = resolve; });
    statusWriteBarrier = async (filter, update) => {
        if (!filter.docId.equals(examTid) || update.$set?.score === undefined) return;
        await new Promise((resolve) => { releases.set(update.$set.score, resolve); if (releases.size === 2) enter(); });
    };
    const writes = [80, 20].map((score) => contest.setStatus('d', examTid, 2, { score }));
    await entered;
    try {
        assert.equal((await contest.get('d', examTid))._assessmentStatusUpdates[2].length, 2);
        releases.get(80)(); await writes[0];
        assert.equal((await assessment.getAssessmentResults('d', course, 2))[1].score, null);
        await contest.setStatus('d', course.docId, 2, { 'allow.2': false });
        await handlers.updateAllowedNodes('d', course.docId, 2, course);
        assert.equal((await contest.getStatus('d', course.docId, 2)).allow[2], false);
        await contest.setStatus('d', course.docId, 2, { 'allow.2': true });
    } finally { for (const release of releases.values()) release(); await Promise.all(writes); }
    assert.equal((await contest.get('d', examTid))._assessmentStatusUpdates[2], undefined);
    await handlers.updateAllowedNodes('d', course.docId, 2, course);
    assert.equal((await contest.getStatus('d', course.docId, 2)).allow[2], true);
});

test('a failed source write releases its marker and never recreates parent enrollment', async () => {
    const { course, examTid } = await assessmentGatedCourseFixture();
    await contest.cancelAttend('d', course.docId, 2);
    await assert.rejects(contest.attend('d', examTid, 2), errors.ContestAlreadyAttendedError);
    assert.equal(await contest.getStatus('d', course.docId, 2), null);
    assert.equal((await contest.get('d', examTid))._assessmentStatusUpdates[2], undefined);
    assert.equal((await assessment.getAssessmentResults('d', course, 2))[1].score, 80);
});

test('a failed final invalidation leaves uncertain assessment results unavailable', async () => {
    const { course, examTid } = await assessmentGatedCourseFixture();
    let invalidations = 0;
    statusWriteBarrier = async (filter, update) => {
        if (filter.docId.equals(course.docId) && update.$inc?._assessmentRevision && ++invalidations === 2) {
            throw new Error('injected final invalidation failure');
        }
    };
    await assert.rejects(contest.setStatus('d', examTid, 2, { score: 20 }), /injected final invalidation failure/);
    assert.equal((await contest.getStatus('d', examTid, 2)).score, 20);
    assert.equal((await assessment.getAssessmentResults('d', course, 2))[1].score, null);
    await handlers.updateAllowedNodes('d', course.docId, 2, course);
    assert.equal((await contest.getStatus('d', course.docId, 2)).allow[2], undefined);
});

test('HTTP attachment POSTs enforce the role matrix before storage and persist authorized replacement once', async () => {
    const course = await courseFixture();
    const roles = {
        student: actor(2), unrelated: actor(4, PERM.PERM_EDIT_HOMEWORK_SELF),
        owner: actor(1, PERM.PERM_EDIT_HOMEWORK_SELF), maintainer: actor(3, PERM.PERM_EDIT_HOMEWORK_SELF),
        admin: actor(5, PERM.PERM_EDIT_HOMEWORK),
    };
    const app = new Koa();
    app.use(async (ctx) => {
        const h = handler(handlers.CourseLectureHandler, roles[ctx.get('Authorization').slice(7)]);
        try {
            await h.prepare('d', course.docId);
            if (ctx.path === '/upload') await h.postUploadFile('d', course.docId, 'a.txt');
            else await h.postDeleteFiles('d', course.docId, ['a.txt']);
            ctx.body = { ok: true };
        } catch (error) {
            if (!(error instanceof errors.ForbiddenError || error instanceof errors.NotAssignedError)) throw error;
            ctx.status = 403;
        }
    });
    for (const role of ['student', 'unrelated']) {
        await request(app.callback()).post('/upload').set('Authorization', `Bearer ${role}`).expect(403);
        await request(app.callback()).post('/delete').set('Authorization', `Bearer ${role}`).expect(403);
    }
    assert.equal(storageWrites, 0);
    assert.equal((await contest.get('d', course.docId)).files, undefined);
    for (const role of ['owner', 'maintainer', 'admin']) {
        await request(app.callback()).post('/upload').set('Authorization', `Bearer ${role}`).expect(200);
        await request(app.callback()).post('/upload').set('Authorization', `Bearer ${role}`).expect(200);
        assert.equal((await contest.get('d', course.docId)).files.length, 1);
        await request(app.callback()).post('/delete').set('Authorization', `Bearer ${role}`).expect(200);
        assert.equal((await contest.get('d', course.docId)).files.length, 0);
    }
});

test('response projection preserves serializer dictionary identity and public metadata', () => {
    const dictionary = Object.assign(Object.create(null), { _teacher: { name: 'teacher' } });
    const response = { dictionary, date: new Date(), user: actor(2) };
    assert.equal(handlers.projectCourseResponse(response, { user: actor(2) }), response);
    assert.equal(response.dictionary, dictionary);
});
