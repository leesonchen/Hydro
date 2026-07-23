import assert from 'assert';
import { writeFileSync } from 'fs';
import autocannon from 'autocannon';
import { ObjectId } from 'mongodb';
import {
    after, before, describe, it,
} from 'node:test';
import * as supertest from 'supertest';

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
        const suffix = Date.now().toString(36);
        const groupId = new ObjectId();
        const classId = new ObjectId();
        const teachersClassId = new ObjectId();
        const archivedClassId = new ObjectId();
        const legacyGroupId = new ObjectId();
        const alternateGroupId = new ObjectId();
        const groupName = `invite-group-${suffix}`;
        const className = `invite-class-${suffix}`;
        const alternateDomainId = `invite-${suffix}`;
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

        await DomainModel.add(alternateDomainId, 2, `Invitation Test ${suffix}`, '');
        await Promise.all([
            UserModel.collGroup.insertMany([
                ...targets, ...blockedTargets, legacyGroup, alternateGroup,
            ] as any),
            DomainModel.setUserRole('system', 2, 'root', true),
        ]);
        try {
            await agent.get('/d/system/domain/group').expect(200);
            await agent.get('/d/system/domain/class')
                .expect(200)
                .expect((res) => {
                    assert(res.text.includes(archivedClassId.toHexString()));
                    assert(!res.text.includes(`/d/system/domain/group/${archivedClassId}/invitation`));
                });
            await agent.post(`/d/system/domain/group/${groupId}/invitation`)
                .send({ operation: 'create', expire: 0 })
                .expect(403);

            await DomainModel.setUserRole('system', 2, 'default', true);
            const unauthorizedClassInvitation = await agent
                .get(`/d/system/domain/group/${classId}/invitation`);
            await UserModel.collGroup.updateOne(
                { _id: classId },
                { $addToSet: { teachers: 2 } },
            );
            const teacherClassInvitation = await agent
                .get(`/d/system/domain/group/${classId}/invitation`);
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
            const staleLegacyInvitation = await agent
                .get(`/d/system/domain/group/join?token=${legacyOldTokenId}`);
            const activeLegacyInvitation = await agent
                .post('/d/system/domain/group/join')
                .send({ token: legacyLatestTokenId });
            const migratedLegacyGroup = await UserModel.collGroup.findOne({ _id: legacyGroupId });

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
                staleLegacyInvitation: staleLegacyInvitation.status,
                activeLegacyInvitation: activeLegacyInvitation.status,
                activeLegacyPointer: migratedLegacyGroup?.invitationTokenId,
                crossDomainInvitation: crossDomainInvitation.status,
                canonicalDomainInvitation: canonicalDomainInvitation.status,
            }, {
                unauthorizedClassInvitation: 403,
                teacherClassInvitation: 200,
                staleLegacyInvitation: 403,
                activeLegacyInvitation: 302,
                activeLegacyPointer: legacyLatestTokenId,
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

            const editClass = (archive: boolean) => agent.post(`/d/system/domain/class/${classId}/edit`)
                .send({
                    operation: 'update',
                    name: className,
                    teachers: '3',
                    students: '4',
                    teacherGroups: '',
                    studentGroups: '',
                    beginAtDate: '2026-7-23',
                    beginAtTime: '0:00',
                    EndAtDate: '2026-7-24',
                    EndAtTime: '23:59',
                    intervalDays: 1,
                    archive,
                })
                .expect(302);

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
                    _id: {
                        $in: [
                            groupId, classId, teachersClassId, archivedClassId,
                            legacyGroupId, alternateGroupId,
                        ],
                    },
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
                DomainModel.setUserRole('system', 2, 'default', true),
                DomainModel.del(alternateDomainId),
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
