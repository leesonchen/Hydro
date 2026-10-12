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
let mongod, client, db, document, contest, users, handlers, hooks, api, assessmentBarrier;
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
    const database = { collection: (name) => db.collection(name), ensureIndexes: (coll, ...indexes) => coll.createIndexes(indexes) };
    document = load('packages/hydrooj/src/model/document.ts', {
        '../service/db': database, '../service/bus': bus, '../error': errors, '../utils': utils,
    });
    users = load('packages/hydrooj/src/model/user.ts', {
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
    handlers = load('packages/hydrooj/src/builtin/course-management/handler/course.ts', {
        '../../../plugin-api': api, '../../../service/bus': bus,
        '../../../lib/classroomFeedbackAccess': { canManageFeedback: async () => false },
        '../../../lib/referenceCode': {}, '../../../model/classroomFeedback': { feedbackRepository: {} },
        '../../../model/feedback': {}, '../model/assessment': { getAssessmentResults: async () => { await assessmentBarrier?.(); return {}; } },
        '../model/course': courseModel, '../model/structure': structure,
        '../model/class': { ClassModel: { getGroupByName: async () => ({ students: [] }) } },
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
    storageWrites = 0; assessmentBarrier = undefined; users.cache.clear();
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
