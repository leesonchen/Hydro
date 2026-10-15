import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import * as supertest from 'supertest';
import WebSocket from 'ws';
import { PERM, PRIV, STATUS } from '@hydrooj/common';

/** Real Hydro routes, sessions, database documents and bus subscriptions. */
export function register() {
    describe('Classroom assessment HTTP and WebSocket access', () => {
        let domainId: string;
        let origin: string;
        let model: any;
        let document: any;
        let groupId: ObjectId;
        let ownerUid: number;
        let className: string;
        const actors: Record<string, any> = {};
        const sockets = new Set<WebSocket>();
        const forbiddenContestPerms = PERM.PERM_VIEW_CONTEST | PERM.PERM_EDIT_CONTEST
            | PERM.PERM_EDIT_CONTEST_SELF | PERM.PERM_VIEW_CONTEST_SCOREBOARD | PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD;
        const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const get = (actor: any, path: string) => actor.client.get(`/d/${domainId}${path}`).accept('json');
        const post = (actor: any, path: string, body: any) => actor.client.post(`/d/${domainId}${path}`)
            .set('Origin', origin).accept('json').send(body);
        const clearCounters = () => global.app.get('db').db.collection('opcount').deleteMany({
            op: { $in: ['global', 'user_login', 'user_login_id', 'scoreboard_download', 'contest_code'] },
        });
        const waitFor = async (predicate: () => boolean, label: string) => {
            const deadline = Date.now() + 5000;
            while (!predicate() && Date.now() < deadline) await pause(10);
            assert(predicate(), label);
        };

        const connect = async (actor: any, path: string) => {
            const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/d/${domainId}${path}`, {
                headers: { Cookie: actor.cookie, Origin: origin },
            });
            sockets.add(ws);
            const frames: any[] = [];
            const closed: any[] = [];
            const errors: Error[] = [];
            ws.on('message', (data) => {
                if (data.toString() === 'ping') { ws.send('pong'); return; }
                frames.push(JSON.parse(data.toString()));
            });
            ws.on('close', (code, reason) => closed.push({ code, reason: reason.toString() }));
            ws.on('error', (error) => errors.push(error));
            await waitFor(() => ws.readyState !== WebSocket.CONNECTING, 'WebSocket must complete its real handshake');
            assert.equal(errors.length, 0, errors[0]?.message);
            return {
                ws, frames, closed,
                ready: async (rid: ObjectId, detail = false) => {
                    if (!detail) ws.send(JSON.stringify({ rids: [rid.toString()] }));
                    await waitFor(() => frames.some((frame) => frame.rdoc?._id === rid.toString()) || closed.length > 0,
                        'authorized subscription must deliver the initial record');
                    assert.equal(closed.length, 0, JSON.stringify(frames));
                    const initial = frames.find((frame) => frame.rdoc?._id === rid.toString());
                    frames.length = 0;
                    return initial;
                },
                denied: async () => {
                    await waitFor(() => closed.length > 0 || ws.readyState === WebSocket.CLOSING,
                        'unauthorized WebSocket must receive a server close frame');
                    assert(frames.some((frame) => frame.error), 'denied subscription must return an authorization error');
                    assert(!frames.some((frame) => frame.rdoc), 'denied subscription must not disclose a record');
                    // Initialization failures leave the server transport paused;
                    // finish the client side after observing its real close frame.
                    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
                },
            };
        };

        const restrictGlobalCourseScope = async (actor: any) => {
            const token = require('../packages/hydrooj/src/model/token').default;
            const sessions = await token.coll.find({ uid: actor.uid, tokenType: token.TYPE_SESSION }).toArray();
            assert(sessions.length, 'the actual login must have created a session');
            // MANAGE_ALL_DOMAIN normally grants the root role. Real scoped
            // sessions allow global transport without a course-management grant.
            await token.coll.updateMany({ uid: actor.uid, tokenType: token.TYPE_SESSION }, { $set: {
                scope: (PERM.PERM_ALL & ~PERM.PERM_EDIT_HOMEWORK & ~PERM.PERM_EDIT_HOMEWORK_SELF).toString(),
            } });
            return async () => {
                for (const session of sessions) await token.coll.updateOne({ _id: session._id }, { $set: { scope: session.scope } });
            };
        };

        before(async () => {
            model = global.Hydro.model;
            document = require('../packages/hydrooj/src/model/document');
            domainId = `assessment-access-${Date.now().toString(36)}`;
            origin = `http://127.0.0.1:${require('hydrooj').httpServer.address().port}`;
            await clearCounters();
            const ownerName = `cao${Date.now().toString(36)}`;
            ownerUid = await model.user.create(`${ownerName}@example.com`, ownerName, 'assessment-test-password');
            await model.domain.add(domainId, ownerUid, 'Assessment access integration', '');
            await model.domain.edit(domainId, { enableCourse: true });
            const studentPerms = PERM.PERM_DEFAULT & ~forbiddenContestPerms & ~PERM.PERM_EDIT_HOMEWORK_SELF;
            await model.domain.addRole(domainId, 'course-student', studentPerms);
            await model.domain.addRole(domainId, 'course-teacher', studentPerms | PERM.PERM_EDIT_HOMEWORK_SELF);
            await model.domain.addRole(domainId, 'contest-admin', PERM.PERM_DEFAULT | PERM.PERM_EDIT_CONTEST
                | PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD | PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD);
            for (const label of ['teacher', 'student', 'peer', 'late', 'oldOwner', 'admin', 'outsider']) {
                const uname = `ca${Date.now().toString(36)}${label}`;
                const uid = await model.user.create(`${uname}@example.com`, uname, 'assessment-test-password');
                const role = label === 'teacher' ? 'course-teacher' : label === 'admin' ? 'contest-admin' : 'course-student';
                await model.domain.setUserRole(domainId, uid, role, true);
                const client = supertest.agent(require('hydrooj').httpServer);
                const login = await client.post('/login').send({ uname, password: 'assessment-test-password' }).expect(302);
                actors[label] = { uid, uname, client, cookie: login.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ') };
            }
            className = 'assessment-access-class';
            groupId = new ObjectId();
            await model.user.collGroup.insertOne({
                _id: groupId, domainId, name: className, class: true, archive: false,
                teachers: [actors.teacher.uid],
                students: ['student', 'peer', 'late', 'oldOwner'].map((key) => actors[key].uid),
                uids: ['teacher', 'student', 'peer', 'late', 'oldOwner'].map((key) => actors[key].uid),
            });
            const teacher = await model.user.getById(domainId, actors.teacher.uid);
            for (const perm of [PERM.PERM_VIEW_CONTEST, PERM.PERM_EDIT_CONTEST, PERM.PERM_VIEW_CONTEST_SCOREBOARD,
                PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD, PERM.PERM_READ_RECORD_CODE]) assert.equal(teacher.hasPerm(perm), false);
            assert.equal(teacher.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF), true);
        });

        beforeEach(async () => {
            await clearCounters();
            await model.user.collGroup.updateOne({ _id: groupId }, { $set: {
                students: ['student', 'peer', 'late', 'oldOwner'].map((key) => actors[key].uid),
                uids: ['teacher', 'student', 'peer', 'late', 'oldOwner'].map((key) => actors[key].uid),
            } });
            require('../packages/hydrooj/src/model/user').deleteUserCache(true, true);
        });

        const fixture = async (phase: 'before' | 'during' | 'after' = 'during', rule = 'ioi') => {
            const now = Date.now();
            const pid = await model.problem.add(domainId, '', `Assessment ${new ObjectId()}`, 'Private assessment statement', ownerUid);
            await model.problem.edit(domainId, pid, { hidden: true });
            const begin = new Date(now + (phase === 'before' ? 3600000 : -3600000));
            const end = new Date(now + (phase === 'after' ? -60000 : 7200000));
            const courseId = await model.contest.add(domainId, 'Parent course', '', ownerUid, 'course',
                new Date(now - 86400000), new Date(now + 86400000), [], false,
                { assign: [className], maintainer: [actors.teacher.uid], dag: [] });
            // Use production course synchronization to create and bind the child.
            await model.contest.edit(domainId, courseId, { dag: [{
                _id: 1, title: 'Classroom assessment', kind: 'assessment', pids: [pid], requireNids: [],
                assessment: { rule, passScore: rule === 'acm' ? 1 : 60, beginAt: begin.toISOString(), endAt: end.toISOString() },
            }] });
            const course = await model.contest.get(domainId, courseId);
            const tid = new ObjectId(course.dag[0].assessment.contestTid);
            for (const key of ['student', 'peer', 'late', 'oldOwner']) {
                await model.contest.attend(domainId, courseId, actors[key].uid, { allow: { 1: true } });
            }
            // Deliberately stale child copies must never replace parent authorization.
            await document.coll.updateOne({ domainId, docId: tid }, { $set: {
                owner: actors.oldOwner.uid, maintainer: [actors.oldOwner.uid], assign: ['stale-child-only'],
            } });
            const seedRecord = async (actor = actors.student, practice = false, attend = true) => {
                const rid = new ObjectId();
                const row = {
                    _id: rid, domainId, pid, uid: actor.uid, lang: 'cc', code: `// ${actor.uname}\nint main(){return 0;}`,
                    status: STATUS.STATUS_ACCEPTED, score: 80, time: 123, memory: 456, files: {},
                    testCases: [{ id: 1, status: STATUS.STATUS_ACCEPTED, score: 80 }],
                    compilerTexts: [], judgeTexts: [], judgeAt: new Date(),
                    ...(practice ? { practiceContest: tid, participationMode: 'practice' } : { contest: tid, participationMode: 'official' }),
                };
                await model.record.coll.insertOne(row);
                if (!practice) {
                    if (attend) await model.contest.attend(domainId, tid, actor.uid);
                    await model.contest.updateStatus(domainId, tid, actor.uid, rid, pid, { status: row.status, score: row.score });
                }
                return row;
            };
            return { pid, tid, courseId, seedRecord };
        };

        it('allows parent teachers to preview before the exam without manufacturing attendance', async () => {
            const f = await fixture('before');
            await get(actors.teacher, `/course/assessment/${f.tid}/problems`).expect(200);
            await get(actors.teacher, `/p/${f.pid}?tid=${f.tid}`).expect(200);
            await get(actors.student, `/p/${f.pid}?tid=${f.tid}`).expect(403);
            await get(actors.admin, `/p/${f.pid}?tid=${f.tid}`).expect(403);
            await get(actors.oldOwner, `/p/${f.pid}?tid=${f.tid}`).expect(403);
            assert.equal(await model.contest.getStatus(domainId, f.tid, actors.teacher.uid), null);
            assert.equal(await model.contest.getStatus(domainId, f.tid, actors.student.uid), null);
        });

        it('creates formal attendance only through an eligible student start and marks teacher submissions as staff', async () => {
            const f = await fixture();
            await get(actors.student, `/p/${f.pid}?tid=${f.tid}`).expect(403);
            await post(actors.teacher, `/course/assessment/${f.tid}`, { operation: 'attend' }).expect(403);
            await post(actors.outsider, `/course/assessment/${f.tid}`, { operation: 'attend' }).expect(403);
            await post(actors.student, `/course/assessment/${f.tid}`, { operation: 'attend' }).expect(200);
            assert((await model.contest.getStatus(domainId, f.tid, actors.student.uid)).attend);
            await get(actors.student, `/course/assessment/${f.tid}/problems`).expect(200);
            for (const [actor, participationMode] of [[actors.student, 'official'], [actors.teacher, 'staff']] as const) {
                const submitted = await post(actor, `/p/${f.pid}/submit?tid=${f.tid}`, {
                    lang: 'cc', code: 'int main(){return 0;}',
                }).expect(200);
                const row = await model.record.coll.findOne({ _id: new ObjectId(submitted.body.rid) });
                assert.equal(row.contest.toString(), f.tid.toString());
                assert.equal(row.practiceContest, undefined);
                assert.equal(row.participationMode, participationMode);
            }
            assert(!(await model.contest.getStatus(domainId, f.tid, actors.teacher.uid))?.attend);
            assert.equal(await model.contest.getStatus(domainId, f.tid, actors.late.uid), null);
        });

        it('serves live default, csv and ghost scoreboards and code exports solely through current course authority', async () => {
            const f = await fixture('during', 'acm');
            const official = await f.seedRecord();
            await f.seedRecord(actors.teacher, false, false);
            const scoreboard = await get(actors.teacher, `/classroom/${f.tid}/scoreboard?realtime=true`).expect(200);
            assert(scoreboard.body.rows.some((row) => row.some((cell) => cell.type === 'user' && +cell.raw === actors.student.uid)));
            assert(!scoreboard.body.rows.some((row) => row.some((cell) => cell.type === 'user' && +cell.raw === actors.teacher.uid)));
            const csv = await get(actors.teacher, `/classroom/${f.tid}/scoreboard/csv`).expect(200);
            assert.match(csv.headers['content-disposition'], /\.csv/);
            const ghost = await get(actors.teacher, `/classroom/${f.tid}/scoreboard/ghost`).expect(200);
            const ghostText = ghost.text || ghost.body.toString();
            assert.match(ghostText, /@teams 1\b/);
            assert(!ghostText.includes(actors.teacher.uname));
            await get(actors.teacher, `/course/assessment/${f.tid}/code?all=true`).expect(200)
                .then((res) => assert.match(res.headers['content-disposition'], /\.zip/));
            await get(actors.teacher, `/record/${official._id}?download=true`).expect(200)
                .then((res) => assert.match(res.text || res.body.toString(), /int main/));
            for (const actor of [actors.student, actors.admin, actors.oldOwner]) {
                await get(actor, `/classroom/${f.tid}/scoreboard`).expect(403);
                await get(actor, `/course/assessment/${f.tid}/code`).expect(403);
            }
        });

        it('uses parent ACL for formal and practice HTTP records and keeps students limited to themselves', async () => {
            const f = await fixture('after');
            const formal = await f.seedRecord();
            const practice = await f.seedRecord(actors.student, true);
            for (const row of [formal, practice]) {
                const detail = await get(actors.teacher, `/record/${row._id}`).expect(200);
                assert.equal(detail.body.rdoc.code, row.code);
                assert.equal(detail.body.rdoc.score, 80);
                await get(actors.student, `/record/${row._id}`).expect(200);
                for (const actor of [actors.peer, actors.admin, actors.oldOwner]) {
                    await get(actor, `/record/${row._id}`).expect(403);
                    await get(actor, `/record/${row._id}?download=true`).expect(403);
                }
            }
            for (const practiceFlag of ['', '&practice=true']) {
                const teacher = await get(actors.teacher, `/record?tid=${f.tid}${practiceFlag}`).expect(200);
                assert.equal(teacher.body.rdocs.length, 1);
                const own = await get(actors.student, `/record?tid=${f.tid}${practiceFlag}`).expect(200);
                assert(own.body.rdocs.every((row) => row.uid === actors.student.uid));
                await get(actors.peer, `/record?tid=${f.tid}&uidOrName=${actors.student.uid}${practiceFlag}`).expect(403);
                await get(actors.oldOwner, `/record?tid=${f.tid}&uidOrName=${actors.student.uid}${practiceFlag}`).expect(403);
            }
        });

        it('applies the rule projection to students even when their child owner copy is stale', async () => {
            const f = await fixture('during', 'acm');
            const own = await f.seedRecord(actors.oldOwner);
            // ACM deliberately hides detailed scores while live. The stale child
            // owner must receive that projection; the current parent teacher sees it.
            const student = await get(actors.oldOwner, `/record/${own._id}`).expect(200);
            assert.equal(student.body.rdoc.score, undefined);
            const teacher = await get(actors.teacher, `/record/${own._id}`).expect(200);
            assert.equal(teacher.body.rdoc.score, 80);
            const studentStream = await connect(actors.oldOwner, `/record-detail-conn?rid=${own._id}&noTemplate=true`);
            await studentStream.ready(own._id, true);
            global.app.broadcast('record/change', { ...own, score: 93 });
            await pause(1100);
            assert(studentStream.frames.some((frame) => frame.rdoc), 'student still receives their projected record');
            assert(studentStream.frames.every((frame) => frame.rdoc?.score === undefined));
            studentStream.ws.close();
        });

        it('streams authorized formal and practice records through both real WebSocket routes', async () => {
            const f = await fixture();
            const formal = await f.seedRecord();
            const practice = await f.seedRecord(actors.student, true);
            for (const row of [formal, practice]) {
                const flag = row.practiceContest ? '&practice=true' : '';
                const main = await connect(actors.teacher, `/record-conn?tid=${f.tid}&noTemplate=true${flag}`);
                await main.ready(row._id);
                const detail = await connect(actors.teacher, `/record-detail-conn?rid=${row._id}&noTemplate=true`);
                await detail.ready(row._id, true);
                global.app.broadcast('record/change', { ...row, score: 91 });
                await waitFor(() => main.frames.some((frame) => frame.rdoc?.score === 91)
                    && detail.frames.some((frame) => frame.rdoc?.score === 91), 'both authorized subscriptions must receive the bus update');
                for (const actor of [actors.peer, actors.admin, actors.oldOwner]) {
                    const denied = await connect(actor, `/record-detail-conn?rid=${row._id}&noTemplate=true`);
                    await denied.denied();
                }
                main.ws.close();
                detail.ws.close();
            }
        });

        it('does not leak other students or unrelated all-zero pretests into a classroom formal subscription', async () => {
            const f = await fixture();
            const own = await f.seedRecord();
            const peer = await f.seedRecord(actors.peer);
            const main = await connect(actors.student, `/record-conn?tid=${f.tid}&noTemplate=true`);
            await main.ready(own._id);
            const teacher = await connect(actors.teacher, `/record-conn?tid=${f.tid}&noTemplate=true`);
            await teacher.ready(own._id);
            const pretest = { ...peer, _id: new ObjectId(), contest: new ObjectId('000000000000000000000000'), input: ['private input'] };
            // Include a same-user pretest too: uid filtering alone is insufficient.
            global.app.broadcast('record/change', pretest);
            global.app.broadcast('record/change', { ...pretest, _id: new ObjectId(), uid: actors.student.uid });
            global.app.broadcast('record/change', { ...peer, score: 92 });
            await waitFor(() => teacher.frames.some((frame) => frame.rdoc?._id === peer._id.toString()), 'teacher receives a peer formal record');
            await pause(200);
            assert(!main.frames.some((frame) => frame.rdoc), 'student must not receive peer or pretest records');
            assert(!teacher.frames.some((frame) => frame.rdoc?.contest === '000000000000000000000000'));
            main.ws.close();
            teacher.ws.close();
        });

        it('reprojects existing student streams against a classroom time extension instead of their ended contest snapshot', async () => {
            const f = await fixture('after', 'acm');
            const row = await f.seedRecord();
            const main = await connect(actors.student, `/record-conn?tid=${f.tid}&noTemplate=true`);
            assert.equal((await main.ready(row._id)).rdoc.score, 80);
            const detail = await connect(actors.student, `/record-detail-conn?rid=${row._id}&noTemplate=true`);
            assert.equal((await detail.ready(row._id, true)).rdoc.score, 80);
            const extendedEnd = new Date(Date.now() + 3600000);
            await document.coll.updateOne({ domainId, docId: f.tid }, { $set: { endAt: extendedEnd } });
            await document.coll.updateOne({ domainId, docId: f.courseId }, {
                $set: { 'dag.0.assessment.endAt': extendedEnd.toISOString() },
            });
            global.app.broadcast('record/change', { ...row, score: 94 });
            for (const stream of [main, detail]) {
                await waitFor(() => stream.frames.some((frame) => frame.rdoc?._id === row._id.toString()),
                    'a permitted own record update must continue after the classroom time extension');
                const update = stream.frames.find((frame) => frame.rdoc?._id === row._id.toString()).rdoc;
                assert.equal(update.status, STATUS.STATUS_ACCEPTED);
                assert.equal(update.score, undefined, 'live ACM projection must hide the detailed score again');
                assert.equal(update.time, undefined);
                assert.equal(update.memory, undefined);
                assert.deepEqual(update.testCases, []);
                stream.ws.close();
            }
        });

        for (const revocation of ['roster', 'node', 'maintainer']) {
            it(`rechecks ${revocation} revocation for HTTP and queued formal/practice WebSocket deliveries`, async () => {
                const f = await fixture('after');
                const formal = await f.seedRecord();
                const practice = await f.seedRecord(actors.student, true);
                const viewer = revocation === 'maintainer' ? actors.teacher : actors.student;
                const streams: any[] = [];
                for (const row of [formal, practice]) {
                    const flag = row.practiceContest ? '&practice=true' : '';
                    const main = await connect(viewer, `/record-conn?tid=${f.tid}&noTemplate=true${flag}`);
                    await main.ready(row._id);
                    const detail = await connect(viewer, `/record-detail-conn?rid=${row._id}&noTemplate=true`);
                    await detail.ready(row._id, true);
                    streams.push(main, detail);
                    // A first update occupies the throttled send interval. A later
                    // update remains queued while the real parent grant is revoked.
                    global.app.broadcast('record/change', { ...row, score: 81 });
                }
                await pause(150);
                streams.forEach((stream) => { stream.frames.length = 0; });
                for (const row of [formal, practice]) global.app.broadcast('record/change', { ...row, score: 99 });
                if (revocation === 'roster') {
                    await model.user.collGroup.updateOne({ _id: groupId }, {
                        $pull: { students: viewer.uid, uids: viewer.uid },
                    });
                } else if (revocation === 'node') {
                    await document.collStatus.updateOne({ domainId, docId: f.courseId, uid: viewer.uid }, { $set: { 'allow.1': false } });
                } else {
                    await document.coll.updateOne({ domainId, docId: f.courseId }, { $set: { maintainer: [] } });
                }
                require('../packages/hydrooj/src/model/user').deleteUserCache(true, true);
                for (const row of [formal, practice]) {
                    await get(viewer, `/record/${row._id}`).expect(403);
                    await get(viewer, `/record/${row._id}?download=true`).expect(403);
                    global.app.broadcast('record/change', { ...row, score: 100 });
                }
                for (const stream of streams) await waitFor(() => stream.closed.length > 0, 'revoked connection must terminate');
                for (const stream of [streams[1], streams[3]]) {
                    assert(!stream.frames.some((frame) => [99, 100].includes(frame.rdoc?.score)),
                        'detail update queued before revocation must be cancelled');
                }
                const counts = streams.map((stream) => stream.frames.filter((frame) => frame.rdoc).length);
                await pause(1100);
                assert.deepEqual(streams.map((stream) => stream.frames.filter((frame) => frame.rdoc).length), counts,
                    'throttled queues must remain empty after revocation');
                for (const row of [formal, practice]) assert(await model.record.coll.findOne({ _id: row._id }), 'historical records survive revocation');
            });
        }

        it('terminates teacher subscriptions on demotion even when the former maintainer remains an enrolled student viewing their own record', async () => {
            const f = await fixture('during', 'acm');
            const row = await f.seedRecord(actors.oldOwner);
            await model.domain.setUserRole(domainId, actors.oldOwner.uid, 'course-teacher', true);
            await document.coll.updateOne({ domainId, docId: f.courseId }, { $addToSet: { maintainer: actors.oldOwner.uid } });
            require('../packages/hydrooj/src/model/user').deleteUserCache(true, true);
            try {
                const main = await connect(actors.oldOwner, `/record-conn?tid=${f.tid}&uidOrName=${actors.oldOwner.uid}&noTemplate=true`);
                await main.ready(row._id);
                const detail = await connect(actors.oldOwner, `/record-detail-conn?rid=${row._id}&noTemplate=true`);
                await detail.ready(row._id, true);
                await document.coll.updateOne({ domainId, docId: f.courseId }, { $pull: { maintainer: actors.oldOwner.uid } });
                require('../packages/hydrooj/src/model/user').deleteUserCache(true, true);
                const own = await get(actors.oldOwner, `/record/${row._id}`).expect(200);
                assert.equal(own.body.rdoc.score, undefined, 'demoted student keeps only the ordinary projected own record');
                global.app.broadcast('record/change', { ...row, score: 99 });
                for (const stream of [main, detail]) {
                    await waitFor(() => stream.closed.length > 0, 'the former teacher stream must close instead of retaining its unprojected payload');
                    assert(!stream.frames.some((frame) => frame.rdoc), 'the old teacher stream must not disclose a post-demotion update');
                }
            } finally {
                await model.domain.setUserRole(domainId, actors.oldOwner.uid, 'course-student', true);
                require('../packages/hydrooj/src/model/user').deleteUserCache(true, true);
            }
        });

        it('filters classroom records from global all/allDomain lists and subscriptions using each current parent ACL', async () => {
            const f = await fixture('after');
            const row = await f.seedRecord();
            const ordinaryTid = await model.contest.add(domainId, 'Ordinary contest used as a global filter', '', ownerUid, 'ioi',
                new Date(Date.now() - 3600000), new Date(Date.now() - 60000), [f.pid], false, {});
            // Global privileges authorize global transport, never classroom access.
            const original = await model.user.coll.findOne({ _id: actors.admin.uid });
            await model.user.coll.updateOne({ _id: actors.admin.uid }, { $set: { priv: original.priv | PRIV.PRIV_MANAGE_ALL_DOMAIN } });
            require('../packages/hydrooj/src/model/user').deleteUserCache(true, true);
            const restoreScope = await restrictGlobalCourseScope(actors.admin);
            try {
                for (const query of ['all=true', 'allDomain=true', `all=true&tid=${ordinaryTid}`, `allDomain=true&tid=${ordinaryTid}`]) {
                    const res = await get(actors.admin, `/record?${query}`).expect(200);
                    assert(!res.body.rdocs.some((r) => r._id === row._id.toString()), `${query} must omit inaccessible classroom records`);
                    const stream = await connect(actors.admin, `/record-conn?${query}&noTemplate=true`);
                    stream.ws.send(JSON.stringify({ rids: [row._id.toString()] }));
                    // A normal public record is a transport barrier for subscription setup.
                    const publicRecord = { ...row, _id: new ObjectId(), contest: undefined, uid: actors.admin.uid };
                    await model.record.coll.insertOne(publicRecord);
                    stream.ws.send(JSON.stringify({ rids: [publicRecord._id.toString()] }));
                    await waitFor(() => stream.frames.some((frame) => frame.rdoc?._id === publicRecord._id.toString()) || stream.closed.length > 0,
                        'global subscription must process the request');
                    global.app.broadcast('record/change', { ...row, score: 97 });
                    await pause(200);
                    assert(!stream.frames.some((frame) => frame.rdoc?._id === row._id.toString()), `${query} must not disclose classroom updates`);
                    stream.ws.close();
                }
            } finally {
                await restoreScope();
                await model.user.coll.updateOne({ _id: actors.admin.uid }, { $set: { priv: original.priv } });
                require('../packages/hydrooj/src/model/user').deleteUserCache(true, true);
            }
        });

        it('projects a classroom student own ACM record on global HTTP and WebSocket reads even with an unrelated contest filter', async () => {
            const f = await fixture('during', 'acm');
            const row = await f.seedRecord(actors.oldOwner);
            const ordinaryTid = await model.contest.add(domainId, 'Unrelated ordinary contest projection', '', ownerUid, 'ioi',
                new Date(Date.now() - 3600000), new Date(Date.now() - 60000), [f.pid], false, {});
            const original = await model.user.coll.findOne({ _id: actors.oldOwner.uid });
            await model.domain.setUserRole(domainId, actors.oldOwner.uid, 'contest-admin', true);
            await model.user.coll.updateOne({ _id: actors.oldOwner.uid }, {
                $set: { priv: original.priv | PRIV.PRIV_MANAGE_ALL_DOMAIN },
            });
            require('../packages/hydrooj/src/model/user').deleteUserCache(true, true);
            const restoreScope = await restrictGlobalCourseScope(actors.oldOwner);
            try {
                for (const query of ['all=true', 'allDomain=true', `all=true&tid=${ordinaryTid}`, `allDomain=true&tid=${ordinaryTid}`]) {
                    const filter = `${query}&uidOrName=${actors.oldOwner.uid}`;
                    const res = await get(actors.oldOwner, `/record?${filter}`).expect(200);
                    const listed = res.body.rdocs.find((r) => r._id === row._id.toString());
                    assert(listed, `${query} should include the authorized own classroom record`);
                    assert.equal(listed.score, undefined, `${query} must use the actual classroom ACM projection`);
                    const stream = await connect(actors.oldOwner, `/record-conn?${filter}&noTemplate=true`);
                    await stream.ready(row._id);
                    global.app.broadcast('record/change', { ...row, score: 94 });
                    await waitFor(() => stream.frames.some((frame) => frame.rdoc?._id === row._id.toString()),
                        `${query} should deliver the authorized own classroom update`);
                    assert(stream.frames.every((frame) => frame.rdoc?.score === undefined),
                        `${query} must not use an unrelated ordinary contest or global permission to reveal classroom score`);
                    stream.ws.close();
                }
            } finally {
                await restoreScope();
                await model.domain.setUserRole(domainId, actors.oldOwner.uid, 'course-student', true);
                await model.user.coll.updateOne({ _id: actors.oldOwner.uid }, { $set: { priv: original.priv } });
                require('../packages/hydrooj/src/model/user').deleteUserCache(true, true);
            }
        });

        it('lets an absent enrolled student practice after the exam without attendance, formal score or rating evidence', async () => {
            const f = await fixture('after');
            await f.seedRecord();
            const formalBefore = await model.contest.getStatus(domainId, f.tid, actors.student.uid);
            const ratingBefore = await model.domain.collUser.findOne({ domainId, uid: actors.late.uid });
            assert.equal(await model.contest.getStatus(domainId, f.tid, actors.late.uid), null);
            await document.coll.updateOne({ domainId, docId: f.tid }, { $unset: { allowPractice: '' } });
            await get(actors.late, `/p/${f.pid}?tid=${f.tid}`).expect(200);
            const result = await post(actors.late, `/p/${f.pid}/submit?tid=${f.tid}`, { lang: 'cc', code: 'int main(){return 0;}' }).expect(200);
            const practice = await model.record.coll.findOne({ _id: new ObjectId(result.body.rid) });
            assert.equal(practice.practiceContest.toString(), f.tid.toString());
            assert.equal(practice.contest, undefined);
            assert.equal(practice.participationMode, 'practice');
            assert.equal(practice.classroomSession, undefined);
            assert.equal(await model.contest.getStatus(domainId, f.tid, actors.late.uid), null);
            assert.deepEqual(await model.contest.getStatus(domainId, f.tid, actors.student.uid), formalBefore);
            assert.deepEqual(await model.domain.collUser.findOne({ domainId, uid: actors.late.uid }), ratingBefore);
            await document.coll.updateOne({ domainId, docId: f.tid }, { $set: { allowPractice: false } });
            await post(actors.late, `/p/${f.pid}/submit?tid=${f.tid}`, { lang: 'cc', code: 'int main(){return 1;}' }).expect(403);
        });

        it('preserves ordinary contest attendance and explicit practice opt-in', async () => {
            const now = Date.now();
            const pid = await model.problem.add(domainId, '', 'Ordinary private contest problem', 'Statement', ownerUid);
            await model.problem.edit(domainId, pid, { hidden: true });
            const tid = await model.contest.add(domainId, 'Ordinary contest', '', ownerUid, 'ioi',
                new Date(now - 60000), new Date(now + 60000), [pid], false, {});
            await get(actors.admin, `/p/${pid}?tid=${tid}`).expect(403);
            await post(actors.admin, `/contest/${tid}`, { operation: 'attend' }).expect(200);
            assert((await model.contest.getStatus(domainId, tid, actors.admin.uid)).attend);
            await get(actors.admin, `/contest/${tid}/problems`).expect(200);
            await get(actors.admin, `/p/${pid}?tid=${tid}`).expect(200);
            await document.coll.updateOne({ domainId, docId: tid }, { $set: { endAt: new Date(now - 1000) } });
            await post(actors.admin, `/p/${pid}/submit?tid=${tid}`, { lang: 'cc', code: 'int main(){}' }).expect(403);
            await model.contest.edit(domainId, tid, { allowPractice: true });
            const result = await post(actors.admin, `/p/${pid}/submit?tid=${tid}`, { lang: 'cc', code: 'int main(){}' }).expect(200);
            const record = await model.record.coll.findOne({ _id: new ObjectId(result.body.rid) });
            assert.equal(record.practiceContest.toString(), tid.toString());
            await get(actors.teacher, `/contest/${tid}`).expect(403);
        });

        after(async () => {
            for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
            if (!model || !domainId) return;
            await model.domain.del(domainId);
            await model.record.coll.deleteMany({ domainId });
            await model.user.collGroup.deleteMany({ domainId });
            await model.user.coll.deleteMany({ _id: { $in: [ownerUid, ...Object.values(actors).map((actor: any) => actor.uid)] } });
            require('../packages/hydrooj/src/model/user').deleteUserCache(true, true);
        });
    });
}
