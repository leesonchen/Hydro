const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { after, before, beforeEach, describe, it } = require('node:test');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { applyMiddleware, createStore } = require('redux');
const { thunk } = require('redux-thunk');
const reduxPromise = require('redux-promise-middleware').default;
const { JSDOM } = require('jsdom');
const Koa = require('koa');

function loadSource(relativePath, mocks = {}, globals = {}) {
    const filename = path.resolve(__dirname, '..', relativePath);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.ReactJSX,
            experimentalDecorators: true,
            esModuleInterop: true,
        },
    }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, {
        exports, global: { Hydro: { model: {} } }, Date, Array, Object, Set, Map, console,
        require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
        ...globals,
    }, { filename });
    return exports;
}

const { PERM, PRIV } = loadSource('packages/common/permission.ts');
const identityDecorator = (_target, _name, descriptor) => descriptor;
const errors = new Proxy({}, {
    get: (target, name) => target[name] ||= class extends Error {
        constructor(...args) { super(args.join(' ')); this.name = name; }
    },
});
const loggerErrors = [];
class Logger { error(error) { loggerErrors.push(error); } }
const avatar = (value) => `/avatar/${encodeURIComponent(value || 'default')}`;

describe('Private content feedback', () => {
    let mongod;
    let client;
    let db;
    let Message;
    let Feedback;
    let Domain;
    let HomeMessages;
    let ProblemDetail;
    let CourseLecture;
    let sourceProblem;
    let courseDoc;
    let courseStatus;
    let homeModule;
    let user;
    const broadcasts = [];

    before(async () => {
        mongod = await MongoMemoryServer.create();
        client = await MongoClient.connect(mongod.getUri());
        db = client.db('feedback-test');
        const database = {
            collection: (name) => db.collection(name),
            ensureIndexes: (collection, ...indexes) => collection.createIndexes(indexes),
        };
        user = {
            coll: db.collection('user'),
            inc: (uids, field, value) => db.collection('user').updateMany({ _id: { $in: uids } }, { $inc: { [field]: value } }),
            async getById(_domain, uid) {
                const actor = await user.coll.findOne({ _id: uid });
                return actor && {
                    ...actor,
                    hasPriv: (...privs) => privs.some((priv) => (actor.priv & priv) === priv),
                    hasPerm: (...perms) => perms.some((perm) => ((PERM.PERM_VIEW | PERM.PERM_VIEW_PROBLEM | PERM.PERM_VIEW_HOMEWORK) & perm) === perm),
                    own: (doc) => doc.owner === uid,
                    serialize: () => ({ _id: actor._id, uname: actor.uname }),
                };
            },
            async getList(_domain, uids) {
                return Object.fromEntries((await user.coll.find({ _id: { $in: uids } }).toArray()).map((actor) => [actor._id, actor]));
            },
            setById: (uid, values) => user.coll.updateOne({ _id: uid }, { $set: values }),
        };
        const listeners = {};
        const context = { on: (event, callback) => { (listeners[event] ||= []).push(callback); } };
        const bus = {
            broadcast: (event, to, mdoc) => broadcasts.push({ event, to, mdoc }),
            parallel: (event, ...args) => Promise.all((listeners[event] || []).map((callback) => callback(...args))),
        };
        Domain = loadSource('packages/hydrooj/src/model/domain.ts', {
            '../error': errors, '../service/db': database, '../service/bus': bus,
            '../utils': { ArgMethod: identityDecorator }, './builtin': { PRIV },
            './user': { ...user, deleteUserCache() {} },
        }).default;
        const messageModule = loadSource('packages/hydrooj/src/model/message.ts', {
            '../service/db': database,
            '../service/bus': bus,
            '../logger': { Logger },
            '../utils': { ArgMethod: identityDecorator },
            './builtin': { PRIV },
            './system': {},
            './user': user,
        });
        Message = messageModule.default;
        const feedbackModule = loadSource('packages/hydrooj/src/model/feedback.ts', {
            '../error': errors,
            '../lib/avatar': avatar,
            '../logger': { Logger },
            '../service/db': database,
            './builtin': { PRIV },
            './domain': Domain,
            './message': Message,
            './user': user,
        });
        Feedback = feedbackModule.default;
        await messageModule.apply();
        await feedbackModule.apply(context);
        const opcount = loadSource('packages/hydrooj/src/model/opcount.ts', { '../error': errors, '../service/db': database });
        await opcount.apply();
        const { Types } = loadSource('framework/framework/validator.ts');

        class Handler {
            checkPriv(priv) { if (!this.user.hasPriv(priv)) throw new errors.PrivilegeError(priv); }
            translate(text) { return text; }
            back(body) { this.response.body = body; }
            async limitRate(op, seconds, count) {
                this.limits.push({ op, seconds, count });
                await opcount.inc(op, String(this.user._id), seconds, count);
            }
        }
        homeModule = loadSource('packages/hydrooj/src/handler/home.ts', {
            '../context': {},
            '../error': errors,
            '../lib/avatar': avatar,
            '../lib/mail': {},
            '../lib/rating-publication-read': {},
            '../lib/verifyTFA': {},
            '../model/blacklist': {},
            '../model/builtin': { PRIV, PERM },
            '../model/contest': {},
            '../model/discussion': {},
            '../model/domain': {},
            '../model/feedback': Feedback,
            '../model/message': Message,
            '../model/oplog': {},
            '../model/problem': {},
            '../model/setting': {},
            '../model/storage': {},
            '../model/system': {},
            '../model/token': {},
            '../model/training': {},
            '../model/user': user,
            '../service/server': {
                Handler, Types, param: () => identityDecorator, query: () => identityDecorator,
                requireSudo: identityDecorator,
            },
            '../utils': {},
        });
        HomeMessages = homeModule.HomeMessagesHandler;
        const contest = {
            get: async () => courseDoc,
            getStatus: async () => courseStatus,
            setStatus: async (_domain, _tid, _uid, values) => { Object.assign(courseStatus, values); },
            isNotStarted: (doc) => doc.beginAt > new Date(),
            isDone: () => false,
        };
        const courseStructure = loadSource('packages/hydrooj/src/builtin/course-management/model/structure.ts');
        ProblemDetail = loadSource('packages/hydrooj/src/handler/problem.ts', {
            '../builtin/course-management/model/structure': courseStructure,
            '../lib/contest-practice': { isPracticeOpen: () => false, canSubmitPractice: async () => false },
            '../lib/course-assessment-access': { assertCourseAssessmentAccess: async () => false },
            '@hydrooj/utils/lib/search': {}, '@hydrooj/utils/lib/utils': {},
            '../context': {}, '../logger': { Logger }, '../error': errors,
            '../lib/referenceCode': {}, '../model/builtin': { PERM, PRIV, STATUS: {} },
            '../model/contest': contest, '../model/discussion': { count: async () => 0 },
            '../model/document': {}, '../model/domain': {}, '../model/feedback': Feedback,
            '../model/oplog': {}, '../model/problem': {
                get: async (domainId, pid) => domainId === 'alpha' && Number(pid) === 7 ? { ...sourceProblem, config: { ...sourceProblem.config } } : null,
                canViewBy: (doc, actor) => !doc.hidden || actor.own(doc) || actor.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN),
                getVisibleStatus: async () => null,
            },
            '../model/record': { STAT_QUERY: {} }, '../model/setting': { langs: {} }, '../model/solution': { count: async () => 0 },
            '../model/storage': {}, '../model/system': {}, '../model/user': user,
            '../service/server': {
                Handler, Types, param: () => identityDecorator, post: () => identityDecorator,
                query: () => identityDecorator, route: () => identityDecorator, Query: () => identityDecorator,
            },
            './contest': { ContestDetailBaseHandler: Handler },
        }).ProblemDetailHandler;
        const pluginApi = new Proxy({
            _: require('lodash'), ObjectId, Handler, Types, PRIV, PERM, STATUS: { STATUS_ACCEPTED: 1 },
            param: () => identityDecorator, post: () => identityDecorator,
            ContestModel: contest, UserModel: user,
            DocumentModel: { TYPE_CONTEST: 30, collStatus: {
                updateOne: async (_filter, update) => { Object.assign(courseStatus, update.$set); },
            } },
        }, { get: (target, name) => Object.hasOwn(target, name) ? target[name] : errors[name] });
        CourseLecture = loadSource('packages/hydrooj/src/builtin/course-management/handler/course.ts', {
            '../../../lib/referenceCode': {}, '../../../model/feedback': Feedback,
            '../../../lib/classroomFeedbackAccess': {}, '../../../model/classroomFeedback': {},
            '../model/structure': courseStructure,
            '../model/assessment': loadSource('packages/hydrooj/src/builtin/course-management/model/assessment.ts', {
                '../../../plugin-api': pluginApi,
            }),
            '../../../plugin-api': pluginApi, '../../../service/bus': {},
            '../model/class': {}, '../model/course': { DEFAULT_COURSE_LESSON_DURATION_HOURS: 3 },
        }, { console: { ...console, log() {} } }).CourseLectureHandler;
    });

    beforeEach(async () => {
        await Promise.all(['feedback', 'message', 'user', 'domain', 'domain.user', 'opcount'].map((name) => db.collection(name).deleteMany({})));
        await user.coll.insertMany([
            { _id: 10, uname: 'student', priv: PRIV.PRIV_USER_PROFILE },
            { _id: 11, uname: 'other student', priv: PRIV.PRIV_USER_PROFILE },
            { _id: 20, uname: 'domain owner', priv: PRIV.PRIV_USER_PROFILE },
            { _id: 21, uname: 'other domain owner', priv: PRIV.PRIV_USER_PROFILE },
            { _id: 30, uname: 'system admin', priv: PRIV.PRIV_USER_PROFILE | PRIV.PRIV_EDIT_SYSTEM },
            { _id: 31, uname: 'second system admin', priv: PRIV.PRIV_USER_PROFILE | PRIV.PRIV_EDIT_SYSTEM | PRIV.PRIV_SEND_MESSAGE },
            { _id: 32, uname: 'banned admin', priv: PRIV.PRIV_EDIT_SYSTEM },
        ]);
        await db.collection('domain').insertMany([{ _id: 'alpha', owner: 20 }, { _id: 'beta', owner: 21 }]);
        broadcasts.length = 0;
        loggerErrors.length = 0;
        sourceProblem = {
            _id: new ObjectId(), domainId: 'alpha', docId: 7, title: 'Example', owner: 20,
            hidden: false, content: 'Original statement', config: { type: 'default' }, data: [], additional_file: [],
        };
        courseDoc = {
            _id: new ObjectId(), docId: new ObjectId(), domainId: 'alpha', owner: 20,
            title: 'Course', rule: 'course', assign: ['10'], pids: [7],
            beginAt: new Date(Date.now() - 3600000),
            dag: [{ _id: 3, title: 'Chapter', lecture: 'Chapter', pids: [7] }],
        };
        courseStatus = { attend: 1, startAt: new Date(), allow: { 3: true }, lectureAllow: { 3: true } };
    });

    after(async () => {
        await client?.close();
        await mongod?.stop();
    });

    async function create(content = 'The example is incorrect.') {
        return Feedback.create('alpha', 10, { type: 'problem', pid: 7, title: 'P7. Example' }, content, 'quoted original');
    }

    async function handler(uid) {
        return Object.assign(new HomeMessages(), {
            user: await user.getById('system', uid), response: {}, limits: [],
            // Reply ownership must come from the thread, even when the message page is in another domain.
            args: { domainId: 'beta', uid: 11, to: [11], content: 'forged' },
        });
    }

    async function sourceHandler(HandlerClass, uid = 10) {
        return Object.assign(new HandlerClass(), {
            user: await user.getById('alpha', uid), response: {}, limits: [],
            domain: { _id: 'alpha', owner: 20 }, UiContext: {},
            ctx: { parallel: async () => {} }, args: { domainId: 'beta', to: [11] },
        });
    }

    it('uses the real problem and lecture access checks and rate limits before creating a feedback', async () => {
        const problem = await sourceHandler(ProblemDetail);
        sourceProblem.hidden = true;
        await assert.rejects(problem._prepare('alpha', 7), { name: 'PermissionError' });
        sourceProblem.hidden = false;
        await problem._prepare('alpha', 7);
        await problem.postFeedback('alpha', 'Problem issue');
        const first = await Feedback.get(problem.response.body.feedbackId);
        assert.equal(first.source.url, '/d/alpha/p/7');
        assert.equal(first.source.title, '7. Example');
        assert.equal(first.domainId, 'alpha');
        assert.equal(problem.limits.length, 2);

        const contextualProblem = await sourceHandler(ProblemDetail);
        contextualProblem.tdoc = courseDoc;
        contextualProblem.tsdoc = { ...courseStatus, allow: { 3: false } };
        await assert.rejects(contextualProblem._prepare('alpha', 7, courseDoc.docId), { name: 'ForbiddenError' });
        contextualProblem.tsdoc = courseStatus;
        courseDoc.beginAt = new Date(Date.now() + 3600000);
        await assert.rejects(contextualProblem._prepare('alpha', 7, courseDoc.docId), { name: 'ForbiddenError' });
        courseDoc.beginAt = new Date(Date.now() - 3600000);

        const lecture = await sourceHandler(CourseLecture);
        courseDoc.assign = ['11'];
        await assert.rejects(lecture.prepare('alpha', courseDoc.docId), { name: 'NotAssignedError' });
        courseDoc.assign = ['10'];
        await lecture.prepare('alpha', courseDoc.docId);
        courseStatus.lectureAllow[3] = false;
        await assert.rejects(lecture.readableLecture('alpha', courseDoc.docId, 3), { name: 'ForbiddenError' });
        await assert.rejects(lecture.postFeedback('alpha', courseDoc.docId, 3, 'Lecture issue'), { name: 'ForbiddenError' });
        courseStatus.lectureAllow[3] = true;
        await lecture.postFeedback('alpha', courseDoc.docId, 3, 'Lecture issue');
        const second = await Feedback.get(lecture.response.body.feedbackId);
        assert.equal(second.source.url, `/d/alpha/course/${courseDoc.docId}/lecture/3`);
        assert.equal(second.source.type, 'lecture');
        await assert.rejects(lecture.postFeedback('alpha', courseDoc.docId, 99, 'Missing chapter'), { name: 'ValidationError' });
        await problem.postFeedback('alpha', 'Third feedback');
        await assert.rejects(problem.postFeedback('alpha', 'Too many feedbacks'), { name: 'OpcountExceededError' });
        assert.equal(await Feedback.coll.countDocuments({}), 3);
    });

    it('creates feedback without granting private-message permission and copies active admins exactly once', async () => {
        const result = await create();
        assert.equal(Array.from(result.mdoc.to).sort().join(','), '20,30,31');
        assert.equal(result.mdoc.domainId, 'alpha');
        assert.equal(result.mdoc.from, 10);
        assert.equal((await user.coll.findOne({ _id: 10 })).priv, PRIV.PRIV_USER_PROFILE);
        const thread = await Feedback.get(result.feedbackId);
        assert.equal(thread.source.url, '/d/alpha/p/7');
        assert.equal(thread.quote, 'quoted original');
        assert.equal(broadcasts.length, 1);
        for (const uid of [20, 30, 31]) assert.equal((await user.coll.findOne({ _id: uid })).unreadMsg, 1);
        assert.equal((await user.coll.findOne({ _id: 11 })).unreadMsg, undefined);
        assert.equal((await user.coll.findOne({ _id: 32 })).unreadMsg, undefined);

        await db.collection('domain').updateOne({ _id: 'alpha' }, { $set: { owner: 30 } });
        const deduplicated = await create('another issue');
        assert.equal(Array.from(deduplicated.mdoc.to).sort().join(','), '30,31');
    });

    it('supports student follow-up and administrator replies only inside the originating feedback', async () => {
        const { feedbackId } = await create();
        const student = await handler(10);
        await student.postFeedbackReply({}, feedbackId, 'Additional details.');
        assert.equal(Array.from(student.response.body.mdoc.to).sort().join(','), '20,30,31');
        const owner = await handler(20);
        await owner.postFeedbackReply({}, feedbackId, 'The statement has been corrected.');
        assert.equal(Array.from(owner.response.body.mdoc.to).sort().join(','), '10,30,31');
        const system = await handler(30);
        await system.postFeedbackReply({}, feedbackId, 'Verified.');
        assert.equal(Array.from(system.response.body.mdoc.to).sort().join(','), '10,20,31');
        assert.equal((await Feedback.dialogue(await Feedback.get(feedbackId), 10)).messages.length, 4);
        assert.equal(student.limits[0].op, 'feedback_reply');
        assert.equal(student.limits[0].count, 10);
        assert.equal((await user.coll.findOne({ _id: 10 })).unreadMsg, 2);
        await assert.rejects(student.postSend({}, 20, 'ordinary private message'), { name: 'PrivilegeError' });
    });

    it('rejects other students, unrelated owners, banned users, and forged feedback IDs', async () => {
        const { feedbackId } = await create();
        for (const uid of [11, 21, 32]) {
            const thread = await Feedback.get(feedbackId);
            assert.equal(await Feedback.canAccess(thread, uid), false);
            await assert.rejects(Feedback.dialogue(thread, uid), { name: 'PermissionError' });
            await assert.rejects(Feedback.reply(feedbackId, uid, 'blocked'), { name: 'PermissionError' });
        }
        await assert.rejects(Feedback.reply(new ObjectId(), 10, 'blocked'), { name: 'NotFoundError' });
        await user.coll.updateOne({ _id: 10 }, { $set: { priv: 0 } });
        await assert.rejects(create(), { name: 'PrivilegeError' });
        await assert.rejects(Feedback.reply(feedbackId, 10, 'blocked'), { name: 'PermissionError' });
        assert.equal(await Message.coll.countDocuments({}), 1);
    });

    it('rechecks current roles for historical reads, new recipients, and live subscriptions', async () => {
        const { feedbackId, mdoc } = await create();
        const callbacks = {};
        homeModule.apply({ Route() {}, on: (name, fn) => { callbacks[name] = fn; } });
        let receive;
        const sent = [];
        const socket = {
            ctx: { on: (_event, fn) => { receive = fn; } },
            send: (event) => sent.push(event),
        };
        callbacks['subscription/enable']('message:30', socket, false);
        await user.coll.updateOne({ _id: 30 }, { $set: { priv: PRIV.PRIV_USER_PROFILE } });
        await receive([30], mdoc);
        assert.equal(sent.length, 0);
        assert.equal((await Feedback.list(30)).length, 0);
        await assert.rejects(Feedback.list(30, feedbackId), { name: 'PermissionError' });
        await assert.rejects(Feedback.reply(feedbackId, 30, 'blocked'), { name: 'PermissionError' });
        assert.equal((await Message.getByUser(30)).length, 0);
        assert.equal((await Message.getMulti(30).toArray()).length, 0);

        callbacks['subscription/enable']('message:20', socket, false);
        await receive([20], mdoc);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].payload.feedbackThread.feedbackId.toString(), feedbackId.toString());
        assert.equal(Object.hasOwn(sent[0].payload.udoc, 'mail'), false);
        await db.collection('domain').updateOne({ _id: 'alpha' }, { $set: { owner: 21 } });
        assert.equal((await Feedback.list(20)).length, 0);
        const reply = await Feedback.reply(feedbackId, 10, 'Follow-up after the ownership change.');
        assert.equal(Array.from(reply.mdoc.to).sort().join(','), '21,31');
    });

    it('keeps problem and lecture conversations separate, with immutable source snapshots', async () => {
        const first = await create();
        const tid = new ObjectId();
        const lecture = await Feedback.create('beta', 10, { type: 'lecture', tid, nodeId: 3, title: 'Course / Chapter 3' }, 'Lecture issue');
        const h = await handler(10);
        await h.get({}, lecture.feedbackId);
        assert.equal(h.response.body.canSendMessage, false);
        assert.equal(Object.keys(h.response.body.messages).length, 0);
        assert.equal(h.response.body.feedbackThreads.length, 2);
        assert.equal(new Set(h.response.body.feedbackThreads.map((thread) => thread._id)).size, 2);
        const detail = h.response.body.feedbackThreads.find((thread) => thread.feedbackId.equals(lecture.feedbackId));
        assert.equal(detail.source.url, `/d/beta/course/${tid}/lecture/3`);
        assert.equal(detail.quote, '');
        assert.equal(Object.hasOwn(detail.authors[10], 'mail'), false);
        sourceProblem.title = 'Revised title';
        sourceProblem.content = 'Revised statement';
        await Feedback.reply(first.feedbackId, 10, 'Still relevant after the statement was revised.');
        const snapshot = await Feedback.get(first.feedbackId);
        assert.equal(snapshot.source.title, 'P7. Example');
        assert.equal(snapshot.quote, 'quoted original');
    });

    it('removes a deleted domain\'s feedback and replies before its ID is reused by another owner', async () => {
        const problem = await create();
        await Feedback.reply(problem.feedbackId, 30, 'Private administrator reply');
        const lecture = await Feedback.create('alpha', 10, {
            type: 'lecture', tid: new ObjectId(), nodeId: 3, title: 'Private lecture',
        }, 'Lecture issue', 'Private lecture quote');
        const other = await Feedback.create('beta', 11, { type: 'problem', pid: 9, title: 'Other domain' }, 'Keep this feedback');
        const ordinary = await Message.send(31, 21, 'Keep this ordinary message');
        await Message.coll.updateOne({ _id: ordinary._id }, { $set: { domainId: 'alpha' } });

        await Domain.del('alpha');
        await Domain.add('alpha', 21, 'Recreated domain', '');
        const inbox = await handler(21);
        await inbox.get({});
        assert.deepEqual(Array.from(inbox.response.body.feedbackThreads, (thread) => String(thread.feedbackId)), [String(other.feedbackId)]);
        assert.equal(inbox.response.body.messages[31].messages[0].content, 'Keep this ordinary message');
        assert.equal(await Feedback.coll.countDocuments({ domainId: 'alpha' }), 0);
        assert.equal(await Message.coll.countDocuments({ domainId: 'alpha', feedbackId: { $exists: true } }), 0);
        assert.equal((await Feedback.get(other.feedbackId)).domainId, 'beta');
        assert.equal(await Message.coll.countDocuments({ feedbackId: other.feedbackId }), 1);
        await assert.rejects(Feedback.list(21, problem.feedbackId), { name: 'NotFoundError' });
        await assert.rejects(Feedback.reply(lecture.feedbackId, 21, 'Cannot reply to the old domain'), { name: 'NotFoundError' });

        const fresh = await create('New domain feedback');
        assert.equal(Array.from(fresh.mdoc.to).sort().join(','), '21,30,31');
        assert.equal(await Feedback.canAccess(await Feedback.get(fresh.feedbackId), 21), true);
        assert.equal(await Feedback.canAccess(await Feedback.get(fresh.feedbackId), 20), false);
    });

    it('blocks deletion through the ordinary message endpoint while preserving ordinary messaging', async () => {
        const result = await create();
        const student = await handler(10);
        await assert.rejects(student.postDeleteMessage({}, result.mdoc._id), { name: 'PermissionError' });
        const administrator = await handler(31);
        await administrator.postSend({}, 11, 'An ordinary message.');
        const normal = (await Message.getByUser(31))[0];
        assert.equal(normal.content, 'An ordinary message.');
        await administrator.postDeleteMessage({}, normal._id);
        assert.equal(await Message.coll.countDocuments({ feedbackId: { $exists: false } }), 0);
        assert.equal(await Message.coll.countDocuments({ feedbackId: result.feedbackId }), 1);
    });

    it('validates text before saving and retains a persisted reply when notification delivery fails', async () => {
        await assert.rejects(create('  '), { name: 'ValidationError' });
        await assert.rejects(create('x'.repeat(2001)), { name: 'ValidationError' });
        await assert.rejects(Feedback.create('alpha', 10, { type: 'problem', pid: 1, title: 'test' }, 'valid', 'x'.repeat(4001)), { name: 'ValidationError' });
        assert.equal(await Feedback.coll.countDocuments({}), 0);
        const result = await create('<script>unsafe()</script>\nplain text');
        assert.equal(result.mdoc.content, '<script>unsafe()</script>\nplain text');
        const increment = user.inc;
        user.inc = async () => { throw new Error('notification counter failed'); };
        try {
            const reply = await Feedback.reply(result.feedbackId, 20, 'Saved reply');
            assert.equal(await Message.coll.countDocuments({ _id: reply.mdoc._id }), 1);
            assert.equal(loggerErrors.length, 1);
        } finally {
            user.inc = increment;
        }
    });
});

describe('Feedback conversation UI', () => {
    const utils = {
        i18n: (text) => text,
        request: { get: async () => ({}) },
        mongoId: (id) => ({ timestamp: Number.parseInt(String(id).slice(0, 8), 16) }),
    };
    const helpers = loadSource('packages/ui-default/components/messagepad/helpers.ts', {
        'vj/utils': utils, 'vj/components/notification': { error() {} },
    });
    const globals = { UserContext: { _id: 10, uname: 'student', avatarUrl: '/student.png' } };
    const dialogues = loadSource('packages/ui-default/components/messagepad/reducers/dialogues.js', { '../helpers': helpers }, globals).default;
    const inputs = loadSource('packages/ui-default/components/messagepad/reducers/inputs.js', { '../helpers': helpers }, globals).default;
    const posting = loadSource('packages/ui-default/components/messagepad/reducers/isPosting.ts', {
        '../helpers': helpers, 'vj/components/notification': { error() {} },
    }, globals).default;
    const sample = (id) => ({
        _id: `feedback:${id}`, kind: 'feedback', feedbackId: id, domainId: 'alpha', canReply: true,
        source: { title: 'P7. Example', url: '/d/alpha/p/7' }, quote: '<img src=x onerror=unsafe()>',
        udoc: { _id: 10, uname: 'student', avatarUrl: '/student.png' },
        authors: { 20: { _id: 20, uname: 'domain owner', avatarUrl: '/owner.png' } },
        messages: [],
    });

    function inboxFixture(pagePath, selected, { deferRequests = false, target = '20', initialInbox } = {}) {
        const dom = new JSDOM('<div id="messagePad"></div>', {
            url: `https://hydro.example${pagePath}?${selected ? `feedback=${selected}&` : ''}target=${encodeURIComponent(target)}#messages`,
        });
        const $ = require('jquery')(dom.window);
        const requests = [];
        const responses = [];
        const notices = [];
        const { Types } = loadSource('framework/framework/validator.ts');
        const app = new Koa();
        $.ajaxTransport('+json', (options) => ({
            send(_headers, complete) {
                const url = new URL(options.url, dom.window.location.href);
                requests.push(url);
                const context = app.createContext({ url: `${url.pathname}${url.search}` }, {});
                const feedback = context.query.feedback;
                const valid = !feedback || Types.ObjectId[1](feedback);
                const body = valid
                    ? initialInbox || { messages: {}, feedbackThreads: feedback ? [sample(feedback)] : [], canSendMessage: false }
                    : { error: { message: 'Invalid feedback ID' } };
                const respond = (response = body) => complete(
                    valid ? 200 : 403, valid ? 'OK' : 'Forbidden', { text: JSON.stringify(response) }, 'Content-Type: application/json',
                );
                responses.push(respond);
                if (!deferRequests) respond();
            },
            abort() {},
        }));
        const browserGlobals = { ...globals, window: dom.window, document: dom.window.document, URL, UiContext: { ws_prefix: '/' } };
        const { request } = loadSource('packages/ui-default/utils/base.ts', { jquery: $ }, browserGlobals);
        const activeId = loadSource('packages/ui-default/components/messagepad/reducers/activeId.ts', {
            'jquery.easing': {}, jquery: $,
        }, browserGlobals).default;
        const canSendMessage = loadSource('packages/ui-default/components/messagepad/reducers/canSendMessage.ts').default;
        const reducer = loadSource('packages/ui-default/components/messagepad/reducers/index.ts', {
            './activeId': activeId, './canSendMessage': canSendMessage,
            './dialogues': dialogues, './inputs': inputs, './isPosting': posting,
        }).default;
        const store = createStore(reducer, applyMiddleware(thunk, reduxPromise));
        const notifications = { error: (message) => notices.push(message) };
        const inboxHelpers = loadSource('packages/ui-default/components/messagepad/helpers.ts', {
            'vj/utils': { request }, 'vj/components/notification': notifications,
        }, browserGlobals);
        return { dom, $, requests, responses, notices, browserGlobals, request, store, notifications, inboxHelpers };
    }

    async function mountInbox(fixture, api = async () => []) {
        let finish;
        const mounted = new Promise((resolve) => { finish = resolve; });
        const page = loadSource('packages/ui-default/pages/home_messages.page.tsx', {
            jquery: fixture.$,
            'react-dom/client': { createRoot: () => ({ render: () => finish(true) }) },
            'vj/components/notification': { error: (message) => { fixture.notices.push(message); finish(false); } },
            'vj/components/selectUser': {},
            'vj/context': { ctx: { plugin() {} }, Service: class {} },
            'vj/misc/Page': { NamedPage: class { constructor(_name, afterLoading) { this.afterLoading = afterLoading; } } },
            'vj/utils': { api, request: fixture.request, loadReactRedux: async () => ({ Provider: () => null, store: fixture.store }) },
            '../components/messagepad/helpers': fixture.inboxHelpers,
            '../components/socket': class {},
            '../components/messagepad': () => null,
            '../components/messagepad/reducers': {},
        }, fixture.browserGlobals).default;
        page.afterLoading();
        assert.equal(await mounted, true, fixture.requests.map((url) => url.href).join('\n'));
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(fixture.notices, []);
    }

    it('initializes feedback deep links with one valid feedback parameter and preserves the domain path', async () => {
        for (const pagePath of ['/home/messages', '/d/alpha/home/messages']) {
            const selected = new ObjectId().toString();
            const fixture = inboxFixture(pagePath, selected);
            try {
                await mountInbox(fixture);
                assert.equal(fixture.requests.length, 1);
                assert.equal(fixture.requests[0].pathname, pagePath);
                assert.deepEqual(fixture.requests[0].searchParams.getAll('feedback'), [selected]);
                assert.equal(fixture.store.getState().activeId, `feedback:${selected}`);
                assert(fixture.store.getState().dialogues[`feedback:${selected}`]);
                assert.deepEqual(fixture.notices, []);
            } finally {
                fixture.dom.window.close();
            }
        }
    });

    it('selects received ordinary messages through deep links without giving read-only users send permission', async () => {
        for (const pagePath of ['/home/messages', '/d/alpha/home/messages']) {
            const fixture = inboxFixture(pagePath, null, {
                initialInbox: {
                    messages: { 20: { _id: 20, udoc: { _id: 20, uname: 'sender' }, messages: [{ _id: '1', from: 20, content: 'Received message' }] } },
                    feedbackThreads: [], canSendMessage: false,
                },
            });
            try {
                const calls = [];
                await mountInbox(fixture, (...args) => { calls.push(args); return []; });
                assert.equal(fixture.store.getState().activeId, 20);
                assert.equal(fixture.store.getState().dialogues[20].messages[0].content, 'Received message');
                assert.equal(fixture.store.getState().canSendMessage, false);
                assert.deepEqual(calls, []);
            } finally {
                fixture.dom.window.close();
            }
        }
    });

    it('keeps new ordinary conversation creation restricted while preserving permitted user lookups', async () => {
        for (const canSendMessage of [false, true]) {
            const fixture = inboxFixture('/home/messages', null, {
                target: 'new-sender', initialInbox: { messages: {}, feedbackThreads: [], canSendMessage },
            });
            try {
                const calls = [];
                await mountInbox(fixture, (...args) => { calls.push(args); return [{ _id: 21, uname: 'new-sender' }]; });
                const state = fixture.store.getState();
                if (canSendMessage) {
                    assert.equal(calls.length, 1);
                    assert.equal(calls[0][0], 'users');
                    assert.equal(calls[0][1].search, 'new-sender');
                    assert.equal(calls[0][1].exact, true);
                    assert.equal(state.activeId, 21);
                    assert(state.dialogues[21]);
                } else {
                    assert.deepEqual(calls, []);
                    assert.equal(state.activeId, null);
                    assert.equal(Object.keys(state.dialogues).length, 0);
                }
            } finally {
                fixture.dom.window.close();
            }
        }
    });

    it('reloads and switches feedback on a deep-linked page using only the selected feedback ID', async () => {
        for (const pagePath of ['/home/messages', '/d/alpha/home/messages']) {
            const original = new ObjectId().toString();
            const next = new ObjectId().toString();
            const fixture = inboxFixture(pagePath, original);
            try {
                for (const selected of [original, next]) {
                    fixture.inboxHelpers.activateDialogue(fixture.store.dispatch, `feedback:${selected}`);
                    await new Promise((resolve) => setImmediate(resolve));
                    const url = fixture.requests.at(-1);
                    assert.equal(url.pathname, pagePath);
                    assert.deepEqual(url.searchParams.getAll('feedback'), [selected]);
                    assert.equal(fixture.store.getState().activeId, `feedback:${selected}`);
                    assert(fixture.store.getState().dialogues[`feedback:${selected}`]);
                    assert.deepEqual(fixture.notices, []);
                }
            } finally {
                fixture.dom.window.close();
            }
        }
    });

    it('preserves feedback pushed during a refresh while still removing conversations no longer returned', async () => {
        const first = sample(new ObjectId().toString());
        const revoked = sample(new ObjectId().toString());
        const incoming = sample(new ObjectId().toString());
        const fixture = inboxFixture('/home/messages', first.feedbackId, { deferRequests: true });
        try {
            fixture.store.dispatch({
                type: 'DIALOGUES_LOAD_DIALOGUES_FULFILLED', payload: { feedbackThreads: [first, revoked] },
            });
            fixture.inboxHelpers.activateDialogue(fixture.store.dispatch, first._id);
            const mdoc = { _id: new ObjectId().toString(), feedbackId: incoming.feedbackId, from: 20, content: 'New feedback during GET' };
            fixture.store.dispatch({
                type: 'DIALOGUES_MESSAGE_PUSH', payload: { mdoc, udoc: incoming.authors[20], feedbackThread: incoming },
            });
            fixture.responses[0]({ messages: {}, feedbackThreads: [first], canSendMessage: false });
            await new Promise((resolve) => setImmediate(resolve));
            const state = fixture.store.getState();
            assert.equal(state.dialogues[incoming._id].messages[0].content, mdoc.content);
            assert.equal(state.dialogues[revoked._id], undefined);

            // A later authorized refresh must still remove the newly pushed thread if access is revoked.
            fixture.inboxHelpers.activateDialogue(fixture.store.dispatch, first._id);
            fixture.responses[1]({ messages: {}, feedbackThreads: [first], canSendMessage: false });
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(fixture.store.getState().dialogues[incoming._id], undefined);
            assert.deepEqual(fixture.notices, []);
        } finally {
            fixture.dom.window.close();
        }
    });

    it('uses only the latest overlapping refresh without restoring revoked conversations or send privileges', async () => {
        for (const responseOrder of [[0, 1], [1, 0]]) {
            const revoked = sample(new ObjectId().toString());
            const current = sample(new ObjectId().toString());
            const fixture = inboxFixture('/d/alpha/home/messages', revoked.feedbackId, { deferRequests: true });
            try {
                fixture.store.dispatch({
                    type: 'DIALOGUES_LOAD_DIALOGUES_FULFILLED', payload: { feedbackThreads: [revoked, current], canSendMessage: false },
                });
                fixture.inboxHelpers.activateDialogue(fixture.store.dispatch, revoked._id);
                fixture.inboxHelpers.activateDialogue(fixture.store.dispatch, current._id);
                const payloads = [
                    { messages: {}, feedbackThreads: [revoked], canSendMessage: true },
                    { messages: {}, feedbackThreads: [current], canSendMessage: false },
                ];
                for (const index of responseOrder) {
                    fixture.responses[index](payloads[index]);
                    await new Promise((resolve) => setImmediate(resolve));
                    assert.equal(fixture.store.getState().canSendMessage, false);
                    assert.equal(fixture.store.getState().activeId, current._id);
                }
                assert.equal(fixture.store.getState().dialogues[revoked._id], undefined);
                assert(fixture.store.getState().dialogues[current._id]);
                assert.deepEqual(fixture.notices, []);
            } finally {
                fixture.dom.window.close();
            }
        }
    });

    it('keeps ordinary and feedback sends locked across a refresh until their own request settles', async () => {
        const first = sample(new ObjectId().toString());
        const second = sample(new ObjectId().toString());
        const fixture = inboxFixture('/home/messages', first.feedbackId, { deferRequests: true });
        try {
            fixture.store.dispatch({
                type: 'DIALOGUES_LOAD_DIALOGUES_FULFILLED',
                payload: { messages: { 20: { _id: 20, messages: [] } }, feedbackThreads: [first], canSendMessage: true },
            });
            for (const id of [20, first._id]) {
                fixture.store.dispatch({ type: 'DIALOGUES_INPUT_CHANGED', payload: 'Unsent draft', meta: { dialogueId: id } });
            }
            let resolveOrdinary;
            let rejectFeedback;
            const ordinarySend = fixture.store.dispatch({
                type: 'DIALOGUES_POST_SEND',
                payload: new Promise((resolve) => { resolveOrdinary = resolve; }), meta: { dialogueId: 20 },
            });
            const feedbackSend = fixture.store.dispatch({
                type: 'DIALOGUES_POST_SEND',
                payload: new Promise((_resolve, reject) => { rejectFeedback = reject; }), meta: { dialogueId: first._id },
            }).catch(() => {});
            fixture.inboxHelpers.activateDialogue(fixture.store.dispatch, first._id);
            fixture.responses[0]({
                messages: { 20: { _id: 20, messages: [] }, 30: { _id: 30, messages: [] } },
                feedbackThreads: [first, second], canSendMessage: true,
            });
            await new Promise((resolve) => setImmediate(resolve));
            const state = fixture.store.getState();
            assert.equal(state.isPosting[20], true);
            assert.equal(state.isPosting[first._id], true);
            assert.equal(state.isPosting[30], false);
            assert.equal(state.isPosting[second._id], false);
            assert.equal(state.inputs[20], 'Unsent draft');
            assert.equal(state.inputs[first._id], 'Unsent draft');

            resolveOrdinary({ mdoc: { _id: new ObjectId().toString(), from: 10, to: 20, content: 'Unsent draft' } });
            await ordinarySend;
            assert.equal(fixture.store.getState().isPosting[20], false);
            assert.equal(fixture.store.getState().isPosting[first._id], true);
            assert.equal(fixture.store.getState().inputs[20], '');

            rejectFeedback(new Error('Temporary send failure'));
            await feedbackSend;
            assert.equal(fixture.store.getState().isPosting[first._id], false);
            assert.equal(fixture.store.getState().inputs[first._id], 'Unsent draft');
            assert.deepEqual(fixture.notices, []);
        } finally {
            fixture.dom.window.close();
        }
    });

    it('groups by feedback ID, de-duplicates live replies and preserves drafts and pending sends', () => {
        const id = new ObjectId().toString();
        const first = sample(id);
        const second = sample(new ObjectId().toString());
        let state = dialogues({}, {
            type: 'DIALOGUES_LOAD_DIALOGUES_FULFILLED', payload: { messages: {}, feedbackThreads: [first, second] },
        });
        const mdoc = { _id: new ObjectId().toString(), feedbackId: id, from: 20, to: [10, 30], content: 'Reply' };
        const action = { type: 'DIALOGUES_MESSAGE_PUSH', payload: { mdoc, udoc: first.authors[20], feedbackThread: { ...first, messages: [mdoc] } } };
        state = dialogues(state, action);
        state = dialogues(state, action);
        assert.equal(Object.keys(state).length, 2);
        assert.equal(state[first._id].messages.length, 1);
        assert.equal(state[second._id].messages.length, 0);
        const draft = { [first._id]: 'unsent correction' };
        assert.equal(inputs(draft, action)[first._id], 'unsent correction');
        assert.equal(inputs(draft, { type: 'DIALOGUES_LOAD_DIALOGUES_FULFILLED', payload: { feedbackThreads: [first] } })[first._id], 'unsent correction');
        assert.equal(posting({ [first._id]: true }, action)[first._id], true);
        assert.equal(posting({ 20: true }, { type: 'DIALOGUES_CREATE', payload: { user: { _id: 20 } } })[20], true);
        const revoked = dialogues(state, { type: 'DIALOGUES_LOAD_DIALOGUES_FULFILLED', payload: { feedbackThreads: [second] } });
        assert.equal(revoked[first._id], undefined);
        const normal = { _id: new ObjectId().toString(), from: 20, to: [10], content: 'ordinary reply' };
        const ordinary = dialogues({}, { type: 'DIALOGUES_MESSAGE_PUSH', payload: { mdoc: normal, udoc: first.authors[20] } });
        assert.equal(ordinary[20].udoc.uname, 'domain owner');
        assert.equal(ordinary[20].messages.length, 1);
    });

    it('selects a deep-linked feedback before the message pad is mounted', () => {
        const dom = new JSDOM('<div id="messagePad"></div>');
        const $ = require('jquery')(dom.window);
        const active = loadSource('packages/ui-default/components/messagepad/reducers/activeId.ts', {
            'jquery.easing': {}, jquery: $,
        }, { window: dom.window, document: dom.window.document }).default;
        const id = `feedback:${new ObjectId()}`;
        assert.equal(active(null, { type: 'DIALOGUES_SWITCH_TO', payload: id }), id);
        dom.window.close();
    });

    it('renders feedback source, quotes, and each author as escaped plain text', () => {
        const Message = loadSource('packages/ui-default/components/messagepad/MessageComponent.jsx').default;
        const Content = loadSource('packages/ui-default/components/messagepad/MessagePadDialogueContentContainer.jsx', {
            'jquery.easing': {}, jquery: {},
            'react-redux': { connect: () => (component) => component },
            'vj/utils': utils, './MessageComponent': Message,
        }, globals).default;
        const item = sample(new ObjectId().toString());
        item.messages = [{ _id: new ObjectId().toString(), feedbackId: item.feedbackId, from: 20, content: '<script>unsafe()</script>\nCorrected.' }];
        const html = renderToStaticMarkup(React.createElement(Content, { activeId: item._id, item }));
        assert(html.includes('domain owner'));
        assert(html.includes('/owner.png'));
        assert(html.includes('/d/alpha/p/7'));
        assert(html.includes('&lt;script&gt;unsafe()&lt;/script&gt;'));
        assert(html.includes('&lt;img src=x onerror=unsafe()&gt;'));
        assert(!html.includes('<script>'));
        assert(!html.includes('<img src=x'));
    });

    it('captures selections in the current statement and does not treat feedback as a color action', () => {
        const dom = new JSDOM('<div data-marker-enabled><div data-feedback-url="/d/alpha/p/7" data-feedback-title="P7. Example"><p id="text">Original statement</p></div></div>');
        const $ = require('jquery')(dom.window);
        const opened = [];
        let colors = 0;
        dom.window.document.execCommand = () => { colors++; return true; };
        const Marker = loadSource('packages/ui-default/components/marker/Marker.js', {
            jquery: $,
            'vj/components/feedback': {
                getFeedbackSource: (element) => ({ url: element.getAttribute('data-feedback-url'), title: element.getAttribute('data-feedback-title') }),
                openFeedback: (...args) => opened.push(args),
            },
            'vj/components/tooltip/Tooltip': { get: () => null },
            'vj/utils': { i18n: (text) => text, delay: async () => {} },
        }, { window: dom.window, document: dom.window.document }).default;
        const range = dom.window.document.createRange();
        range.selectNodeContents(dom.window.document.querySelector('#text'));
        dom.window.getSelection().addRange(range);
        Marker.showAtPosition($('[data-marker-enabled]'), 100, 100);
        $('[data-action="feedback"]').trigger('click');
        assert.equal(opened[0][0].url, '/d/alpha/p/7');
        assert.equal(opened[0][1], 'Original statement');
        assert.equal(colors, 0);
        Marker.showAtPosition($('[data-marker-enabled]'), 100, 100);
        $('[data-color="#ffff00"]').trigger('click');
        assert.equal(colors, 1);
        dom.window.close();
    });
});
