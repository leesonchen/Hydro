const assert = require('node:assert/strict');
const { before, after, describe, it } = require('node:test');
const { randomUUID } = require('node:crypto');
const { ObjectId, BSON } = require('mongodb');
const supertest = require('supertest');
const net = require('node:net');

exports.register = () => describe('Local feedback', () => {
    let domainId;
    let courseId;
    let homeworkId;
    let pid;
    let uid;
    let extraUid;
    let teacherUid;
    let peerUid;
    let teacher;
    let peer;
    let manager;
    let student;
    let outsider;
    let repository;
    let coll;
    let origin;
    let validRid;
    let retest;
    const users = [];
    const post = (agent, path, body, source = origin) => agent.post(path).set('Origin', source).set('Accept', 'application/json').send(body);
    const get = (agent, path) => agent.get(path).set('Accept', 'application/json');
    const courseUrl = () => `/d/${domainId}/course/${courseId}/feedback`;
    const body = (patch = {}) => ({
        requestId: randomUUID(), studentUid: uid, activityType: 'course', activityId: courseId.toString(),
        pid, nodeId: 0, kind: 'GUIDED', ...patch,
    });

    before(async () => {
        const model = global.Hydro.model;
        domainId = `feedback-${Date.now().toString(36)}`;
        origin = `http://127.0.0.1:${require('hydrooj').httpServer.address().port}`;
        const login = async (label) => {
            const uname = `${domainId}-${label}`;
            const id = await model.user.create(`${uname}@example.com`, uname, 'feedback-test-password');
            users.push(id);
            const agent = supertest.agent(require('hydrooj').httpServer);
            await agent.post('/login').send({ uname, password: 'feedback-test-password' }).expect(302);
            return [id, agent];
        };
        let managerUid;
        let outsiderUid;
        [managerUid, manager] = await login('manager');
        [teacherUid, teacher] = await login('teacher');
        [peerUid, peer] = await login('peer');
        [uid, student] = await login('student');
        [extraUid] = await login('extra');
        [outsiderUid, outsider] = await login('outsider');
        await model.domain.add(domainId, managerUid, 'Feedback integration', '');
        await model.domain.edit(domainId, { enableCourse: true, classroomFeedback: true });
        const { PERM } = model.builtin;
        await model.domain.addRole(domainId, 'teacher', PERM.PERM_DEFAULT | PERM.PERM_EDIT_HOMEWORK_SELF | PERM.PERM_VIEW_RECORD);
        await model.domain.addRole(domainId, 'read-only', PERM.PERM_DEFAULT & ~PERM.PERM_EDIT_HOMEWORK_SELF);
        await Promise.all([teacherUid, peerUid, outsiderUid].map((id) => model.domain.setUserRole(domainId, id, 'teacher', true)));
        await Promise.all([uid, extraUid].map((id) => model.domain.setUserRole(domainId, id, 'default', true)));
        await model.user.collGroup.insertOne({
            _id: new ObjectId(), domainId, name: 'feedback-class', class: true,
            teachers: [teacherUid, peerUid], students: [uid], uids: [teacherUid, peerUid, uid], archive: false,
        });
        pid = await model.problem.add(domainId, '', 'Feedback problem', 'Test', managerUid);
        const begin = new Date(Date.now() - 60000);
        const end = new Date(Date.now() + 3600000);
        courseId = await model.contest.add(domainId, 'Feedback course', '', teacherUid, 'course', begin, end, [pid], false, {
            assign: ['feedback-class', String(extraUid)], dag: [{ _id: 0, title: 'Lesson', pids: [pid], requireNids: [] }],
        });
        homeworkId = await model.contest.add(domainId, 'Feedback homework', '', teacherUid, 'homework', begin, end, [pid], false, {
            assign: ['feedback-class'], penaltySince: end,
        });
        const feedback = require('../packages/hydrooj/src/model/classroomFeedback');
        repository = feedback.feedbackRepository;
        coll = feedback.coll;
        await repository.ensureIndexes();
        validRid = new ObjectId();
        await model.record.coll.insertOne({ _id: validRid, domainId, uid, pid, contest: courseId, code: 'int main(){}', status: 1, files: {} });
    });

    it('records all three observations and temporary students without submissions or AI-EDU configuration', async () => {
        for (const kind of ['GUIDED', 'CHECKED', 'NEEDS_RETEST']) {
            const response = await post(teacher, courseUrl(), body({ kind, note: '<script>window.feedbackXss=1</script>' })).expect(200);
            assert(response.body.eventId);
            if (kind === 'NEEDS_RETEST') retest = response.body.eventId;
        }
        await post(teacher, courseUrl(), body({ studentUid: extraUid })).expect(200);
        const response = await get(teacher, courseUrl()).expect(200);
        assert(response.headers['cache-control'].includes('no-store'));
        assert.equal(response.body.items.length, 4);
        assert.equal(response.body.items[0].requestHash, undefined);
        assert(response.body.roster.includes(extraUid));
        assert(!response.body.roster.includes(teacherUid));
        assert.equal(await global.Hydro.model.contest.getStatus(domainId, courseId, uid), null);
    });

    it('denies students, unrelated SELF teachers, wrong activity type and cross-domain access', async () => {
        await get(student, courseUrl()).expect(403);
        await post(student, courseUrl(), body()).expect(403);
        await get(outsider, courseUrl()).expect(403);
        await post(outsider, courseUrl(), body()).expect(403);
        await get(teacher, `/d/${domainId}/homework/${courseId}/feedback`).expect(404);
        await post(teacher, `/d/system/course/${courseId}/feedback`, body()).expect(403);
    });

    it('shows feedback entry only to authorized teachers on course and submission pages', async () => {
        const coursePage = `/d/${domainId}/course/${courseId}`;
        for (const agent of [teacher, peer, manager]) {
            const response = await get(agent, coursePage).expect(200);
            assert.equal(response.body.feedbackUrl, courseUrl());
        }
        for (const agent of [student, outsider]) {
            const response = await get(agent, coursePage).expect(200);
            assert.equal(response.body.feedbackUrl, null);
        }
        const recordPage = `/d/${domainId}/record/${validRid}`;
        const response = await get(teacher, recordPage).expect(200);
        assert(response.body.feedbackUrl.includes(courseUrl()));
        assert(response.body.feedbackUrl.includes(`rid=${validRid}`));
        assert.equal((await get(student, recordPage).expect(200)).body.feedbackUrl, null);
    });

    it('uses route activity and session identity, rejecting forged body and query overrides', async () => {
        for (const patch of [{ activityId: homeworkId.toString() }, { studentUid: teacherUid }, { pid: pid + 999 }, { nodeId: 77 }]) {
            const response = await post(teacher, courseUrl(), body(patch));
            assert([400, 403].includes(response.status));
        }
        for (const field of ['domainId', 'operatorUid', 'tid', 'schemaVersion']) {
            await post(teacher, courseUrl(), body({ [field]: domainId })).expect(400);
        }
        await post(outsider, `${courseUrl()}?tid=${homeworkId}&domainId=system`, body()).expect(403);
        await post(teacher, courseUrl(), body({ note: '😀'.repeat(501) })).expect(400);
    });

    it('validates optional submissions against domain, student, problem and activity', async () => {
        await post(teacher, courseUrl(), body({ rid: validRid.toString() })).expect(200);
        for (const patch of [{ uid: extraUid }, { pid: pid + 1 }, { contest: homeworkId }, { domainId: 'system' }]) {
            const rid = new ObjectId();
            await global.Hydro.model.record.coll.insertOne({ _id: rid, domainId, uid, pid, contest: courseId, ...patch });
            await post(teacher, courseUrl(), body({ rid: rid.toString() })).expect(403);
        }
        await post(teacher, courseUrl(), body({ rid: new ObjectId().toString() })).expect(403);
    });

    it('converges concurrent real MongoDB requests, reports conflicts and preserves distinct observations', async () => {
        const input = body();
        const beforeCount = await coll.countDocuments({ domainId });
        const receipts = await Promise.all(Array.from({ length: 12 }, () => post(teacher, courseUrl(), input).expect(200)));
        assert.equal(new Set(receipts.map((r) => r.body.eventId)).size, 1);
        assert.equal(await coll.countDocuments({ domainId }), beforeCount + 1);
        await post(teacher, courseUrl(), { ...input, note: 'different' }).expect(409);
        await post(teacher, courseUrl(), body()).expect(200);
        assert.equal(await coll.countDocuments({ domainId }), beforeCount + 2);
    });

    it('appends idempotent corrections, restricts retraction and keeps retest resolution separate from mastery', async () => {
        await post(peer, `${courseUrl()}/${retest}/retract`, { requestId: randomUUID() }).expect(403);
        const input = { requestId: randomUUID(), note: 'followed up', rid: validRid.toString() };
        const resolved = await post(peer, `${courseUrl()}/${retest}/resolve`, input).expect(200);
        const replay = await post(peer, `${courseUrl()}/${retest}/resolve`, input).expect(200);
        assert.equal(resolved.body.eventId, replay.body.eventId);
        assert.equal(replay.body.replayed, true);
        await post(peer, `${courseUrl()}/${retest}/resolve`, { ...input, note: 'changed' }).expect(409);
        const original = await coll.findOne({ _id: retest });
        assert.equal(original.kind, 'NEEDS_RETEST');
        assert.equal(original.eventType, 'OBSERVATION_RECORDED');
        assert.equal(original.mastery, undefined);
        const retraction = { requestId: randomUUID(), note: 'mistaken observation' };
        await post(manager, `${courseUrl()}/${retest}/retract`, retraction).expect(200);
        await post(manager, `${courseUrl()}/${retest}/retract`, retraction).expect(200);
        const result = await get(teacher, courseUrl()).expect(200);
        const item = result.body.items.find((e) => e._id === retest);
        assert(item.retracted && item.resolved);
        assert.equal(item.changes.length, 2);
        const pending = await get(teacher, `${courseUrl()}?pending=true`).expect(200);
        assert(!pending.body.items.some((e) => e._id === retest));
        await post(teacher, `/d/${domainId}/homework/${homeworkId}/feedback/${retest}/retract`, retraction).expect(404);
    });

    it('requires an explicit course node when the same problem belongs to multiple lessons', async () => {
        await global.Hydro.model.contest.edit(domainId, courseId, { dag: [{ _id: 0, title: 'A', pids: [pid] }, { _id: 1, title: 'B', pids: [pid] }] });
        const input = body();
        delete input.nodeId;
        await post(teacher, courseUrl(), input).expect(400);
        await post(teacher, courseUrl(), { ...input, nodeId: 1 }).expect(200);
        await global.Hydro.model.contest.edit(domainId, courseId, { dag: [{ _id: 0, title: 'Lesson', pids: [pid] }] });
    });

    it('retains historical visibility after roster/node changes and reauthorizes old retries', async () => {
        const input = body();
        const saved = await post(teacher, courseUrl(), input).expect(200);
        await global.Hydro.model.user.collGroup.updateOne({ domainId, name: 'feedback-class' }, { $set: { students: [] } });
        await global.Hydro.model.contest.edit(domainId, courseId, { dag: [] });
        const history = await get(teacher, courseUrl()).expect(200);
        assert(history.body.items.some((e) => e._id === saved.body.eventId));
        await post(teacher, courseUrl(), input).expect(403);
        await post(teacher, `${courseUrl()}/${saved.body.eventId}/retract`, { requestId: randomUUID() }).expect(200);
        await global.Hydro.model.user.collGroup.updateOne({ domainId, name: 'feedback-class' }, { $set: { students: [uid] } });
        await global.Hydro.model.contest.edit(domainId, courseId, { dag: [{ _id: 0, title: 'Lesson', pids: [pid] }] });
        await global.Hydro.model.domain.setUserRole(domainId, teacherUid, 'read-only', true);
        await get(teacher, courseUrl()).expect(403);
        await post(teacher, courseUrl(), input).expect(403);
        await global.Hydro.model.domain.setUserRole(domainId, teacherUid, 'teacher', true);
    });

    it('disables feedback without deleting events, and keeps ordinary course pages accessible', async () => {
        const count = await coll.countDocuments({ domainId });
        await global.Hydro.model.domain.edit(domainId, { classroomFeedback: false });
        await get(teacher, courseUrl()).expect(403);
        await post(teacher, courseUrl(), body()).expect(403);
        await get(teacher, `/d/${domainId}/course/${courseId}`).expect(200);
        assert.equal(await coll.countDocuments({ domainId }), count);
        await global.Hydro.model.domain.edit(domainId, { classroomFeedback: true });
    });

    it('rejects cross-origin and missing-origin JSON requests, form bodies and impersonated sessions', async () => {
        await post(teacher, courseUrl(), body(), 'https://attacker.example').expect(403);
        await teacher.post(courseUrl()).set('Accept', 'application/json').send(body()).expect(403);
        await teacher.post(courseUrl()).set('Origin', origin).type('form').send(body()).expect(400);
        const cookie = (await teacher.post('/login').send({ uname: `${domainId}-teacher`, password: 'feedback-test-password' }).expect(302)).headers['set-cookie'];
        const sid = /sid=([^;]+)/.exec(cookie[0])[1];
        const token = global.Hydro.model.token;
        await token.update(sid, token.TYPE_SESSION, 3600, { sudoUid: 1 });
        await get(teacher, courseUrl()).expect(403);
        await post(teacher, courseUrl(), body()).expect(403);
        await token.update(sid, token.TYPE_SESSION, 3600, { sudoUid: null });
    });

    it('does not acknowledge unavailable MongoDB and safely retries a lost post-insert receipt', async () => {
        const insert = coll.insertOne;
        const input = body();
        coll.insertOne = async () => { throw new Error('Injected feedback database outage'); };
        try { await post(teacher, courseUrl(), input).expect(500); } finally { coll.insertOne = insert; }
        assert.equal(await coll.countDocuments({ domainId, requestId: input.requestId }), 0);
        coll.insertOne = async function (...args) {
            await insert.apply(this, args);
            throw new Error('Injected lost receipt after commit');
        };
        try { await post(teacher, courseUrl(), input).expect(500); } finally { coll.insertOne = insert; }
        const retry = await post(teacher, courseUrl(), input).expect(200);
        assert.equal(retry.body.replayed, true);
        assert.equal(await coll.countDocuments({ domainId, requestId: input.requestId }), 1);
    });

    it('supports homework through the same local service and rejects resolving non-retest observations', async () => {
        const url = `/d/${domainId}/homework/${homeworkId}/feedback`;
        const input = body({ activityType: 'homework', activityId: homeworkId.toString() });
        delete input.nodeId;
        const saved = await post(teacher, url, input).expect(200);
        await get(teacher, url).expect(200);
        await post(teacher, `${url}/${saved.body.eventId}/resolve`, { requestId: randomUUID() }).expect(400);
        await post(teacher, `${url}/${saved.body.eventId}/retract`, { requestId: randomUUID() }).expect(200);
    });

    it('enforces the feedback limit even for privileged users without preventing local queries', async () => {
        const model = global.Hydro.model;
        const uname = `${domainId}-limited`;
        const id = await model.user.create(`${uname}@example.com`, uname, 'feedback-test-password');
        users.push(id);
        await model.user.setPriv(id, model.builtin.PRIV.PRIV_ALL);
        await model.domain.setUserRole(domainId, id, 'root', true);
        const agent = supertest.agent(require('hydrooj').httpServer);
        await agent.post('/login').send({ uname, password: 'feedback-test-password' }).expect(302);
        const input = body();
        const now = Date.now();
        const expireAt = new Date(now - now % 60000 + 60000);
        const counters = global.app.get('db').db.collection('opcount');
        await counters.insertOne({ op: 'classroom_feedback', ident: String(id), expireAt, opcount: 120 });
        const denied = await post(agent, courseUrl(), input).expect(403);
        assert.equal(denied.body.error.name, 'OpcountExceededError');
        assert.equal(await coll.countDocuments({ operatorUid: id }), 0);
        await get(agent, courseUrl()).expect(200);
        await counters.deleteMany({ op: 'classroom_feedback', ident: String(id) });
        await post(agent, courseUrl(), input).expect(200);
    });

    it('completes the local workflow while all non-loopback service connections are blocked', async () => {
        const connect = net.Socket.prototype.connect;
        const denied = [];
        net.Socket.prototype.connect = function (...args) {
            const options = Array.isArray(args[0]) ? args[0][0] : args[0];
            const host = options && typeof options === 'object' ? options.host : typeof args[1] === 'string' ? args[1] : null;
            if (host && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
                denied.push(host);
                throw new Error('External services are unavailable');
            }
            return connect.apply(this, args);
        };
        try {
            const saved = await post(teacher, courseUrl(), body({ kind: 'NEEDS_RETEST' })).expect(200);
            await get(teacher, `${courseUrl()}?pending=true`).expect(200);
            await post(teacher, `${courseUrl()}/${saved.body.eventId}/resolve`, { requestId: randomUUID() }).expect(200);
            await post(teacher, `${courseUrl()}/${saved.body.eventId}/retract`, { requestId: randomUUID() }).expect(200);
            assert.deepEqual(denied, []);
        } finally { net.Socket.prototype.connect = connect; }
    });

    it('paginates a class-sized history and finds older pending retests after many recent closed records', async () => {
        const scope = { domainId, activityType: 'course', activityId: courseId.toString() };
        const actor = { domainId, operatorUid: teacherUid };
        const allow = async () => {};
        for (let i = 0; i < 110; i++) {
            const saved = await repository.record(actor, body({ kind: 'NEEDS_RETEST', studentUid: extraUid }), allow);
            if (i >= 55) {
                const target = await repository.get(scope, saved.eventId);
                await repository.change(actor, target, 'RETEST_RESOLVED', { requestId: randomUUID() }, allow);
            }
        }
        const first = await repository.list(scope, { pending: true, studentUid: extraUid });
        assert.equal(first.items.length, 50);
        assert(first.next);
        const second = await repository.list(scope, { pending: true, studentUid: extraUid, before: first.next });
        assert.equal(second.items.length, 5);
        assert.equal(second.next, null);
        assert.equal(new Set([...first.items, ...second.items].map((e) => e._id)).size, 55);
        await assert.rejects(repository.list(scope, { before: 'bad' }), /before/);
        const plan = await coll.find({ ...scope, eventType: 'OBSERVATION_RECORDED' }).sort({ recordedAt: -1, _id: -1 }).limit(51).explain('executionStats');
        assert(JSON.stringify(plan.queryPlanner.winningPlan).includes('feedback_activity'));
        assert(!JSON.stringify(plan.queryPlanner.winningPlan).includes('COLLSCAN'));
        const response = await get(teacher, `${courseUrl()}?studentUid=${extraUid}&pending=true`).expect(200);
        assert.equal(response.body.items.length, 50);
    });

    it('restores facts, corrections and stable retry keys from BSON into a fresh local collection', async () => {
        const db = global.app.get('db').db;
        const restored = db.collection('classroom.feedback.restore-test');
        const scope = { domainId, activityType: 'course', activityId: courseId.toString() };
        try {
            const exported = (await coll.find({ domainId }).toArray()).map((doc) => BSON.deserialize(BSON.serialize(doc)));
            await restored.insertMany(exported);
            const clone = require('../packages/hydrooj/src/model/classroomFeedback').createFeedbackRepository(restored);
            await clone.ensureIndexes();
            assert.deepEqual(await clone.list(scope, { pending: true }), await repository.list(scope, { pending: true }));
            const target = await clone.get(scope, retest);
            assert(target);
            assert.equal(await restored.countDocuments({ domainId }), await coll.countDocuments({ domainId }));
            const original = exported.find((e) => e.eventType === 'OBSERVATION_RECORDED');
            const { _id, operatorUid, schemaVersion, source, eventType, requestHash, recordedAt, domainId: originalDomain, ...input } = original;
            const retry = await clone.record({ domainId: originalDomain, operatorUid }, input, async () => {});
            assert.equal(retry.eventId, _id);
            assert.equal(retry.replayed, true);
        } finally { await restored.drop(); }
    });

    after(async () => {
        const model = global.Hydro.model;
        await Promise.all([
            coll.deleteMany({ domainId }),
            model.record.coll.deleteMany({ uid: { $in: users } }),
            model.user.collGroup.deleteMany({ domainId }),
            model.domain.collUser.deleteMany({ domainId }),
            model.domain.coll.deleteOne({ _id: domainId }),
            model.document.getMulti(domainId, model.document.TYPE_CONTEST, {}).toArray().then((docs) => Promise.all(docs.map((d) => model.contest.del(domainId, d.docId)))),
            model.user.coll.deleteMany({ _id: { $in: users } }),
        ]);
    });
});
