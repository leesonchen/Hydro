import assert from 'assert';
import { writeFileSync } from 'fs';
import autocannon from 'autocannon';
import { ObjectId } from 'mongodb';
import {
    after, before, describe, it,
} from 'node:test';
import * as supertest from 'supertest';
import { PERM } from '@hydrooj/common';

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
        Root.creditionals = cookie;
    });

    it('API registered user', async () => {
        await agent.get('/api/user?args={"id":2}&projection=uname').expect({ uname: 'root' });
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

    it('Join groups and classes with expiring invitation links', async () => {
        const UserModel = global.Hydro.model.user;
        const TokenModel = global.Hydro.model.token;
        const DomainModel = global.Hydro.model.domain;
        const ContestModel = global.Hydro.model.contest;
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
                await agent.post('/d/system/domain/group/join')
                    .send({ token: tokenId })
                    .expect(403);
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

            await editClass(true);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert(editedClass?.archive);
            assert.equal(editedClass.invitationTokenId, null);
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
                .send({ ...reassignCoursePayload, assign: className })
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
            await agent.get(`/d/system/domain/group/join?token=${invitations[1]._id}`).expect(403);
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

    after(() => {
        if (process.env.BENCHMARK) {
            const metrics = Object.entries(results).map(([k, v]) => ({
                name: `Benchmark - ${k} - Req/sec`,
                unit: 'Req/sec',
                value: v.requests.average,
            }));
            writeFileSync('./benchmark.json', JSON.stringify(metrics, null, 2));
        }
        setTimeout(() => process.exit(0), 1000);
    });
});
