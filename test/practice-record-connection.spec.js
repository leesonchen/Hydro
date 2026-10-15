const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { ObjectId } = require('mongodb');

function loadSource(relativePath, mocks) {
    const filename = path.resolve(__dirname, '..', relativePath);
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
            experimentalDecorators: true, esModuleInterop: true },
    }).outputText, { exports, setTimeout, clearTimeout,
        require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    }, { filename });
    return exports;
}

const { PERM, PRIV } = loadSource('packages/common/permission.ts', {});
const STATUS = { STATUS_WAITING: 0, STATUS_JUDGING: 20, STATUS_COMPILING: 21, STATUS_FETCHED: 22, STATUS_ACCEPTED: 1 };
const view = PERM.PERM_VIEW_CONTEST | PERM.PERM_VIEW_HOMEWORK | PERM.PERM_VIEW_PROBLEM;
const manage = view | PERM.PERM_EDIT_CONTEST | PERM.PERM_EDIT_HOMEWORK;
const errors = new Proxy({}, { get: (_target, name) => class extends Error { constructor() { super(name); } } });

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

function fixture({ manager = true, scope = PERM.PERM_ALL, assigned = false, classroom = false,
    formal = false, contestAdminOnly = false } = {}) {
    const domainId = 'practice-test';
    const tid = new ObjectId();
    const tdoc = { domainId, docId: tid, rule: 'oi', owner: 99, assign: assigned ? ['class'] : [],
        allowPractice: true, ...(classroom ? { sourceType: 'course_assessment' } : {}) };
    const state = { account: { _id: 7, priv: PRIV.PRIV_USER_PROFILE },
        perm: contestAdminOnly ? view | PERM.PERM_EDIT_CONTEST : manager ? manage : view,
        groups: ['class'], fail: false, parentAllowed: true };
    class User {
        constructor(udoc, dudoc, originalScope = PERM.PERM_ALL) {
            Object.assign(this, udoc, dudoc, { scope: originalScope });
        }
        async init() { return this; }
        own(doc) { return doc.owner === this._id || doc.maintainer?.includes(this._id); }
        hasPerm(perm) { return (this.perm & this.scope & perm) === perm; }
        hasPriv(priv) { return (this.priv & priv) === priv; }
    }
    const cached = new User(state.account, { perm: state.perm, group: [...state.groups] }, scope);
    const contest = {
        RULES: { oi: {} },
        get: async () => tdoc,
        canAccessAssignedContest: (actor, doc) => !doc.assign?.length || actor.own(doc)
            || doc.assign.some((name) => actor.group?.includes(name) || name === String(actor._id)),
        isOwnOrTeammateRecord: async (_domain, rdoc, uid) => rdoc.uid === uid,
        canShowSelfRecord: () => true, canShowRecord: () => true, canShowScoreboard: () => true,
        getStatus: async () => ({ attend: 1 }),
        applyProjection: (_doc, record) => record,
    };
    const user = {
        User,
        // Deliberately stale: invalidating the shared cache does not refresh a live connection.
        getById: async (_domain, uid) => uid === cached._id ? cached : { _id: uid },
        coll: { findOne: async () => { if (state.fail) throw Error('ACL read failed'); return state.account; } },
        listGroup: async () => state.groups.map((name) => ({ name })),
    };
    const assertCourseAssessmentAccess = async () => {
        if (!state.parentAllowed) throw new Error('Parent course chapter access revoked');
        return manager && !contestAdminOnly;
    };
    const practice = loadSource('packages/hydrooj/src/lib/contest-practice.ts', {
        './course-assessment-access': { assertCourseAssessmentAccess },
        '../error': errors, '../model/builtin': { PERM, STATUS }, '../model/contest': contest,
        '../model/record': {}, '../service/db': {},
    });
    const rdoc = { _id: new ObjectId(), domainId,
        ...(formal ? { contest: tid } : { practiceContest: tid }), uid: manager ? 11 : 7,
        pid: 42, status: STATUS.STATUS_WAITING, code: 'private code', compilerTexts: [], testCases: [] };
    class ConnectionHandler {
        sent = [];
        closed = [];
        failures = [];
        send(payload) { this.sent.push(payload); }
        close(code) { this.closed.push(code); }
        onerror(error) { this.failures.push(error); this.close(4000); }
        checkPerm(perm) { if (!this.user.hasPerm(perm)) throw Error('Permission denied'); }
    }
    const throttle = (fn) => {
        let pending;
        function throttled(...args) { pending = () => fn.apply(this, args); }
        throttled.flush = async () => { const run = pending; pending = null; await run?.(); };
        throttled.cancel = () => { pending = null; throttled.canceled++; };
        throttled.canceled = 0;
        return throttled;
    };
    const noopDecorator = () => () => {};
    const handlers = loadSource('packages/hydrooj/src/handler/record.ts', {
        lodash: { ...require('lodash'), throttle }, '../error': errors,
        '../lib/classroomFeedbackAccess': {}, '../lib/contest-practice': practice,
        '../lib/course-assessment-access': { assertCourseAssessmentAccess },
        '../model/builtin': { PERM, PRIV, STATUS }, '../model/contest': contest,
        '../model/domain': { getDomainUser: async () => ({ perm: state.perm }) },
        '../model/user': user, '../model/problem': {
            get: async () => ({ docId: 42 }), getVisibleStatus: async () => null, canViewBy: () => true,
        },
        '../model/record': {
            get: async () => rdoc,
            RECORD_GENERATE: new ObjectId('000000000000000000000001'),
            RECORD_PRETEST: new ObjectId('000000000000000000000002'),
        }, '../model/setting': {}, '../model/storage': {},
        '../model/system': {}, '../model/task': {}, '../utils': {}, './judge': {},
        './contest': { ContestDetailBaseHandler: ConnectionHandler },
        '../service/server': { ConnectionHandler, param: noopDecorator, subscribe: noopDecorator, Types: {} },
    });
    async function connect(kind, { noTemplate = true, uid = manager ? undefined : 7 } = {}) {
        const h = new handlers[kind === 'list' ? 'RecordMainConnectionHandler' : 'RecordDetailConnectionHandler']();
        h.user = cached;
        h.args = { domainId };
        h.renderHTML = async () => '<div>private record</div>';
        if (kind === 'list') await h.prepare(domainId, tid, 42, uid === undefined ? undefined : String(uid),
            undefined, false, false, false, noTemplate, !formal);
        else {
            await h.prepare(domainId, rdoc._id, noTemplate);
            // prepare starts an async update in the baseline implementation.
            await h.onRecordChange(rdoc);
        }
        return h;
    }
    const push = async (h, kind, doc = rdoc) => {
        await h.onRecordChange(doc);
        await (kind === 'list' ? h.throttleQueueClear : h.throttleSend).flush();
    };
    return { state, cached, tdoc, rdoc, connect, push };
}

for (const kind of ['list', 'detail']) {
    test(`${kind} formal classroom record stream closes when parent access is revoked`, async () => {
        const f = fixture({ manager: false, assigned: true, classroom: true, formal: true });
        const h = await f.connect(kind);
        f.state.parentAllowed = false;
        await f.push(h, kind);
        assert.equal(h.sent.length, 0);
        assert.deepEqual(h.closed, [4000]);
    });
    test(`${kind} denies classroom classmates even with generic contest-admin permission`, async () => {
        const f = fixture({ manager: false, classroom: true, formal: true, contestAdminOnly: true });
        f.rdoc.uid = 11;
        await assert.rejects(f.connect(kind, { uid: 11 }), /Permission/);
    });
    test(`${kind} permits parent course teachers to read formal student submissions`, async () => {
        const f = fixture({ manager: true, classroom: true, formal: true });
        const h = await f.connect(kind);
        await f.push(h, kind);
        assert.equal(h.sent.length, 1);
        assert.deepEqual(h.closed, []);
        h.cleanup?.();
    });
    test(`${kind} classroom practice stream closes when the parent course chapter is revoked`, async () => {
        const f = fixture({ manager: false, assigned: true, classroom: true });
        const h = await f.connect(kind);
        f.state.parentAllowed = false;
        await f.push(h, kind);
        assert.equal(h.sent.length, 0);
        assert.deepEqual(h.closed, [4000]);
    });
    for (const change of ['demoted', 'removed from group', 'disabled', 'deleted']) {
        test(`${kind} practice stream stops after viewer is ${change}, despite a stale cached user`, async () => {
            const f = fixture({ manager: change === 'demoted', assigned: change === 'removed from group' });
            const h = await f.connect(kind);
            if (change === 'demoted') f.state.perm = view;
            if (change === 'removed from group') f.state.groups = [];
            if (change === 'disabled') f.state.account.priv = 0;
            if (change === 'deleted') f.state.account = null;
            await f.push(h, kind);
            assert.equal(h.sent.length, 0);
            assert.deepEqual(h.closed, [4003]);
            assert(f.cached.hasPerm(view), 'the connection still holds its original rights');
            assert.equal(h.disconnectTimeout ?? null, null);
        });
    }

    test(`${kind} practice stream rechecks permissions after a queued or throttled event`, async () => {
        const f = fixture();
        const h = await f.connect(kind);
        await h.onRecordChange(f.rdoc);
        f.state.perm = view;
        const throttle = kind === 'list' ? h.throttleQueueClear : h.throttleSend;
        await throttle.flush();
        assert.equal(h.sent.length, 0);
        assert.deepEqual(h.closed, [4003]);
        assert(throttle.canceled > 0);
        if (kind === 'list') assert.equal(h.queue.size, 0);
    });

    test(`${kind} practice stream rechecks after asynchronous HTML rendering`, async () => {
        const f = fixture();
        const h = await f.connect(kind, { noTemplate: false });
        const rendering = deferred();
        const release = deferred();
        h.renderHTML = async () => { rendering.resolve(); await release.promise; return '<div>private record</div>'; };
        await h.onRecordChange(f.rdoc);
        const sending = (kind === 'list' ? h.throttleQueueClear : h.throttleSend).flush();
        await rendering.promise;
        f.state.perm = view;
        release.resolve();
        await sending;
        assert.equal(h.sent.length, 0);
        assert.deepEqual(h.closed, [4003]);
    });

    test(`${kind} practice stream fails closed on permission read errors and cancels later work`, async () => {
        const f = fixture();
        const h = await f.connect(kind);
        await h.onRecordChange(f.rdoc);
        f.state.fail = true;
        await f.push(h, kind);
        assert.equal(h.sent.length, 0);
        assert.equal(h.failures.length, 1);
        assert.deepEqual(h.closed, [4000]);
        f.state.fail = false;
        await f.push(h, kind);
        assert.equal(h.sent.length, 0);
    });

    test(`${kind} practice stream preserves the original scope when refreshing its actor`, async () => {
        const f = fixture({ manager: false, scope: view });
        const h = await f.connect(kind);
        f.state.perm = manage;
        f.rdoc.uid = 11;
        if (kind === 'list') h.uid = 11;
        await f.push(h, kind);
        assert.equal(h.sent.length, 0);
        assert.deepEqual(h.closed, [4003]);
    });

    test(`${kind} practice stream continues to read personal history after practice closes`, async () => {
        const f = fixture({ manager: false });
        const h = await f.connect(kind);
        f.tdoc.allowPractice = false;
        await f.push(h, kind);
        assert.equal(h.sent.length, 1);
        assert.deepEqual(h.closed, []);
        h.cleanup?.();
    });

    test(`${kind} practice stream cancels a pending finished record when the connection closes`, async () => {
        const f = fixture({ manager: false });
        const h = await f.connect(kind);
        await h.onRecordChange({ ...f.rdoc, status: STATUS.STATUS_ACCEPTED });
        h.cleanup();
        await (kind === 'list' ? h.throttleQueueClear : h.throttleSend).flush();
        assert.equal(h.sent.length, 0);
        assert.equal(h.disconnectTimeout ?? null, null);
    });
}

test('all-practice list still requires manager permissions for an event belonging to the viewer', async () => {
    const f = fixture();
    const h = await f.connect('list');
    f.state.perm = view;
    f.rdoc.uid = 7;
    await f.push(h, 'list');
    assert.equal(h.sent.length, 0);
    assert.deepEqual(h.closed, [4003]);
});

test('personal practice list ignores unrelated users, domains, contests and problems without disconnecting', async () => {
    const f = fixture({ manager: false });
    const h = await f.connect('list');
    for (const patch of [{ uid: 11 }, { domainId: 'other' }, { practiceContest: new ObjectId() }, { pid: 43 },
        { practiceContest: undefined, contest: f.tdoc.docId }]) {
        await f.push(h, 'list', { ...f.rdoc, ...patch });
    }
    assert.equal(h.sent.length, 0);
    assert.deepEqual(h.closed, []);
    await f.push(h, 'list');
    assert.equal(h.sent.length, 1);
    h.cleanup?.();
});

test('a practice list update arriving during an HTML flush remains queued for the next flush', async () => {
    const f = fixture({ manager: false });
    const h = await f.connect('list', { noTemplate: false });
    const rendering = deferred();
    const release = deferred();
    h.renderHTML = async (_template, { rdoc }) => {
        if (rdoc.status === STATUS.STATUS_WAITING) { rendering.resolve(); await release.promise; }
        return `${rdoc.status}`;
    };
    await h.onRecordChange(f.rdoc);
    const first = h.throttleQueueClear.flush();
    await rendering.promise;
    await h.onRecordChange({ ...f.rdoc, status: STATUS.STATUS_ACCEPTED });
    release.resolve();
    await first;
    assert.equal(h.queue.size, 1);
    await h.throttleQueueClear.flush();
    assert.deepEqual(h.sent.map((payload) => payload.html), ['0', '1']);
    h.cleanup();
});
