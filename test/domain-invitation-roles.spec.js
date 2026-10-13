const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { after, before, describe, it } = require('node:test');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ts = require('typescript');
const nunjucks = require('nunjucks');
const { JSDOM } = require('jsdom');

// Exercise the real model, handlers, validators and templates against MongoDB
// without booting unrelated plugins or requiring a running Hydro installation.
function loadSource(relativePath, mocks = {}, globals = {}) {
    const filename = path.resolve(__dirname, '..', relativePath);
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            experimentalDecorators: true,
            esModuleInterop: true,
        },
    }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, {
        exports, global: { Hydro: { model: {} } }, Date, Array, Object, Set, console,
        require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
        ...globals,
    }, { filename });
    return exports;
}

class ValidationError extends Error {
    constructor(field, _, message) { super(message || field); this.field = field; }
}
const errors = new Proxy({ ValidationError }, {
    get: (target, name) => target[name] ||= class extends Error {
        constructor(...args) { super(args.join(' ')); this.name = name; }
    },
});
const builtin = {
    BUILTIN_ROLES: { guest: 0n, default: 1n, root: 255n },
    PERM: { PERM_EDIT_DOMAIN: 2n, PERM_EDIT_HOMEWORK: 4n },
    PERMS_BY_FAMILY: {},
    PRIV: { PRIV_MANAGE_ALL_DOMAIN: 8, PRIV_USER_PROFILE: 1 },
};
const identityDecorator = (_target, _name, descriptor) => descriptor;

describe('Domain invitation role order', () => {
    let mongod;
    let client;
    let db;
    let domain;
    let user;
    let tokens;
    let clearDomainCache;
    const handlers = {};
    const userPrivileges = new Map();
    const domainId = 'invite-roles-test';

    before(async () => {
        mongod = await MongoMemoryServer.create();
        client = await MongoClient.connect(mongod.getUri());
        db = client.db('invitation-role-test');
        user = {
            getById: async (_domain, uid) => ({
                _id: uid, uname: `u${uid}`, mail: `u${uid}@example.com`,
                priv: userPrivileges.get(uid) ?? builtin.PRIV.PRIV_USER_PROFILE,
            }),
            getMulti: (query) => db.collection('user').find(query),
            collGroup: db.collection('user.group'),
        };
        const userMocks = { __esModule: true, default: user, deleteUserCache: () => {}, canManageClass: () => true };
        const bus = { parallel: async () => {}, broadcast: () => {} };
        const domainModule = loadSource('packages/hydrooj/src/model/domain.ts', {
            '../error': errors,
            '../service/db': {
                collection: (name) => db.collection(name),
                ensureIndexes: (collection, ...indexes) => collection.createIndexes(indexes),
            },
            '../service/bus': bus,
            '../utils': { ArgMethod: identityDecorator },
            './builtin': builtin,
            './user': userMocks,
        });
        domain = domainModule.default;
        const realUser = loadSource('packages/hydrooj/src/model/user.ts', {
            '../error': errors,
            '../lib/rating-publication-read': {
                projectUserRating: async (_domain, value) => value,
                projectUserRatings: async (_domain, values) => values,
                publicRatingStore: { active: async () => null },
            },
            '../lib/avatar': {},
            '../lib/hash.hydro': {},
            '../service/db': { collection: (name) => db.collection(name) },
            '../service/bus': { ...bus, on: () => {} },
            '../utils': { ArgMethod: identityDecorator },
            './builtin': builtin,
            './domain': domain,
            './setting': {},
            './system': {},
            './token': {},
        }).default;
        user.addUserToGroup = realUser.addUserToGroup;
        user.addUserToGroupWithChanges = realUser.addUserToGroupWithChanges;
        tokens = {
            TYPE_GROUP_INVITATION: 90,
            TYPE_TEXTS: { 90: 'invitation' },
            get: (id) => db.collection('tokens').findOne({ _id: id }),
            getMulti: (_type, filter) => db.collection('tokens').find(filter),
            add: async (type, seconds, fields) => {
                const id = new ObjectId().toHexString();
                await db.collection('tokens').insertOne({ _id: id, tokenType: type, expireAt: new Date(Date.now() + seconds * 1000), ...fields });
                return [id];
            },
        };
        class Handler {
            checkPerm() { if (!this.user.hasPerm()) throw new errors.PermissionError(); }
            checkPriv() { if (!this.user.hasPriv()) throw new errors.PermissionError(); }
            back() { this.response.redirect = '/'; }
            url(_name, args) { return `/d/${args?.domainId || domainId}/`; }
        }
        const validator = loadSource('framework/framework/validator.ts');
        const decorators = loadSource('framework/framework/decorators.ts', { './error': errors });
        const handlerModule = loadSource('packages/hydrooj/src/handler/domain.ts', {
            '../error': errors,
            '../lib/rating-publication-read': {
                projectUserRating: async (_domain, value) => value,
                projectUserRatings: async (_domain, values) => values,
                publicRatingStore: { active: async () => null },
            },
            '../lib/avatar': {},
            '../model/builtin': builtin,
            '../model/discussion': {},
            '../model/domain': domain,
            '../model/message': {},
            '../model/oplog': { log: async () => {} },
            '../model/setting': {},
            '../model/system': { get: () => 'https://example.com/' },
            '../model/token': tokens,
            '../model/user': userMocks,
            '../service/server': {
                ...decorators, Types: validator.Types, Handler,
                requireSudo: identityDecorator,
                Query: (_schema, fn) => fn, Mutation: (_schema, fn) => fn,
            },
            '../utils': {},
        });
        await handlerModule.apply({
            Route: (name, _url, HandlerClass) => { handlers[name] = HandlerClass; },
            inject: async () => {},
        });
        // Clear the real domain model cache through its normal event callback.
        const listeners = {};
        await domainModule.apply({ on: (event, fn) => { listeners[event] = fn; } });
        clearDomainCache = () => listeners['domain/delete-cache'](domainId);
        bus.broadcast = (event, arg) => listeners[event]?.(arg);
    });

    after(async () => { await client?.close(); await mongod?.stop(); });

    function handler(name, uid = 10, manager = false) {
        return Object.assign(new handlers[name](), {
            args: { domainId }, response: { body: {} },
            request: { body: {}, query: {}, headers: {} },
            user: { _id: uid, hasPerm: () => manager, hasPriv: () => false },
        });
    }

    async function resetDomain() {
        userPrivileges.clear();
        await clearDomainCache();
        await domain.coll.deleteMany({});
        await domain.collUser.deleteMany({});
        await user.collGroup.deleteMany({});
        await domain.add(domainId, 1, 'Invitation test', '');
        await domain.addRole(domainId, 'student', 7n);
        await domain.addRole(domainId, 'teacher', 2n);
        return await domain.getRoles(domainId);
    }

    function meta(roles, defaultRole = 'student') {
        return Object.fromEntries(roles.map((role) => [role._id, { priority: role.priority, default: role._id === defaultRole }]));
    }

    async function beforeNextRoleWrite(concurrentChange, operation) {
        const originalUpdateOne = domain.coll.updateOne;
        let intercepted = false;
        domain.coll.updateOne = async (...args) => {
            if (!intercepted && args[0]._id === domainId
                && Object.keys(args[1].$set || {}).some((key) => key === 'roles' || key.startsWith('roles.'))) {
                intercepted = true;
                await concurrentChange();
            }
            return await originalUpdateOne.apply(domain.coll, args);
        };
        try {
            await operation();
            assert.equal(intercepted, true);
        } finally {
            domain.coll.updateOne = originalUpdateOne;
        }
    }

    async function duringRoleVerification(change, operation) {
        const originalFindOne = domain.coll.findOne;
        let intercepted = false;
        domain.coll.findOne = async (...args) => {
            if (!intercepted && args[0]._id === domainId && args[1]?.projection?.roles) {
                intercepted = true;
                await change();
            }
            return await originalFindOne.apply(domain.coll, args);
        };
        try {
            return await operation();
        } finally {
            domain.coll.findOne = originalFindOne;
            assert.equal(intercepted, true);
        }
    }

    function render(template, body) {
        const base = new nunjucks.Loader();
        base.getSource = (name) => ['domain_base.html', 'layout/basic.html'].includes(name)
            ? { src: '{% block domain_content %}{% endblock %}{% block content %}{% endblock %}', path: name }
            : null;
        const env = new nunjucks.Environment([base, new nunjucks.FileSystemLoader(path.resolve(__dirname, '../packages/ui-default/templates'))]);
        env.addGlobal('_', (text) => Object.assign(new nunjucks.runtime.SafeString(text || ''), {
            format: (...values) => (text || '').replace(/\{(\d+)\}/g, (_match, index) => values[index]),
        }));
        env.addFilter('assign', (target, source) => ({ ...target, ...source }));
        env.addFilter('bitand', (left, right) => BigInt(left) & BigInt(right));
        const source = fs.readFileSync(path.resolve(__dirname, '../packages/ui-default/templates', template), 'utf8');
        return env.renderString('{% import "components/form.html" as form %}' + source, {
            domain: { name: 'Test' }, handler: { args: { domainId } }, model: { domain },
            noscript_note: { render: () => '' }, datetimeSpan: () => '', ...body,
        });
    }

    it('provides safe legacy defaults and unique order without changing permissions', async () => {
        const roles = await domain.getRoles({ _id: 'old-domain', roles: { student: '7', teacher: '2', default: '0' } });
        assert.deepEqual(Array.from(roles, (role) => role._id), ['guest', 'default', 'student', 'teacher', 'root']);
        assert.deepEqual(Array.from(roles, (role) => role.priority), [0, 1, 2, 3, 4]);
        assert.equal(domain.getDefaultRole(roles), 'default');
        assert.equal(roles[1].perm, 0n);
    });

    it('persists a single default and order through permission edits, addition and deletion', async () => {
        const roles = await resetDomain();
        const settings = meta(roles);
        [settings.student.priority, settings.teacher.priority] = [settings.teacher.priority, settings.student.priority];
        await domain.setRoleMeta(domainId, settings);
        await domain.setRoles(domainId, { student: 5n });
        assert.equal(domain.getDefaultRole(await domain.getRoles(domainId)), 'student');
        await domain.addRole(domainId, 'assistant', 1n);
        assert.deepEqual(Array.from(await domain.getRoles(domainId), (role) => role._id), ['guest', 'default', 'teacher', 'student', 'assistant', 'root']);
        await domain.deleteRoles(domainId, ['student']);
        const remaining = await domain.getRoles(domainId);
        assert.equal(domain.getDefaultRole(remaining), 'default');
        assert.deepEqual(Array.from(remaining, (role) => role.priority), [0, 1, 2, 3, 4]);
    });

    for (const operation of ['add', 'delete', 'permissions']) {
        it(`preserves concurrent role settings and role changes during ${operation}`, async () => {
            const settings = meta(await resetDomain(), 'teacher');
            [settings.default.priority, settings.teacher.priority] = [settings.teacher.priority, settings.default.priority];
            await beforeNextRoleWrite(async () => {
                await domain.setRoleMeta(domainId, settings);
                await domain.addRole(domainId, 'tutor', 3n);
                await domain.setRoles(domainId, { teacher: 9n });
            }, () => {
                if (operation === 'add') return domain.addRole(domainId, 'assistant', 1n);
                if (operation === 'delete') return domain.deleteRoles(domainId, ['student']);
                return domain.setRoles(domainId, { student: 5n });
            });
            const roles = await domain.getRoles(domainId);
            assert.equal(domain.getDefaultRole(roles), 'teacher');
            const expected = ['guest', 'teacher', ...(operation === 'delete' ? [] : ['student']), 'default', 'tutor',
                ...(operation === 'add' ? ['assistant'] : []), 'root'];
            assert.deepEqual(Array.from(roles, (role) => role._id), expected);
            assert.deepEqual(Array.from(roles, (role) => role.priority), expected.map((_role, index) => index));
            assert.equal(roles.find((role) => role._id === 'teacher').perm, 9n);
            if (operation === 'permissions') assert.equal(roles.find((role) => role._id === 'student').perm, 5n);
        });
    }

    it('rejects duplicate priorities, missing/multiple defaults and edits to fixed endpoints', async () => {
        const roles = await resetDomain();
        for (const change of [
            (s) => { s.student.priority = s.default.priority; },
            (s) => { s.student.priority = 1.5; },
            (s) => { s.student.default = false; },
            (s) => { s.teacher.default = true; },
            (s) => { s.guest.default = true; },
            (s) => { s.root.priority = 2; },
            (s) => { delete s.teacher; },
        ]) {
            const settings = meta(roles);
            change(settings);
            await assert.rejects(domain.setRoleMeta(domainId, settings), ValidationError);
        }
    });

    it('atomically assigns new members, upgrades lower roles and preserves equal/higher roles and bans', async () => {
        await resetDomain();
        const cases = [
            [undefined, undefined, 'student'],
            [false, 'teacher', 'student'],
            [true, undefined, 'student'],
            [true, 'default', 'student'],
            [true, 'student', 'student'],
            [true, 'teacher', 'teacher'],
            [true, 'root', 'root'],
            [false, 'guest', 'guest'],
        ];
        for (const [index, [join, role, expected]] of cases.entries()) {
            const uid = index + 20;
            await domain.collUser.insertOne({ domainId, uid, join, role, requireInvitation: true });
            const joined = await domain.joinUserInDomain(domainId, uid, 'student');
            assert.equal(joined.role, expected);
            assert.equal(joined.join, expected !== 'guest');
            assert.equal(joined.requireInvitation, expected === 'guest' ? true : undefined);
        }
        await Promise.all(Array.from({ length: 12 }, (_, index) => domain.joinUserInDomain(domainId, 40, index % 2 ? 'student' : 'teacher')));
        assert.equal((await domain.collUser.findOne({ domainId, uid: 40 })).role, 'teacher');
    });

    it('uses the configured order instead of permission bits or role names', async () => {
        const settings = meta(await resetDomain());
        [settings.default.priority, settings.student.priority] = [settings.student.priority, settings.default.priority];
        await domain.setRoleMeta(domainId, settings);
        await domain.setUserInDomain(domainId, 10, { join: true, role: 'default' });
        await domain.joinUserInDomain(domainId, 10, 'student');
        assert.equal((await domain.collUser.findOne({ domainId, uid: 10 })).role, 'default');
    });

    it('domain invitations accept existing members, validate codes, and keep higher roles', async () => {
        await resetDomain();
        await domain.edit(domainId, { _join: { method: domain.JOIN_METHOD_CODE, code: 'studentCode', role: 'student', expire: null } });
        await domain.setUserInDomain(domainId, 10, { join: true, role: 'default' });
        const joining = handler('domain_join');
        await joining.prepare({ domainId });
        await assert.rejects(joining.post({ domainId }, 'wrong'), { name: 'InvalidJoinInvitationCodeError' });
        assert.equal((await domain.collUser.findOne({ domainId, uid: 10 })).role, 'default');
        await joining.post({ domainId }, 'studentCode');
        assert.equal((await domain.collUser.findOne({ domainId, uid: 10 })).role, 'student');
        await domain.setUserRole(domainId, 10, 'teacher');
        await joining.prepare({ domainId });
        await joining.post({ domainId }, 'studentCode');
        assert.equal((await domain.collUser.findOne({ domainId, uid: 10 })).role, 'teacher');
    });

    it('direct invitations preserve preassigned roles regardless of public join settings', async () => {
        await resetDomain();
        const manager = handler('domain_user', 1, true);
        let uid = 50;
        for (const method of [domain.JOIN_METHOD_ALL, domain.JOIN_METHOD_CODE, domain.JOIN_METHOD_NONE]) {
            await domain.edit(domainId, {
                _join: { method, role: 'default', code: 'publicCode', expire: null },
            });
            for (const role of ['student', 'teacher', 'root']) {
                uid++;
                await domain.setUserInDomain(domainId, uid, { join: false, role: 'default' });
                await manager.postSetUsers(domainId, [uid], role, false);
                const joining = handler('domain_join', uid);
                await joining.prepare({ domainId });
                await joining.post({ domainId });
                const joined = await domain.collUser.findOne({ domainId, uid });
                assert.equal(joined.join, true);
                assert.equal(joined.role, role);
            }
        }
    });

    it('rejects direct invitations changed during the same request and permits a fresh lower-role invitation', async () => {
        await resetDomain();
        for (const [index, role] of ['student', 'default', 'guest'].entries()) {
            const uid = 50 + index;
            await domain.setUserInDomain(domainId, uid, { join: false, role: 'root' });
            const joining = handler('domain_join', uid);
            await joining.prepare({ domainId });
            await domain.setUserRole(domainId, uid, role);
            await assert.rejects(joining.post({ domainId }), { name: 'DomainJoinForbiddenError' });
            const rejected = await domain.collUser.findOne({ domainId, uid });
            assert.equal(rejected.join, false);
            assert.equal(rejected.role, role);
            if (role === 'student') {
                await joining.prepare({ domainId });
                await joining.post({ domainId });
                assert.equal((await domain.collUser.findOne({ domainId, uid })).role, 'student');
                assert.equal((await domain.collUser.findOne({ domainId, uid })).join, true);
            }
        }
    });

    it('direct invitations guard changes to membership and rejoin requirements and never recreate deleted memberships', async () => {
        await resetDomain();
        for (const [index, change] of [
            async (uid) => domain.setJoin(domainId, uid, true),
            async (uid) => domain.setUserInDomain(domainId, uid, { requireInvitation: true }),
            async (uid) => domain.collUser.deleteOne({ domainId, uid }),
        ].entries()) {
            const uid = 60 + index;
            await domain.setUserInDomain(domainId, uid, { role: 'teacher' });
            const joining = handler('domain_join', uid);
            await joining.prepare({ domainId });
            await change(uid);
            const expected = await domain.collUser.findOne({ domainId, uid });
            await assert.rejects(joining.post({ domainId }), { name: 'DomainJoinForbiddenError' });
            assert.deepEqual(await domain.collUser.findOne({ domainId, uid }), expected);
        }
    });

    it('joins global administrators through their own privilege without a preassigned membership', async () => {
        await resetDomain();
        userPrivileges.set(70, builtin.PRIV.PRIV_USER_PROFILE | builtin.PRIV.PRIV_MANAGE_ALL_DOMAIN);
        const joining = handler('domain_join', 70);
        joining.user.hasPriv = (priv) => priv === builtin.PRIV.PRIV_MANAGE_ALL_DOMAIN;
        await joining.prepare({ domainId });
        await joining.post({ domainId });
        const joined = await domain.collUser.findOne({ domainId, uid: 70 });
        assert.equal(joined.join, true);
        assert.equal(joined.role, 'root');
    });

    it('allows global administrators to rejoin after a domain moderator kick', async () => {
        await resetDomain();
        userPrivileges.set(83, builtin.PRIV.PRIV_USER_PROFILE | builtin.PRIV.PRIV_MANAGE_ALL_DOMAIN);
        await domain.setUserInDomain(domainId, 83, { join: false, role: 'guest' });
        const joining = handler('domain_join', 83);
        joining.user.hasPriv = (priv) => priv === builtin.PRIV.PRIV_MANAGE_ALL_DOMAIN;
        await joining.prepare({ domainId });
        await joining.post({ domainId });
        const joined = await domain.collUser.findOne({ domainId, uid: 83 });
        assert.equal(joined.join, true);
        assert.equal(joined.role, 'root');
        assert.equal(joined.requireInvitation, undefined);
        assert.equal(joined._roleAssignment, undefined);
        const effective = await domain.getDomainUser(domainId, { _id: 83, priv: userPrivileges.get(83) });
        assert.equal(effective.role, 'root');
        assert.equal(effective.perm, builtin.BUILTIN_ROLES.root);
    });

    it('uses global privilege when a moderator ban is written after join preparation', async () => {
        await resetDomain();
        userPrivileges.set(84, builtin.PRIV.PRIV_USER_PROFILE | builtin.PRIV.PRIV_MANAGE_ALL_DOMAIN);
        const joining = handler('domain_join', 84);
        joining.user.hasPriv = (priv) => priv === builtin.PRIV.PRIV_MANAGE_ALL_DOMAIN;
        await joining.prepare({ domainId });
        await domain.setUserInDomain(domainId, 84, { join: false, role: 'guest' });
        await joining.post({ domainId });
        const joined = await domain.collUser.findOne({ domainId, uid: 84 });
        assert.equal(joined.join, true);
        assert.equal(joined.role, 'root');
    });

    it('does not bypass moderator bans for root join requests without global privilege', async () => {
        await resetDomain();
        await domain.setUserInDomain(domainId, 85, { join: false, role: 'guest', requireInvitation: true });
        const expected = await domain.collUser.findOne({ domainId, uid: 85 });
        const joined = await domain.joinUserInDomain(domainId, 85, 'root');
        assert.equal(joined.role, 'guest');
        assert.deepEqual(await domain.collUser.findOne({ domainId, uid: 85 }), expected);
        const joining = handler('domain_join', 85, true);
        await assert.rejects(joining.prepare({ domainId }), { name: 'DomainJoinForbiddenError' });
    });

    it('preserves an existing role when the requested role is deleted before the assignment write', async () => {
        await resetDomain();
        await domain.setUserInDomain(domainId, 71, { join: true, role: 'student' });
        const originalFindOneAndUpdate = domain.collUser.findOneAndUpdate;
        let intercepted = false;
        domain.collUser.findOneAndUpdate = async (...args) => {
            if (!intercepted && args[0].uid === 71 && Array.isArray(args[1])) {
                intercepted = true;
                await domain.deleteRoles(domainId, ['teacher']);
            }
            return await originalFindOneAndUpdate.apply(domain.collUser, args);
        };
        try {
            const joined = await domain.joinUserInDomain(domainId, 71, 'teacher');
            assert.equal(intercepted, true);
            assert.equal(joined.role, 'student');
            assert.equal(joined._roleAssignment, undefined);
        } finally {
            domain.collUser.findOneAndUpdate = originalFindOneAndUpdate;
        }
    });

    it('role deletion restores pending upgrades while confirmed members fall back to default', async () => {
        await resetDomain();
        await domain.setUserInDomain(domainId, 72, { join: true, role: 'student' });
        await domain.setUserInDomain(domainId, 73, { join: true, role: 'teacher' });
        const joined = await duringRoleVerification(
            () => domain.deleteRoles(domainId, ['teacher']),
            () => domain.joinUserInDomain(domainId, 72, 'teacher'),
        );
        assert.equal(joined.role, 'student');
        assert.equal(joined._roleAssignment, undefined);
        assert.equal((await domain.collUser.findOne({ domainId, uid: 73 })).role, 'default');
    });

    it('failed custom-role rechecks preserve valid member roles and unrelated profile updates', async () => {
        await resetDomain();
        await domain.setUserInDomain(domainId, 74, { join: true, role: 'student' });
        const joined = await duringRoleVerification(async () => {
            await domain.setUserInDomain(domainId, 74, { displayName: 'Updated' });
            throw new Error('Injected role recheck failure');
        }, () => domain.joinUserInDomain(domainId, 74, 'teacher'));
        assert.equal(joined.role, 'student');
        assert.equal(joined.displayName, 'Updated');
        assert.equal(joined._roleAssignment, undefined);
    });

    for (const [name, change] of [
        ['membership set', () => domain.setUserInDomain(domainId, 91, { join: true })],
        ['membership update', () => domain.updateUserInDomain(domainId, 91, { $set: { join: true } })],
        ['invitation requirement', () => domain.setUserInDomain(domainId, 91, { requireInvitation: false })],
        ['single membership', () => domain.setJoin(domainId, 91, true)],
        ['bulk membership', () => domain.setJoin(domainId, [91], true)],
        ['bulk member update', () => domain.setMultiUserInDomain(domainId, { uid: 91 }, { requireInvitation: true })],
    ]) {
        // eslint-disable-next-line ts/no-loop-func
        it(`${name} writes do not confirm a role when invitation verification fails`, async () => {
            await resetDomain();
            await domain.setUserInDomain(domainId, 91, { join: true, role: 'student' });
            const joined = await duringRoleVerification(async () => {
                await change();
                const effective = await domain.getDomainUser(domainId, { _id: 91, priv: builtin.PRIV.PRIV_USER_PROFILE });
                assert.equal(effective.role, 'student');
                assert.equal(effective.perm, 7n);
                throw new Error('Injected role recheck failure');
            }, () => domain.joinUserInDomain(domainId, 91, 'teacher'));
            assert.equal(joined.role, 'student');
            assert.equal(joined._roleAssignment, undefined);
        });
    }

    it('membership revocation during verification preserves the original role and stays revoked', async () => {
        await resetDomain();
        await domain.setUserInDomain(domainId, 91, { join: true, role: 'student' });
        await duringRoleVerification(async () => {
            await domain.setJoin(domainId, 91, false);
            throw new Error('Injected role recheck failure');
        }, () => assert.rejects(domain.joinUserInDomain(domainId, 91, 'teacher'), { name: 'DomainJoinForbiddenError' }));
        const member = await domain.collUser.findOne({ domainId, uid: 91 });
        assert.equal(member.join, false);
        assert.equal(member.role, 'student');
        assert.equal(member._roleAssignment, undefined);
    });

    it('rejects reserved names when creating roles through handlers or either model write path', async () => {
        await resetDomain();
        const manager = handler('domain_role', 1, true);
        await manager.prepare({ domainId });
        for (const name of Object.getOwnPropertyNames(Object.prototype)) {
            // eslint-disable-next-line no-await-in-loop
            await assert.rejects(manager.postAdd(domainId, name), /This role name is reserved/);
            // eslint-disable-next-line no-await-in-loop
            await assert.rejects(domain.addRole(domainId, name, 6n), /This role name is reserved/);
            // eslint-disable-next-line no-await-in-loop
            await assert.rejects(domain.setRoles(domainId, Object.fromEntries([[name, 6n]])), /This role name is reserved/);
        }
        const stored = await domain.coll.findOne({ _id: domainId });
        assert.deepEqual(Object.keys(stored.roles), ['student', 'teacher']);
    });

    it('preserves editing, membership, role settings and deletion for legacy reserved names', async () => {
        await resetDomain();
        await domain.edit(domainId, { roles: Object.fromEntries([['student', '7'], ['teacher', '2'], ['__proto__', '1']]) });
        await domain.setRoles(domainId, Object.fromEntries([['__proto__', 6n]]));
        const roles = await domain.getRoles(domainId);
        assert.equal(roles.find((role) => role._id === '__proto__').perm, 6n);
        await domain.setRoleMeta(domainId, meta(roles, '__proto__'));
        assert.equal(domain.getDefaultRole(await domain.getRoles(domainId)), '__proto__');
        await domain.setUserRole(domainId, 91, '__proto__', true);
        assert.equal((await domain.getDomainUser(domainId, { _id: 91, priv: 1 })).perm, 6n);
        await domain.deleteRoles(domainId, ['__proto__']);
        assert(!(await domain.getRoles(domainId)).some((role) => role._id === '__proto__'));
        assert.equal((await domain.collUser.findOne({ domainId, uid: 91 })).role, 'default');
    });

    it('submits the actual permission form for legacy reserved names and more than twenty roles', async () => {
        await resetDomain();
        const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'permissions',
            ...Array.from({ length: 23 }, (_, index) => `role${index}`)];
        await domain.edit(domainId, { roles: Object.fromEntries(names.map((name) => [name, '1'])) });
        const roles = await domain.getRoles(domainId);
        const dom = new JSDOM(render('domain_permission.html', {
            roles,
            PERMS_BY_FAMILY: { permission: [{ desc: 'View', key: 1n }, { desc: 'Edit', key: 2n }] },
            log2: (value) => value.toString(2).length - 1,
        }));
        try {
            const $ = require('jquery')(dom.window);
            $.expr.pseudos.visible = (element) => element.value !== '1000';
            loadSource('packages/ui-default/components/form/multiSelectCheckbox.page.js', {
                jquery: $,
                'vj/misc/Page': { AutoloadPage: class { constructor(_name, run) { run(); } } },
            }, { document: dom.window.document });
            for (const group of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
                const checkboxes = [...dom.window.document.querySelectorAll('input[data-checkbox-range]')]
                    .filter((input) => input.getAttribute('data-checkbox-group') === group && input.value !== '1000');
                assert.doesNotThrow(() => $(dom.window.document).trigger($.Event('click', {
                    target: checkboxes[0], shiftKey: true,
                })));
                $(dom.window.document).trigger($.Event('click', { target: checkboxes[1], shiftKey: true }));
                assert(checkboxes.every((input) => input.checked));
            }
            const inputs = dom.window.document.querySelectorAll('input[type="checkbox"]');
            for (const input of inputs) if (!input.disabled) input.checked = input.value !== '0';
            const raw = new URLSearchParams(new dom.window.FormData(dom.window.document.querySelector('form'))).toString();
            const request = require('node:stream').Readable.from([Buffer.from(raw)]);
            request.headers = { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(raw) };
            const parsed = await require('co-body').form(request);
            assert.equal(Array.isArray(parsed.permissions), false);
            const permissions = handler('domain_permission', 1, true);
            await permissions.prepare({ domainId });
            permissions.request.body = parsed;
            await permissions.post({ domainId });
            await permissions.postUpdate({ domainId });
            const updated = await domain.getRoles(domainId);
            for (const role of updated) assert.equal(role.perm, role._id === 'root' ? 255n : 2n);
            assert.deepEqual(Array.from(updated, (role) => role._id), Array.from(roles, (role) => role._id));
        } finally {
            dom.window.close();
        }
    });

    for (const role of ['teacher', 'root', 'guest']) {
        it(`does not overwrite a subsequent moderator assignment to ${role} during failed verification`, async () => {
            await resetDomain();
            await domain.setUserInDomain(domainId, 75, { join: true, role: 'student' });
            const joined = await duringRoleVerification(async () => {
                await domain.setUserRole(domainId, 75, role);
                throw new Error('Injected role recheck failure');
            }, () => domain.joinUserInDomain(domainId, 75, 'teacher'));
            assert.equal(joined.role, role);
            assert.equal(joined._roleAssignment, undefined);
        });
    }

    it('preserves bulk moderator role assignments and subsequent membership revocations', async () => {
        await resetDomain();
        await domain.setUserInDomain(domainId, 76, { join: true, role: 'student' });
        const joined = await duringRoleVerification(async () => {
            await domain.setUserRole(domainId, [76], 'teacher');
            throw new Error('Injected role recheck failure');
        }, () => domain.joinUserInDomain(domainId, 76, 'teacher'));
        assert.equal(joined.role, 'teacher');
        assert.equal(joined._roleAssignment, undefined);
        await domain.setUserRole(domainId, 76, 'student');
        await duringRoleVerification(async () => {
            await domain.setUserInDomain(domainId, 76, { join: false, requireInvitation: true, role: 'default' });
            throw new Error('Injected role recheck failure');
        }, () => assert.rejects(domain.joinUserInDomain(domainId, 76, 'teacher'), { name: 'DomainJoinForbiddenError' }));
        const revoked = await domain.collUser.findOne({ domainId, uid: 76 });
        assert.equal(revoked.join, false);
        assert.equal(revoked.requireInvitation, true);
        assert.equal(revoked.role, 'default');
    });

    it('does not restore a previous role that was deleted while an upgrade was pending', async () => {
        await resetDomain();
        await domain.setUserInDomain(domainId, 77, { join: true, role: 'student' });
        const joined = await duringRoleVerification(async () => {
            await domain.deleteRoles(domainId, ['student']);
            throw new Error('Injected role recheck failure');
        }, () => domain.joinUserInDomain(domainId, 77, 'teacher'));
        assert.equal(joined.role, 'default');
        assert.equal(joined._roleAssignment, undefined);
    });

    it('unverified custom roles cannot grant permissions to existing or new members', async () => {
        await resetDomain();
        for (const existing of [true, false]) {
            const uid = existing ? 78 : 79;
            if (existing) await domain.setUserInDomain(domainId, uid, { join: true, role: 'student' });
            const joined = await duringRoleVerification(async () => {
                const effective = await domain.getDomainUser(domainId, { _id: uid, priv: builtin.PRIV.PRIV_USER_PROFILE });
                assert.equal(effective.role, existing ? 'student' : 'guest');
                assert.equal(effective.perm, existing ? 7n : 0n);
            }, () => domain.joinUserInDomain(domainId, uid, 'teacher'));
            assert.equal(joined.role, 'teacher');
            assert.equal(joined._roleAssignment, undefined);
        }
    });

    it('recovers abandoned role verification using the previous member role', async () => {
        await resetDomain();
        await domain.setUserInDomain(domainId, 80, { join: true, role: 'teacher' });
        // The fixture represents an interrupted assignment, bypassing moderator invalidation.
        await domain.collUser.updateOne({ domainId, uid: 80 }, { $set: { _roleAssignment: {
            token: 'abandoned', role: 'teacher', previousRole: 'student', wasMember: true,
            expiresAt: new Date(Date.now() - 1000),
        } } });
        const joined = await domain.joinUserInDomain(domainId, 80, 'default');
        assert.equal(joined.role, 'student');
        assert.equal(joined._roleAssignment, undefined);
    });

    it('serializes concurrent upgrades so a failed later upgrade preserves a confirmed earlier role', { timeout: 5000 }, async () => {
        await resetDomain();
        await domain.addRole(domainId, 'assistant', 1n);
        await domain.setUserInDomain(domainId, 81, { join: true, role: 'student' });
        let releaseFirst;
        let notifyFirst;
        let notifyWaiting;
        const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
        const firstStarted = new Promise((resolve) => { notifyFirst = resolve; });
        const secondWaiting = new Promise((resolve) => { notifyWaiting = resolve; });
        const originalFindOne = domain.coll.findOne;
        const originalFindOneAndUpdate = domain.collUser.findOneAndUpdate;
        let verifications = 0;
        domain.coll.findOne = async (...args) => {
            if (args[0]._id === domainId && args[1]?.projection?.roles) {
                verifications++;
                if (verifications === 1) {
                    notifyFirst();
                    await firstReleased;
                } else throw new Error('Injected second role recheck failure');
            }
            return await originalFindOne.apply(domain.coll, args);
        };
        domain.collUser.findOneAndUpdate = async (...args) => {
            const result = await originalFindOneAndUpdate.apply(domain.collUser, args);
            const ownToken = args[1]?.[0]?.$set?._roleAssignment?.$cond?.[1]?.token;
            if (ownToken && result?._roleAssignment && result._roleAssignment.token !== ownToken) notifyWaiting();
            return result;
        };
        const firstJoin = domain.joinUserInDomain(domainId, 81, 'teacher');
        let secondJoin;
        try {
            await firstStarted;
            secondJoin = domain.joinUserInDomain(domainId, 81, 'assistant');
            await secondWaiting;
            releaseFirst();
            const joined = await Promise.all([firstJoin, secondJoin]);
            assert.deepEqual(Array.from(joined, (member) => member.role), ['teacher', 'teacher']);
            assert.equal((await domain.collUser.findOne({ domainId, uid: 81 }))._roleAssignment, undefined);
        } finally {
            releaseFirst();
            await Promise.allSettled([firstJoin, secondJoin]);
            domain.coll.findOne = originalFindOne;
            domain.collUser.findOneAndUpdate = originalFindOneAndUpdate;
        }
    });

    it('failed rollback writes leave permissions at the original role and can be recovered after expiration', async () => {
        await resetDomain();
        await domain.setUserInDomain(domainId, 82, { join: true, role: 'student' });
        const originalFindOneAndUpdate = domain.collUser.findOneAndUpdate;
        domain.collUser.findOneAndUpdate = async (...args) => {
            if (args[0]['_roleAssignment.token']) throw new Error('Injected rollback write failure');
            return await originalFindOneAndUpdate.apply(domain.collUser, args);
        };
        try {
            await duringRoleVerification(async () => {
                throw new Error('Injected role recheck failure');
            }, () => assert.rejects(domain.joinUserInDomain(domainId, 82, 'teacher'), /Injected rollback write failure/));
            const effective = await domain.getDomainUser(domainId, { _id: 82, priv: builtin.PRIV.PRIV_USER_PROFILE });
            assert.equal(effective.role, 'student');
            assert.equal(effective.perm, 7n);
        } finally {
            domain.collUser.findOneAndUpdate = originalFindOneAndUpdate;
        }
        await domain.collUser.updateOne({ domainId, uid: 82 }, {
            $set: { '_roleAssignment.expiresAt': new Date(Date.now() - 1000) },
        });
        const recovered = await domain.joinUserInDomain(domainId, 82, 'default');
        assert.equal(recovered.role, 'student');
        assert.equal(recovered._roleAssignment, undefined);
    });

    it('expired links and a concurrent ban cannot change an existing member role', async () => {
        await resetDomain();
        await domain.edit(domainId, { _join: { method: domain.JOIN_METHOD_ALL, role: 'student', expire: new Date(Date.now() - 1000) } });
        await domain.setUserInDomain(domainId, 10, { join: true, role: 'default' });
        const joining = handler('domain_join');
        await assert.rejects(joining.prepare({ domainId }));
        assert.equal((await domain.collUser.findOne({ domainId, uid: 10 })).role, 'default');
        await domain.edit(domainId, { _join: { method: domain.JOIN_METHOD_ALL, role: 'student', expire: null } });
        await joining.prepare({ domainId });
        await domain.setUserRole(domainId, 10, 'guest');
        await assert.rejects(joining.post({ domainId }), { name: 'DomainJoinForbiddenError' });
        assert.equal((await domain.collUser.findOne({ domainId, uid: 10 })).role, 'guest');
    });

    it('class invitations upgrade existing domain/class members and preserve a teacher role', async () => {
        await resetDomain();
        const groupId = new ObjectId();
        await user.collGroup.insertOne({ _id: groupId, domainId, name: 'class-a', class: true, uids: [10], students: [10], teachers: [] });
        const [id] = await tokens.add(tokens.TYPE_GROUP_INVITATION, 3600, { domainId, groupId, allowExternalDomainJoin: true, externalJoinRole: 'student' });
        await user.collGroup.updateOne({ _id: groupId }, { $set: { invitationTokenId: id } });
        await domain.setUserInDomain(domainId, 10, { join: true, role: 'default' });
        const joining = handler('domain_group_join');
        await joining.prepare({ domainId }, id);
        await joining.post();
        assert.equal((await domain.collUser.findOne({ domainId, uid: 10 })).role, 'student');
        await domain.setUserRole(domainId, 10, 'teacher');
        await joining.prepare({ domainId }, id);
        await joining.post();
        assert.equal((await domain.collUser.findOne({ domainId, uid: 10 })).role, 'teacher');
        assert.equal((await user.collGroup.findOne({ _id: groupId })).classEditLock, undefined);
        await domain.setUserRole(domainId, 10, 'guest');
        await assert.rejects(joining.prepare({ domainId }, id), { name: 'DomainJoinForbiddenError' });
    });

    it('group links upgrade members while restricted class links keep domain roles and reject outsiders', async () => {
        await resetDomain();
        await domain.setUserInDomain(domainId, 10, { join: true, role: 'default' });
        const groupId = new ObjectId();
        await user.collGroup.insertOne({ _id: groupId, domainId, name: 'group-a', uids: [] });
        const [groupToken] = await tokens.add(tokens.TYPE_GROUP_INVITATION, 3600, { domainId, groupId, externalJoinRole: 'student' });
        await user.collGroup.updateOne({ _id: groupId }, { $set: { invitationTokenId: groupToken } });
        const groupJoining = handler('domain_group_join');
        await groupJoining.prepare({ domainId }, groupToken);
        await groupJoining.post();
        assert.equal((await domain.collUser.findOne({ domainId, uid: 10 })).role, 'student');

        const classId = new ObjectId();
        await user.collGroup.insertOne({ _id: classId, domainId, name: 'restricted', class: true, uids: [], teachers: [], students: [] });
        const [classToken] = await tokens.add(tokens.TYPE_GROUP_INVITATION, 3600, { domainId, groupId: classId, allowExternalDomainJoin: false });
        await user.collGroup.updateOne({ _id: classId }, { $set: { invitationTokenId: classToken } });
        await domain.setUserRole(domainId, 10, 'default');
        const classJoining = handler('domain_group_join');
        await classJoining.prepare({ domainId }, classToken);
        await classJoining.post();
        assert.equal((await domain.collUser.findOne({ domainId, uid: 10 })).role, 'default');
        const outsider = handler('domain_group_join', 11);
        await assert.rejects(outsider.prepare({ domainId }, classToken), { name: 'DomainJoinForbiddenError' });
    });

    it('stale group and class invitations preserve existing roles and reject new domain members', async () => {
        const settings = meta(await resetDomain(), 'default');
        [settings.default.priority, settings.student.priority] = [settings.student.priority, settings.default.priority];
        await domain.setRoleMeta(domainId, settings);
        for (const isClass of [false, true]) {
            await domain.addRole(domainId, 'obsolete', 1n);
            const groupId = new ObjectId();
            await user.collGroup.insertOne({
                _id: groupId, domainId, name: `stale-${isClass}`, class: isClass, uids: [], students: [], teachers: [],
            });
            const [id] = await tokens.add(tokens.TYPE_GROUP_INVITATION, 3600, {
                domainId, groupId, allowExternalDomainJoin: true, externalJoinRole: 'obsolete',
            });
            await user.collGroup.updateOne({ _id: groupId }, { $set: { invitationTokenId: id } });
            await domain.deleteRoles(domainId, ['obsolete']);
            for (const [index, role] of ['student', 'default', 'teacher', 'root'].entries()) {
                const uid = 10 + index;
                await domain.setUserInDomain(domainId, uid, { join: true, role });
                const joining = handler('domain_group_join', uid);
                await joining.prepare({ domainId }, id);
                await joining.post();
                assert.equal((await domain.collUser.findOne({ domainId, uid })).role, role);
                assert((await user.collGroup.findOne({ _id: groupId })).uids.includes(uid));
            }
            const outsider = handler('domain_group_join', 14);
            await outsider.prepare({ domainId }, id);
            await assert.rejects(outsider.post(), { field: 'externalJoinRole' });
            assert.equal(await domain.collUser.findOne({ domainId, uid: 14 }), null);
            assert(!(await user.collGroup.findOne({ _id: groupId })).uids.includes(14));
        }
    });

    it('retains fallback behavior for missing roles and failed custom-role rechecks', async () => {
        await resetDomain();
        for (const [index, membership] of [null, { join: false, role: 'teacher' }, { join: true, role: 'deleted' }].entries()) {
            const uid = 20 + index;
            if (membership) await domain.setUserInDomain(domainId, uid, membership);
            const joined = await domain.joinUserInDomain(domainId, uid, 'missing');
            assert.equal(joined.join, true);
            assert.equal(joined.role, 'default');
        }
        const originalFindOne = domain.coll.findOne;
        domain.coll.findOne = async (...args) => {
            if (args[0]._id === domainId && args[1]?.projection?.roles) throw new Error('Injected role recheck failure');
            return await originalFindOne.apply(domain.coll, args);
        };
        try {
            const joined = await domain.joinUserInDomain(domainId, 23, 'student');
            assert.equal(joined.join, true);
            assert.equal(joined.role, 'default');
        } finally {
            domain.coll.findOne = originalFindOne;
        }
    });

    it('role selectors and omitted creation roles use the marked default, with ordered permission columns', async () => {
        const roles = await resetDomain();
        await domain.setRoleMeta(domainId, meta(roles));
        await domain.edit(domainId, { _join: null });
        const applications = handler('domain_join_applications', 1, true);
        await applications.prepare({ domainId });
        await applications.get();
        assert.equal(applications.response.body.defaultRole, 'student');
        await applications.post(domainId, domain.JOIN_METHOD_ALL, undefined, '', -1);
        assert.equal((await domain.get(domainId))._join.role, 'student');
        const groupId = new ObjectId();
        await user.collGroup.insertOne({ _id: groupId, domainId, name: 'class-default', class: true, uids: [], teachers: [], students: [] });
        const invitation = handler('domain_group_invitation', 1, true);
        await invitation.prepare(domainId, groupId);
        await invitation.postCreate({ domainId }, 3);
        const group = await user.collGroup.findOne({ _id: groupId });
        assert.equal((await tokens.get(group.invitationTokenId)).externalJoinRole, 'student');
        const permissions = handler('domain_permission', 1, true);
        await permissions.prepare({ domainId });
        await permissions.get({ domainId });
        assert.deepEqual(Array.from(permissions.response.body.roles, (role) => role._id), ['guest', 'default', 'student', 'teacher', 'root']);
        await invitation.get({ domainId });
        assert.equal(invitation.response.body.defaultRole, 'student');

        for (const [template, body, selector] of [
            ['domain_join_applications.html', applications.response.body, 'role'],
            ['domain_group_invitation.html', { ...invitation.response.body, currentInvitation: { externalJoinRole: 'default', expireAt: new Date() } }, 'externalJoinRole'],
        ]) {
            const dom = new JSDOM(render(template, body));
            assert.equal(dom.window.document.querySelector(`select[name="${selector}"]`).value, 'student');
            dom.window.close();
        }
    });

    it('editing public invitations retains the saved role when changing expiration or invitation code', async () => {
        const roles = await resetDomain();
        await domain.setRoleMeta(domainId, meta(roles));
        for (const role of ['default', 'teacher']) {
            await domain.edit(domainId, { _join: {
                method: domain.JOIN_METHOD_CODE, role, code: 'oldCode', expire: null,
            } });
            const applications = handler('domain_join_applications', 1, true);
            await applications.prepare({ domainId });
            await applications.get();
            assert.equal(applications.response.body.defaultRole, 'student');
            const dom = new JSDOM(render('domain_join_applications.html', applications.response.body));
            try {
                const selectedRole = dom.window.document.querySelector('select[name="role"]').value;
                assert.equal(selectedRole, role);
                await applications.post(domainId, domain.JOIN_METHOD_CODE, selectedRole, '', 24, 'newCode');
                const saved = (await domain.get(domainId))._join;
                assert.equal(saved.role, role);
                assert.equal(saved.code, 'newCode');
                assert(saved.expire > new Date());
            } finally {
                dom.window.close();
            }
        }
    });

    it('role page reorders unique positions, fixes the endpoints and submits the default radio', async () => {
        const roles = await resetDomain();
        await domain.setRoleMeta(domainId, meta(roles));
        const dom = new JSDOM(render('domain_role.html', { roles: await domain.getRoles(domainId) }));
        const $ = require('jquery')(dom.window);
        const submitted = [];
        const notifications = [];
        class ActionDialog { constructor({ $body }) { this.$dom = $body; } }
        loadSource('packages/ui-default/pages/domain_role.page.js', {
            jquery: $,
            'vj/components/dialog': { ActionDialog, ConfirmDialog: class {} },
            'vj/components/notification': { error: (text) => notifications.push(text), success: () => {} },
            'vj/misc/Page': { NamedPage: class { constructor(_name, run) { run(); } } },
            'vj/utils': {
                i18n: (text) => text,
                request: { post: async (_url, body) => submitted.push(body) },
                delay: () => new Promise(() => {}),
            },
        }, { window: dom.window });
        assert.equal($('[data-role-default="student"]').prop('checked'), true);
        assert.equal($('[data-role-default="guest"]').prop('disabled'), true);
        assert.equal($('input[data-role-priority="root"]').length, 0);
        $('input[data-role-priority="teacher"]').val(1).trigger('change');
        assert.deepEqual($('.domain-roles [data-role-priority]').toArray().map((node) => $(node).attr('data-role-priority')), ['guest', 'teacher', 'default', 'student', 'root']);
        $('[name="update_roles"]').trigger('click');
        assert.deepEqual(Array.from(submitted[0].roles, (role) => role.priority), [0, 1, 2, 3, 4]);
        assert.equal(submitted[0].roles.find((role) => role.role === 'student').default, true);
        const updating = handler('domain_role', 1, true);
        updating.request.body = submitted[0];
        await updating.postUpdate({ domainId });
        assert.deepEqual(Array.from(await domain.getRoles(domainId), (role) => role._id), ['guest', 'teacher', 'default', 'student', 'root']);
        assert.equal(notifications.length, 0);
        dom.window.close();
    });
});
