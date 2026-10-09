import assert from 'assert';
import {
    mkdtempSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import autocannon from 'autocannon';
import { Binary, ObjectId } from 'mongodb';
import {
    after, before, beforeEach, describe, it,
} from 'node:test';
import * as supertest from 'supertest';
import { PERM, PRIV, STATUS } from '@hydrooj/common';
import { getApiArgs } from '@hydrooj/framework';

const Root = {
    username: 'root',
    password: '123456',
    creditionals: null,
};

describe('App', () => {
    let agent;
    before(async () => {
        const init = Date.now();
        await new Promise((resolve) => {
            process.send = ((send) => (data) => {
                console.log('send', data);
                if (data === 'ready') {
                    agent = supertest.agent(require('hydrooj').httpServer);
                    resolve(null);
                }
                return send?.(data) || false;
            })(process.send);
        });
        console.log('Application inited in %d ms', Date.now() - init);
    }, { timeout: 30000 });

    beforeEach(async () => {
        // Each case starts with fresh transport/login quotas. Production limits
        // remain active within a case, including password and feedback limits.
        await global.app.get('db').db.collection('opcount').deleteMany({ op: { $in: ['global', 'user_login', 'user_login_id'] } });
    });

    it('enforces the global HTTP quota within a case and recovers after its counter is cleared', async () => {
        const guest = supertest.agent(require('hydrooj').httpServer);
        const counters = global.app.get('db').db.collection('opcount');
        await guest.get('/').expect(200);
        const counter = await counters.findOne({ op: 'global' });
        assert(counter);
        const now = Date.now();
        const windowEnd = now - now % 5000 + 5000;
        // Cover a possible clock boundary without sleeps or relaxed production limits.
        for (const expireAt of [new Date(windowEnd), new Date(windowEnd + 5000)]) {
            await counters.updateOne(
                { op: 'global', ident: counter.ident, expireAt },
                { $set: { opcount: 100 } }, { upsert: true },
            );
        }
        const denied = await guest.get('/').set('Accept', 'application/json').expect(403);
        assert.equal(denied.body.error.name, 'OpcountExceededError');
        assert.equal(denied.body.error.params[0], 'global');
        await counters.deleteMany({ op: 'global' });
        await guest.get('/').expect(200);
    });

    const routes = ['/', '/p', '/contest', '/homework', '/user/1', '/training'];
    for (const route of routes) {
        // eslint-disable-next-line ts/no-loop-func
        it(`GET ${route}`, () => agent.get(route).expect(200));
    }

    it('API user', async () => {
        await agent.get('/api/user?args={"id":1}&projection=uname').expect({ uname: 'Hydro' });
        await agent.get('/api/user?args={"id":2}&projection=uname').expect(null);
    });

    it('Create User', async () => {
        const redirect = await agent.post('/register')
            .send({ mail: 'test@example.com' })
            .expect(302)
            .then((res) => res.headers.location);
        await agent.post(redirect)
            .send({ uname: Root.username, password: Root.password, verifyPassword: Root.password })
            .expect(302);
    });

    it('Login', async () => {
        const cookie = await agent.post('/login')
            .send({ uname: Root.username, password: Root.password })
            .expect(302)
            .then((res) => res.headers['set-cookie']);
        assert(cookie.some((item) => /httponly/i.test(item)));
        assert(cookie.some((item) => /samesite=lax/i.test(item)));
        Root.creditionals = cookie;
    });

    it('enforces IP and account login quotas within a case and recovers after counters are cleared', async () => {
        const counters = global.app.get('db').db.collection('opcount');
        const freshLogin = () => supertest.agent(require('hydrooj').httpServer).post('/login')
            .set('Accept', 'application/json').send({ uname: Root.username, password: Root.password });
        // Quota requests mutate shared counters and must complete sequentially.
        /* eslint-disable no-await-in-loop */
        for (const [op, limit] of [['user_login', 30], ['user_login_id', 5]] as const) {
            await counters.deleteMany({ op: { $in: ['user_login', 'user_login_id'] } });
            await freshLogin().expect(200);
            const counter = await counters.findOne({ op });
            assert(counter);
            const now = Date.now();
            const windowEnd = now - now % 60000 + 60000;
            for (const expireAt of [new Date(windowEnd), new Date(windowEnd + 60000)]) {
                await counters.updateOne({ op, ident: counter.ident, expireAt }, { $set: { opcount: limit } }, { upsert: true });
            }
            const denied = await freshLogin().expect(403);
            assert.equal(denied.body.error.name, 'OpcountExceededError');
            assert.equal(denied.body.error.params[0], op);
            await counters.deleteMany({ op: { $in: ['user_login', 'user_login_id'] } });
            await freshLogin().expect(200);
        }
        /* eslint-enable no-await-in-loop */
    });

    it('Rejects session IDs supplied through the query string', async () => {
        const sid = /(?:^|;\s*)sid=([^;]+)/.exec(Root.creditionals[0])?.[1];
        assert(sid);
        const request = require('supertest');
        await request(require('hydrooj').httpServer)
            .get(`/home/settings/preference?sid=${encodeURIComponent(sid)}`)
            .expect(302);
    });

    require('./classroom-feedback.integration').register();

    it('Does not let API RPC messages override an explicit route domain', () => {
        const args = getApiArgs({
            domainId: 'route-domain',
            originalPath: '/d/route-domain/api/rpc/conn',
        }, { domainId: 'forged-domain', initial: 0 });
        assert.equal(args.domainId, 'route-domain');
    });

    it('Does not let another domain owner mutate this domain through API arguments', async () => {
        const DomainModel = global.Hydro.model.domain;
        const UserModel = global.Hydro.model.user;
        const suffix = Date.now().toString(36);
        const targetDomainId = `api-target-${suffix}`;
        const attackerDomainId = `api-attacker-${suffix}`;
        const uname = `apiattacker${suffix}`;
        const uid = await UserModel.create(`${uname}@example.com`, uname, '123456');
        const attacker = supertest.agent(require('hydrooj').httpServer);

        await Promise.all([
            DomainModel.add(targetDomainId, 2, `API target ${suffix}`, ''),
            DomainModel.add(attackerDomainId, uid, `API attacker ${suffix}`, ''),
        ]);
        try {
            await DomainModel.setUserRole(targetDomainId, uid, 'default', true);
            await attacker.post('/login').send({ uname, password: '123456' }).expect(302);
            await attacker.post(`/d/${targetDomainId}/api/domain.group`)
                .set('Accept', 'application/json')
                .send({ domainId: attackerDomainId, name: `blocked-${suffix}`, uids: [uid] })
                .expect(403);
            assert.equal(await UserModel.collGroup.countDocuments({ domainId: targetDomainId, name: `blocked-${suffix}` }), 0);
        } finally {
            await Promise.all([
                DomainModel.coll.deleteMany({ _id: { $in: [targetDomainId, attackerDomainId] } }),
                DomainModel.collUser.deleteMany({ domainId: { $in: [targetDomainId, attackerDomainId] } }),
                UserModel.collGroup.deleteMany({ domainId: { $in: [targetDomainId, attackerDomainId] } }),
            ]);
        }
    });

    it('Rejects cross-origin cookie-authenticated form submissions', async () => {
        await agent.post('/home/domain')
            .type('form')
            .set('Origin', 'https://attacker.example')
            .send({ operation: 'leave', id: 'system' })
            .expect(403);
    });

    it('API registered user', async () => {
        await agent.get('/api/user?args={"id":2}&projection=uname').expect({ uname: 'root' });
    });

    it('only saves editable boolean settings and cannot activate pending invitation roles', async () => {
        const DomainModel = global.Hydro.model.domain;
        const UserModel = global.Hydro.model.user;
        const SettingModel = require('../packages/hydrooj/src/model/setting');
        const suffix = Date.now().toString(36);
        const uname = `settingsguard${suffix}`;
        const domainId = `settings-guard-${suffix}`;
        const uid = await UserModel.create(`${uname}@example.com`, uname, '123456');
        const editableKey = `settingsGuard${suffix}`;
        const disabledKey = `settingsDisabled${suffix}`;
        const secretKey = `settingsSecret${suffix}`;
        const disposeSettings = SettingModel.DomainUserSetting(
            SettingModel.Setting('setting_info', editableKey, true, 'boolean'),
            SettingModel.Setting('setting_info', disabledKey, true, 'boolean', '', '', SettingModel.FLAG_DISABLED),
            SettingModel.Setting('setting_storage', secretKey, true, 'boolean'),
        );
        const findDomain = DomainModel.coll.findOne;
        const updateMember = DomainModel.collUser.findOneAndUpdate;
        try {
            await DomainModel.add(domainId, 2, 'Settings guard', '');
            await DomainModel.addRole(domainId, 'student', PERM.PERM_DEFAULT);
            await DomainModel.addRole(domainId, 'teacher', PERM.PERM_DEFAULT | PERM.PERM_EDIT_DOMAIN);
            await DomainModel.setUserRole(domainId, uid, 'student', true);
            await DomainModel.setUserInDomain(domainId, uid, {
                displayName: 'Student', nAccept: 9, [editableKey]: true, [disabledKey]: true, [secretKey]: true,
            });
            const invitee = supertest.agent(require('hydrooj').httpServer);
            await invitee.post('/login').send({ uname, password: '123456' }).expect(302);
            DomainModel.coll.findOne = async function (...args: any[]) {
                if (args[0]?._id === domainId && args[1]?.projection?.roles) throw new Error('Injected role recheck failure');
                return await findDomain.apply(this, args);
            };
            DomainModel.collUser.findOneAndUpdate = async function (...args: any[]) {
                if (args[0]?.domainId === domainId && args[0]?.['_roleAssignment.token']) throw new Error('Injected rollback failure');
                return await updateMember.apply(this, args);
            };
            try {
                await assert.rejects(DomainModel.joinUserInDomain(domainId, uid, 'teacher'), /Injected rollback failure/);
            } finally {
                DomainModel.coll.findOne = findDomain;
                DomainModel.collUser.findOneAndUpdate = updateMember;
            }
            const memberBefore = await DomainModel.collUser.findOne({ domainId, uid });
            assert(memberBefore._roleAssignment);
            await invitee.post(`/d/${domainId}/home/settings/domain`).send({
                booleanKeys: {
                    _roleAssignment: true, role: true, join: true, requireInvitation: true,
                    nAccept: true, displayName: true, constructor: true,
                    [editableKey]: true, [disabledKey]: true, [secretKey]: true,
                },
            }).expect(302);
            const memberAfter = await DomainModel.collUser.findOne({ domainId, uid });
            assert.equal(memberAfter[editableKey], false);
            assert.deepStrictEqual({ ...memberAfter, [editableKey]: memberBefore[editableKey] }, memberBefore);
            const effective = await UserModel.getById(domainId, uid);
            assert.equal(effective.role, 'student');
            assert.equal(effective.hasPerm(PERM.PERM_EDIT_DOMAIN), false);
            const userBefore = await UserModel.coll.findOne({ _id: uid });
            await invitee.post('/home/settings/account').send({
                booleanKeys: { priv: true, authn: true, requirePasswordChange: true, bio: true, constructor: true },
            }).expect(302);
            assert.deepStrictEqual(await UserModel.coll.findOne({ _id: uid }), userBefore);
            await DomainModel.collUser.updateOne({ domainId, uid }, {
                $set: { '_roleAssignment.expiresAt': new Date(Date.now() - 1000) },
            });
            const recovered = await DomainModel.joinUserInDomain(domainId, uid, 'default');
            assert.equal(recovered.role, 'student');
            assert.equal(recovered._roleAssignment, undefined);
        } finally {
            DomainModel.coll.findOne = findDomain;
            DomainModel.collUser.findOneAndUpdate = updateMember;
            disposeSettings();
            await Promise.all([
                DomainModel.coll.deleteOne({ _id: domainId }),
                DomainModel.collUser.deleteMany({ uid }),
                UserModel.coll.deleteOne({ _id: uid }),
            ]);
            UserModel._deleteUserCache({ _id: uid, uname, mail: `${uname}@example.com` });
        }
    });

    it('manages legacy reserved roles over HTTP and rejects new reserved names', async () => {
        const DomainModel = global.Hydro.model.domain;
        const UserModel = global.Hydro.model.user;
        const suffix = Date.now().toString(36);
        const domainId = `permission-guard-${suffix}`;
        const uname = `permissionguard${suffix}`;
        const uid = await UserModel.create(`${uname}@example.com`, uname, '123456');
        const manager = supertest.agent(require('hydrooj').httpServer);
        const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
        const roleUrl = `/d/${domainId}/domain/role`;
        const permissionUrl = `/d/${domainId}/domain/permission`;
        const origin = `http://127.0.0.1:${require('hydrooj').httpServer.address().port}`;
        try {
            await DomainModel.add(domainId, 2, 'Permission guard', '');
            await manager.post('/login').send({ uname: Root.username, password: Root.password }).expect(302);
            const sudo = await manager.post(permissionUrl).send({}).expect(302).expect('location', /\/user\/sudo$/);
            await manager.post(sudo.headers.location).send({ password: Root.password }).expect(200);
            for (const role of names) {
                // eslint-disable-next-line no-await-in-loop
                await manager.post(roleUrl).send({ operation: 'add', role }).expect(403);
                // eslint-disable-next-line no-await-in-loop
                assert.equal(Object.hasOwn((await DomainModel.coll.findOne({ _id: domainId })).roles, role), false);
            }
            await manager.post(permissionUrl).send({ constructor: ['1', '1000'] }).expect(403);
            await manager.post(roleUrl).send({ operation: 'add', role: 'permissions' }).expect(302);
            // Seed the documents an older build could have persisted.
            await DomainModel.edit(domainId, {
                roles: Object.fromEntries([...names, 'permissions'].map((name) => [name, PERM.PERM_DEFAULT.toString()])),
            });
            for (const [index, role] of names.entries()) {
                const form = new URLSearchParams([
                    ['operation', 'update'],
                    [`permissions[${index}][role]`, role],
                    [`permissions[${index}][permissions][]`, '1'],
                    [`permissions[${index}][permissions][]`, '1000'],
                ]).toString();
                // eslint-disable-next-line no-await-in-loop
                await manager.post(permissionUrl).type('form').set('Origin', origin).send(form).expect(302);
                // eslint-disable-next-line no-await-in-loop
                assert.equal((await DomainModel.coll.findOne({ _id: domainId })).roles[role], '2');
            }
            await manager.post(permissionUrl).send({
                operation: 'update', permissions: [
                    { role: '__proto__', permissions: ['2', '1000'] },
                    { role: 'root', permissions: ['0'] },
                ],
            }).expect(302);
            const stored = await DomainModel.coll.findOne({ _id: domainId });
            assert.equal(Reflect.get(stored.roles, '__proto__'), '4');
            assert.equal(Object.hasOwn(stored.roles, 'root'), false);
            await manager.post(permissionUrl).send({
                permissions: ['0', '1001', '1000'], constructor: ['2', '1000'],
            }).expect(302);
            const legacy = await DomainModel.coll.findOne({ _id: domainId });
            assert.equal(legacy.roles.permissions, ((1n << 1001n) | 1n).toString());
            assert.equal(legacy.roles.constructor, '4');
            await manager.post(permissionUrl).send({
                operation: 'update', permissions: [{ role: '__proto__', permissions: ['-1'] }],
            }).expect(403);
            await manager.post(permissionUrl).send({
                operation: 'update', permissions: [
                    { role: '__proto__', permissions: ['0'] }, { role: '__proto__', permissions: ['1'] },
                ],
            }).expect(403);
            assert.deepStrictEqual((await DomainModel.coll.findOne({ _id: domainId })).roles, legacy.roles);
            await DomainModel.setUserRole(domainId, uid, 'default', true);
            await manager.post(`/d/${domainId}/domain/user`).send({
                operation: 'set_users', uids: [uid], role: '__proto__', join: true,
            }).expect(302);
            const members = await manager.get(`/d/${domainId}/domain/user`).accept('json').expect(200);
            assert.equal(Object.hasOwn(members.body.rudocs, '__proto__'), true);
            assert(Reflect.get(members.body.rudocs, '__proto__').some((member) => member._id === uid));
            assert.equal(Object.hasOwn(members.body.domain, '_join'), false);
            assert.equal((await UserModel.getById(domainId, uid)).perm, 4n);
            const roles = await DomainModel.getRoles(domainId);
            await manager.post(roleUrl).send({
                operation: 'update', roles: roles.map((role) => ({
                    role: role._id, priority: role.priority, default: role._id === '__proto__',
                })),
            }).expect(302);
            assert.equal(DomainModel.getDefaultRole(await DomainModel.getRoles(domainId)), '__proto__');
            await manager.post(roleUrl).send({ operation: 'delete', roles: names }).expect(302);
            assert.equal((await DomainModel.collUser.findOne({ domainId, uid })).role, 'default');
            const remaining = await DomainModel.getRoles(domainId);
            assert(remaining.every((role) => !names.includes(role._id)));
        } finally {
            await Promise.all([
                DomainModel.del(domainId),
                UserModel.coll.deleteOne({ _id: uid }),
            ]);
            UserModel._deleteUserCache({ _id: uid, uname, mail: `${uname}@example.com` });
        }
    });

    it('Tracks problem edits and falls back to creation metadata', async () => {
        const ProblemModel = global.Hydro.model.problem;
        const suffix = Date.now().toString(36);
        const pids: number[] = [];

        try {
            const pid = await ProblemModel.add('system', `metadata-${suffix}`, `Metadata ${suffix}`, 'old', 2);
            pids.push(pid);
            const editStartedAt = Date.now();
            await agent.post(`/p/${pid}/edit`)
                .send({
                    title: `Updated metadata ${suffix}`,
                    content: 'new',
                    pid: `metadata-${suffix}`,
                    hidden: false,
                    tag: '',
                    difficulty: 1,
                })
                .expect(302);

            const updated = await ProblemModel.get('system', pid);
            assert.equal(updated.editor, 2);
            assert(updated.updateAt.getTime() >= editStartedAt);
            const detail = await agent.get(`/p/${pid}`)
                .set('Accept', 'application/json')
                .expect(200);
            assert.equal(detail.body.pdoc.editor, 2);
            assert.equal(new Date(detail.body.pdoc.updateAt).getTime(), updated.updateAt.getTime());
            const api = await agent.get(`/api/problem?args=${encodeURIComponent(JSON.stringify({
                id: pid, domainId: 'system',
            }))}`).expect(200);
            assert.equal(api.body.editor, 2);
            assert.equal(new Date(api.body.updateAt).getTime(), updated.updateAt.getTime());

            await ProblemModel.edit('system', pid, { hidden: true });
            const internalUpdated = await ProblemModel.get('system', pid);
            assert.equal(internalUpdated.editor, updated.editor);
            assert.equal(internalUpdated.updateAt.getTime(), updated.updateAt.getTime());

            const oldFileMetadata = new Date('2000-01-02T03:04:05Z');
            await ProblemModel.edit('system', pid, { editor: 3, updateAt: oldFileMetadata });
            const additionalName = `metadata-${suffix}.txt`;
            const renamedAdditionalName = `renamed-${suffix}.txt`;
            await agent.post(`/p/${pid}/files`)
                .field('operation', 'upload_file')
                .field('type', 'additional_file')
                .set('Origin', 'http://127.0.0.1:8888')
                .attach('file', Buffer.from('attachment\n'), additionalName)
                .expect(302);
            let fileUpdated = await ProblemModel.get('system', pid);
            assert.equal(fileUpdated.editor, 2);
            assert(fileUpdated.updateAt.getTime() > oldFileMetadata.getTime());

            await agent.post(`/p/${pid}/files`)
                .send({ operation: 'rename_files', files: [additionalName], newNames: [renamedAdditionalName], type: 'additional_file' })
                .expect(302);
            fileUpdated = await ProblemModel.get('system', pid);
            assert.equal(fileUpdated.editor, 2);
            assert(fileUpdated.updateAt.getTime() > oldFileMetadata.getTime());

            await agent.post(`/p/${pid}/files`)
                .send({ operation: 'delete_files', files: [renamedAdditionalName], type: 'additional_file' })
                .expect(302);
            fileUpdated = await ProblemModel.get('system', pid);
            assert.equal(fileUpdated.editor, 2);
            assert(fileUpdated.updateAt.getTime() > oldFileMetadata.getTime());

            await agent.post(`/p/${pid}/files`)
                .field('operation', 'upload_file')
                .field('type', 'testdata')
                .set('Origin', 'http://127.0.0.1:8888')
                .attach('file', Buffer.from('time: 1s\nmemory: 1m\n'), 'config.yaml')
                .expect(302);
            fileUpdated = await ProblemModel.get('system', pid);
            assert.equal(fileUpdated.editor, 2);
            assert(fileUpdated.updateAt.getTime() > oldFileMetadata.getTime());

            const copiedPid = await ProblemModel.copy('system', pid, 'system');
            pids.push(copiedPid);
            const copied = await ProblemModel.get('system', copiedPid);
            assert.equal(copied.editor, fileUpdated.editor);
            assert.equal(copied.updateAt.getTime(), fileUpdated.updateAt.getTime());
            const copiedDetail = await agent.get(`/p/${copiedPid}`)
                .set('Accept', 'application/json')
                .expect(200);
            assert.equal(copiedDetail.body.editor_udoc._id, fileUpdated.editor);
            assert.equal(new Date(copiedDetail.body.lastUpdateAt).getTime(), fileUpdated.updateAt.getTime());

            const legacyPid = await ProblemModel.add('system', `legacy-${suffix}`, `Legacy ${suffix}`, '', 2);
            pids.push(legacyPid);
            const legacy = await ProblemModel.get('system', legacyPid);
            const legacyDetail = await agent.get(`/p/${legacyPid}`)
                .set('Accept', 'application/json')
                .expect(200);
            assert(!('editor' in legacyDetail.body.pdoc));
            assert(!('updateAt' in legacyDetail.body.pdoc));
            assert.equal(legacyDetail.body.editor_udoc._id, 2);
            assert.equal(
                new Date(legacyDetail.body.lastUpdateAt).getTime(),
                legacy._id.getTimestamp().getTime(),
            );
            const legacyCopyPid = await ProblemModel.copy('system', legacyPid, 'system');
            pids.push(legacyCopyPid);
            const legacyCopy = await ProblemModel.get('system', legacyCopyPid);
            assert(!('editor' in legacyCopy));
            assert(!('updateAt' in legacyCopy));
            const legacyCopyDetail = await agent.get(`/p/${legacyCopyPid}`)
                .set('Accept', 'application/json')
                .expect(200);
            assert.equal(legacyCopyDetail.body.editor_udoc._id, 2);
            assert.equal(
                new Date(legacyCopyDetail.body.lastUpdateAt).getTime(),
                legacyCopy._id.getTimestamp().getTime(),
            );
        } finally {
            await Promise.all(pids.map((id) => ProblemModel.del('system', id)));
        }
    });

    it('Exports files from referenced problems using source-domain permissions', async () => {
        const DomainModel = global.Hydro.model.domain;
        const ProblemModel = global.Hydro.model.problem;
        const StorageModel = global.Hydro.model.storage;
        const UserModel = global.Hydro.model.user;
        const suffix = Date.now().toString(36);
        const sourceDomain = `ref-files-source-${suffix}`;
        const targetDomain = `ref-files-target-${suffix}`;
        const sourceReaderRole = `ref-files-reader-${suffix}`;
        const targetRole = `ref-files-target-user-${suffix}`;
        const testdataName = `data-${suffix}.in`;
        const additionalName = `attachment-${suffix}.txt`;
        const createdUsers: number[] = [];
        let sourcePid: number;
        let targetPid: number;

        const createUser = async (prefix: string) => {
            const uname = `${prefix}${suffix}`;
            const uid = await UserModel.create(`${uname}@example.com`, uname, '123456');
            createdUsers.push(uid);
            return { uid, uname };
        };

        try {
            const owner = await createUser('reffileowner');
            const reader = await createUser('reffilereader');
            const limited = await createUser('reffilelimited');
            await Promise.all([
                DomainModel.add(sourceDomain, owner.uid, `Referenced files source ${suffix}`, ''),
                DomainModel.add(targetDomain, owner.uid, `Referenced files target ${suffix}`, ''),
            ]);
            await Promise.all([
                DomainModel.addRole(
                    sourceDomain,
                    sourceReaderRole,
                    PERM.PERM_DEFAULT | PERM.PERM_READ_PROBLEM_DATA,
                ),
                DomainModel.addRole(targetDomain, targetRole, PERM.PERM_DEFAULT),
                DomainModel.setUserRole(sourceDomain, reader.uid, sourceReaderRole, true),
                DomainModel.setUserRole(sourceDomain, limited.uid, 'default', true),
                DomainModel.setUserRole(targetDomain, reader.uid, targetRole, true),
                DomainModel.setUserRole(targetDomain, limited.uid, targetRole, true),
            ]);

            sourcePid = await ProblemModel.add(
                sourceDomain, `source-${suffix}`, `Referenced files ${suffix}`, '', owner.uid,
            );
            await Promise.all([
                ProblemModel.addTestdata(sourceDomain, sourcePid, testdataName, Buffer.from('1 2\n'), owner.uid),
                ProblemModel.addAdditionalFile(sourceDomain, sourcePid, additionalName, Buffer.from('attachment\n'), owner.uid),
            ]);
            const [sourceTestdataFile, sourceAdditionalFile] = await Promise.all([
                StorageModel.coll.findOne({ path: `problem/${sourceDomain}/${sourcePid}/testdata/${testdataName}` }),
                StorageModel.coll.findOne({ path: `problem/${sourceDomain}/${sourcePid}/additional_file/${additionalName}` }),
            ]);
            assert(sourceTestdataFile);
            assert(sourceAdditionalFile);
            targetPid = await ProblemModel.copy(sourceDomain, sourcePid, targetDomain);

            const readerAgent = supertest.agent(require('hydrooj').httpServer);
            await readerAgent.post('/login').send({ uname: reader.uname, password: '123456' }).expect(302);
            const api = await readerAgent.get(`/d/${targetDomain}/api/problem?args=${encodeURIComponent(JSON.stringify({
                id: targetPid,
                domainId: 'ignored-by-route',
            }))}`).expect(200);
            assert.deepStrictEqual(api.body.data.map((file) => file.name), [testdataName]);
            assert.deepStrictEqual(api.body.additional_file.map((file) => file.name), [additionalName]);

            const detail = await readerAgent.get(`/d/${targetDomain}/p/${targetPid}`)
                .set('Accept', 'application/json').expect(200);
            assert.deepStrictEqual(detail.body.pdoc.data.map((file) => file.name), [testdataName]);
            assert.deepStrictEqual(detail.body.pdoc.additional_file.map((file) => file.name), [additionalName]);

            const bulk = async (type: string, filename: string) => readerAgent.post(
                `/d/${targetDomain}/p/${targetPid}/files`,
            ).set('Accept', 'application/json').send({ operation: 'get_links', files: [filename], type }).expect(200);
            const testdataLinks = await bulk('testdata', testdataName);
            const additionalLinks = await bulk('additional_file', additionalName);
            const getStorageTarget = (link: string) => new URL(`http://localhost${link}`).searchParams.get('target');
            assert.equal(getStorageTarget(testdataLinks.body.links[testdataName]), sourceTestdataFile._id);
            assert.equal(getStorageTarget(additionalLinks.body.links[additionalName]), sourceAdditionalFile._id);

            const singleTestdata = await readerAgent.get(
                `/d/${targetDomain}/p/${targetPid}/file/${testdataName}?type=testdata`,
            ).expect(302);
            const singleAdditional = await readerAgent.get(
                `/d/${targetDomain}/p/${targetPid}/file/${additionalName}?type=additional_file`,
            ).expect(302);
            assert.equal(getStorageTarget(singleTestdata.headers.location), sourceTestdataFile._id);
            assert.equal(getStorageTarget(singleAdditional.headers.location), sourceAdditionalFile._id);

            const limitedAgent = supertest.agent(require('hydrooj').httpServer);
            await limitedAgent.post('/login').send({ uname: limited.uname, password: '123456' }).expect(302);
            const limitedApi = await limitedAgent.get(`/d/${targetDomain}/api/problem?args=${encodeURIComponent(JSON.stringify({
                id: targetPid,
                domainId: targetDomain,
            }))}`).expect(200);
            assert.deepStrictEqual(limitedApi.body.data, []);
            assert.deepStrictEqual(limitedApi.body.additional_file.map((file) => file.name), [additionalName]);
            await limitedAgent.post(`/d/${targetDomain}/p/${targetPid}/files`)
                .send({ operation: 'get_links', files: [testdataName], type: 'testdata' }).expect(403);
            const limitedAdditional = await limitedAgent.post(`/d/${targetDomain}/p/${targetPid}/files`)
                .set('Accept', 'application/json')
                .send({ operation: 'get_links', files: [additionalName], type: 'additional_file' }).expect(200);
            assert.equal(getStorageTarget(limitedAdditional.body.links[additionalName]), sourceAdditionalFile._id);
            await limitedAgent.get(`/d/${targetDomain}/p/${targetPid}/file/${testdataName}?type=testdata`).expect(403);
            const limitedSingle = await limitedAgent.get(`/d/${targetDomain}/p/${targetPid}/file/${additionalName}?type=additional_file`).expect(302);
            assert.equal(getStorageTarget(limitedSingle.headers.location), sourceAdditionalFile._id);

            await ProblemModel.edit(sourceDomain, sourcePid, { hidden: true });
            const hiddenSourceApi = await readerAgent.get(`/d/${targetDomain}/api/problem?args=${encodeURIComponent(JSON.stringify({
                id: targetPid,
                domainId: targetDomain,
            }))}`).expect(200);
            assert.deepStrictEqual(hiddenSourceApi.body.data, []);
            assert.deepStrictEqual(hiddenSourceApi.body.additional_file.map((file) => file.name), [additionalName]);
            await readerAgent.post(`/d/${targetDomain}/p/${targetPid}/files`)
                .send({ operation: 'get_links', files: [testdataName], type: 'testdata' }).expect(403);
            const hiddenSourceAdditional = await readerAgent.get(
                `/d/${targetDomain}/p/${targetPid}/file/${additionalName}?type=additional_file`,
            ).expect(302);
            assert.equal(getStorageTarget(hiddenSourceAdditional.headers.location), sourceAdditionalFile._id);
        } finally {
            if (targetPid) await ProblemModel.del(targetDomain, targetPid);
            if (sourcePid) await ProblemModel.del(sourceDomain, sourcePid);
            await Promise.all([
                DomainModel.del(targetDomain),
                DomainModel.del(sourceDomain),
            ]);
            const cachedUsers = await Promise.all(createdUsers.map((uid) => UserModel.getById('system', uid)));
            for (const udoc of cachedUsers) if (udoc) UserModel._deleteUserCache(udoc);
            await UserModel.coll.deleteMany({ _id: { $in: createdUsers } });
        }
    });

    it('Tracks generated testdata edits and preserves metadata on failure', async () => {
        const ProblemModel = global.Hydro.model.problem;
        const RecordModel = global.Hydro.model.record;
        const suffix = Date.now().toString(36);
        const pid = await ProblemModel.add('system', `generated-metadata-${suffix}`, `Generated metadata ${suffix}`, '', 2);
        const rid = await RecordModel.add(
            'system', pid, 2, '_', 'generated', false, { type: 'generate' },
        );
        const tempDir = mkdtempSync(join(tmpdir(), 'hydro-generated-testdata-'));
        const filePath = join(tempDir, 'generated.in');
        writeFileSync(filePath, 'generated testdata\n');
        const { processJudgeFileCallback } = require('../packages/hydrooj/src/handler/judge');

        try {
            const editStartedAt = Date.now();
            await processJudgeFileCallback(rid, 'generated.in', filePath);
            let pdoc = await ProblemModel.get('system', pid);
            assert.equal(pdoc.editor, 2);
            assert(pdoc.updateAt.getTime() >= editStartedAt);
            assert(pdoc.data.some((file) => file.name === 'generated.in'));

            const oldUpdateAt = new Date('2000-01-02T03:04:05Z');
            await ProblemModel.edit('system', pid, { editor: 3, updateAt: oldUpdateAt });
            pdoc = await ProblemModel.get('system', pid);
            const dataBeforeFailure = pdoc.data;
            await assert.rejects(() => processJudgeFileCallback(rid, '', filePath));
            const unchanged = await ProblemModel.get('system', pid);
            assert.deepEqual(unchanged.data, dataBeforeFailure);
            assert.equal(unchanged.editor, 3);
            assert.equal(unchanged.updateAt.getTime(), oldUpdateAt.getTime());
        } finally {
            await Promise.all([
                ProblemModel.del('system', pid),
                RecordModel.coll.deleteOne({ _id: rid }),
            ]);
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('Allows private content feedback without allowing ordinary messages or bypassing resource access', async () => {
        const { domain: DomainModel, user: UserModel, problem: ProblemModel, contest: ContestModel, feedback: FeedbackModel, message: MessageModel } = global.Hydro.model;
        const suffix = Date.now().toString(36);
        const domainId = `feedback-${suffix}`;
        const otherDomainId = `feedback-other-${suffix}`;
        const actors: Record<string, { uid: number, client: any }> = {};
        const createdUids: number[] = [];
        const originalRootPriv = (await UserModel.coll.findOne({ _id: 2 })).priv;
        let pid: number;
        let tid: ObjectId;
        let unassignedTid: ObjectId;
        try {
            await UserModel.setPriv(2, originalRootPriv | PRIV.PRIV_EDIT_SYSTEM);
            for (const role of ['student', 'other', 'owner', 'outside', 'sys']) {
                const uname = `fb${role}${suffix}`;
                const uid = await UserModel.create(`${uname}@example.com`, uname, '123456');
                createdUids.push(uid);
                await UserModel.setPriv(uid, PRIV.PRIV_USER_PROFILE | (role === 'sys' ? PRIV.PRIV_EDIT_SYSTEM : 0));
                const actorClient = supertest.agent(require('hydrooj').httpServer);
                await actorClient.post('/login').send({ uname, password: '123456' }).expect(302);
                actors[role] = { uid, client: actorClient };
            }
            await DomainModel.add(domainId, actors.owner.uid, 'Feedback domain', '');
            await DomainModel.add(otherDomainId, actors.outside.uid, 'Other feedback domain', '');
            const studentPerm = PERM.PERM_VIEW | PERM.PERM_VIEW_PROBLEM | PERM.PERM_VIEW_HOMEWORK | PERM.PERM_ATTEND_HOMEWORK;
            await DomainModel.edit(domainId, { roles: { student: studentPerm.toString() }, enableCourse: true });
            await Promise.all([
                DomainModel.setUserRole(domainId, actors.student.uid, 'student', true),
                DomainModel.setUserRole(domainId, actors.other.uid, 'student', true),
            ]);
            pid = await ProblemModel.add(domainId, '', 'Feedback source', 'Original statement', actors.owner.uid);
            const beginAt = new Date(Date.now() - 3600000);
            const endAt = new Date(Date.now() + 3600000);
            const courseData = {
                assign: [String(actors.student.uid)],
                dag: [{ _id: 1, title: 'Chapter', lecture: 'Lecture', pids: [pid] }],
                lecture: { 1: 'Original lecture' },
            };
            tid = await ContestModel.add(domainId, 'Feedback course', '', actors.owner.uid, 'course', beginAt, endAt, [pid], false, courseData);
            unassignedTid = await ContestModel.add(domainId, 'Unassigned course', '', actors.owner.uid, 'course', beginAt, endAt, [pid], false, {
                ...courseData, assign: [String(actors.other.uid)],
            });
            await ContestModel.setStatus(domainId, tid, actors.student.uid, {
                attend: 1, startAt: beginAt, endAt, allow: { 1: true }, lectureAllow: { 1: false },
            });
            const submitFeedback = (url: string, content = 'This content is incorrect.', extras = {}) => actors.student.client
                .post(url).set('Accept', 'application/json').send({ operation: 'feedback', content, ...extras });
            const sourceUrl = `/d/${domainId}/p/${pid}`;
            const response = await submitFeedback(sourceUrl, 'This content is incorrect.', {
                quote: '<script>quoted text</script>', uid: actors.other.uid, to: [actors.other.uid],
                domainId: otherDomainId, title: 'Forged title', sourceUrl: 'https://example.invalid/',
            }).expect(200);
            const feedbackId = new ObjectId(response.body.feedbackId);
            const feedbackDoc = await FeedbackModel.get(feedbackId);
            assert.equal(feedbackDoc.domainId, domainId);
            assert.equal(feedbackDoc.source.url, sourceUrl);
            assert.equal(feedbackDoc.source.title, `${pid}. Feedback source`);
            const initialMessage = await MessageModel.coll.findOne({ feedbackId });
            assert(initialMessage.to.includes(actors.owner.uid));
            assert(initialMessage.to.includes(actors.sys.uid));
            assert(initialMessage.to.includes(2));
            assert(!initialMessage.to.includes(actors.other.uid));
            assert(!initialMessage.to.includes(actors.outside.uid));
            assert.equal((await UserModel.coll.findOne({ _id: actors.student.uid })).priv, PRIV.PRIV_USER_PROFILE);
            await actors.student.client.post('/home/messages').set('Accept', 'application/json').send({
                operation: 'send', uid: actors.owner.uid, content: 'Cannot use ordinary private messages.', feedbackId,
            }).expect(403);
            await actors.student.client.post('/home/messages').set('Accept', 'application/json').send({
                operation: 'delete_message', messageId: initialMessage._id,
            }).expect(403);

            // Personal inbox permission errors must remain 403 without system membership.
            await DomainModel.setJoin('system', actors.outside.uid, false);
            assert(!(await UserModel.getById('system', actors.outside.uid))._dudoc.join);
            for (const role of ['other', 'outside']) {
                await actors[role].client.get(`/home/messages?feedback=${feedbackId}`).set('Accept', 'application/json').expect(403);
                await actors[role].client.post('/home/messages').set('Accept', 'application/json').send({
                    operation: 'feedback_reply', feedbackId, content: 'Unauthorized reply', domainId,
                }).expect(403);
            }
            for (const role of ['owner', 'sys', 'student']) {
                const replied = await actors[role].client.post('/home/messages').set('Accept', 'application/json').send({
                    operation: 'feedback_reply', feedbackId, content: `Reply from ${role}`, to: [actors.other.uid], domainId: otherDomainId,
                }).expect(200);
                assert.equal(replied.body.mdoc.domainId, domainId);
                assert(!replied.body.mdoc.to.includes(actors.other.uid));
            }
            const inbox = await actors.student.client.get(`/home/messages?feedback=${feedbackId}`).set('Accept', 'application/json').expect(200);
            assert.equal(inbox.body.canSendMessage, false);
            assert.equal(Object.keys(inbox.body.messages).length, 0);
            assert.equal(inbox.body.feedbackThreads[0].messages.length, 4);
            assert.equal(inbox.body.feedbackThreads[0].quote, '<script>quoted text</script>');
            assert.equal(Object.hasOwn(inbox.body.feedbackThreads[0].authors[actors.owner.uid], 'mail'), false);
            await UserModel.setPriv(actors.sys.uid, PRIV.PRIV_USER_PROFILE);
            await actors.sys.client.get(`/home/messages?feedback=${feedbackId}`).set('Accept', 'application/json').expect(403);
            await actors.sys.client.post('/home/messages').set('Accept', 'application/json').send({
                operation: 'feedback_reply', feedbackId, content: 'Reply after losing administrator privilege',
            }).expect(403);

            await ProblemModel.edit(domainId, pid, { hidden: true });
            await submitFeedback(sourceUrl).expect(403);
            const joinResponse = await actors.outside.client.get(sourceUrl).expect(302);
            const joinUrl = new URL(joinResponse.headers.location, 'http://hydro.test');
            assert.equal(joinUrl.pathname, '/domain/join');
            assert.equal(joinUrl.searchParams.get('target'), domainId);
            await ProblemModel.edit(domainId, pid, { hidden: false });
            await submitFeedback(`${sourceUrl}?tid=${unassignedTid}`).expect(403);
            await submitFeedback(`/d/${domainId}/course/${unassignedTid}/lecture/1`).expect(403);
            const lectureUrl = `/d/${domainId}/course/${tid}/lecture/1`;
            await actors.student.client.get(lectureUrl).set('Accept', 'application/json').expect(403);
            await submitFeedback(lectureUrl).expect(403);
            await ContestModel.setStatus(domainId, tid, actors.student.uid, { lectureAllow: { 1: true } });
            await actors.student.client.get(lectureUrl).set('Accept', 'application/json').expect(200);
            const lectureResponse = await submitFeedback(lectureUrl).expect(200);
            assert.notEqual(lectureResponse.body.feedbackId, response.body.feedbackId);
            const lectureFeedback = await FeedbackModel.get(new ObjectId(lectureResponse.body.feedbackId));
            assert.equal(lectureFeedback.source.type, 'lecture');
            assert.equal(lectureFeedback.source.url, lectureUrl);
            await submitFeedback(sourceUrl, 'x'.repeat(2001)).expect(403);
            await submitFeedback(sourceUrl, 'valid', { quote: 'x'.repeat(4001) }).expect(403);
            await submitFeedback(sourceUrl).expect(200);
            const limited = await submitFeedback(sourceUrl).expect(403);
            assert.equal(limited.body.error.name, 'OpcountExceededError');
        } finally {
            await UserModel.setPriv(2, originalRootPriv);
            const feedbackDocs = await FeedbackModel.coll.find({ domainId: { $in: [domainId, otherDomainId] } }).toArray();
            if (tid) await ContestModel.del(domainId, tid);
            if (unassignedTid) await ContestModel.del(domainId, unassignedTid);
            if (pid) await ProblemModel.del(domainId, pid);
            await Promise.all([
                MessageModel.coll.deleteMany({ feedbackId: { $in: feedbackDocs.map((doc) => doc._id) } }),
                FeedbackModel.coll.deleteMany({ domainId: { $in: [domainId, otherDomainId] } }),
                DomainModel.coll.deleteMany({ _id: { $in: [domainId, otherDomainId] } }),
                DomainModel.collUser.deleteMany({ domainId: { $in: [domainId, otherDomainId] } }),
                DomainModel.collUser.deleteMany({ domainId: 'system', uid: { $in: createdUids } }),
                UserModel.coll.deleteMany({ _id: { $in: createdUids } }),
            ]);
        }
    });

    it('Does not persist lecture rules without a lecture', async () => {
        const ContestModel = global.Hydro.model.contest;
        const ProblemModel = global.Hydro.model.problem;
        const suffix = Date.now().toString(36);
        const pid = await ProblemModel.add('system', `course-lecture-rule-${suffix}`, `Course lecture rule ${suffix}`, '', 2);
        const courseId = await ContestModel.add(
            'system', `Course lecture rule ${suffix}`, '', 2, 'course',
            new Date('2026-09-16T00:00:00Z'), new Date('2026-09-17T00:00:00Z'), [pid], false,
            { assign: [], dag: [{ _id: 1, title: 'Initial', pids: [pid] }] },
        );

        try {
            await agent.post(`/d/system/course/${courseId}/edit`)
                .send({
                    title: `Course lecture rule ${suffix}`,
                    content: 'content',
                    dag: JSON.stringify([{
                        _id: 1,
                        title: 'No lecture',
                        lecture: '   ',
                        pids: [pid],
                        lectureRule: { pids: [pid], condition: { type: 'all' } },
                    }]),
                    beginAt: '2026-9-16 0:00',
                    endAt: '2026-9-17 23:59',
                    lessonDurationHours: 3,
                    lessonBeginAt: '2026-9-16 0:00',
                    lessonEndAt: '2026-9-16 3:00',
                    assign: '',
                    extraStudents: '',
                    publicScoreboard: true,
                    enablePenalty: true,
                })
                .expect(302);
            const saved = await ContestModel.get('system', courseId);
            assert(saved);
            assert.equal(saved.dag[0].lecture, false);
            assert(!saved.dag[0].lectureRule);
        } finally {
            await Promise.all([
                ContestModel.del('system', courseId),
                ProblemModel.del('system', pid),
            ]);
        }
    });

    it('Tracks lecture metadata per chapter and copies it with course templates', async () => {
        const ContestModel = global.Hydro.model.contest;
        const UserModel = global.Hydro.model.user;
        const suffix = Date.now().toString(36);
        const classId = new ObjectId();
        const className = `metadata-class-${suffix}`;
        const courseIds: ObjectId[] = [];
        let templateId: ObjectId | undefined;
        let savedTemplateId: ObjectId | undefined;
        const teachersGroupBefore = await UserModel.collGroup.findOne({ domainId: 'system', name: 'teachers' });

        try {
            const courseUpdateAt = new Date('2020-01-02T03:04:05Z');
            const courseId = await ContestModel.add(
                'system', `Lecture metadata ${suffix}`, '', 2, 'course',
                new Date('2026-09-15T00:00:00Z'), new Date('2026-09-16T00:00:00Z'), [], false,
                {
                    dag: [
                        { _id: 1, title: 'First', lecture: 'First', pids: [] },
                        { _id: 2, title: 'Second', lecture: 'Second', pids: [] },
                    ],
                    lecture: { 1: 'old first', 2: 'old second' },
                    editor: 3,
                    updateAt: courseUpdateAt,
                },
            );
            courseIds.push(courseId);
            const originalCourse = await ContestModel.get('system', courseId);

            const fallback = await agent.get(`/d/system/course/${courseId}/lecture/2`)
                .set('Accept', 'application/json')
                .expect(200);
            assert.equal(fallback.body.lectureMeta.editor, 2);
            assert.equal(
                new Date(fallback.body.lectureMeta.updateAt).getTime(),
                originalCourse._id.getTimestamp().getTime(),
            );

            const beforeLectureEdit = Date.now();
            await agent.post(`/d/system/course/${courseId}/lecture/1`)
                .send({ operation: 'update', lecture: 'new first' })
                .expect(302);
            const editedCourse = await ContestModel.get('system', courseId);
            assert.equal(editedCourse.lecture[1], 'new first');
            assert.equal(editedCourse.lecture[2], 'old second');
            assert.equal(editedCourse.lectureMeta[1].editor, 2);
            assert(editedCourse.lectureMeta[1].updateAt.getTime() >= beforeLectureEdit);
            assert(!editedCourse.lectureMeta[2]);
            assert.equal(editedCourse.editor, 3);
            assert.equal(editedCourse.updateAt.getTime(), courseUpdateAt.getTime());
            await assert.rejects(ContestModel.edit('system', courseId, {
                'lecture.1': 'stale replacement',
            } as any, originalCourse), (err: any) => (
                err.name === 'BadRequestError' && err.params?.[0] === 'Contest changed. Please refresh and try again.'
            ));
            assert.equal((await ContestModel.get('system', courseId)).lecture[1], 'new first');

            const lecturePage = await agent.get(`/d/system/course/${courseId}/lecture/1`)
                .set('Accept', 'application/json')
                .expect(200);
            assert.equal(lecturePage.body.lectureMeta.editor, 2);

            const savedTemplateTitle = `Saved lecture template ${suffix}`;
            await agent.post(`/d/system/course/${courseId}/edit`)
                .send({
                    title: savedTemplateTitle,
                    content: 'saved template content',
                    dag: JSON.stringify([
                        { _id: 1, title: 'First', lecture: 'First', pids: [] },
                        { _id: 2, title: 'Second', lecture: 'Second', pids: [] },
                    ]),
                    beginAt: '2026-9-15 0:00',
                    endAt: '2026-9-16 23:59',
                    lessonDurationHours: 3,
                    lessonBeginAt: '2026-9-15 0:00',
                    lessonEndAt: '2026-9-15 3:00',
                    isTemplate: true,
                    templateCategory: '',
                    assign: '',
                    extraStudents: '',
                    publicScoreboard: true,
                    enablePenalty: true,
                })
                .expect(302);
            const savedTemplate = await ContestModel.getMulti('system', {
                rule: 'course',
                title: savedTemplateTitle,
                assign: { $in: ['teachers'] },
            }).next();
            assert(savedTemplate);
            savedTemplateId = savedTemplate._id;
            assert.equal(savedTemplate.lectureMeta[1].editor, editedCourse.lectureMeta[1].editor);
            assert.equal(
                savedTemplate.lectureMeta[1].updateAt.getTime(),
                editedCourse.lectureMeta[1].updateAt.getTime(),
            );

            await Promise.all([1, 2].map((id) => agent.post(`/d/system/course/${courseId}/lecture/${id}`)
                .send({ operation: 'update', lecture: `concurrent ${id}` })
                .expect(302)));
            const concurrentlyEditedCourse = await ContestModel.get('system', courseId);
            assert.equal(concurrentlyEditedCourse.lecture[1], 'concurrent 1');
            assert.equal(concurrentlyEditedCourse.lecture[2], 'concurrent 2');
            assert.equal(concurrentlyEditedCourse.lectureMeta[1].editor, 2);
            assert.equal(concurrentlyEditedCourse.lectureMeta[2].editor, 2);
            assert.equal(concurrentlyEditedCourse.editor, 3);
            assert.equal(concurrentlyEditedCourse.updateAt.getTime(), courseUpdateAt.getTime());

            await UserModel.collGroup.insertOne({
                _id: classId,
                domainId: 'system',
                name: className,
                uids: [2],
                teachers: [2],
                students: [],
                beginAt: new Date('2026-09-15T00:00:00Z'),
                endAt: new Date('2026-09-20T00:00:00Z'),
                archive: false,
                class: true,
                intervalDays: 1,
            });
            const templateUpdateAt = new Date('2021-02-03T04:05:06Z');
            templateId = await ContestModel.add(
                'system', `Lecture template ${suffix}`, '', 2, 'course',
                new Date('2026-09-15T00:00:00Z'), new Date('2026-09-16T00:00:00Z'), [], false,
                {
                    assign: ['teachers'],
                    dag: [
                        { _id: 1, title: 'Template first', lecture: 'Template first', pids: [] },
                        { _id: 2, title: 'Template second', lecture: 'Template second', pids: [] },
                    ],
                    lecture: { 1: 'template first', 2: 'template second' },
                    lectureMeta: { 1: { editor: 3, updateAt: templateUpdateAt } },
                },
            );
            const template = await ContestModel.get('system', templateId);
            const copied = await agent.post(`/d/system/domain/class/${classId}/edit`)
                .send({ operation: 'copy', template: `system:${templateId}` })
                .set('Accept', 'application/json')
                .expect(200);
            assert.equal(copied.body.tdocs.length, 1);
            const copiedCourse = await ContestModel.getMulti('system', {
                rule: 'course',
                title: `Lecture template ${suffix}`,
                assign: { $in: [className] },
            }).next();
            assert(copiedCourse);
            assert.equal(copiedCourse.lecture[1], 'template first');
            assert.equal(copiedCourse.lectureMeta[1].editor, 3);
            assert.equal(copiedCourse.lectureMeta[1].updateAt.getTime(), templateUpdateAt.getTime());
            assert.equal(copiedCourse.lectureMeta[2].editor, template.owner);
            assert.equal(
                copiedCourse.lectureMeta[2].updateAt.getTime(),
                template._id.getTimestamp().getTime(),
            );
            courseIds.push(copiedCourse._id);
        } finally {
            await Promise.all(courseIds.map((id) => ContestModel.del('system', id)));
            if (templateId) await ContestModel.del('system', templateId);
            if (savedTemplateId) await ContestModel.del('system', savedTemplateId);
            if (!teachersGroupBefore) {
                await UserModel.collGroup.deleteOne({ domainId: 'system', name: 'teachers' });
            }
            await UserModel.collGroup.deleteOne({ _id: classId });
        }
    });

    it('Does not expose hidden OI results through global problem status views', async () => {
        const ContestModel = global.Hydro.model.contest;
        const DomainModel = global.Hydro.model.domain;
        const ProblemModel = global.Hydro.model.problem;
        const RecordModel = global.Hydro.model.record;
        const SystemModel = global.Hydro.model.system;
        const UserModel = global.Hydro.model.user;
        const suffix = Date.now().toString(36);
        const groupId = new ObjectId();
        const groupName = `hidden-result-${suffix}`;
        const managerRole = `result-manager-${suffix}`;
        const privilegedRole = `result-privileged-${suffix}`;
        const createdUsers: number[] = [];
        const pids: number[] = [];
        const oldStatMode = SystemModel.get('record.statMode');
        let tid: ObjectId | undefined;

        const createUser = async (prefix: string, role = 'default') => {
            const uname = `${prefix}${suffix}`;
            const uid = await UserModel.create(`${uname}@example.com`, uname, '123456');
            createdUsers.push(uid);
            await DomainModel.setUserInDomain('system', uid, { join: true, role });
            return { uid, uname };
        };

        try {
            await Promise.all([
                DomainModel.addRole(
                    'system', managerRole,
                    PERM.PERM_DEFAULT | PERM.PERM_CREATE_CONTEST,
                ),
                DomainModel.addRole(
                    'system', privilegedRole,
                    PERM.PERM_DEFAULT | PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD,
                ),
            ]);
            const participant = await createUser('resultuser');
            const outsider = await createUser('resultoutside');
            const manager = await createUser('resultmanager', managerRole);
            const privileged = await createUser('resultpriv', privilegedRole);
            await UserModel.collGroup.insertOne({
                _id: groupId,
                domainId: 'system',
                name: groupName,
                uids: [participant.uid, manager.uid],
            } as any);

            for (let i = 0; i < 3; i++) {
                // eslint-disable-next-line no-await-in-loop
                pids.push(await ProblemModel.add(
                    'system', '', `Hidden result ${suffix} ${i}`, '', 2,
                ));
            }
            const now = Date.now();
            tid = await ContestModel.add(
                'system', `Hidden OI ${suffix}`, '', 2, 'oi',
                new Date(now - 3600000), new Date(now + 3600000), pids, false,
                { assign: [groupName] },
            );

            const ordinaryWa = new ObjectId();
            const ordinaryAc = new ObjectId();
            const ordinaryNewerWa = new ObjectId();
            const hiddenRids = [new ObjectId(), new ObjectId(), new ObjectId()];
            await RecordModel.coll.insertMany([
                {
                    _id: ordinaryWa, domainId: 'system', pid: pids[0], uid: participant.uid,
                    status: STATUS.STATUS_WRONG_ANSWER, score: 0, judgeAt: new Date(now - 1000),
                },
                {
                    _id: ordinaryAc, domainId: 'system', pid: pids[1], uid: participant.uid,
                    status: STATUS.STATUS_ACCEPTED, score: 100,
                },
                {
                    _id: ordinaryNewerWa, domainId: 'system', pid: pids[0], uid: participant.uid,
                    status: STATUS.STATUS_TIME_LIMIT_EXCEEDED, score: 0, judgeAt: new Date(now - 2000),
                },
                ...hiddenRids.map((rid, index) => ({
                    _id: rid, domainId: 'system', pid: pids[index], uid: participant.uid,
                    contest: tid, status: STATUS.STATUS_ACCEPTED, score: 73,
                })),
            ] as any[]);
            await Promise.all([
                ProblemModel.updateStatus(
                    'system', pids[0], participant.uid, ordinaryWa,
                    STATUS.STATUS_WRONG_ANSWER, 0,
                ),
                ProblemModel.updateStatus(
                    'system', pids[1], participant.uid, ordinaryAc,
                    STATUS.STATUS_ACCEPTED, 100,
                ),
                ContestModel.attend('system', tid, participant.uid),
            ]);
            for (let index = 0; index < pids.length; index++) {
                // eslint-disable-next-line no-await-in-loop
                await ProblemModel.updateStatus(
                    'system', pids[index], participant.uid, hiddenRids[index],
                    STATUS.STATUS_ACCEPTED, 73,
                );
                // eslint-disable-next-line no-await-in-loop
                await ContestModel.updateStatus(
                    'system', tid, participant.uid, hiddenRids[index], pids[index],
                    { status: STATUS.STATUS_ACCEPTED, score: 73 },
                );
            }
            await ProblemModel.setStar('system', pids[2], participant.uid, true);
            await RecordModel.coll.updateOne(
                { _id: hiddenRids[1] },
                { $set: { status: STATUS.STATUS_WRONG_ANSWER, score: 0 } },
            );
            await ProblemModel.updateStatus(
                'system', pids[1], participant.uid, hiddenRids[1],
                STATUS.STATUS_WRONG_ANSWER, 0,
            );
            await ContestModel.updateStatus(
                'system', tid, participant.uid, hiddenRids[1], pids[1],
                { status: STATUS.STATUS_WRONG_ANSWER, score: 0 },
            );

            const [participantDoc, outsiderDoc, privilegedDoc, ownerDoc] = await Promise.all([
                UserModel.getById('system', participant.uid),
                UserModel.getById('system', outsider.uid),
                UserModel.getById('system', privileged.uid),
                UserModel.getById('system', 2),
            ]);
            const visibleFor = (viewer) => (
                contestDoc, targetUid,
            ) => ContestModel.canShowProblemStatus(viewer, targetUid, contestDoc);
            const participantStatuses = await ProblemModel.resolveVisibleStatuses(
                'system', [participant.uid], pids, visibleFor(participantDoc),
            );
            const participantStatus = Object.fromEntries(
                participantStatuses.map((psdoc) => [psdoc.docId, psdoc]),
            );
            assert.equal(participantStatus[pids[0]].rid.toHexString(), ordinaryWa.toHexString());
            assert.equal(participantStatus[pids[0]].status, STATUS.STATUS_WRONG_ANSWER);
            assert.equal(participantStatus[pids[1]].rid.toHexString(), ordinaryAc.toHexString());
            assert.equal(participantStatus[pids[1]].status, STATUS.STATUS_ACCEPTED);
            assert.equal(participantStatus[pids[2]].star, true);
            assert(!('rid' in participantStatus[pids[2]]));
            assert(!('status' in participantStatus[pids[2]]));
            assert(!('score' in participantStatus[pids[2]]));

            const activeTdoc = await ContestModel.get('system', tid);
            assert.equal(ContestModel.canShowProblemStatus(participantDoc, participant.uid, activeTdoc), false);
            assert.equal(ContestModel.canShowProblemStatus(outsiderDoc, participant.uid, activeTdoc), false);
            assert.equal(ContestModel.canShowProblemStatus(ownerDoc, participant.uid, activeTdoc), true);
            assert.equal(ContestModel.canShowProblemStatus(privilegedDoc, participant.uid, activeTdoc), true);
            const projectedRecord = ContestModel.applyProjection(activeTdoc, {
                _id: hiddenRids[2], domainId: 'system', pid: pids[2], uid: participant.uid,
                status: STATUS.STATUS_ACCEPTED, score: 73, subtasks: { 1: { score: 73 } },
            }, participantDoc);
            assert(!('status' in projectedRecord));
            assert(!('score' in projectedRecord));
            assert(!('subtasks' in projectedRecord));

            const { JudgeResultCallbackContext } = require('../packages/hydrooj/src/handler/judge');
            const hiddenPdocBeforeJudge = await ProblemModel.get('system', pids[2]);
            await JudgeResultCallbackContext.postJudge(await RecordModel.get('system', hiddenRids[2]));
            const hiddenPdocAfterJudge = await ProblemModel.get('system', pids[2]);
            assert.equal(hiddenPdocAfterJudge.nAccept, hiddenPdocBeforeJudge.nAccept);
            assert.equal(hiddenPdocAfterJudge.stats?.s73, hiddenPdocBeforeJudge.stats?.s73);

            const participantAgent = supertest.agent(require('hydrooj').httpServer);
            await participantAgent.post('/login')
                .send({ uname: participant.uname, password: '123456' }).expect(302);
            const contestList = await participantAgent.get('/contest?rule=oi')
                .set('Accept', 'application/json').expect(200);
            const listedContest = contestList.body.tdocs.find((tdoc) => tdoc.docId === tid.toHexString());
            assert(listedContest);
            const listedStatus = contestList.body.tsdict[tid.toHexString()];
            assert.equal(listedStatus.attend, 1);
            assert(!('score' in listedStatus));
            assert(!('detail' in listedStatus));
            assert(!('journal' in listedStatus));

            const homepage = await participantAgent.get('/')
                .set('Accept', 'application/json').expect(200);
            const contestSection = homepage.body.contents
                .flatMap((column) => column.sections)
                .find(([name]) => name === 'contest');
            assert(contestSection);
            const homeStatus = contestSection[1][1][tid.toHexString()];
            assert.equal(homeStatus.attend, 1);
            assert(!('score' in homeStatus));
            assert(!('detail' in homeStatus));
            assert(!('journal' in homeStatus));

            const problemListResponse = await participantAgent.get('/p')
                .set('Accept', 'application/json').expect(200);
            assert(!('status' in problemListResponse.body.psdict[pids[2]]));
            const problemResponse = await participantAgent.get(`/p/${pids[2]}`)
                .set('Accept', 'application/json').expect(200);
            assert.equal(problemResponse.body.psdoc.star, true);
            assert(!('status' in problemResponse.body.psdoc));
            assert(!('rdoc' in problemResponse.body));

            const contestProblems = await participantAgent.get(`/contest/${tid}/problems`)
                .set('Accept', 'application/json').expect(200);
            for (const pid of pids) {
                assert.deepStrictEqual(contestProblems.body.psdict[pid], { submitted: true });
            }
            assert.deepStrictEqual(contestProblems.body.rdict, {});
            assert.deepStrictEqual(contestProblems.body.rdocs, []);
            const previousUiAddon = global.addons['ui-default'];
            global.addons['ui-default'] = dirname(require.resolve('@hydrooj/ui-default/package.json'));
            const renderer = global.app.plugin(require('@hydrooj/ui-default/backendlib/template').TemplateService);
            try {
                await renderer;
                const contestProblemPage = await participantAgent.get(`/contest/${tid}/problems`)
                    .set('Accept-Language', 'en').accept('html').expect(200);
                assert.equal(contestProblemPage.type, 'text/html');
                assert.match(contestProblemPage.text, /<td class="col--status record-status--border">Submitted<\/td>/);
                assert.doesNotMatch(contestProblemPage.text, /No Submissions/);
            } finally {
                await renderer.dispose();
                if (previousUiAddon === undefined) delete global.addons['ui-default'];
                else global.addons['ui-default'] = previousUiAddon;
            }

            const profile = await participantAgent.get(`/user/${participant.uid}`)
                .set('Accept', 'application/json').expect(200);
            assert(profile.body.pdocs.some((pdoc) => pdoc.docId === pids[1]));
            assert(!profile.body.pdocs.some((pdoc) => pdoc.docId === pids[2]));
            const activity = profile.body.tdocs.find((tdoc) => tdoc.docId === tid.toHexString());
            assert(activity);
            assert(!('activityStats' in activity));

            await RecordModel.coll.updateOne(
                { _id: hiddenRids[1] },
                { $set: { status: STATUS.STATUS_ACCEPTED, score: 73 } },
            );
            await ProblemModel.updateStatus(
                'system', pids[1], participant.uid, hiddenRids[1],
                STATUS.STATUS_ACCEPTED, 73,
            );
            await ContestModel.updateStatus(
                'system', tid, participant.uid, hiddenRids[1], pids[1],
                { status: STATUS.STATUS_ACCEPTED, score: 73 },
            );

            const managerAgent = supertest.agent(require('hydrooj').httpServer);
            await managerAgent.post('/login')
                .send({ uname: manager.uname, password: '123456' }).expect(302);
            const statistics = await managerAgent.get(`/contest-statistics?group=${groupName}`)
                .set('Accept', 'application/json').expect(200);
            const contestRow = statistics.body.table.rows.find((row) => row.label === `Hidden OI ${suffix}`);
            assert(contestRow);
            assert(contestRow.cells.every((cell) => cell === ''));
            const statisticsCsv = await managerAgent
                .get(`/contest-statistics?group=${groupName}&download=true`).expect(200);
            assert(!statisticsCsv.body.toString('utf8').includes('73'));

            await RecordModel.collStat.insertMany([
                {
                    _id: ordinaryAc, domainId: 'system', pid: pids[1], uid: participant.uid,
                    time: 100, memory: 1024, length: 10, lang: 'cc',
                },
                {
                    _id: hiddenRids[1], domainId: 'system', pid: pids[1], uid: participant.uid,
                    contest: tid, time: 10, memory: 512, length: 20, lang: 'cc',
                },
            ]);
            await SystemModel.set('record.statMode', 'all', false);
            let problemStats = await participantAgent.get(`/p/${pids[1]}/stat`)
                .set('Accept', 'application/json').expect(200);
            assert.deepStrictEqual(problemStats.body.rsdocs.map((rsdoc) => rsdoc._id), [ordinaryAc.toHexString()]);

            await ContestModel.edit('system', tid, {
                endAt: new Date(now - 1000),
                keepScoreboardHidden: true,
            });
            const endedHiddenTdoc = await ContestModel.get('system', tid);
            assert.equal(ContestModel.canShowProblemStatus(participantDoc, participant.uid, endedHiddenTdoc), false);
            const endedContestProblems = await participantAgent.get(`/contest/${tid}/problems`)
                .set('Accept', 'application/json').expect(200);
            assert.deepStrictEqual(endedContestProblems.body.psdict[pids[2]], { submitted: true });
            await participantAgent.get(`/record/${hiddenRids[2]}`)
                .set('Accept', 'application/json').expect(403);

            await ContestModel.edit('system', tid, { keepScoreboardHidden: false });
            const visibleStatus = await ProblemModel.getVisibleStatus(
                'system', pids[2], participant.uid, visibleFor(participantDoc),
            );
            assert.equal(visibleStatus.rid.toHexString(), hiddenRids[2].toHexString());
            assert.equal(visibleStatus.score, 73);
            const visibleProblem = await participantAgent.get(`/p/${pids[2]}`)
                .set('Accept', 'application/json').expect(200);
            assert.equal(visibleProblem.body.psdoc.score, 73);

            problemStats = await participantAgent.get(`/p/${pids[1]}/stat`)
                .set('Accept', 'application/json').expect(200);
            assert.equal(problemStats.body.rsdocs.length, 2);
            await SystemModel.set('record.statMode', 'unique', false);
            problemStats = await participantAgent.get(`/p/${pids[1]}/stat?sort=time&direction=1`)
                .set('Accept', 'application/json').expect(200);
            assert.deepStrictEqual(problemStats.body.rsdocs.map((rsdoc) => rsdoc._id), [hiddenRids[1].toHexString()]);
        } finally {
            await SystemModel.set('record.statMode', oldStatMode, false);
            const cachedUsers = await Promise.all(createdUsers.map((uid) => UserModel.getById('system', uid)));
            for (const udoc of cachedUsers) if (udoc) UserModel._deleteUserCache(udoc);
            await Promise.all([
                ...(tid ? [ContestModel.del('system', tid)] : []),
                ...pids.map((pid) => ProblemModel.del('system', pid)),
                UserModel.collGroup.deleteOne({ _id: groupId }),
                UserModel.coll.deleteMany({ _id: { $in: createdUsers } }),
                DomainModel.collUser.deleteMany({ domainId: 'system', uid: { $in: createdUsers } }),
            ]);
            await DomainModel.deleteRoles('system', [managerRole, privilegedRole]);
        }
    });

    it('lets teammates view visible records without bypassing hidden contest results', async () => {
        const DomainModel = global.Hydro.model.domain;
        const ContestModel = global.Hydro.model.contest;
        const ProblemModel = global.Hydro.model.problem;
        const RecordModel = global.Hydro.model.record;
        const UserModel = global.Hydro.model.user;
        const suffix = Date.now().toString(36);
        const domainId = `team-record-${suffix}`;
        const users: Array<{ uid: number, uname: string }> = [];
        let teamUid: number | undefined;
        try {
            await DomainModel.add(domainId, 2, 'Team record visibility', '');
            for (const prefix of ['submitter', 'teammate']) {
                const uname = `${prefix}${suffix}`;
                // eslint-disable-next-line no-await-in-loop
                const uid = await UserModel.create(`${uname}@example.com`, uname, '123456');
                users.push({ uid, uname });
                // eslint-disable-next-line no-await-in-loop
                await DomainModel.setUserRole(domainId, uid, 'default', true);
            }
            const members = users.map((user) => user.uid);
            teamUid = await UserModel.createVuser(`team${suffix}`, { members });
            const pid = await ProblemModel.add(domainId, '', 'Team record problem', '', 2);
            const now = Date.now();
            const tid = await ContestModel.add(
                domainId, 'Team OI', '', 2, 'oi',
                new Date(now - 7200000), new Date(now - 1000), [pid], false, { allowTeam: true },
            );
            await ContestModel.attend(domainId, tid, teamUid, { members });
            const rid = new ObjectId();
            await RecordModel.coll.insertOne({
                _id: rid, domainId, pid, uid: users[0].uid, contest: tid,
                status: STATUS.STATUS_ACCEPTED, score: 100, lang: 'cpp', code: 'team source',
            } as any);
            const viewers = [];
            for (const user of users) {
                const viewer = supertest.agent(require('hydrooj').httpServer);
                // eslint-disable-next-line no-await-in-loop
                await viewer.post('/login').send({ uname: user.uname, password: '123456' }).expect(302);
                // eslint-disable-next-line no-await-in-loop
                const response = await viewer.get(`/d/${domainId}/record/${rid}`).accept('json').expect(200);
                assert.equal(response.body.rdoc.code, 'team source');
                assert.equal(response.body.rdoc.score, 100);
                viewers.push(viewer);
            }
            await ContestModel.edit(domainId, tid, { keepScoreboardHidden: true });
            for (const viewer of viewers) {
                // eslint-disable-next-line no-await-in-loop
                await viewer.get(`/d/${domainId}/record/${rid}`).accept('json').expect(403);
            }
            await agent.get(`/d/${domainId}/record/${rid}`).accept('json').expect(200);
        } finally {
            await DomainModel.del(domainId);
            await Promise.all([
                RecordModel.coll.deleteMany({ domainId }),
                UserModel.coll.deleteMany({ _id: { $in: users.map((user) => user.uid) } }),
                require('../packages/hydrooj/src/model/user').collV.deleteMany({ _id: teamUid }),
            ]);
        }
    });

    it('isolates post-contest practice, invitations, personal records, and rejudging', async () => {
        const { domain: DomainModel, contest: ContestModel, problem: ProblemModel, record: RecordModel, user: UserModel } = global.Hydro.model;
        const practice = require('../packages/hydrooj/src/lib/contest-practice');
        const { postJudge } = require('../packages/hydrooj/src/handler/judge');
        const { RecordMainConnectionHandler, RecordDetailConnectionHandler } = require('../packages/hydrooj/src/handler/record');
        const suffix = Date.now().toString(36);
        const domainId = `contest-practice-${suffix}`;
        const users = [];
        let teamUid;
        let renderer;
        const previousUiAddon = global.addons['ui-default'];
        try {
            await DomainModel.add(domainId, 2, 'Contest practice', '');
            for (const prefix of ['practice', 'mate', 'newcomer']) {
                const uname = `${prefix}${suffix}`;
                // eslint-disable-next-line no-await-in-loop
                const uid = await UserModel.create(`${uname}@example.com`, uname, '123456');
                // eslint-disable-next-line no-await-in-loop
                await DomainModel.setUserRole(domainId, uid, 'default', true);
                const client = supertest.agent(require('hydrooj').httpServer);
                // eslint-disable-next-line no-await-in-loop
                await client.post('/login').send({ uname, password: '123456' }).expect(302);
                users.push({ uid, client });
            }
            const [student, mate, newcomer] = users;
            const pid = await ProblemModel.add(domainId, '', 'Hidden practice problem', 'Practice statement', 2);
            await ProblemModel.edit(domainId, pid, { hidden: true });
            const now = Date.now();
            const tid = await ContestModel.add(
                domainId, 'Practice contest', '', 2, 'oi',
                new Date(now - 7200000), new Date(now - 3600000), [pid], true,
                { allowPractice: true, _code: 'practice-code', keepScoreboardHidden: true },
            );
            const prefix = `/d/${domainId}`;
            const editBody = {
                operation: 'update', title: 'Practice contest', content: 'Practice contest rules', rule: 'oi', pids: `${pid}`,
                beginAtDate: '2020-01-01', beginAtTime: '12:00', duration: 1,
                rated: true, code: 'practice-code', keepScoreboardHidden: true,
            };
            await agent.post(`${prefix}/contest/${tid}/edit`).send({ ...editBody, allowPractice: false }).expect(302);
            assert.equal((await ContestModel.get(domainId, tid)).allowPractice, false);
            await agent.post(`${prefix}/contest/${tid}/edit`).send({ ...editBody, allowPractice: true }).expect(302);
            await agent.post(`${prefix}/contest/${tid}/edit`).send(editBody).expect(302);
            assert.equal((await ContestModel.get(domainId, tid)).allowPractice, true);
            const submit = (client) => client.post(`${prefix}/p/${pid}/submit?tid=${tid}`)
                .send({ lang: 'cc', code: 'int main() { return 0; }', practice: false, practiceContest: new ObjectId().toHexString() })
                .accept('json');
            const getActor = (uid) => UserModel.getById(domainId, uid);
            const originalContest = await ContestModel.get(domainId, tid);
            const originalProblem = await ProblemModel.get(domainId, pid);
            const originalUser = await DomainModel.getDomainUser(domainId, await getActor(student.uid));
            await submit(newcomer.client).expect(403);
            await newcomer.client.post(`${prefix}/contest/${tid}`).send({ operation: 'practice', code: 'wrong' }).expect(403);
            await newcomer.client.post(`${prefix}/contest/${tid}`).send({ operation: 'practice', code: 'practice-code' }).expect(302);
            await newcomer.client.post(`${prefix}/contest/${tid}`).send({ operation: 'practice', code: 'practice-code' }).expect(302);
            assert.equal(await global.app.get('db').collection('contest.practiceAccess').countDocuments({ domainId }), 1);
            await ContestModel.edit(domainId, tid, { _code: 'changed-code' });
            await submit(newcomer.client).expect(403);
            await newcomer.client.post(`${prefix}/contest/${tid}`).send({ operation: 'practice', code: 'changed-code' }).expect(302);
            const newcomerSubmission = await submit(newcomer.client).expect(200);
            assert(newcomerSubmission.body.rid);
            assert.equal((await ContestModel.get(domainId, tid)).attend, originalContest.attend);
            assert.equal(await ContestModel.getStatus(domainId, tid, newcomer.uid), null);

            // Original team members need no new invitation, but practice remains personal.
            await ContestModel.edit(domainId, tid, { rated: false, allowTeam: true });
            teamUid = await UserModel.createVuser(`practice-team-${suffix}`, { members: [student.uid, mate.uid] });
            await ContestModel.attend(domainId, tid, teamUid, { members: [student.uid, mate.uid] });
            const teamStatusBefore = await ContestModel.getStatus(domainId, tid, teamUid);
            const studentSubmission = await submit(student.client).expect(200);
            const rid = new ObjectId(studentSubmission.body.rid);
            let rdoc = await RecordModel.get(domainId, rid);
            assert(rdoc.practiceContest.equals(tid));
            assert.equal(rdoc.contest, undefined);
            await assert.rejects(() => RecordModel.add(domainId, pid, student.uid, 'cc', 'invalid', false, {
                contest: tid, practiceContest: tid, type: 'judge',
            }));
            await student.client.get(`${prefix}/p/${pid}`).accept('json').expect(403);
            const detail = await student.client.get(`${prefix}/p/${pid}?tid=${tid}`).accept('json').expect(200);
            assert.equal(detail.body.mode, 'practice');
            global.addons['ui-default'] = dirname(require.resolve('@hydrooj/ui-default/package.json'));
            renderer = global.app.plugin(require('@hydrooj/ui-default/backendlib/template').TemplateService);
            await renderer;
            await student.client.get(`${prefix}/p/${pid}?tid=${tid}`).accept('html').expect(200)
                .then((res) => assert.match(res.text, /practice=true/));
            await student.client.get(`${prefix}/p/${pid}/submit?tid=${tid}`).accept('html').expect(200);
            await agent.get(`${prefix}/contest/${tid}/edit`).accept('html').expect(200)
                .then((res) => assert.match(res.text, /name="allowPractice"/));
            await student.client.get(`${prefix}/record/${rid}`).accept('json').expect(200);
            await student.client.get(`${prefix}/record/${rid}`).accept('html').expect(200);
            await student.client.get(`${prefix}/record/${rid}?download=true`).expect(200);
            await mate.client.get(`${prefix}/record/${rid}`).accept('json').expect(403);
            await mate.client.get(`${prefix}/record/${rid}?download=true`).expect(403);
            await agent.get(`${prefix}/record/${rid}`).accept('json').expect(200);
            await mate.client.get(`${prefix}/record?tid=${tid}&practice=true&uidOrName=${student.uid}`).accept('json').expect(403);
            const ownRecords = await student.client.get(`${prefix}/record?tid=${tid}&practice=true`).accept('json').expect(200);
            assert.deepEqual(ownRecords.body.rdocs.map((row) => row._id), [rid.toHexString()]);
            await student.client.get(`${prefix}/record?tid=${tid}&practice=true`).accept('html').expect(200)
                .then((res) => assert.match(res.text, /practice=1/));
            const managerRecords = await agent.get(`${prefix}/record?tid=${tid}&practice=true`).accept('json').expect(200);
            assert.equal(managerRecords.body.rdocs.length, 2);
            const ordinaryRecords = await agent.get(`${prefix}/record?all=true`).accept('json').expect(200);
            assert(ordinaryRecords.body.rdocs.every((row) => !row.practiceContest));

            // Exercise the same HTTP/live ACL, including the noTemplate payload used by the editor.
            const wsArgs = [domainId, tid, pid, `${student.uid}`, undefined, false, false, false, true, true];
            const ws = Object.assign(Object.create(RecordMainConnectionHandler.prototype), {
                user: await getActor(student.uid), args: { domainId }, queue: new Map(),
            });
            await ws.prepare(...wsArgs);
            let pushed = 0;
            ws.queueSend = () => { pushed++; };
            await ws.onRecordChange(rdoc);
            assert.equal(pushed, 1);
            const outsiderWs = Object.assign(Object.create(RecordMainConnectionHandler.prototype), {
                user: await getActor(mate.uid), args: { domainId }, queue: new Map(),
            });
            await assert.rejects(() => outsiderWs.prepare(...wsArgs));
            await outsiderWs.prepare(domainId, tid, pid, `${mate.uid}`, undefined, false, false, false, true, true);
            outsiderWs.queueSend = () => { pushed++; };
            await outsiderWs.onRecordChange(rdoc);
            assert.equal(pushed, 1);
            const detailWs = Object.assign(Object.create(RecordDetailConnectionHandler.prototype), {
                user: await getActor(student.uid), args: { domainId }, onRecordChange: () => {},
            });
            await detailWs.prepare(domainId, rid, true);
            assert.equal(detailWs.canViewCode, true);
            detailWs.user = await getActor(mate.uid);
            await assert.rejects(() => detailWs.prepare(domainId, rid, true));

            rdoc = await RecordModel.update(domainId, rid, { status: STATUS.STATUS_ACCEPTED, score: 100 });
            await postJudge(rdoc);
            assert.equal(await ProblemModel.getStatus(domainId, pid, student.uid), null);
            assert.deepEqual(await ContestModel.getStatus(domainId, tid, teamUid), teamStatusBefore);
            assert.equal(await RecordModel.collStat.countDocuments({ _id: rid }), 0);
            const finalProblem = await ProblemModel.get(domainId, pid);
            assert.equal(finalProblem.nSubmit, originalProblem.nSubmit);
            assert.equal(finalProblem.nAccept, originalProblem.nAccept);
            const finalUser = await DomainModel.getDomainUser(domainId, await getActor(student.uid));
            assert.equal(finalUser.nSubmit, originalUser.nSubmit);
            assert.equal(finalUser.nAccept, originalUser.nAccept);
            assert.equal(finalUser.rp, originalUser.rp);
            const results = await practice.getPracticeResults(domainId, tid, student.uid, [pid]);
            assert.equal(results[pid].status, STATUS.STATUS_ACCEPTED);
            const pendingRid = await RecordModel.add(domainId, pid, student.uid, 'cc', 'pending', false, { practiceContest: tid, type: 'judge' });
            assert((await practice.getPracticeResults(domainId, tid, student.uid, [pid]))[pid].rid.equals(rid));
            rdoc = await RecordModel.update(domainId, rid, { status: STATUS.STATUS_WRONG_ANSWER, score: 40 });
            await postJudge(rdoc);
            assert.equal((await practice.getPracticeResults(domainId, tid, student.uid, [pid]))[pid].score, 40);
            const pending = await RecordModel.update(domainId, pendingRid, { status: STATUS.STATUS_WRONG_ANSWER, score: 50 });
            await postJudge(pending);
            assert((await practice.getPracticeResults(domainId, tid, student.uid, [pid]))[pid].rid.equals(pendingRid));
            const rejudgedRid = await RecordModel.add(domainId, pid, student.uid, 'cc', 'rejudge', false, {
                practiceContest: tid, type: 'rejudge',
            });
            assert((await RecordModel.get(domainId, rejudgedRid)).practiceContest.equals(tid));
            const problems = await student.client.get(`${prefix}/contest/${tid}/problems`).accept('json').expect(200);
            assert.equal(problems.body.correction[pid].score, 50);
            assert.equal(problems.body.canViewRecord, false);
            assert.equal(problems.body.rdict[pendingRid.toHexString()].score, 50);
            await student.client.get(`${prefix}/contest/${tid}/problems`).accept('html').expect(200);

            // Closing practice retains history; reopening the formal contest does not reclassify old records.
            await ContestModel.edit(domainId, tid, { allowPractice: false });
            await submit(student.client).expect(403);
            await student.client.get(`${prefix}/record/${rid}`).accept('json').expect(200);
            await ContestModel.edit(domainId, tid, { allowPractice: true, endAt: new Date(Date.now() + 3600000), duration: 0.01 });
            await ContestModel.setStatus(domainId, tid, teamUid, { startAt: new Date(now - 3600000), endAt: new Date(now - 1000) });
            assert.equal(await practice.canSubmitPractice(await getActor(student.uid), await ContestModel.get(domainId, tid)), false);
            await submit(student.client).expect(403);
            await ContestModel.edit(domainId, tid, { endAt: new Date(now - 3600000), assign: [`${newcomer.uid}`] });
            await student.client.get(`${prefix}/record/${rid}`).accept('json').expect(403);
            await student.client.get(`${prefix}/record?tid=${tid}&practice=true`).accept('json').expect(403);
            assert.equal(await practice.canSubmitPractice(await getActor(student.uid), await ContestModel.get(domainId, tid)), false);
        } finally {
            if (renderer) await renderer.dispose();
            if (previousUiAddon === undefined) delete global.addons['ui-default'];
            else global.addons['ui-default'] = previousUiAddon;
            await DomainModel.del(domainId);
            await Promise.all([
                RecordModel.coll.deleteMany({ domainId }),
                global.app.get('db').collection('contest.practiceAccess').deleteMany({ domainId }),
                global.Hydro.model.task.deleteMany({ domainId }),
                UserModel.coll.deleteMany({ _id: { $in: users.map((user) => user.uid) } }),
                require('../packages/hydrooj/src/model/user').collV.deleteMany({ _id: teamUid }),
            ]);
        }
    });

    it('Require explicit invitations after leaving and scope class invitations', async () => {
        const DomainModel = global.Hydro.model.domain;
        const OplogModel = global.Hydro.model.oplog;
        const TokenModel = global.Hydro.model.token;
        const UserModel = global.Hydro.model.user;
        const suffix = Date.now().toString(36);
        const domainId = `rejoin${suffix}`;
        const groupId = new ObjectId();
        const classId = new ObjectId();
        const groupName = `invite-target-${suffix}`;
        const teacherRole = `class-teacher-${suffix}`;
        const uname = `rejoin${suffix}`;
        const mail = `${uname}@example.com`;
        let uid: number | undefined;

        await DomainModel.add(domainId, 1, `Rejoin test ${suffix}`, '');
        try {
            await DomainModel.addRole(
                domainId,
                teacherRole,
                PERM.PERM_DEFAULT | PERM.PERM_CREATE_HOMEWORK | PERM.PERM_EDIT_HOMEWORK_SELF,
            );
            await DomainModel.edit(domainId, {
                _join: { method: DomainModel.JOIN_METHOD_ALL, role: 'default', group: groupName, expire: null },
            });
            uid = await UserModel.create(mail, uname, '123456');
            await DomainModel.setUserInDomain(domainId, uid, { join: true, role: teacherRole });
            await UserModel.collGroup.insertMany([
                { _id: groupId, domainId, name: groupName, uids: [] },
                {
                    _id: classId,
                    domainId,
                    name: `teacher-invite-${suffix}`,
                    uids: [2],
                    teachers: [2],
                    students: [],
                    beginAt: new Date(),
                    endAt: new Date(Date.now() + 86400000),
                    archive: false,
                    class: true,
                },
            ] as any);
            const invitedAgent = supertest.agent(require('hydrooj').httpServer);
            await invitedAgent.post('/login').send({ uname, password: '123456' }).expect(302);
            await invitedAgent.post('/home/domain')
                .send({ operation: 'leave', id: domainId }).expect(302);
            let dudoc = await DomainModel.collUser.findOne({ domainId, uid });
            assert.deepStrictEqual(
                { join: dudoc?.join, role: dudoc?.role, requireInvitation: dudoc?.requireInvitation },
                { join: false, role: 'default', requireInvitation: true },
            );
            await invitedAgent.get(`/d/${domainId}/domain/join`).expect(403);

            const code = `code${suffix}`;
            await DomainModel.edit(domainId, {
                _join: {
                    method: DomainModel.JOIN_METHOD_CODE,
                    role: 'default',
                    group: groupName,
                    expire: null,
                    code,
                },
            });
            await invitedAgent.post(`/d/${domainId}/domain/join`).send({ code }).expect(302);
            dudoc = await DomainModel.collUser.findOne({ domainId, uid });
            assert.equal(dudoc?.requireInvitation, undefined);
            assert((await UserModel.collGroup.findOne({ _id: groupId }))?.uids.includes(uid));

            await invitedAgent.post('/home/domain')
                .send({ operation: 'leave', id: domainId }).expect(302);
            await DomainModel.setUserRole(domainId, 2, teacherRole, true);
            await agent.post(`/d/${domainId}/domain/group/${classId}/invitation`)
                .send({ operation: 'create', expire: 3 }).expect(302);
            let classDoc = await UserModel.collGroup.findOne({ _id: classId });
            const teacherToken = await TokenModel.get(
                classDoc?.invitationTokenId, TokenModel.TYPE_GROUP_INVITATION,
            );
            assert.equal(teacherToken?.allowExternalDomainJoin, false);
            await invitedAgent.post(`/d/${domainId}/domain/group/join`)
                .send({ token: teacherToken._id }).expect(403);

            await DomainModel.setUserInDomain(domainId, uid, { join: true, role: 'default' });
            const originalAddUserToGroup = UserModel.addUserToGroupWithChanges;
            UserModel.addUserToGroupWithChanges = async (...args) => {
                await DomainModel.leave(domainId, uid);
                return await originalAddUserToGroup(...args);
            };
            try {
                await invitedAgent.post(`/d/${domainId}/domain/group/join`)
                    .send({ token: teacherToken._id }).expect(403);
            } finally {
                UserModel.addUserToGroupWithChanges = originalAddUserToGroup;
            }
            dudoc = await DomainModel.collUser.findOne({ domainId, uid });
            assert.deepStrictEqual(
                { join: dudoc?.join, role: dudoc?.role, requireInvitation: dudoc?.requireInvitation },
                { join: false, role: 'default', requireInvitation: true },
            );
            const rejectedFormerMember = await UserModel.collGroup.findOne({ _id: classId });
            assert(!rejectedFormerMember?.uids.includes(uid));
            assert(!rejectedFormerMember?.students.includes(uid));

            await Promise.all([
                UserModel.collGroup.updateOne(
                    { _id: classId }, { $pull: { uids: uid, students: uid } },
                ),
                DomainModel.setUserRole(domainId, 2, 'root', true),
            ]);
            await agent.post(`/d/${domainId}/domain/group/${classId}/invitation`)
                .send({ operation: 'create', expire: 24 }).expect(302);
            classDoc = await UserModel.collGroup.findOne({ _id: classId });
            const managerToken = await TokenModel.get(
                classDoc?.invitationTokenId, TokenModel.TYPE_GROUP_INVITATION,
            );
            assert.equal(managerToken?.allowExternalDomainJoin, true);
            const originalManagerAddUserToGroup = UserModel.addUserToGroupWithChanges;
            UserModel.addUserToGroupWithChanges = async (...args) => {
                await DomainModel.setUserRole(domainId, uid, 'guest');
                return await originalManagerAddUserToGroup(...args);
            };
            try {
                await invitedAgent.post(`/d/${domainId}/domain/group/join`)
                    .send({ token: managerToken._id }).expect(403);
            } finally {
                UserModel.addUserToGroupWithChanges = originalManagerAddUserToGroup;
            }
            dudoc = await DomainModel.collUser.findOne({ domainId, uid });
            assert.deepStrictEqual(
                { join: dudoc?.join, role: dudoc?.role, requireInvitation: dudoc?.requireInvitation },
                { join: false, role: 'guest', requireInvitation: true },
            );
            const rejectedGroup = await UserModel.collGroup.findOne({ _id: classId });
            assert(!rejectedGroup?.uids.includes(uid));
            assert(!rejectedGroup?.students.includes(uid));
            await DomainModel.setUserInDomain(domainId, uid, {
                join: false,
                role: 'default',
                requireInvitation: true,
            });
            let concurrentEditLockMatched = -1;
            const originalLockedJoinUserInDomain = DomainModel.joinUserInDomain;
            DomainModel.joinUserInDomain = async (...args) => {
                const concurrentEditLock = await UserModel.collGroup.updateOne(
                    {
                        _id: classId,
                        class: true,
                        $or: [
                            { classEditLock: { $exists: false } },
                            { 'classEditLock.expiresAt': { $lte: new Date() } },
                        ],
                    },
                    {
                        $set: {
                            classEditLock: {
                                token: new ObjectId().toHexString(),
                                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
                            },
                        },
                    },
                );
                concurrentEditLockMatched = concurrentEditLock.matchedCount;
                await DomainModel.setUserRole(domainId, uid, 'guest');
                return await originalLockedJoinUserInDomain(...args);
            };
            try {
                await invitedAgent.post(`/d/${domainId}/domain/group/join`)
                    .send({ token: managerToken._id }).expect(403);
            } finally {
                DomainModel.joinUserInDomain = originalLockedJoinUserInDomain;
            }
            assert.equal(concurrentEditLockMatched, 0);
            const rejectedDuringClassEdit = await UserModel.collGroup.findOne({ _id: classId });
            assert(!rejectedDuringClassEdit?.uids.includes(uid));
            assert(!rejectedDuringClassEdit?.students.includes(uid));
            assert.equal(rejectedDuringClassEdit?.classEditLock, undefined);
            await DomainModel.setUserInDomain(domainId, uid, {
                join: false,
                role: 'default',
                requireInvitation: true,
            });
            const originalRollbackUpdateOne = UserModel.collGroup.updateOne;
            const callRollbackUpdateOne = originalRollbackUpdateOne.bind(UserModel.collGroup);
            const originalRollbackJoinUserInDomain = DomainModel.joinUserInDomain;
            let rollbackFailureInjected = false;
            (UserModel.collGroup as any).updateOne = async (filter: any, update: any, options: any) => {
                if (!rollbackFailureInjected
                    && filter._id?.toString() === classId.toString()
                    && update.$pull?.students === uid) {
                    rollbackFailureInjected = true;
                    throw new Error('Injected group membership rollback failure');
                }
                return await callRollbackUpdateOne(filter, update, options);
            };
            DomainModel.joinUserInDomain = async (...args) => {
                await DomainModel.setUserRole(domainId, uid, 'guest');
                return await originalRollbackJoinUserInDomain(...args);
            };
            try {
                await invitedAgent.post(`/d/${domainId}/domain/group/join`)
                    .send({ token: managerToken._id }).expect(500);
            } finally {
                (UserModel.collGroup as any).updateOne = originalRollbackUpdateOne;
                DomainModel.joinUserInDomain = originalRollbackJoinUserInDomain;
            }
            assert(rollbackFailureInjected);
            const failedRollbackGroup = await UserModel.collGroup.findOne({ _id: classId });
            assert(failedRollbackGroup?.uids.includes(uid));
            assert(failedRollbackGroup?.students.includes(uid));
            assert(failedRollbackGroup?.classEditLock);
            const editAfterRollbackFailure = await callRollbackUpdateOne(
                {
                    _id: classId,
                    class: true,
                    $or: [
                        { classEditLock: { $exists: false } },
                        { 'classEditLock.expiresAt': { $lte: new Date() } },
                    ],
                },
                {
                    $set: {
                        classEditLock: {
                            token: new ObjectId().toHexString(),
                            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
                        },
                    },
                },
            );
            assert.equal(editAfterRollbackFailure.matchedCount, 0);
            await Promise.all([
                callRollbackUpdateOne(
                    { _id: classId },
                    {
                        $pull: { uids: uid, students: uid },
                        $unset: { classEditLock: '' },
                    },
                ),
                DomainModel.setUserInDomain(domainId, uid, {
                    join: false,
                    role: 'default',
                    requireInvitation: true,
                }),
            ]);
            const originalConcurrentAddUserToGroup = UserModel.addUserToGroupWithChanges;
            UserModel.addUserToGroupWithChanges = async (...args) => {
                await Promise.all([
                    UserModel.collGroup.updateOne(
                        { _id: classId },
                        { $addToSet: { uids: uid, teachers: uid } },
                    ),
                    DomainModel.setUserRole(domainId, uid, 'guest'),
                ]);
                return await originalConcurrentAddUserToGroup(...args);
            };
            try {
                await invitedAgent.post(`/d/${domainId}/domain/group/join`)
                    .send({ token: managerToken._id }).expect(403);
            } finally {
                UserModel.addUserToGroupWithChanges = originalConcurrentAddUserToGroup;
            }
            const concurrentlyPromotedGroup = await UserModel.collGroup.findOne({ _id: classId });
            assert(concurrentlyPromotedGroup?.uids.includes(uid));
            assert(concurrentlyPromotedGroup?.teachers.includes(uid));
            assert(!concurrentlyPromotedGroup?.students.includes(uid));
            await Promise.all([
                UserModel.collGroup.updateOne(
                    { _id: classId }, { $pull: { uids: uid, students: uid, teachers: uid } },
                ),
                DomainModel.setUserInDomain(domainId, uid, {
                    join: false,
                    role: 'default',
                    requireInvitation: true,
                }),
            ]);
            const originalJoinUserInDomain = DomainModel.joinUserInDomain;
            DomainModel.joinUserInDomain = async (...args) => {
                await Promise.all([
                    UserModel.collGroup.updateOne(
                        { _id: classId },
                        {
                            $addToSet: { uids: uid, teachers: uid },
                            $pull: { students: uid },
                        },
                    ),
                    DomainModel.setUserRole(domainId, uid, 'guest'),
                ]);
                return await originalJoinUserInDomain(...args);
            };
            try {
                await invitedAgent.post(`/d/${domainId}/domain/group/join`)
                    .send({ token: managerToken._id }).expect(403);
            } finally {
                DomainModel.joinUserInDomain = originalJoinUserInDomain;
            }
            const promotedAfterInvitation = await UserModel.collGroup.findOne({ _id: classId });
            assert(promotedAfterInvitation?.uids.includes(uid));
            assert(promotedAfterInvitation?.teachers.includes(uid));
            assert(!promotedAfterInvitation?.students.includes(uid));
            await Promise.all([
                UserModel.collGroup.updateOne(
                    { _id: classId }, { $pull: { uids: uid, students: uid, teachers: uid } },
                ),
                DomainModel.setUserInDomain(domainId, uid, {
                    join: false,
                    role: 'default',
                    requireInvitation: true,
                }),
            ]);
            await invitedAgent.post(`/d/${domainId}/domain/group/join`)
                .send({ token: managerToken._id }).expect(302);
            dudoc = await DomainModel.collUser.findOne({ domainId, uid });
            assert.deepStrictEqual(
                { join: dudoc?.join, role: dudoc?.role, requireInvitation: dudoc?.requireInvitation },
                { join: true, role: 'default', requireInvitation: undefined },
            );
            await agent.post(`/d/${domainId}/domain/group/${classId}/invitation`)
                .send({ operation: 'revoke' }).expect(302);
            assert.equal(await OplogModel.coll.countDocuments({
                domainId, groupId: classId, type: 'domain.group.invitation.create',
            }), 2);
            assert.equal(await OplogModel.coll.countDocuments({
                domainId, groupId: classId, type: 'domain.group.invitation.revoke',
            }), 1);

            await DomainModel.setUserInDomain(domainId, uid, {
                join: false,
                requireInvitation: false,
                role: 'guest',
            });
            await invitedAgent.post('/home/domain')
                .send({ operation: 'leave', id: domainId }).expect(302);
            dudoc = await DomainModel.collUser.findOne({ domainId, uid });
            assert.deepStrictEqual(
                { join: dudoc?.join, role: dudoc?.role, requireInvitation: dudoc?.requireInvitation },
                { join: false, role: 'guest', requireInvitation: false },
            );
        } finally {
            if (uid) {
                const udoc = await UserModel.getById('system', uid);
                if (udoc) UserModel._deleteUserCache(udoc);
                await UserModel.coll.deleteOne({ _id: uid });
                await DomainModel.collUser.deleteOne({ domainId: 'system', uid });
            }
            await Promise.all([
                UserModel.collGroup.deleteMany({ domainId }),
                TokenModel.coll.deleteMany({ domainId, tokenType: TokenModel.TYPE_GROUP_INVITATION }),
                OplogModel.coll.deleteMany({ domainId }),
                DomainModel.del(domainId),
            ]);
        }
    });

    it('Use the new user import entry only', async () => {
        const UserModel = global.Hydro.model.user;
        const root = await UserModel.getById('system', 2);
        const originalPriv = root.priv;
        await UserModel.setSuperAdmin(2);
        try {
            await agent.get('/manage/userimport')
                .expect(302)
                .expect('location', '/manage/users/import');
            await agent.get('/manage/users/import').expect(200);
        } finally {
            await UserModel.setPriv(2, originalPriv);
        }
    });

    it('Require sudo for direct security mutations', async () => {
        const securityAgent = supertest.agent(require('hydrooj').httpServer);
        await securityAgent.post('/login')
            .send({ uname: Root.username, password: Root.password }).expect(302);
        await securityAgent.post('/home/security')
            .send({ operation: 'delete_all_tokens' })
            .expect(302)
            .expect('location', '/user/sudo');
    });

    it('Change a required password without entering sudo mode first', async () => {
        const DomainModel = global.Hydro.model.domain;
        const TokenModel = global.Hydro.model.token;
        const UserModel = global.Hydro.model.user;
        const suffix = Date.now().toString(36);
        const mail = `password-${suffix}@example.com`;
        const uname = `password${suffix}`;
        const uid = await UserModel.create(mail, uname, '123456');
        let udoc = await UserModel.getById('system', uid);
        await UserModel.setById(uid, { requirePasswordChange: true });
        const passwordAgent = supertest.agent(require('hydrooj').httpServer);
        try {
            await passwordAgent.post('/login')
                .send({ uname, password: '123456' }).expect(302);
            await passwordAgent.get('/')
                .expect(302)
                .expect('location', '/home/security/password');
            await passwordAgent.get('/home/security/password')
                .expect(200);
            await passwordAgent.post('/home/security/password')
                .send({
                    currentPassword: 'wrong-password',
                    password: '654321',
                    verifyPassword: '654321',
                })
                .expect(403);
            await passwordAgent.post('/home/security/password')
                .send({
                    currentPassword: '123456',
                    password: '654321',
                    verifyPassword: '654321',
                })
                .expect(302)
                .expect('location', '/login');
            udoc = await UserModel.getById('system', uid);
            assert.equal(udoc.requirePasswordChange, false);
            await udoc.checkPassword('654321');
        } finally {
            if (udoc) UserModel._deleteUserCache(udoc);
            await Promise.all([
                TokenModel.delByUid(uid),
                UserModel.coll.deleteOne({ _id: uid }),
                DomainModel.collUser.deleteOne({ domainId: 'system', uid }),
            ]);
        }
    });

    it('Resetting a user password clears all authenticators and rejects stale updates', async () => {
        const DomainModel = global.Hydro.model.domain;
        const UserModel = global.Hydro.model.user;
        const suffix = Date.now().toString(36);
        const editUid = await UserModel.create(`reset-edit-${suffix}@example.com`, `resetedit${suffix}`, 'old-password');
        const batchUid = await UserModel.create(`reset-batch-${suffix}@example.com`, `resetbatch${suffix}`, 'old-password');
        const batchUid2 = await UserModel.create(`reset-batch-2-${suffix}@example.com`, `resetbatch2${suffix}`, 'old-password');
        const targetUids = [editUid, batchUid, batchUid2];
        const originalRootPriv = (await UserModel.getById('system', 2)).priv;
        const credentialID = Binary.createFromBase64('dGVzdC1jcmVkZW50aWFs');
        await UserModel.setSuperAdmin(2);
        for (const uid of targetUids) {
            await UserModel.setById(uid, {
                authenticators: [{ credentialID }],
                tfa: 'test-secret',
            });
        }

        const managerAgent = supertest.agent(require('hydrooj').httpServer);
        const resetSingle = () => managerAgent
            .post(`/manage/user/${editUid}/edit`)
            .send({ operation: 'reset_password' });
        const resetBatch = () => managerAgent
            .post('/manage/users/batch_operation')
            .send({ operation: 'reset_password', uids: [batchUid, batchUid2], password: '654321' });
        const resetUpdates: any[] = [];
        const originalFindOneAndUpdate = (UserModel.coll as any).findOneAndUpdate;
        (UserModel.coll as any).findOneAndUpdate = async (...args: any[]) => {
            if (targetUids.includes(args[0]?._id)) resetUpdates.push(args[1]);
            return originalFindOneAndUpdate.apply(UserModel.coll, args);
        };

        try {
            await managerAgent.post('/login')
                .send({ uname: Root.username, password: Root.password }).expect(302);

            await resetSingle().expect(302).expect('location', '/user/sudo');
            await managerAgent.post('/user/sudo').send({ password: Root.password }).expect(200);
            await resetSingle().expect(302);

            await resetBatch().expect(200).expect({ ok: 1 });
            assert.equal(resetUpdates.length, targetUids.length);
            for (const update of resetUpdates) {
                assert.deepStrictEqual(update.$set.authenticators, []);
                assert.equal(update.$set.tfa, false);
                assert.equal(update.$set.requirePasswordChange, true);
            }
            assert.equal(await UserModel.updateAuthenticatorCounter(editUid, credentialID, 1), null);

            for (const [uid, password] of [[editUid, '123456'], [batchUid, '654321'], [batchUid2, '654321']]) {
                const udoc = await UserModel.coll.findOne({ _id: uid });
                assert.deepStrictEqual(udoc.authenticators, []);
                assert.equal(udoc.tfa, false);
                assert.equal(udoc.requirePasswordChange, true);
                const user = await UserModel.getById('system', uid);
                await user.checkPassword(password);
                UserModel._deleteUserCache(user);
            }
        } finally {
            (UserModel.coll as any).findOneAndUpdate = originalFindOneAndUpdate;
            await UserModel.setPriv(2, originalRootPriv);
            for (const uid of targetUids) {
                const udoc = await UserModel.getById('system', uid);
                if (udoc) UserModel._deleteUserCache(udoc);
            }
            await Promise.all([
                UserModel.coll.deleteMany({ _id: { $in: targetUids } }),
                DomainModel.collUser.deleteMany({ domainId: 'system', uid: { $in: targetUids } }),
            ]);
        }
    });

    it('Rate limit password verification for privileged users', async () => {
        const DomainModel = global.Hydro.model.domain;
        const TokenModel = global.Hydro.model.token;
        const UserModel = global.Hydro.model.user;
        const suffix = Date.now().toString(36);
        const dummyMail = `password-rate-dummy-${suffix}@example.com`;
        const dummyUname = `passwordratedummy${suffix}`;
        const mail = `password-rate-${suffix}@example.com`;
        const uname = `passwordrate${suffix}`;
        const dummyUid = await UserModel.create(dummyMail, dummyUname, '123456');
        const uid = await UserModel.create(mail, uname, '123456');
        await UserModel.setSuperAdmin(uid);
        const passwordAgent = supertest.agent(require('hydrooj').httpServer);
        try {
            await passwordAgent.post('/login')
                .send({ uname, password: '123456' }).expect(302);
            for (let attempt = 0; attempt < 5; attempt++) {
                // eslint-disable-next-line no-await-in-loop
                await passwordAgent.post('/home/security/password')
                    .send({
                        currentPassword: 'wrong-password',
                        password: '654321',
                        verifyPassword: '654321',
                    })
                    .expect(403)
                    .expect(/Invalid password/);
            }
            await passwordAgent.post('/home/security/password')
                .send({
                    currentPassword: 'wrong-password',
                    password: '654321',
                    verifyPassword: '654321',
                })
                .expect(403)
                .expect(/Too frequent operations/);
        } finally {
            const udoc = await UserModel.getById('system', uid);
            if (udoc) UserModel._deleteUserCache(udoc);
            await Promise.all([
                TokenModel.delByUid(uid),
                UserModel.coll.deleteMany({ _id: { $in: [dummyUid, uid] } }),
                DomainModel.collUser.deleteMany({ domainId: 'system', uid: { $in: [dummyUid, uid] } }),
            ]);
        }
    });

    it('Reject cross-type homework and course edit routes', async () => {
        const ContestModel = global.Hydro.model.contest;
        const suffix = Date.now().toString(36);
        const beginAt = new Date('2026-07-26T00:00:00Z');
        const penaltySince = new Date('2026-07-27T00:00:00Z');
        const endAt = new Date('2026-07-28T00:00:00Z');
        const courseId = await ContestModel.add(
            'system', `Cross-route course ${suffix}`, '', 2, 'course', beginAt, endAt, [], false,
            { assign: [], dag: [] },
        );
        const homeworkId = await ContestModel.add(
            'system', `Cross-route homework ${suffix}`, '', 2, 'homework', beginAt, endAt, [], false,
            { assign: [], penaltySince, penaltyRules: { 0: 1 } },
        );
        try {
            await agent.post(`/d/system/homework/${courseId}/edit`)
                .send({ operation: 'delete' })
                .expect(404);
            assert(await ContestModel.get('system', courseId));
            await agent.get(`/d/system/homework/${courseId}/edit`).expect(404);
            await agent.post(`/d/system/course/${homeworkId}/edit`)
                .send({ operation: 'delete' })
                .expect(404);
            assert(await ContestModel.get('system', homeworkId));
        } finally {
            await Promise.all([
                ContestModel.del('system', courseId),
                ContestModel.del('system', homeworkId),
            ]);
            // Start the request-heavy invitation regression in a fresh global rate-limit window.
            await new Promise((resolve) => setTimeout(resolve, 5100));
        }
    });

    it('Auto-claims a course template for its owner', async () => {
        const ContestModel = global.Hydro.model.contest;
        const suffix = Date.now().toString(36);
        const tid = await ContestModel.add(
            'system', `Template owner access ${suffix}`, '', 2, 'course',
            new Date(Date.now() - 3600000), new Date(Date.now() + 3600000), [], false,
            { assign: ['teachers'], dag: [] },
        );
        try {
            assert.equal(await ContestModel.getStatus('system', tid, 2), null);
            await agent.get(`/d/system/course/${tid}`).expect(200);
            assert.equal((await ContestModel.getStatus('system', tid, 2))?.attend, 1);
        } finally {
            await ContestModel.del('system', tid);
        }
    });

    it('Handles concurrent course template owner auto-claims', async () => {
        const ContestModel = global.Hydro.model.contest;
        const DocumentModel = global.Hydro.model.document;
        const suffix = Date.now().toString(36);
        const tid = await ContestModel.add(
            'system', `Concurrent template owner access ${suffix}`, '', 2, 'course',
            new Date(Date.now() - 3600000), new Date(Date.now() + 3600000), [], false,
            { assign: ['teachers'], dag: [] },
        );
        const originalFindOneAndUpdate = DocumentModel.collStatus.findOneAndUpdate;
        let attendCalls = 0;
        let releaseAttend: () => void;
        const attendReady = new Promise<void>((resolve) => {
            releaseAttend = resolve;
        });
        DocumentModel.collStatus.findOneAndUpdate = async (...args) => {
            const [filter, update] = args;
            if (filter.domainId === 'system' && filter.docId.equals(tid)
                && filter.uid === 2 && update.$inc?.attend === 1) {
                attendCalls++;
                if (attendCalls === 2) releaseAttend();
                await attendReady;
            }
            return await originalFindOneAndUpdate.apply(DocumentModel.collStatus, args);
        };
        try {
            const responses = await Promise.allSettled([
                agent.get(`/d/system/course/${tid}`),
                agent.get(`/d/system/course/${tid}`),
            ]);
            assert.equal(attendCalls, 2);
            assert(responses.every((result) => result.status === 'fulfilled' && result.value.status === 200));
            assert.equal((await ContestModel.getStatus('system', tid, 2))?.attend, 1);
        } finally {
            DocumentModel.collStatus.findOneAndUpdate = originalFindOneAndUpdate;
            await ContestModel.del('system', tid);
        }
    });

    it('Assigns configured external invitation roles and resolves class invitation codes', async () => {
        const DomainModel = global.Hydro.model.domain;
        const TokenModel = global.Hydro.model.token;
        const UserModel = global.Hydro.model.user;
        const suffix = Date.now().toString(36);
        const domainId = `invite-code-${suffix}`;
        const classId = new ObjectId();
        const duplicateClassId = new ObjectId();
        const teacherClassId = new ObjectId();
        const role = `inviterole${suffix}`;
        const code = `Invite${suffix}`;
        const inviteeName = `invitee${suffix}`;
        const existingName = `existing${suffix}`;
        const teacherName = `teacher${suffix}`;
        const inviteeUid = await UserModel.create(`${inviteeName}@example.com`, inviteeName, '123456');
        const existingUid = await UserModel.create(`${existingName}@example.com`, existingName, '123456');
        const teacherUid = await UserModel.create(`${teacherName}@example.com`, teacherName, '123456');

        await DomainModel.add(domainId, 2, `Invitation code ${suffix}`, '');
        try {
            await DomainModel.addRole(domainId, role, PERM.PERM_DEFAULT);
            await Promise.all([
                DomainModel.setUserInDomain(domainId, existingUid, { join: true, role: 'default' }),
                DomainModel.setUserInDomain(domainId, teacherUid, { join: true, role: 'default' }),
                UserModel.collGroup.insertMany([
                    {
                        _id: classId, domainId, name: `class-${suffix}`, uids: [2], students: [], teachers: [], class: true,
                    },
                    {
                        _id: duplicateClassId, domainId, name: `duplicate-${suffix}`, uids: [2], students: [], teachers: [], class: true,
                    },
                    {
                        _id: teacherClassId,
                        domainId,
                        name: `teacher-${suffix}`,
                        uids: [teacherUid],
                        students: [],
                        teachers: [teacherUid],
                        class: true,
                    },
                ] as any),
            ]);
            await agent.post(`/d/${domainId}/domain/group/${classId}/invitation`)
                .send({ operation: 'create', expire: 3, externalJoinRole: 'root' }).expect(403);
            await agent.post(`/d/${domainId}/domain/group/${classId}/invitation`)
                .send({ operation: 'create', expire: 3, invitationCode: code, externalJoinRole: role }).expect(302);
            const classDoc = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(classDoc?.invitationCode, code.toLowerCase());
            const invitation = await TokenModel.get(classDoc?.invitationTokenId, TokenModel.TYPE_GROUP_INVITATION);
            assert.equal(invitation?.externalJoinRole, role);

            const invitee = supertest.agent(require('hydrooj').httpServer);
            await invitee.post('/login').send({ uname: inviteeName, password: '123456' }).expect(302);
            await invitee.get(`/d/${domainId}/domain/group/join?code=${code.toLowerCase()}`)
                .expect(200)
                .expect((res) => assert(res.text.includes(role)));
            await invitee.post(`/d/${domainId}/domain/group/join?code=${code.toLowerCase()}`)
                .send({ token: invitation._id })
                .expect(302);
            assert.deepStrictEqual(
                await DomainModel.collUser.findOne({ domainId, uid: inviteeUid }).then((doc) => ({ join: doc?.join, role: doc?.role })),
                { join: true, role },
            );
            assert((await UserModel.collGroup.findOne({ _id: classId }))?.students.includes(inviteeUid));

            await agent.post(`/d/${domainId}/domain/group/${duplicateClassId}/invitation`)
                .send({ operation: 'create', expire: 3, invitationCode: code, externalJoinRole: role }).expect(403);

            const existing = supertest.agent(require('hydrooj').httpServer);
            await existing.post('/login').send({ uname: existingName, password: '123456' }).expect(302);
            await TokenModel.coll.updateOne(
                { _id: invitation._id },
                { $set: { externalJoinRole: 'root' } },
            );
            const originalAddUserToGroupWithChanges = UserModel.addUserToGroupWithChanges;
            let membershipMutationAttempted = false;
            UserModel.addUserToGroupWithChanges = async (...args: any[]) => {
                membershipMutationAttempted = true;
                const membership = await originalAddUserToGroupWithChanges.call(UserModel, ...args);
                await DomainModel.setUserInDomain(domainId, existingUid, { join: false, role: 'default' });
                return membership;
            };
            try {
                await existing.post(`/d/${domainId}/domain/group/join`).send({ code }).expect(403);
            } finally {
                UserModel.addUserToGroupWithChanges = originalAddUserToGroupWithChanges;
                await TokenModel.coll.updateOne({ _id: invitation._id }, { $set: { externalJoinRole: role } });
            }
            assert(!membershipMutationAttempted);
            assert(!(await UserModel.collGroup.findOne({ _id: classId }))?.students.includes(existingUid));
            assert.deepStrictEqual(
                await DomainModel.collUser.findOne({ domainId, uid: existingUid })
                    .then((doc) => ({ join: doc?.join, role: doc?.role })),
                { join: true, role: 'default' },
            );

            const teacher = supertest.agent(require('hydrooj').httpServer);
            await teacher.post('/login').send({ uname: teacherName, password: '123456' }).expect(302);
            await teacher.get(`/d/${domainId}/domain/group/${teacherClassId}/invitation`)
                .expect(200)
                .expect((res) => assert(!res.text.includes('name="externalJoinRole"')));
            await teacher.post(`/d/${domainId}/domain/group/${teacherClassId}/invitation`)
                .send({ operation: 'create', expire: 3, externalJoinRole: role }).expect(403);

            await DomainModel.deleteRoles(domainId, [role]);
            await UserModel.collGroup.updateOne(
                { _id: classId },
                { $pull: { uids: existingUid, students: existingUid } },
            );
            await existing.post(`/d/${domainId}/domain/group/join`).send({ code }).expect(302);
            assert((await UserModel.collGroup.findOne({ _id: classId }))?.students.includes(existingUid));
            assert.equal((await DomainModel.collUser.findOne({ domainId, uid: existingUid }))?.role, 'default');

            await DomainModel.setUserInDomain(domainId, inviteeUid, { join: false, role: 'default' });
            await DomainModel.joinUserInDomain(domainId, inviteeUid, role);
            assert.equal(
                (await DomainModel.collUser.findOne({ domainId, uid: inviteeUid }))?.role,
                'default',
            );

            await DomainModel.addRole(domainId, role, PERM.PERM_DEFAULT);
            const cachedDomain = await DomainModel.get(domainId);
            const originalDomainUserUpdateMany = DomainModel.collUser.updateMany;
            DomainModel.collUser.updateMany = async (...args: any[]) => {
                const roleFilters = [args[0], ...(args[0]?.$or || [])];
                if (args[0]?.domainId === domainId && roleFilters.some((filter) => filter?.role?.$in?.includes(role))) {
                    throw new Error('Injected role migration failure');
                }
                return await originalDomainUserUpdateMany.call(DomainModel.collUser, ...args);
            };
            try {
                await assert.rejects(DomainModel.deleteRoles(domainId, [role]), /Injected role migration failure/);
            } finally {
                DomainModel.collUser.updateMany = originalDomainUserUpdateMany;
            }
            const reloadedDomain = await DomainModel.get(domainId);
            assert.notStrictEqual(reloadedDomain, cachedDomain);
            assert(!Object.hasOwn(reloadedDomain?.roles || {}, role));

            await DomainModel.addRole(domainId, role, PERM.PERM_DEFAULT);
            await DomainModel.setUserInDomain(domainId, inviteeUid, { join: false, role: 'default' });
            const originalDomainFindOne = DomainModel.coll.findOne;
            DomainModel.coll.findOne = async (...args: any[]) => {
                if (args[0]?._id === domainId && args[1]?.projection?.roles) {
                    throw new Error('Injected role recheck failure');
                }
                return await originalDomainFindOne.call(DomainModel.coll, ...args);
            };
            try {
                const joined = await DomainModel.joinUserInDomain(domainId, inviteeUid, role);
                assert.deepStrictEqual({ join: joined?.join, role: joined?.role }, { join: true, role: 'default' });
            } finally {
                DomainModel.coll.findOne = originalDomainFindOne;
            }
        } finally {
            await Promise.all([
                UserModel.coll.deleteMany({ _id: { $in: [inviteeUid, existingUid, teacherUid] } }),
                UserModel.collGroup.deleteMany({ domainId }),
                TokenModel.coll.deleteMany({ domainId, tokenType: TokenModel.TYPE_GROUP_INVITATION }),
                DomainModel.del(domainId),
            ]);
        }
    });

    it('Join groups and classes with expiring invitation links', async () => {
        const UserModel = global.Hydro.model.user;
        const TokenModel = global.Hydro.model.token;
        const DomainModel = global.Hydro.model.domain;
        const ContestModel = global.Hydro.model.contest;
        const db = require('../packages/hydrooj/src/service/db').default;
        const { ClassModel } = require('../packages/hydrooj/src/builtin/course-management/model/class');
        const suffix = Date.now().toString(36);
        const groupId = new ObjectId();
        const classId = new ObjectId();
        const teachersClassId = new ObjectId();
        const archivedClassId = new ObjectId();
        const deletedClassId = new ObjectId();
        const deleteLockedClassId = new ObjectId();
        const regularTeachersGroupId = new ObjectId();
        const legacyGroupId = new ObjectId();
        const alternateGroupId = new ObjectId();
        const groupName = `invite-group-${suffix}`;
        const className = `invite-class-${suffix}`;
        const deleteLockedClassName = `delete-locked-class-${suffix}`;
        const renamedClassName = `renamed-invite-class-${suffix}`;
        const conflictingRenameName = `conflicting-rename-class-${suffix}`;
        const concurrentRenamedClassName = `concurrent-renamed-class-${suffix}`;
        const creatorManagedClassName = `creator-managed-invite-class-${suffix}`;
        const unauthorizedClassName = `unauthorized-invite-class-${suffix}`;
        const importedUsername = `classimport${suffix}`;
        const importedEmail = `${importedUsername}@example.com`;
        const templateTitle = `Conflicting teachers template ${suffix}`;
        const lockedCourseTitle = `Locked class course ${suffix}`;
        const lockedCopyTitle = `Locked class template ${suffix}`;
        const invalidClassNames = [Date.now().toString(), `invalid,class-${suffix}`];
        const creatorRole = `invite-class-creator-${suffix}`;
        const alternateDomainId = `invite-${suffix}`;
        let collisionCourseId: ObjectId | undefined;
        let unassignedEditRaceCourseId: ObjectId | undefined;
        let deleteConditionalCourseId: ObjectId | undefined;
        let assignmentRaceCourseId: ObjectId | undefined;
        let lockedTemplateCourseId: ObjectId | undefined;
        let importedUser: any;
        const classUpdatePayload = ({
            archive = false,
            name = className,
            students = '4',
            teachers = '3',
        }: {
            archive?: boolean;
            name?: string;
            students?: string;
            teachers?: string;
        } = {}) => ({
            operation: 'update',
            name,
            teachers,
            students,
            teacherGroups: '',
            studentGroups: '',
            beginAtDate: '2026-7-23',
            beginAtTime: '0:00',
            EndAtDate: '2026-7-24',
            EndAtTime: '23:59',
            intervalDays: 1,
            archive,
        });
        const targets = [
            {
                _id: groupId,
                domainId: 'system',
                name: groupName,
                uids: [],
            },
            {
                _id: classId,
                domainId: 'system',
                name: className,
                uids: [2],
                teachers: [],
                students: [],
                beginAt: new Date(),
                endAt: new Date(Date.now() + 86400000),
                archive: false,
                class: true,
            },
            {
                _id: deleteLockedClassId,
                domainId: 'system',
                name: deleteLockedClassName,
                uids: [],
                teachers: [],
                students: [],
                beginAt: new Date(),
                endAt: new Date(Date.now() + 86400000),
                archive: false,
                class: true,
            },
        ];
        const blockedTargets = [
            {
                _id: teachersClassId,
                domainId: 'system',
                name: 'teachers',
                uids: [],
                teachers: [],
                students: [],
                beginAt: new Date(),
                endAt: new Date(Date.now() + 86400000),
                archive: false,
                class: true,
            },
            {
                _id: archivedClassId,
                domainId: 'system',
                name: `archived-class-${suffix}`,
                uids: [],
                teachers: [],
                students: [],
                beginAt: new Date(),
                endAt: new Date(Date.now() + 86400000),
                archive: true,
                class: true,
            },
        ];
        const legacyGroup = {
            _id: legacyGroupId,
            domainId: 'system',
            name: `legacy-invite-group-${suffix}`,
            uids: [],
        };
        const alternateGroup = {
            _id: alternateGroupId,
            domainId: alternateDomainId,
            name: `alternate-invite-group-${suffix}`,
            uids: [],
        };

        await Promise.all([
            DomainModel.add(alternateDomainId, 2, `Invitation Test ${suffix}`, ''),
            DomainModel.addRole(
                'system',
                creatorRole,
                PERM.PERM_DEFAULT | PERM.PERM_CREATE_HOMEWORK,
            ),
        ]);
        await Promise.all([
            UserModel.collGroup.insertMany([
                ...targets, ...blockedTargets, legacyGroup, alternateGroup,
            ] as any),
            DomainModel.setUserRole('system', 2, 'root', true),
        ]);
        try {
            await agent.get('/d/system/domain/group').expect(200);
            const originalRootPriv = (await UserModel.getById('system', 2)).priv;
            await UserModel.setSuperAdmin(2);
            let importResponse: any;
            try {
                importResponse = await agent.post('/manage/users/import')
                    .send({
                        users: [
                            importedEmail,
                            importedUsername,
                            '123456',
                            'Imported User',
                            JSON.stringify({ group: className }),
                        ].join('\t'),
                        draft: false,
                    })
                    .expect(200);
            } finally {
                await UserModel.setPriv(2, originalRootPriv);
            }
            assert(importResponse.text.includes(`Group ${className} conflicts with an existing class.`));
            importedUser = await UserModel.getByEmail('system', importedEmail);
            assert(importedUser);
            assert.deepStrictEqual((await UserModel.collGroup.findOne({ _id: classId }))?.uids, [2]);
            await Promise.all([
                UserModel.coll.deleteOne({ _id: importedUser._id }),
                DomainModel.collUser.deleteOne({ domainId: 'system', uid: importedUser._id }),
            ]);
            UserModel._deleteUserCache(importedUser);
            await assert.rejects(UserModel.updateGroup('system', className, [2, 5]));
            await assert.rejects(UserModel.delGroup('system', className));
            const classAfterRejectedGroupMutations = await UserModel.collGroup.findOne({ _id: classId });
            assert(classAfterRejectedGroupMutations?.class);
            assert.deepStrictEqual(classAfterRejectedGroupMutations.uids, [2]);
            assert.deepStrictEqual(classAfterRejectedGroupMutations.teachers, []);
            assert.deepStrictEqual(classAfterRejectedGroupMutations.students, []);
            await agent.get('/d/system/domain/class')
                .expect(200)
                .expect((res) => {
                    assert(res.text.includes(archivedClassId.toHexString()));
                    assert(!res.text.includes(`/d/system/domain/group/${archivedClassId}/invitation`));
                });
            await agent.post(`/d/system/domain/group/${groupId}/invitation`)
                .send({ operation: 'create', expire: 0 })
                .expect(403);
            await DomainModel.setUserRole('system', 2, creatorRole, true);
            await agent.post('/d/system/domain/class/create')
                .send(classUpdatePayload({ name: creatorManagedClassName }))
                .expect(302);
            const creatorManagedClass = await UserModel.collGroup.findOne({
                domainId: 'system', name: creatorManagedClassName,
            });
            assert(creatorManagedClass?.class);
            assert.deepStrictEqual(creatorManagedClass.teachers, [3, 2]);
            await agent.get('/d/system/domain/class')
                .expect(200)
                .expect((res) => {
                    const body = JSON.parse(res.text);
                    assert.equal(body.canCreateClass, true);
                    assert(body.groups.some((group: any) => group._id === creatorManagedClass._id.toHexString()));
                });
            await agent.post(`/d/system/domain/class/${creatorManagedClass._id}/edit`)
                .send(classUpdatePayload({ name: creatorManagedClassName, teachers: '2,3' }))
                .expect(302);
            await UserModel.collGroup.deleteOne({ _id: creatorManagedClass._id });

            await DomainModel.setUserRole('system', 2, 'default', true);
            await agent.get('/d/system/domain/class')
                .expect(200)
                .expect((res) => {
                    const body = JSON.parse(res.text);
                    assert.equal(body.canCreateClass, false);
                    assert(!body.groups.some((group: any) => group._id === classId.toHexString()));
                });
            const unauthorizedClassInvitation = await agent
                .get(`/d/system/domain/group/${classId}/invitation`);
            await agent.post(`/d/system/domain/class/${classId}/edit`)
                .send(classUpdatePayload({ teachers: '2' }))
                .expect(403);
            await agent.post('/d/system/domain/class/create')
                .send(classUpdatePayload({ name: unauthorizedClassName, teachers: '2' }))
                .expect(403);
            assert.equal(await UserModel.collGroup.findOne({
                domainId: 'system', name: unauthorizedClassName,
            }), null);
            await UserModel.collGroup.updateOne(
                { _id: classId },
                { $addToSet: { teachers: 2 } },
            );
            const teacherClassInvitation = await agent
                .get(`/d/system/domain/group/${classId}/invitation`);
            await agent.post(`/d/system/domain/class/${classId}/edit`)
                .send(classUpdatePayload({ teachers: '2,3' }))
                .expect(302);
            await Promise.all([
                UserModel.collGroup.updateOne(
                    { _id: classId },
                    { $pull: { teachers: 2 } },
                ),
                DomainModel.setUserRole('system', 2, 'root', true),
            ]);

            const [legacyOldTokenId] = await TokenModel.add(
                TokenModel.TYPE_GROUP_INVITATION, 3600, {
                    domainId: 'system',
                    groupId: legacyGroupId,
                },
            );
            const [legacyLatestTokenId] = await TokenModel.add(
                TokenModel.TYPE_GROUP_INVITATION, 3600, {
                    domainId: 'system',
                    groupId: legacyGroupId,
                },
            );
            await Promise.all([
                TokenModel.coll.updateOne(
                    { _id: legacyOldTokenId },
                    { $set: { updateAt: new Date(Date.now() - 1000) } },
                ),
                TokenModel.coll.updateOne(
                    { _id: legacyLatestTokenId },
                    { $set: { updateAt: new Date() } },
                ),
            ]);
            const legacyOldInvitation = await agent
                .get(`/d/system/domain/group/join?token=${legacyOldTokenId}`);
            const legacyLatestInvitation = await agent
                .get(`/d/system/domain/group/join?token=${legacyLatestTokenId}`);
            const unmigratedLegacyGroup = await UserModel.collGroup.findOne({ _id: legacyGroupId });
            await agent.get(`/d/system/domain/group/${legacyGroupId}/invitation`)
                .expect(200)
                .expect((res) => {
                    assert(!res.text.includes(legacyOldTokenId));
                    assert(!res.text.includes(legacyLatestTokenId));
                });
            await agent.post(`/d/system/domain/group/${legacyGroupId}/invitation`)
                .send({ operation: 'create', expire: 3 })
                .expect(302);
            const regeneratedLegacyGroup = await UserModel.collGroup.findOne({ _id: legacyGroupId });
            assert(regeneratedLegacyGroup?.invitationTokenId);
            const regeneratedLegacyInvitation = await agent.get(
                `/d/system/domain/group/join?token=${regeneratedLegacyGroup.invitationTokenId}`,
            );

            const [alternateTokenId] = await TokenModel.add(
                TokenModel.TYPE_GROUP_INVITATION, 3600, {
                    domainId: alternateDomainId,
                    groupId: alternateGroupId,
                },
            );
            await UserModel.collGroup.updateOne(
                { _id: alternateGroupId },
                { $set: { invitationTokenId: alternateTokenId } },
            );
            const crossDomainInvitation = await agent
                .post('/d/system/domain/group/join')
                .send({ token: alternateTokenId });
            const canonicalDomainInvitation = await agent
                .get(`/d/${alternateDomainId}/domain/group/join?token=${alternateTokenId}`);

            assert.deepStrictEqual({
                unauthorizedClassInvitation: unauthorizedClassInvitation.status,
                teacherClassInvitation: teacherClassInvitation.status,
                legacyOldInvitation: legacyOldInvitation.status,
                legacyLatestInvitation: legacyLatestInvitation.status,
                legacyPointerBeforeRegeneration: unmigratedLegacyGroup?.invitationTokenId,
                regeneratedLegacyInvitation: regeneratedLegacyInvitation.status,
                crossDomainInvitation: crossDomainInvitation.status,
                canonicalDomainInvitation: canonicalDomainInvitation.status,
            }, {
                unauthorizedClassInvitation: 403,
                teacherClassInvitation: 200,
                legacyOldInvitation: 403,
                legacyLatestInvitation: 403,
                legacyPointerBeforeRegeneration: undefined,
                regeneratedLegacyInvitation: 200,
                crossDomainInvitation: 403,
                canonicalDomainInvitation: 200,
            });

            await Promise.all(blockedTargets.map(async (target) => {
                await agent.get(`/d/system/domain/group/${target._id}/invitation`).expect(404);
                await agent.post(`/d/system/domain/group/${target._id}/invitation`)
                    .send({ operation: 'create', expire: 3 })
                    .expect(404);

                const [tokenId] = await TokenModel.add(TokenModel.TYPE_GROUP_INVITATION, 3600, {
                    domainId: 'system',
                    groupId: target._id,
                });
                await agent.get(`/d/system/domain/group/join?token=${tokenId}`).expect(403);
                if (target._id.equals(archivedClassId)) {
                    const conflictingCode = `conflicting-${suffix}`;
                    await UserModel.collGroup.updateOne(
                        { _id: target._id },
                        { $set: { invitationCode: conflictingCode, invitationTokenId: tokenId } },
                    );
                    await agent.post(`/d/system/domain/group/join?code=${conflictingCode}`)
                        .send({ token: alternateTokenId })
                        .expect(403)
                        .expect(/Group Invitation/);
                } else {
                    await agent.post('/d/system/domain/group/join')
                        .send({ token: tokenId })
                        .expect(403);
                }
            }));

            const invitations = await Promise.all(targets.map(async (target) => {
                await agent.post(`/d/system/domain/group/${target._id}/invitation`)
                    .send({ operation: 'create', expire: 3 })
                    .expect(302);
                const invitation = await TokenModel.getMulti(TokenModel.TYPE_GROUP_INVITATION, {
                    domainId: 'system',
                    groupId: target._id,
                }).sort({ updateAt: -1 }).limit(1).next();
                assert(invitation);
                const invitedGroup = await UserModel.collGroup.findOne({ _id: target._id });
                assert.equal(invitedGroup?.invitationTokenId, invitation._id);

                await agent.get(`/d/system/domain/group/${target._id}/invitation`)
                    .expect(200)
                    .expect((res) => assert(res.text.includes(invitation._id)));
                return invitation;
            }));

            const systemDomain = await DomainModel.get('system');
            assert(systemDomain);
            const originalHost = systemDomain.host;
            systemDomain.host = ['invite.example.test'];
            try {
                await agent.get(`/d/system/domain/group/${groupId}/invitation`)
                    .expect(200)
                    .expect((res) => {
                        assert.match(
                            res.text,
                            new RegExp(`https?://invite\\.example\\.test/d/system/domain/group/join\\?token=${invitations[0]._id}`),
                        );
                    });
            } finally {
                systemDomain.host = originalHost;
            }

            const editClass = (archive: boolean, name = className, status = 302) => agent
                .post(`/d/system/domain/class/${classId}/edit`)
                .send(classUpdatePayload({ archive, name }))
                .expect(status);

            await editClass(false);
            let editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert(editedClass);
            assert.equal(editedClass.invitationTokenId, invitations[1]._id);
            await agent.get(`/d/system/domain/group/join?token=${invitations[1]._id}`).expect(200);

            await UserModel.collGroup.updateOne(
                { _id: classId },
                { $set: { invitationCode: `archive${suffix}` } },
            );
            await editClass(true);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert(editedClass?.archive);
            assert.equal(editedClass.invitationTokenId, null);
            assert.equal(editedClass.invitationCode, null);
            await agent.get(`/d/system/domain/group/join?token=${invitations[1]._id}`).expect(403);

            await editClass(false);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(editedClass?.archive, false);
            assert.equal(editedClass?.invitationTokenId, null);
            await agent.get(`/d/system/domain/group/join?token=${invitations[1]._id}`).expect(403);

            await agent.post(`/d/system/domain/group/${classId}/invitation`)
                .send({ operation: 'create', expire: 3 })
                .expect(302);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert(editedClass?.invitationTokenId);
            const regeneratedClassInvitation = await TokenModel.get(
                editedClass.invitationTokenId, TokenModel.TYPE_GROUP_INVITATION,
            );
            assert(regeneratedClassInvitation);
            invitations[1] = regeneratedClassInvitation;

            const invitationBeforeLockedMutation = editedClass.invitationTokenId;
            const invitationIdsBeforeLockedMutation = new Set((await TokenModel.getMulti(
                TokenModel.TYPE_GROUP_INVITATION,
                { domainId: 'system', groupId: classId },
            ).toArray()).map((invitation: any) => invitation._id));
            const invitationLockToken = new ObjectId().toHexString();
            const invitationLock = await ClassModel.acquireEditLock(
                'system', classId, className, invitationLockToken,
            );
            assert.equal(invitationLock.matchedCount, 1);
            try {
                await agent.post(`/d/system/domain/group/${classId}/invitation`)
                    .send({ operation: 'create', expire: 3 })
                    .expect(400);
                await agent.post(`/d/system/domain/group/${classId}/invitation`)
                    .send({ operation: 'revoke' })
                    .expect(400);
            } finally {
                await ClassModel.releaseEditLock('system', classId, invitationLockToken);
            }
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(editedClass?.invitationTokenId, invitationBeforeLockedMutation);
            const invitationIdsAfterLockedMutation = (await TokenModel.getMulti(
                TokenModel.TYPE_GROUP_INVITATION,
                { domainId: 'system', groupId: classId },
            ).toArray()).map((invitation: any) => invitation._id);
            assert(invitationIdsAfterLockedMutation.every(
                (invitationId: string) => invitationIdsBeforeLockedMutation.has(invitationId),
            ));

            collisionCourseId = await ContestModel.add(
                'system',
                `Invitation rename collision ${suffix}`,
                '',
                2,
                'course',
                new Date(),
                new Date(Date.now() + 86400000),
            );
            await ContestModel.edit('system', collisionCourseId, { assign: [className, '999999'] });
            await editClass(false, groupName, 403);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(editedClass?.name, className);
            assert.equal(editedClass?.invitationTokenId, invitations[1]._id);
            const courseAfterRejectedCollision = await ContestModel.get('system', collisionCourseId);
            assert.deepStrictEqual(courseAfterRejectedCollision.assign, [className, '999999']);

            await agent.post(`/d/system/domain/class/${teachersClassId}/edit`)
                .send({ operation: 'delete' })
                .expect(404);
            assert(await UserModel.collGroup.findOne({ _id: teachersClassId }));
            await UserModel.collGroup.deleteOne({ _id: teachersClassId });
            await UserModel.collGroup.insertOne({
                _id: regularTeachersGroupId,
                domainId: 'system',
                name: 'teachers',
                uids: [2],
            });
            await agent.post('/d/system/course/create?isTemplate=true')
                .send({
                    title: templateTitle,
                    content: 'Template content',
                    dag: JSON.stringify([{ _id: 1, title: 'Lesson', pids: [], requireNids: [] }]),
                    beginAt: '2026-7-26 0:00',
                    endAt: '2026-7-27 23:59',
                    lessonDurationHours: 2,
                    lessonBeginAt: '2026-7-26 0:00',
                    lessonEndAt: '2026-7-26 2:00',
                    isTemplate: true,
                    templateCategory: '',
                    assign: '',
                    extraStudents: '',
                    publicScoreboard: true,
                    enablePenalty: true,
                })
                .expect(400);
            const regularTeachersGroup = await UserModel.collGroup.findOne({ _id: regularTeachersGroupId });
            assert(regularTeachersGroup);
            assert.equal(regularTeachersGroup.class, undefined);
            assert.equal(
                (await ContestModel.getMulti('system', { rule: 'course', title: templateTitle }).toArray()).length,
                0,
            );
            await UserModel.collGroup.deleteOne({ _id: regularTeachersGroupId });
            await editClass(false, 'teachers', 403);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(editedClass?.name, className);
            assert.equal(editedClass?.invitationTokenId, invitations[1]._id);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [className, '999999'],
            );
            await agent.post('/d/system/domain/class/create')
                .send(classUpdatePayload({ name: 'teachers' }))
                .expect(403);
            assert.equal(await UserModel.collGroup.findOne({ domainId: 'system', name: 'teachers' }), null);
            await Promise.all(invalidClassNames.map((invalidName) => agent
                .post('/d/system/domain/class/create')
                .send(classUpdatePayload({ name: invalidName }))
                .expect(403)));
            assert.equal(await UserModel.collGroup.countDocuments({
                domainId: 'system', name: { $in: invalidClassNames },
            }), 0);

            const renameGroupForCollision = ClassModel.renameGroup;
            const concurrentGroupId = new ObjectId();
            let concurrentGroupInserted = false;
            (ClassModel as any).renameGroup = async (...args: any[]) => {
                if (!concurrentGroupInserted && args[3] === conflictingRenameName) {
                    concurrentGroupInserted = true;
                    await UserModel.collGroup.insertOne({
                        _id: concurrentGroupId,
                        domainId: 'system',
                        name: conflictingRenameName,
                        uids: [],
                    });
                }
                return (renameGroupForCollision as any)(...args);
            };
            try {
                await editClass(false, conflictingRenameName, 403);
            } finally {
                (ClassModel as any).renameGroup = renameGroupForCollision;
                await UserModel.collGroup.deleteOne({ _id: concurrentGroupId });
            }
            assert(concurrentGroupInserted);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(editedClass?.name, className);
            assert.equal(editedClass?.classEditLock, undefined);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [className, '999999'],
            );

            let rejectCourseRename = true;
            const disposeRenameFailure = global.app.on('contest/before-edit', (tdoc: any, $set: any) => {
                if (rejectCourseRename
                    && tdoc.docId.equals(collisionCourseId)
                    && $set.assign?.includes(renamedClassName)) {
                    rejectCourseRename = false;
                    throw new Error('Injected class rename failure');
                }
            });
            try {
                await editClass(false, renamedClassName, 500);
            } finally {
                disposeRenameFailure();
            }
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(editedClass?.name, className);
            assert.equal(editedClass?.invitationTokenId, invitations[1]._id);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [className, '999999'],
            );

            let rejectAfterCourseRename = true;
            const disposePostRenameFailure = global.app.on('contest/edit', (tdoc: any) => {
                if (rejectAfterCourseRename
                    && tdoc.docId.equals(collisionCourseId)
                    && tdoc.assign?.includes(renamedClassName)) {
                    rejectAfterCourseRename = false;
                    throw new Error('Injected failure after class course rename');
                }
            });
            try {
                await editClass(false, renamedClassName, 500);
            } finally {
                disposePostRenameFailure();
            }
            assert.equal(rejectAfterCourseRename, false);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(editedClass?.name, className);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [className, '999999'],
            );

            const originalUpdateGroup = ClassModel.updateGroup;
            const originalRenameGroup = ClassModel.renameGroup;
            let rollbackRenameInterleaved = false;
            (ClassModel as any).updateGroup = async (...args: any[]) => {
                if (args[0] === 'system' && args[1] === renamedClassName) {
                    throw new Error('Injected class update failure before rollback');
                }
                return (originalUpdateGroup as any)(...args);
            };
            (ClassModel as any).renameGroup = async (...args: any[]) => {
                const result = await (originalRenameGroup as any)(...args);
                if (!rollbackRenameInterleaved
                    && args[0] === 'system'
                    && args[2] === renamedClassName
                    && args[3] === className
                    && result.matchedCount) {
                    rollbackRenameInterleaved = true;
                    await editClass(false, concurrentRenamedClassName, 400);
                }
                return result;
            };
            try {
                await editClass(false, renamedClassName, 500);
            } finally {
                (ClassModel as any).updateGroup = originalUpdateGroup;
                (ClassModel as any).renameGroup = originalRenameGroup;
            }
            assert(rollbackRenameInterleaved);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(editedClass?.name, className);
            assert.equal(editedClass?.classEditLock, undefined);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [className, '999999'],
            );

            await editClass(false, renamedClassName);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(editedClass?.name, renamedClassName);
            assert.equal(editedClass?.invitationTokenId, invitations[1]._id);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [renamedClassName, '999999'],
            );
            await editClass(false);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(editedClass?.name, className);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [className, '999999'],
            );

            let concurrentCourseEdit = false;
            const disposeConcurrentCourseEdit = global.app.on('contest/before-edit', async (tdoc: any, $set: any) => {
                if (!concurrentCourseEdit
                    && tdoc.docId.equals(collisionCourseId)
                    && $set.assign?.includes(renamedClassName)) {
                    concurrentCourseEdit = true;
                    await ContestModel.edit('system', collisionCourseId!, {
                        assign: [className, '999999', '888888'],
                    });
                }
            });
            try {
                await editClass(false, renamedClassName);
            } finally {
                disposeConcurrentCourseEdit();
            }
            assert(concurrentCourseEdit);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [renamedClassName, '999999', '888888'],
            );
            await editClass(false);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [className, '999999', '888888'],
            );
            await ContestModel.edit('system', collisionCourseId, { assign: [className, '999999'] });

            let propagationEditRejected = false;
            const disposePropagationEdit = global.app.on('contest/before-edit', async (tdoc: any, $set: any) => {
                if (!propagationEditRejected
                    && tdoc.docId.equals(collisionCourseId)
                    && $set.maintainer?.includes(3)) {
                    propagationEditRejected = true;
                    await agent.post(`/d/system/domain/class/${classId}/edit`)
                        .send(classUpdatePayload({ teachers: '2' }))
                        .expect(400);
                }
            });
            try {
                await editClass(false);
            } finally {
                disposePropagationEdit();
            }
            assert(propagationEditRejected);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.deepStrictEqual(editedClass?.teachers, [3]);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).maintainer,
                [3],
            );

            await ContestModel.edit('system', collisionCourseId, { maintainer: [2] });
            let propagationMovePreserved = false;
            const disposePropagationMove = global.app.on('contest/before-edit', async (tdoc: any, $set: any) => {
                if (!propagationMovePreserved
                    && tdoc.docId.equals(collisionCourseId)
                    && $set.maintainer?.includes(3)) {
                    propagationMovePreserved = true;
                    await ContestModel.edit('system', collisionCourseId!, {
                        assign: [deleteLockedClassName, '999999'],
                    });
                }
            });
            try {
                await editClass(false);
            } finally {
                disposePropagationMove();
            }
            assert(propagationMovePreserved);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [deleteLockedClassName, '999999'],
            );
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).maintainer,
                [2],
            );
            await ContestModel.edit('system', collisionCourseId, {
                assign: [className, '999999'],
                maintainer: [3],
            });

            const reassignCoursePayload = {
                title: `Invitation rename collision ${suffix}`,
                content: 'Course content',
                dag: JSON.stringify([{ _id: 1, title: 'Lesson', pids: [], requireNids: [] }]),
                beginAt: '2026-7-26 0:00',
                endAt: '2026-7-27 23:59',
                lessonDurationHours: 2,
                lessonBeginAt: '2026-7-26 0:00',
                lessonEndAt: '2026-7-26 2:00',
                isTemplate: false,
                templateCategory: '',
                assign: deleteLockedClassName,
                extraStudents: '999999',
                publicScoreboard: true,
                enablePenalty: true,
            };
            unassignedEditRaceCourseId = await ContestModel.add(
                'system',
                `Unassigned edit race course ${suffix}`,
                '',
                2,
                'course',
                new Date(),
                new Date(Date.now() + 86400000),
                [],
                false,
                { assign: [] },
            );
            const editRaceDocumentModel = global.Hydro.model.document;
            const findOneAndUpdateBeforeAssignmentChange = editRaceDocumentModel.coll.findOneAndUpdate
                .bind(editRaceDocumentModel.coll);
            let assignmentChangedDuringUnassignedEdit = false;
            editRaceDocumentModel.coll.findOneAndUpdate = async (...args: any[]) => {
                if (!assignmentChangedDuringUnassignedEdit
                    && args[0]?.docId instanceof ObjectId
                    && args[0].docId.equals(unassignedEditRaceCourseId)) {
                    assignmentChangedDuringUnassignedEdit = true;
                    await ContestModel.edit('system', unassignedEditRaceCourseId!, {
                        assign: [deleteLockedClassName],
                    });
                }
                return findOneAndUpdateBeforeAssignmentChange(...args);
            };
            try {
                await agent.post(`/d/system/course/${unassignedEditRaceCourseId}/edit`)
                    .send({ ...reassignCoursePayload, assign: className })
                    .expect(400);
            } finally {
                editRaceDocumentModel.coll.findOneAndUpdate = findOneAndUpdateBeforeAssignmentChange;
            }
            assert(assignmentChangedDuringUnassignedEdit);
            assert.deepStrictEqual(
                (await ContestModel.get('system', unassignedEditRaceCourseId)).assign,
                [deleteLockedClassName],
            );
            const acquireBeforeStaleCourseEdit = ClassModel.acquireEditLock;
            let courseAssignmentChangedBeforeLock = false;
            (ClassModel as any).acquireEditLock = async (...args: any[]) => {
                if (!courseAssignmentChangedBeforeLock && args[2] === className) {
                    courseAssignmentChangedBeforeLock = true;
                    await ContestModel.edit('system', collisionCourseId!, {
                        assign: [deleteLockedClassName, '999999'],
                    });
                }
                return acquireBeforeStaleCourseEdit(...args);
            };
            try {
                await agent.post(`/d/system/course/${collisionCourseId}/edit`)
                    .send({ ...reassignCoursePayload, assign: className })
                    .expect(400);
            } finally {
                (ClassModel as any).acquireEditLock = acquireBeforeStaleCourseEdit;
            }
            assert(courseAssignmentChangedBeforeLock);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [deleteLockedClassName, '999999'],
            );
            await ContestModel.edit('system', collisionCourseId, { assign: [className, '999999'] });
            const sourceLockToken = new ObjectId().toHexString();
            const sourceLock = await ClassModel.acquireEditLock(
                'system', classId, className, sourceLockToken,
            );
            assert.equal(sourceLock.matchedCount, 1);
            try {
                await agent.post(`/d/system/course/${collisionCourseId}/edit`)
                    .send(reassignCoursePayload)
                    .expect(400);
                await agent.post(`/d/system/course/${collisionCourseId}/edit`)
                    .send({ ...reassignCoursePayload, operation: 'delete', assign: className })
                    .expect(400);
            } finally {
                await ClassModel.releaseEditLock('system', classId, sourceLockToken);
            }
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [className, '999999'],
            );
            await agent.post(`/d/system/course/${collisionCourseId}/edit`)
                .send(reassignCoursePayload)
                .expect(302);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [deleteLockedClassName, '999999'],
            );
            await agent.post(`/d/system/course/${collisionCourseId}/edit`)
                .send({
                    ...reassignCoursePayload,
                    assign: className,
                    dagRevision: (await ContestModel.get('system', collisionCourseId)).dagRevision,
                })
                .expect(302);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [className, '999999'],
            );

            deleteConditionalCourseId = await ContestModel.add(
                'system',
                `Conditional delete course ${suffix}`,
                '',
                2,
                'course',
                new Date(),
                new Date(Date.now() + 86400000),
                [],
                false,
                { assign: [deleteLockedClassName] },
            );
            await ContestModel.edit('system', deleteConditionalCourseId, { assign: [className] });
            assert.equal(
                await ContestModel.delIfAssigned('system', deleteConditionalCourseId, deleteLockedClassName),
                false,
            );
            assert(await ContestModel.get('system', deleteConditionalCourseId));
            let deleteTriggeredEdit = false;
            const disposeDeleteEdit = global.app.on('contest/before-edit', (tdoc: any) => {
                if (tdoc.docId.equals(deleteConditionalCourseId)) deleteTriggeredEdit = true;
            });
            try {
                await agent.post(`/d/system/course/${deleteConditionalCourseId}/edit`)
                    .send({ ...reassignCoursePayload, operation: 'delete', assign: className })
                    .expect(302);
            } finally {
                disposeDeleteEdit();
            }
            assert.equal(deleteTriggeredEdit, false);
            await assert.rejects(ContestModel.get('system', deleteConditionalCourseId));
            deleteConditionalCourseId = undefined;

            assignmentRaceCourseId = await ContestModel.add(
                'system',
                `Assignment race course ${suffix}`,
                '',
                2,
                'course',
                new Date(),
                new Date(Date.now() + 86400000),
                [],
                false,
                { assign: [] },
            );
            const DocumentModel = global.Hydro.model.document;
            const deleteOneBeforeAssignmentChange = DocumentModel.coll.deleteOne.bind(DocumentModel.coll);
            let assignmentChangedBeforeDelete = false;
            DocumentModel.coll.deleteOne = async (...args: any[]) => {
                if (!assignmentChangedBeforeDelete
                    && args[0]?.docId instanceof ObjectId
                    && args[0].docId.equals(assignmentRaceCourseId)) {
                    assignmentChangedBeforeDelete = true;
                    await ContestModel.edit('system', assignmentRaceCourseId!, { assign: [className] });
                }
                return deleteOneBeforeAssignmentChange(...args);
            };
            try {
                await agent.post(`/d/system/course/${assignmentRaceCourseId}/edit`)
                    .send({ ...reassignCoursePayload, operation: 'delete', assign: '' })
                    .expect(400);
            } finally {
                DocumentModel.coll.deleteOne = deleteOneBeforeAssignmentChange;
            }
            assert(assignmentChangedBeforeDelete);
            assert.deepStrictEqual(
                (await ContestModel.get('system', assignmentRaceCourseId)).assign,
                [className],
            );

            lockedTemplateCourseId = await ContestModel.add(
                'system',
                lockedCopyTitle,
                '',
                2,
                'course',
                new Date(),
                new Date(Date.now() + 86400000),
                [],
                false,
                {
                    assign: ['teachers'],
                    dag: [],
                },
            );

            const deleteLockToken = new ObjectId().toHexString();
            const deleteLock = await ClassModel.acquireEditLock(
                'system', deleteLockedClassId, deleteLockedClassName, deleteLockToken,
            );
            assert.equal(deleteLock.matchedCount, 1);
            try {
                await agent.post('/d/system/course/create')
                    .send({
                        title: lockedCourseTitle,
                        content: 'Locked course content',
                        dag: JSON.stringify([{ _id: 1, title: 'Lesson', pids: [], requireNids: [] }]),
                        beginAt: '2026-7-26 0:00',
                        endAt: '2026-7-27 23:59',
                        lessonDurationHours: 2,
                        lessonBeginAt: '2026-7-26 0:00',
                        lessonEndAt: '2026-7-26 2:00',
                        isTemplate: false,
                        templateCategory: '',
                        assign: deleteLockedClassName,
                        extraStudents: '',
                        publicScoreboard: true,
                        enablePenalty: true,
                    })
                    .expect(400);
                await agent.post(`/d/system/domain/class/${deleteLockedClassId}/edit`)
                    .send({ operation: 'copy', template: `system:${lockedTemplateCourseId}` })
                    .expect(400);
                await agent.post(`/d/system/domain/class/${deleteLockedClassId}/edit`)
                    .send({ operation: 'delete' })
                    .expect(400);
            } finally {
                await ClassModel.releaseEditLock('system', deleteLockedClassId, deleteLockToken);
            }
            assert(await UserModel.collGroup.findOne({ _id: deleteLockedClassId }));
            assert.equal(
                (await ContestModel.getMulti('system', {
                    rule: 'course',
                    title: { $in: [lockedCourseTitle, lockedCopyTitle] },
                    assign: deleteLockedClassName,
                }).toArray()).length,
                0,
            );

            const staleRename = await ClassModel.updateGroup(
                'system', `stale-rename-${suffix}`, [3], [4],
                editedClass.beginAt, editedClass.endAt, false, 1,
                classId, false, `outdated-name-${suffix}`,
            );
            assert.equal(staleRename.matchedCount, 0);
            assert.equal((await UserModel.collGroup.findOne({ _id: classId }))?.name, className);
            const deletedClassUpdate = await ClassModel.updateGroup(
                'system', `deleted-class-${suffix}`, [3], [4],
                new Date(), new Date(Date.now() + 86400000), false, 1,
                deletedClassId, false, `deleted-class-${suffix}`,
            );
            assert.equal(deletedClassUpdate.matchedCount, 0);
            assert.equal(deletedClassUpdate.upsertedCount, 0);
            assert.equal(await UserModel.collGroup.findOne({ _id: deletedClassId }), null);

            await Promise.all([3, 24].map((expire) => agent.post(`/d/system/domain/group/${groupId}/invitation`)
                .send({ operation: 'create', expire })
                .expect(302)));
            const concurrentlyUpdatedGroup = await UserModel.collGroup.findOne({ _id: groupId });
            assert(concurrentlyUpdatedGroup?.invitationTokenId);
            const groupInvitations = await TokenModel.getMulti(TokenModel.TYPE_GROUP_INVITATION, {
                domainId: 'system',
                groupId,
            }).toArray();
            const activeGroupInvitation = groupInvitations.find(
                (invitation) => invitation._id === concurrentlyUpdatedGroup.invitationTokenId,
            );
            assert(activeGroupInvitation);
            const staleGroupInvitations = groupInvitations.filter(
                (invitation) => invitation._id !== activeGroupInvitation._id,
            );
            assert(staleGroupInvitations.length >= 2);
            await Promise.all(staleGroupInvitations.map((invitation) => agent
                .get(`/d/system/domain/group/join?token=${invitation._id}`)
                .expect(403)));
            invitations[0] = activeGroupInvitation;

            await agent.post(`/d/system/domain/group/${groupId}/invitation`)
                .send({ operation: 'revoke' })
                .expect(302);
            const revokedGroup = await UserModel.collGroup.findOne({ _id: groupId });
            assert.equal(revokedGroup?.invitationTokenId, null);
            assert(await TokenModel.get(activeGroupInvitation._id, TokenModel.TYPE_GROUP_INVITATION));
            await agent.get(`/d/system/domain/group/join?token=${activeGroupInvitation._id}`).expect(403);

            await agent.post(`/d/system/domain/group/${groupId}/invitation`)
                .send({ operation: 'create', expire: 3 })
                .expect(302);
            const groupAfterRecreate = await UserModel.collGroup.findOne({ _id: groupId });
            assert(groupAfterRecreate?.invitationTokenId);
            const invitationAfterRecreate = await TokenModel.get(
                groupAfterRecreate.invitationTokenId, TokenModel.TYPE_GROUP_INVITATION,
            );
            assert(invitationAfterRecreate);
            assert.notEqual(invitationAfterRecreate._id, activeGroupInvitation._id);
            await agent.get(`/d/system/domain/group/join?token=${activeGroupInvitation._id}`).expect(403);
            invitations[0] = invitationAfterRecreate;

            await DomainModel.setUserInDomain('system', 2, { join: false, role: 'default' });
            const findOneBeforeTeacherChange = UserModel.collGroup.findOne.bind(UserModel.collGroup);
            let teacherChangedBetweenJoinReadAndWrite = false;
            UserModel.collGroup.findOne = async (...args: any[]) => {
                const result = await findOneBeforeTeacherChange(...args);
                if (!teacherChangedBetweenJoinReadAndWrite
                    && result?._id?.equals(classId)
                    && args[0]?.invitationTokenId === invitations[1]._id) {
                    teacherChangedBetweenJoinReadAndWrite = true;
                    const staleJoinLockToken = new ObjectId().toHexString();
                    const staleJoinLock = await ClassModel.acquireEditLock(
                        'system', classId, className, staleJoinLockToken,
                    );
                    assert.equal(staleJoinLock.matchedCount, 1);
                    await UserModel.collGroup.updateOne(
                        { _id: classId },
                        { $addToSet: { teachers: 2, uids: 2 }, $pull: { students: 2 } },
                    );
                    await ClassModel.releaseEditLock('system', classId, staleJoinLockToken);
                }
                return result;
            };
            try {
                assert.equal(
                    await UserModel.addUserToGroup('system', classId, 2, invitations[1]._id),
                    null,
                );
            } finally {
                UserModel.collGroup.findOne = findOneBeforeTeacherChange;
            }
            assert(teacherChangedBetweenJoinReadAndWrite);
            const classAfterStaleJoin = await UserModel.collGroup.findOne({ _id: classId });
            assert(classAfterStaleJoin?.teachers.includes(2));
            assert(!classAfterStaleJoin?.students.includes(2));
            await UserModel.collGroup.updateOne(
                { _id: classId },
                { $pull: { teachers: 2, uids: 2 } },
            );
            const joinLockToken = new ObjectId().toHexString();
            const joinLock = await ClassModel.acquireEditLock(
                'system', classId, className, joinLockToken,
            );
            assert.equal(joinLock.matchedCount, 1);
            try {
                await agent.post('/d/system/domain/group/join')
                    .send({ token: invitations[1]._id })
                    .expect(403);
            } finally {
                await ClassModel.releaseEditLock('system', classId, joinLockToken);
            }
            const classAfterLockedJoin = await UserModel.collGroup.findOne({ _id: classId });
            assert(!classAfterLockedJoin?.uids.includes(2));
            assert(!classAfterLockedJoin?.students.includes(2));
            assert.equal(
                (await DomainModel.collUser.findOne({ domainId: 'system', uid: 2 }))?.join,
                false,
            );
            await db.collection('opcount').deleteMany({ op: 'global' });
            await Promise.all(invitations.map(async (invitation) => {
                await agent.get(`/d/system/domain/group/join?token=${invitation._id}`).expect(200);
                await agent.post('/d/system/domain/group/join')
                    .send({ token: invitation._id })
                    .expect(302);
            }));

            const group = await UserModel.collGroup.findOne({ _id: groupId });
            assert.deepStrictEqual(group?.uids, [2]);
            const courseClass = await UserModel.collGroup.findOne({ _id: classId }) as any;
            assert.deepStrictEqual(courseClass?.uids, [3, 4, 2]);
            assert.deepStrictEqual(courseClass?.teachers, [3]);
            assert.deepStrictEqual(courseClass?.students, [4, 2]);
            const domainUser = await DomainModel.collUser.findOne({ domainId: 'system', uid: 2 });
            assert.equal(domainUser?.join, true);
            assert.equal(domainUser?.role, 'default');

            await TokenModel.coll.updateOne(
                { _id: invitations[1]._id },
                { $set: { expireAt: new Date(0) } },
            );
            await agent.get(`/d/system/domain/group/join?token=${invitations[1]._id}`)
                .expect(403)
                .expect(/Group Invitation/);
        } finally {
            if (importedUser) UserModel._deleteUserCache(importedUser);
            await Promise.all([
                UserModel.collGroup.deleteMany({
                    $or: [
                        {
                            _id: {
                                $in: [
                                    groupId, classId, teachersClassId, archivedClassId, deletedClassId,
                                    deleteLockedClassId, regularTeachersGroupId, legacyGroupId, alternateGroupId,
                                ],
                            },
                        },
                        { domainId: 'system', name: creatorManagedClassName },
                        { domainId: 'system', name: unauthorizedClassName },
                        { domainId: 'system', name: { $in: invalidClassNames } },
                    ],
                }),
                TokenModel.coll.deleteMany({
                    tokenType: TokenModel.TYPE_GROUP_INVITATION,
                    groupId: {
                        $in: [
                            groupId, classId, teachersClassId, archivedClassId,
                            legacyGroupId, alternateGroupId,
                        ],
                    },
                }),
                UserModel.coll.deleteOne({ mailLower: importedEmail.toLowerCase() }),
                ...(importedUser ? [DomainModel.collUser.deleteOne({
                    domainId: 'system', uid: importedUser._id,
                })] : []),
                DomainModel.del(alternateDomainId),
                ...(collisionCourseId ? [ContestModel.del('system', collisionCourseId)] : []),
                ...(unassignedEditRaceCourseId ? [ContestModel.del('system', unassignedEditRaceCourseId)] : []),
                ...(deleteConditionalCourseId ? [ContestModel.del('system', deleteConditionalCourseId)] : []),
                ...(assignmentRaceCourseId ? [ContestModel.del('system', assignmentRaceCourseId)] : []),
                ...(lockedTemplateCourseId ? [ContestModel.del('system', lockedTemplateCourseId)] : []),
            ]);
            await Promise.all([
                DomainModel.setUserRole('system', 2, 'default', true),
                DomainModel.deleteRoles('system', [creatorRole]),
            ]);
        }
    });

    // TODO add more tests

    const results: Record<string, autocannon.Result> = {};
    if (process.env.BENCHMARK) {
        for (const route of routes) {
            it(`Performance test ${route}`, { timeout: 60000 }, async () => {
                const result = await autocannon({ url: `http://localhost:8888${route}` });
                assert(result.errors === 0, `test ${route} returns errors`);
                results[route] = result;
            });
        }
    }

    after(async () => {
        if (process.env.BENCHMARK) {
            const metrics = Object.entries(results).map(([k, v]) => ({
                name: `Benchmark - ${k} - Req/sec`,
                unit: 'Req/sec',
                value: v.requests.average,
            }));
            writeFileSync('./benchmark.json', JSON.stringify(metrics, null, 2));
        }
        // Let fire-and-forget cache broadcasts from test cleanup finish before
        // closing the shared database, as the old delayed exit did.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await global.app.parallel('app/exit');
        await global.app.root.fiber.dispose();
        await require('./entry').stopMongoInstances();
        process.stdin.pause();
    });
});
