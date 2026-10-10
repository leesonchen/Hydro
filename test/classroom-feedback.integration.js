const assert = require('node:assert/strict');
const { before, after, beforeEach, describe, it } = require('node:test');
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
    let managerUid;
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

    beforeEach(async () => {
        // This suite can also run standalone. Reset only cross-case HTTP counters.
        await global.app.get('db').db.collection('opcount').deleteMany({ op: 'global' });
    });

    it('practice rating trial is restricted to opted-in system administrators, not teachers or domain owners', async () => {
        const database = global.app.get('db').db;
        const model = global.Hydro.model;
        const { runPracticeRating } = require('../packages/hydrooj/src/lib/practice-rating/runner');
        const { COLLECTIONS } = require('../packages/hydrooj/src/lib/practice-rating/store');
        const url = `/d/${domainId}/course/${courseId}/practice-rating`;
        const hwUrl = `/d/${domainId}/homework/${homeworkId}/practice-rating`;
        const originalPriv = (await model.user.coll.findOne({ _id: managerUid })).priv;
        const old = Date.now() - 8 * 86400000;
        const ids = [101, 102].map((n) => new ObjectId(ObjectId.createFromTime(Math.floor(old / 1000)).toHexString().slice(0, 8)
            + n.toString(16).padStart(16, '0')));
        await get(manager, url).expect(403);
        // Existing teacherTrial configurations must never grant access after migration.
        await database.collection(COLLECTIONS.active).updateOne({ _id: domainId }, {
            $set: { teacherTrial: true, adminTrial: true },
        }, { upsert: true });
        await get(teacher, url).expect(403);
        await get(peer, url).expect(403);
        await get(manager, url).expect(403); // Domain ownership alone is insufficient.
        await get(student, url).expect(403);
        await get(outsider, url).expect(403);
        await model.user.setPriv(managerUid, originalPriv | model.builtin.PRIV.PRIV_EDIT_SYSTEM);
        await database.collection('record').insertMany([uid, extraUid].map((studentUid, i) => ({
            _id: ids[i], domainId, uid: studentUid, pid, status: i ? 2 : 1, judgeAt: new Date(old + 1000),
        })));
        try {
            const run = await runPracticeRating(database, { domainId, write: true });
            const response = await get(manager, `${url}?uid=${uid}&pid=${pid}`).expect(200);
            assert.equal(response.body.report.runId, run.runId);
            assert.equal(typeof response.body.report.probability, 'number');
            assert(response.headers['cache-control'].includes('no-store'));
            assert(!JSON.stringify(response.body).includes('recordIds'));
            assert(!JSON.stringify(response.body).includes('evidence'));
            const previousUiAddon = global.addons['ui-default'];
            global.addons['ui-default'] = require('node:path').dirname(require.resolve('@hydrooj/ui-default/package.json'));
            const renderer = global.app.plugin(require('@hydrooj/ui-default/backendlib/template').TemplateService);
            try {
                await renderer;
                const html = await manager.get(`${url}?uid=${uid}&pid=${pid}`).accept('html').expect(200);
                assert(html.text.includes('管理员只读试用'));
                assert(html.text.includes('不等于独立考试能力'));
                assert(!html.text.includes('DATETIME_SPAN_ERROR'));
                const adminPage = await manager.get(`/d/${domainId}/course/${courseId}`).accept('html').expect(200);
                assert(adminPage.text.includes('/practice-rating'));
                const teacherPage = await teacher.get(`/d/${domainId}/course/${courseId}`).accept('html').expect(200);
                assert(!teacherPage.text.includes('/practice-rating'));
                // Failure diagnostics are visible but never replace the active estimate.
                const failureId = 'failed-trial-fixture';
                await database.collection(COLLECTIONS.runs).insertOne({
                    _id: failureId, scope: domainId, asOf: Date.now(), capturedAt: Date.now() + 10000, status: 'failed',
                });
                const warningPage = await manager.get(url).accept('html').expect(200);
                assert(warningPage.text.includes('最近一次计算失败'));
                await database.collection(COLLECTIONS.runs).deleteOne({ _id: failureId });
            } finally {
                await renderer.dispose();
                if (previousUiAddon === undefined) delete global.addons['ui-default'];
                else global.addons['ui-default'] = previousUiAddon;
            }
            // Real account-switch endpoint marks sudoUid and changes the session identity.
            // It must never inherit access to the administrator-only trial.
            const sessionToken = await database.collection('token').findOne({
                tokenType: 0, uid: managerUid,
            });
            assert(sessionToken, 'Expected administrator login session');
            const previousSudoUid = sessionToken.sudoUid;
            await database.collection('token').updateOne({ _id: sessionToken._id }, {
                $set: { sudoUid: managerUid, uid },
            });
            try {
                await get(manager, url).expect(403);
                await get(manager, hwUrl).expect(403);
            } finally {
                await database.collection('token').updateOne({ _id: sessionToken._id }, {
                    $set: { uid: managerUid },
                    $unset: { sudoUid: '' },
                });
                if (previousSudoUid !== undefined) {
                    await database.collection('token').updateOne({ _id: sessionToken._id }, { $set: { sudoUid: previousSudoUid } });
                }
            }
            await get(manager, hwUrl).expect(200);
            await get(manager, `${url}?uid=&pid=`).expect(200);
            await get(manager, `${url}?uid=${teacherUid}&pid=${pid}`).expect(403);
            await get(manager, `${url}?uid=${uid}&pid=999999`).expect(403);
            await get(manager, `${url}?uid=not-a-user`).expect(400);
            const spoof = await get(manager, `${url}?domainId=system&uid=${uid}&pid=${pid}`).expect(200);
            assert.equal(spoof.body.report.scope, domainId);
            await get(manager, `/d/system/course/${courseId}/practice-rating`).expect(403);
            const postResult = await manager.post(url).set('Accept', 'application/json').send({ uid, pid });
            assert.notEqual(postResult.status, 200);
            // Trial access is independent of the classroom-feedback feature toggle.
            await model.domain.edit(domainId, { classroomFeedback: false });
            await get(manager, url).expect(200);
            await model.domain.edit(domainId, { classroomFeedback: true });
            assert.equal(await database.collection(COLLECTIONS.runs).countDocuments({ scope: domainId }), 1);
            await database.collection(COLLECTIONS.active).updateOne({ _id: domainId }, { $set: { adminTrial: false } });
            await get(manager, url).expect(403);
            // The deprecated flag cannot re-enable any trial page.
            await database.collection(COLLECTIONS.active).updateOne({ _id: domainId }, { $unset: { adminTrial: '' } });
            await get(manager, url).expect(403);
        } finally {
            await model.domain.edit(domainId, { classroomFeedback: true });
            await model.user.setPriv(managerUid, originalPriv);
            await database.collection('record').deleteMany({ _id: { $in: ids } });
            await Promise.all(Object.values(COLLECTIONS).map((name) => database.collection(name).deleteMany(
                name === COLLECTIONS.active ? { _id: domainId } : { scope: domainId },
            )));
        }
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

    it('shows feedback entry only to authorized teachers on course, scoreboard and submission pages', async () => {
        const coursePage = `/d/${domainId}/course/${courseId}`;
        for (const agent of [teacher, peer, manager]) {
            const response = await get(agent, coursePage).expect(200);
            assert.equal(response.body.feedbackUrl, courseUrl());
            assert.equal((await get(agent, coursePage + '/scoreboard/0').expect(200)).body.feedbackUrl, courseUrl());
        }
        for (const agent of [student, outsider]) {
            const response = await get(agent, coursePage).expect(200);
            assert.equal(response.body.feedbackUrl, null);
            assert.equal((await get(agent, coursePage + '/scoreboard/0').expect(200)).body.feedbackUrl, null);
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
        assert(item.retracted && !item.resolved);
        assert(item.changes.some((e) => e.eventType === 'RETEST_RESOLVED'));
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

    it('includes boolean and positive numeric claims in unassigned homework, excluding cancellations and other scopes', async () => {
        const model = global.Hydro.model;
        const begin = new Date(Date.now() - 60000);
        const end = new Date(Date.now() + 3600000);
        const id = await model.contest.add(domainId, 'Unassigned homework', '', teacherUid, 'homework', begin, end,
            [pid], false, { assign: [], penaltySince: end });
        const url = `/d/${domainId}/homework/${id}/feedback`;
        const claimed = [];
        const excluded = [];
        try {
            for (const [index, attend] of [true, 1, 2, false, 0, undefined].entries()) {
                const uname = `${domainId}-claim-${index}`;
                const studentUid = await model.user.create(`${uname}@example.com`, uname, 'feedback-test-password');
                users.push(studentUid);
                await model.domain.setUserRole(domainId, studentUid, 'default', true);
                if (attend === 1) await model.contest.attend(domainId, id, studentUid);
                else await model.contest.setStatus(domainId, id, studentUid, attend === undefined ? { startAt: begin } : { attend });
                (attend ? claimed : excluded).push(studentUid);
            }
            await model.contest.setStatus(domainId, id, teacherUid, { attend: true });
            await model.contest.setStatus(domainId, id, -1, { attend: 1 });
            await model.contest.setStatus(domainId, id, 0, { attend: 1 });
            await model.contest.setStatus(domainId, homeworkId, extraUid, { attend: 1 });
            await model.contest.setStatus('system', id, extraUid, { attend: 1 });
            const roster = (await get(teacher, url).expect(200)).body.roster;
            assert.deepEqual([...roster].sort((a, b) => a - b), claimed);
            const feedbackBody = (studentUid) => {
                const input = body({ activityType: 'homework', activityId: id.toString(), studentUid });
                delete input.nodeId;
                return input;
            };
            for (const studentUid of claimed) await post(teacher, url, feedbackBody(studentUid)).expect(200);
            for (const studentUid of [...excluded, extraUid, teacherUid]) await post(teacher, url, feedbackBody(studentUid)).expect(403);
            const numericUid = claimed[1];
            assert.equal((await model.contest.getStatus(domainId, id, numericUid)).attend, 1);
            await model.contest.cancelAttend(domainId, id, numericUid);
            assert(!(await get(teacher, url).expect(200)).body.roster.includes(numericUid));
            await post(teacher, url, feedbackBody(numericUid)).expect(403);
        } finally {
            await model.contest.del(domainId, id);
            await model.document.collStatus.deleteMany({ domainId: 'system', docId: id });
        }
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
        const queries = [
            ['summary', () => repository.summary(scope, { studentUid: extraUid })],
            ['deep-pending', () => repository.list(scope, { pending: true, studentUid: extraUid, before: first.next })],
            ['count', () => repository.count(scope, { studentUid: extraUid })],
        ];
        const measurements = [];
        for (const [name, query] of queries) {
            let pipeline;
            const aggregate = coll.aggregate;
            coll.aggregate = function (stages, ...args) { pipeline = stages; return aggregate.call(this, stages, ...args); };
            const started = performance.now();
            try { await query(); } finally { coll.aggregate = aggregate; }
            const ms = Math.round((performance.now() - started) * 100) / 100;
            const explain = await coll.aggregate(pipeline).explain('executionStats');
            const root = explain.stages?.[0]?.$cursor || explain;
            measurements.push({ name, ms, examined: root.executionStats?.totalDocsExamined,
                indexes: JSON.stringify(root.queryPlanner?.winningPlan).match(/feedback_[a-z]+/g) });
        }
        console.log('FEEDBACK_QUERY_MEASUREMENTS', JSON.stringify({
            events: await coll.countDocuments({ ...scope }),
            observations: await coll.countDocuments({ ...scope, eventType: 'OBSERVATION_RECORDED' }), measurements,
        }));
    });

    it('retains recorded lesson names after edits and keeps summaries independent of the first history page', async () => {
        const saved = await post(teacher, courseUrl(), body({ note: 'older student observation' })).expect(200);
        const scope = { domainId, activityType: 'course', activityId: courseId.toString() };
        for (let i = 0; i < 60; i++) {
            await repository.record({ domainId, operatorUid: teacherUid }, body({ studentUid: extraUid }),
                async () => ({ courseTitle: 'Feedback course', problemTitle: 'Feedback problem', lessonTitle: 'Lesson', nodeId: 0 }));
        }
        const first = await get(teacher, courseUrl()).expect(200);
        assert(!first.body.items.some((e) => e._id === saved.body.eventId));
        const summary = await get(teacher, `${courseUrl()}?view=roster&nodeId=0&pid=${pid}`).expect(200);
        assert(summary.body.items.some((e) => e._id === saved.body.eventId));
        await global.Hydro.model.contest.edit(domainId, courseId, { dag: [{ _id: 0, title: 'Renamed', pids: [pid] }] });
        const detail = await get(teacher, `${courseUrl()}/${saved.body.eventId}`).expect(200);
        assert.equal(detail.body.items[0].context.lessonTitle, 'Lesson');
        assert.equal(detail.body.items[0].context.problemTitle, 'Feedback problem');
        await post(teacher, courseUrl(), body({ requestId: (await coll.findOne({ _id: saved.body.eventId })).requestId,
            note: 'older student observation' })).expect(200);
        const page = await repository.list(scope, { pending: true, studentUid: extraUid });
        await assert.rejects(repository.list(scope, { pending: true, before: page.next }), /before/);
        await global.Hydro.model.contest.edit(domainId, courseId, { dag: [{ _id: 0, title: 'Lesson', pids: [pid] }] });
    });

    it('converges concurrent teacher resolutions and permits authorized undo without losing audit history', async () => {
        const saved = await post(teacher, courseUrl(), body({ kind: 'NEEDS_RETEST' })).expect(200);
        const path = `${courseUrl()}/${saved.body.eventId}`;
        const commands = [{ requestId: randomUUID(), expectedVersion: 0 }, { requestId: randomUUID(), expectedVersion: 0 }];
        const responses = await Promise.all([post(teacher, `${path}/resolve`, commands[0]), post(peer, `${path}/resolve`, commands[1])]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        const winner = responses.findIndex((r) => r.status === 200);
        const winnerAgent = winner === 0 ? teacher : peer;
        const loserAgent = winner === 0 ? peer : teacher;
        const resolutionId = responses[winner].body.eventId;
        assert.equal(await coll.countDocuments({ targetId: saved.body.eventId, version: 1 }), 1);
        const replay = await post(winnerAgent, `${path}/resolve`, commands[winner]).expect(200);
        assert(replay.body.replayed);
        const undo = { requestId: randomUUID(), expectedVersion: 1, resolutionId };
        await post(loserAgent, `${path}/undo-resolve`, undo).expect(403);
        await post(winnerAgent, `${path}/undo-resolve`, undo).expect(200);
        const pending = await get(teacher, `${courseUrl()}?pending=true`).expect(200);
        assert(pending.body.items.some((e) => e._id === saved.body.eventId));
        await post(winnerAgent, `${path}/undo-resolve`, undo).expect(200);
        await post(peer, `${path}/resolve`, { requestId: randomUUID(), expectedVersion: 2 }).expect(200);
        await post(winnerAgent, `${path}/undo-resolve`, { ...undo, requestId: randomUUID() }).expect(409);
        const detail = await get(teacher, path).expect(200);
        assert.equal(detail.body.items[0].changes.length, 3);
        assert.equal(detail.body.items[0].version, 3);
        assert(detail.body.items[0].resolved);
        await post(manager, `${path}/retract`, { requestId: randomUUID(), expectedVersion: 3 }).expect(200);
        await post(teacher, `${path}/resolve`, { requestId: randomUUID() }).expect(409);
    });

    it('keeps retests pending after accepted submissions and unrelated checks, with exact filtered totals', async () => {
        const saved = await post(teacher, courseUrl(), body({ kind: 'NEEDS_RETEST', rid: validRid.toString() })).expect(200);
        await post(teacher, courseUrl(), body({ kind: 'CHECKED' })).expect(200);
        const pending = await get(teacher, `${courseUrl()}?view=pending&studentUid=${uid}&pid=${pid}&nodeId=0`).expect(200);
        assert(pending.body.items.some((e) => e._id === saved.body.eventId));
        assert.equal(pending.body.filteredTotal, pending.body.items.length);
        assert(pending.body.totalPending >= pending.body.filteredTotal);
        assert.equal(pending.body.latest[`${uid}:${pid}`]._id, validRid.toString());
        assert.equal(pending.body.latest[`${uid}:${pid}`].code, undefined);
    });

    it('saves stable course IDs and score owners, rejects stale edits and prevents reuse after deletion', async () => {
        const model = global.Hydro.model;
        // PERM_DEFAULT includes homework SELF editing, which bypasses the DAG.
        // Exercise an actual learner subject to course access restrictions.
        await model.domain.setUserRole(domainId, uid, 'read-only', true);
        const id = await model.contest.add(domainId, 'Structure regression', '', teacherUid, 'course',
            new Date('2026-01-01'), new Date('2030-01-01'), [pid], false, {
                assign: ['feedback-class'], lecture: { 1: 'Stable lecture content' },
                dag: [{ _id: 1, title: 'A', pids: [pid] }, { _id: 2, title: 'B', pids: [pid], requireNids: [1] }],
            });
        await model.contest.attend(domainId, id, uid);
        await model.contest.setStatus(domainId, id, uid, { startAt: new Date(Date.now() - 60000),
            allow: { 1: false, 2: true }, lectureAllow: { 1: true } });
        const problemUrl = `/d/${domainId}/p/${pid}?tid=${id}`;
        await get(student, problemUrl).expect(403);
        const url = `/d/${domainId}/course/${id}/edit`;
        const input = { title: 'Structure regression', content: 'Structure regression content', beginAt: '2026-1-1 0:00', endAt: '2030-1-1 0:00',
            isTemplate: false, assign: 'feedback-class', dagRevision: 0,
            dag: JSON.stringify([{ _id: 2, title: 'B', pids: [pid], requireNids: [1] }, { _id: 1, title: 'A', pids: [pid] }]) };
        await post(teacher, url, input).expect(200);
        const current = await model.contest.get(domainId, id);
        assert.deepEqual(current.dag.map((n) => n._id), [2, 1]);
        assert.equal(current.problemNodeIds[pid], 2);
        assert.equal(current.problemAccessNodeIds[pid], 1);
        await get(student, problemUrl).expect(403);
        assert.equal(current.nodeIdHighWatermark, 2);
        assert.deepEqual(current.lecture, { 1: 'Stable lecture content' });
        assert.deepEqual(current.dag[0].requireNids, [1]);
        const status = await model.contest.getStatus(domainId, id, uid);
        assert.deepEqual(status.allow, { 1: false, 2: true });
        assert.deepEqual(status.lectureAllow, { 1: true });
        await model.contest.setStatus(domainId, id, uid, { 'allow.1': true, 'allow.2': false });
        await get(student, problemUrl).expect(200);
        const scoreboard = await get(student, `/d/${domainId}/course/${id}/scoreboard/0`).expect(200);
        assert.equal(scoreboard.body.courseProblemAccessNodeIds[pid], 1);
        await post(teacher, url, input).expect(400);
        await post(teacher, url, { ...input, dagRevision: 1, dag: JSON.stringify([{ _id: 1, title: 'A', pids: [pid] }]) }).expect(200);
        await post(teacher, url, { ...input, dagRevision: 2 }).expect(400);
        await post(teacher, url, { ...input, dagRevision: 2,
            dag: JSON.stringify([{ _id: 1, title: 'A', pids: [pid] }, { _id: 3, title: 'New', pids: [] }]) }).expect(200);
        await model.domain.setUserRole(domainId, uid, 'default', true);
    });

    it('falls back to the previous effective observation after retracting the latest', async () => {
        const previous = await post(teacher, courseUrl(), body({ note: 'fallback observation' })).expect(200);
        const newest = await post(teacher, courseUrl(), body({ kind: 'CHECKED' })).expect(200);
        await post(teacher, `${courseUrl()}/${newest.body.eventId}/retract`, { requestId: randomUUID() }).expect(200);
        const response = await get(teacher, `${courseUrl()}?view=roster&nodeId=0&pid=${pid}&studentUid=${uid}`).expect(200);
        assert.equal(response.body.items[0]._id, previous.body.eventId);
    });

    it('keeps legacy processing history while joining the versioned state chain once', async () => {
        const saved = await post(teacher, courseUrl(), body({ kind: 'NEEDS_RETEST' })).expect(200);
        await coll.updateOne({ _id: saved.body.eventId }, { $set: { schemaVersion: 1 }, $unset: { context: '' } });
        const ids = [1, 2].map(() => `feedback:${randomUUID().replaceAll('-', '').padEnd(64, '0')}`);
        for (const [index, _id] of ids.entries()) await coll.insertOne({ _id, schemaVersion: 1, domainId,
            targetId: saved.body.eventId, eventType: 'RETEST_RESOLVED', operatorUid: teacherUid,
            recordedAt: new Date(Date.now() + index), requestId: randomUUID(), requestHash: 'legacy', note: 'legacy processing' });
        const path = `${courseUrl()}/${saved.body.eventId}`;
        const detail = await get(teacher, path).expect(200);
        assert.equal(detail.body.items[0].state, 'resolved');
        assert.equal(detail.body.items[0].version, 0);
        assert.equal(detail.body.items[0].changes.length, 2);
        const scoped = await get(teacher, `${courseUrl()}?view=roster&nodeId=0&pid=${pid}`).expect(200);
        assert(!scoped.body.items.some((event) => event._id === saved.body.eventId));
        const input = { requestId: randomUUID(), expectedVersion: 0, resolutionId: ids[1] };
        await post(teacher, `${path}/undo-resolve`, input).expect(200);
        await post(teacher, `${path}/undo-resolve`, input).expect(200);
        const updated = await get(teacher, path).expect(200);
        assert.equal(updated.body.items[0].version, 1);
        assert.equal(updated.body.items[0].changes.length, 3);
        assert.equal(updated.body.items[0].state, 'pending');
    });

    it('arbitrates completion versus original retraction and concurrent retractions', async () => {
        const saved = await post(teacher, courseUrl(), body({ kind: 'NEEDS_RETEST' })).expect(200);
        const path = `${courseUrl()}/${saved.body.eventId}`;
        const pair = await Promise.all(['resolve', 'retract'].map((action) => post(teacher, `${path}/${action}`,
            { requestId: randomUUID(), expectedVersion: 0 })));
        assert.deepEqual(pair.map((response) => response.status).sort(), [200, 409]);
        let detail = (await get(teacher, path).expect(200)).body.items[0];
        if (detail.state === 'resolved') {
            const outcomes = await Promise.all([1, 2].map(() => post(teacher, `${path}/retract`,
                { requestId: randomUUID(), expectedVersion: 1 })));
            assert.deepEqual(outcomes.map((response) => response.status).sort(), [200, 409]);
        }
        detail = (await get(teacher, path).expect(200)).body.items[0];
        assert.equal(detail.state, 'retracted');
        assert(!detail.resolved);
    });

    it('reports partial management failures and changes only the requested access key', async () => {
        const model = global.Hydro.model;
        await model.contest.setStatus(domainId, courseId, uid, { allow: { 0: true, 9: true }, lectureAllow: { 9: false } });
        const eventCount = await coll.countDocuments({ domainId });
        const before = await model.contest.getStatus(domainId, courseId, uid);
        const url = `/d/${domainId}/course/${courseId}/manage`;
        const statusCollection = require('../packages/hydrooj/src/model/document').collStatus;
        const original = statusCollection.findOneAndUpdate;
        statusCollection.findOneAndUpdate = async (...args) => {
            if (args[0].uid === extraUid) throw new Error('Injected failure');
            return await original.apply(statusCollection, args);
        };
        let partial;
        try { partial = await post(teacher, url, { operation: 'allowUser', uid: 0, node: 0, allow: false }).expect(200); }
        finally { statusCollection.findOneAndUpdate = original; }
        assert.deepEqual(partial.body.results.map((result) => result.success).sort(), [false, true]);
        const failed = partial.body.results.find((result) => !result.success);
        const retry = await post(teacher, url, { operation: 'allowUser', uid: failed.uid, node: 0, allow: false }).expect(200);
        assert.deepEqual(retry.body.results, [{ uid: extraUid, success: true }]);
        await post(teacher, url, { operation: 'allowUser', uid, node: 0, reset: true }).expect(200);
        const after = await model.contest.getStatus(domainId, courseId, uid);
        assert.equal(after.allow[0], undefined);
        assert.equal(after.allow[9], true);
        assert.deepEqual(after.lectureAllow, before.lectureAllow);
        assert.deepEqual(after.detail, before.detail);
        assert.equal(await coll.countDocuments({ domainId }), eventCount);
        const { courseNodeHighWatermark } = require('../packages/hydrooj/src/builtin/course-management/handler/course');
        assert.equal(await courseNodeHighWatermark(domainId, await model.contest.get(domainId, courseId)), 9);
    });

    it('audits course ID initialization without writing and explicitly initializes only compatible structures', async () => {
        const model = global.Hydro.model;
        const audit = require('../packages/hydrooj/src/script/course-feedback-structure');
        const previous = await model.contest.get(domainId, courseId);
        const reports = [];
        await audit.run({ domainId }, (entry) => reports.push(entry.message));
        assert.deepEqual(await model.contest.get(domainId, courseId), previous);
        assert(reports.some((entry) => entry.includes('"high":9')));
        await audit.run({ domainId, execute: true }, () => {});
        const current = await model.contest.get(domainId, courseId);
        assert.equal(current.nodeIdHighWatermark, 9);
        assert.equal(current.dagRevision, 0);
        assert.deepEqual(current.dag, previous.dag);
        assert.equal(current.problemNodeIds[pid], 0);
    });

    it('lets an authorized teacher without record/code reading permissions record and follow up locally', async () => {
        const model = global.Hydro.model;
        const { PERM } = model.builtin;
        const permissions = (PERM.PERM_DEFAULT | PERM.PERM_EDIT_HOMEWORK_SELF)
            & ~PERM.PERM_VIEW_RECORD & ~PERM.PERM_READ_RECORD_CODE & ~PERM.PERM_READ_RECORD_CODE_ACCEPT;
        await model.domain.addRole(domainId, 'feedback-only', permissions);
        await model.domain.setUserRole(domainId, peerUid, 'feedback-only', true);
        try {
            const saved = await post(peer, courseUrl(), body({ kind: 'NEEDS_RETEST', rid: validRid.toString() })).expect(200);
            const details = await get(peer, courseUrl() + '/' + saved.body.eventId).expect(200);
            assert.deepEqual(details.body.submissions, {});
            assert.deepEqual(details.body.latest, {});
            assert.equal(details.body.items[0].code, undefined);
            await get(peer, `/d/${domainId}/record/${validRid}`).expect(403);
            await post(peer, courseUrl() + '/' + saved.body.eventId + '/resolve',
                { requestId: randomUUID(), expectedVersion: 0 }).expect(200);
            assert.equal((await get(peer, courseUrl() + '/' + saved.body.eventId).expect(200)).body.items[0].state, 'resolved');
        } finally { await model.domain.setUserRole(domainId, peerUid, 'teacher', true); }
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
            const { _id, operatorUid, schemaVersion, source, eventType, requestHash, recordedAt, context, domainId: originalDomain, ...input } = original;
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
