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
        const regularTeachersGroupId = new ObjectId();
        const legacyGroupId = new ObjectId();
        const alternateGroupId = new ObjectId();
        const groupName = `invite-group-${suffix}`;
        const className = `invite-class-${suffix}`;
        const renamedClassName = `renamed-invite-class-${suffix}`;
        const concurrentRenamedClassName = `concurrent-renamed-class-${suffix}`;
        const creatorManagedClassName = `creator-managed-invite-class-${suffix}`;
        const unauthorizedClassName = `unauthorized-invite-class-${suffix}`;
        const importedUsername = `classimport${suffix}`;
        const importedEmail = `${importedUsername}@example.com`;
        const templateTitle = `Conflicting teachers template ${suffix}`;
        const invalidClassNames = [Date.now().toString(), `invalid,class-${suffix}`];
        const creatorRole = `invite-class-creator-${suffix}`;
        const alternateDomainId = `invite-${suffix}`;
        let collisionCourseId: ObjectId | undefined;
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
            const importedUser = await UserModel.getByEmail('system', importedEmail);
            assert(importedUser);
            assert.deepStrictEqual((await UserModel.collGroup.findOne({ _id: classId }))?.uids, [2]);
            await UserModel.coll.deleteOne({ _id: importedUser._id });
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

            const originalUpdateGroup = ClassModel.updateGroup;
            let interleavedRename = false;
            (ClassModel as any).updateGroup = async (...args: any[]) => {
                if (!interleavedRename && args[0] === 'system' && args[1] === renamedClassName) {
                    interleavedRename = true;
                    await editClass(false, concurrentRenamedClassName);
                    throw new Error('Injected class update failure after a later rename');
                }
                return (originalUpdateGroup as any)(...args);
            };
            try {
                await editClass(false, renamedClassName, 500);
            } finally {
                (ClassModel as any).updateGroup = originalUpdateGroup;
            }
            assert(interleavedRename);
            editedClass = await UserModel.collGroup.findOne({ _id: classId });
            assert.equal(editedClass?.name, concurrentRenamedClassName);
            assert.deepStrictEqual(
                (await ContestModel.get('system', collisionCourseId)).assign,
                [concurrentRenamedClassName, '999999'],
            );
            await editClass(false, className);

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
            await Promise.all([
                UserModel.collGroup.deleteMany({
                    $or: [
                        {
                            _id: {
                                $in: [
                                    groupId, classId, teachersClassId, archivedClassId, deletedClassId,
                                    regularTeachersGroupId, legacyGroupId, alternateGroupId,
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
                DomainModel.del(alternateDomainId),
                ...(collisionCourseId ? [ContestModel.del('system', collisionCourseId)] : []),
            ]);
            await Promise.all([
                DomainModel.setUserRole('system', 2, 'default', true),
                DomainModel.deleteRoles('system', [creatorRole]),
            ]);
        }
    });

    it('API registered user', async () => {
        await agent.get('/api/user?args={"id":2}&projection=uname').expect({ uname: 'root' });
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
