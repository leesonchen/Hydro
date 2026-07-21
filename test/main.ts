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
        const groupName = `invite-group-${suffix}`;
        const className = `invite-class-${suffix}`;
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

        await Promise.all([
            UserModel.collGroup.insertMany(targets as any),
            DomainModel.setUserRole('system', 2, 'root', true),
        ]);
        try {
            await agent.get('/d/system/domain/group').expect(200);
            await agent.get('/d/system/domain/class').expect(200);
            await agent.post(`/d/system/domain/group/${groupId}/invitation`)
                .send({ operation: 'create', expire: 0 })
                .expect(403);

            const invitations = await Promise.all(targets.map(async (target) => {
                await agent.post(`/d/system/domain/group/${target._id}/invitation`)
                    .send({ operation: 'create', expire: 3 })
                    .expect(302);
                const invitation = await TokenModel.getMulti(TokenModel.TYPE_GROUP_INVITATION, {
                    domainId: 'system',
                    groupId: target._id,
                }).sort({ updateAt: -1 }).limit(1).next();
                assert(invitation);

                await agent.get(`/d/system/domain/group/${target._id}/invitation`)
                    .expect(200)
                    .expect((res) => assert(res.text.includes(invitation._id)));
                return invitation;
            }));

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
            assert.deepStrictEqual(courseClass?.uids, [2]);
            assert.deepStrictEqual(courseClass?.students, [2]);
            const domainUser = await DomainModel.collUser.findOne({ domainId: 'system', uid: 2 });
            assert.equal(domainUser?.join, true);
            assert.equal(domainUser?.role, 'default');

            const classInvitation = await TokenModel.getMulti(TokenModel.TYPE_GROUP_INVITATION, {
                groupId: classId,
            }).limit(1).next();
            assert(classInvitation);
            await TokenModel.coll.updateOne(
                { _id: classInvitation._id },
                { $set: { expireAt: new Date(0) } },
            );
            await agent.get(`/d/system/domain/group/join?token=${classInvitation._id}`).expect(403);
        } finally {
            await Promise.all([
                UserModel.collGroup.deleteMany({ _id: { $in: [groupId, classId] } }),
                TokenModel.coll.deleteMany({
                    tokenType: TokenModel.TYPE_GROUP_INVITATION,
                    groupId: { $in: [groupId, classId] },
                }),
                DomainModel.setUserRole('system', 2, 'default', true),
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
