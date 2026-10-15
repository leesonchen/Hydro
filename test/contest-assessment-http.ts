import assert from 'assert';
import { dirname } from 'path';
import { ObjectId } from 'mongodb';
import { it } from 'node:test';
import * as supertest from 'supertest';
import { STATUS } from '@hydrooj/common';

export function register(getTeacher: () => any) {
    it('copies classroom tests and enforces access, monitoring, finalized scores and rejudge over HTTP', async () => {
        const teacher = getTeacher();
        const { domain: DomainModel, contest: ContestModel, problem: ProblemModel, record: RecordModel, user: UserModel } = global.Hydro.model;
        const DocumentModel = require('../packages/hydrooj/src/model/document');
        const suffix = Date.now().toString(36);
        const domainId = `classroom-tests-${suffix}`;
        const prefix = `/d/${domainId}`;
        const users = [];
        let renderer;
        const previousUiAddon = global.addons['ui-default'];
        try {
            await DomainModel.add(domainId, 2, 'Classroom tests', '');
            await DomainModel.edit(domainId, { enableCourse: true });
            for (const label of ['enrolled', 'outsider']) {
                const uname = `${label}${suffix}`;
                // eslint-disable-next-line no-await-in-loop
                const uid = await UserModel.create(`${uname}@example.com`, uname, '123456');
                // eslint-disable-next-line no-await-in-loop
                await DomainModel.setUserRole(domainId, uid, 'default', true);
                const client = supertest.agent(require('hydrooj').httpServer);
                // eslint-disable-next-line no-await-in-loop
                await client.post('/login').send({ uname, password: '123456' }).expect(302);
                users.push({ uid, client });
            }
            const [student, outsider] = users;
            const now = Date.now();
            const begin = new Date(now - 3600000);
            const end = new Date(now + 86400000);
            const classId = new ObjectId();
            const className = `class-${suffix}`;
            await UserModel.collGroup.insertOne({
                _id: classId, domainId, name: className, class: true, teachers: [2], students: [student.uid],
                uids: [2, student.uid], beginAt: begin, endAt: end, intervalDays: 1, archive: false,
            } as any);
            const pid = await ProblemModel.add(domainId, '', 'Private test question', 'Exam-only statement', 2);
            const lessonPid = await ProblemModel.add(domainId, '', 'Follow-up question', 'Follow-up statement', 2);
            await ProblemModel.edit(domainId, pid, { hidden: true });
            const moment = require('moment-timezone');
            const fmt = (date) => moment(date).tz('Asia/Shanghai').format('YYYY-M-D H:mm');
            const dag = [{ _id: 1, title: 'Test', kind: 'assessment', pids: [pid], assessment: {
                rule: 'oi', passScore: 50, monitorMode: 'browser',
                beginAt: new Date(now - 1800000).toISOString(), endAt: new Date(now + 1800000).toISOString(),
            } }, { _id: 2, title: 'After test', kind: 'lesson', pids: [lessonPid], requireNids: [1], completeCondition: { type: 'all' } }];
            await teacher.post(`${prefix}/course/create?isTemplate=true`).send({
                title: `Assessment template ${suffix}`, content: 'Template', isTemplate: true,
                dag: JSON.stringify(dag), beginAt: fmt(begin), endAt: fmt(end), assign: '', extraStudents: '',
            }).expect(302);
            const template = await ContestModel.getMulti(domainId, { rule: 'course', assign: 'teachers' }).next();
            assert(template);
            assert.equal(template.dag[0].assessment.contestTid, undefined);
            const copied = await teacher.post(`${prefix}/domain/class/${classId}/edit`).accept('json')
                .send({ operation: 'copy', template: `${domainId}:${template.docId}` }).expect(200);
            const courseId = new ObjectId(copied.body.tdocs[0].docId);
            let course = await ContestModel.get(domainId, courseId);
            const examId = new ObjectId(course.dag[0].assessment.contestTid);
            let exam = await ContestModel.get(domainId, examId);
            assert.notEqual(exam.docId.toString(), template.docId.toString());
            assert.deepStrictEqual(course.pids, [lessonPid]);
            assert.deepStrictEqual(exam.pids, [pid]);
            assert.equal(exam.monitorMode, 'browser');
            assert.equal(exam.rated, false);
            assert.equal(exam.beginAt.getTime() - course.beginAt.getTime(),
                new Date(template.dag[0].assessment.beginAt).getTime() - template.beginAt.getTime());
            assert.equal(await ContestModel.getStatus(domainId, examId, student.uid), null);
            await outsider.client.get(`${prefix}/contest/${examId}`).accept('json').expect(403);
            await student.client.get(`${prefix}/contest/${examId}`).accept('json').expect(403);
            await student.client.get(`${prefix}/course/${courseId}`).accept('json').expect(200);
            await student.client.post(`${prefix}/course/${courseId}`).send({ operation: 'attend' }).expect(302);
            const firstStatus = await ContestModel.getStatus(domainId, courseId, student.uid);
            assert(firstStatus.attend);
            assert.equal(firstStatus.allow[1], true);
            assert.notEqual(firstStatus.allow[2], true);
            await student.client.get(`${prefix}/p/${pid}`).accept('json').expect(403);
            await student.client.get(`${prefix}/contest/${examId}`).accept('json').expect(200);
            await student.client.get(`${prefix}/p/${pid}?tid=${examId}`).accept('json').expect(403);
            await student.client.post(`${prefix}/contest/${examId}`).send({ operation: 'attend' }).expect(302)
                .then((res) => assert.notEqual(res.headers.location, '/user/sudo'));
            assert((await ContestModel.getStatus(domainId, examId, student.uid))?.attend, 'HTTP attendance must persist');
            await student.client.get(`${prefix}/contest/${examId}/problems`).accept('json').expect(200);
            await student.client.get(`${prefix}/p/${pid}?tid=${examId}`).accept('json').expect(200);
            await student.client.get(`${prefix}/contest/${examId}/monitor`).accept('json').expect(403);
            const report = { eventType: 'page_hidden', sessionId: 'session-http-123456', pageInstanceId: 'page-http-123456', sequence: 1 };
            await student.client.post(`${prefix}/contest/${examId}/monitor`).send(report).accept('json')
                .expect(200).then((res) => assert.equal(res.body.ok, true));
            await student.client.post(`${prefix}/contest/${examId}/monitor`).send(report).accept('json').expect(200);
            const monitoring = global.app.get('db').collection('contest.monitor');
            assert.equal(await monitoring.countDocuments({ domainId, contestTid: examId }), 1);
            await teacher.get(`${prefix}/contest/${examId}/monitor`).accept('json').expect(200);
            await teacher.get(`${prefix}/contest/${examId}/edit`).accept('json').expect(403);
            const rid = await student.client.post(`${prefix}/p/${pid}/submit?tid=${examId}`)
                .send({ lang: 'cc', code: 'int main() { return 0; }' }).accept('json').expect(200)
                .then((res) => new ObjectId(res.body.rid));
            await RecordModel.coll.updateOne({ _id: rid }, { $set: { status: STATUS.STATUS_ACCEPTED, score: 100 } });
            await ContestModel.updateStatus(domainId, examId, student.uid, rid, pid, { status: STATUS.STATUS_ACCEPTED, score: 100 });
            const ongoing = await student.client.get(`${prefix}/course/${courseId}`).accept('json').expect(200);
            assert.equal(ongoing.body.assessments[1].score, null);
            assert.equal(ongoing.body.assessments[1].completed, false);
            // Advance the fixture's end time without a real-time sleep or relaxing production edit guards.
            const finishedAt = new Date(Date.now() - 1000);
            await DocumentModel.coll.updateOne({ domainId, docId: examId }, { $set: { endAt: finishedAt } });
            await DocumentModel.coll.updateOne({ domainId, docId: courseId }, { $set: { 'dag.0.assessment.endAt': finishedAt.toISOString() } });
            const finished = await student.client.get(`${prefix}/course/${courseId}`).accept('json').expect(200);
            assert.equal(finished.body.assessments[1].score, 100);
            assert.equal(finished.body.assessments[1].completed, true);
            assert.equal(finished.body.tsdoc.allow[2], true);
            assert.equal(finished.body.tsdoc.progress, 50);
            await ContestModel.updateStatus(domainId, examId, student.uid, rid, pid, { status: STATUS.STATUS_WRONG_ANSWER, score: 0 });
            const rejudged = await student.client.get(`${prefix}/course/${courseId}`).accept('json').expect(200);
            assert.equal(rejudged.body.assessments[1].score, 0);
            assert.equal(rejudged.body.assessments[1].completed, false);
            assert.equal(rejudged.body.tsdoc.progress, 0);
            global.addons['ui-default'] = dirname(require.resolve('@hydrooj/ui-default/package.json'));
            renderer = global.app.plugin(require('@hydrooj/ui-default/backendlib/template').TemplateService);
            await renderer;
            await student.client.get(`${prefix}/course/${courseId}`).accept('html').expect(200)
                .then((res) => assert.match(res.text, /进入课堂测试/));
            await teacher.get(`${prefix}/contest/${examId}/monitor`).accept('html').expect(200)
                .then((res) => {
                    assert.match(res.text, /切换到其他标签页/);
                    assert.match(res.text, /session-http-123456/);
                });
            const newClassName = `${className}-renamed`;
            await ContestModel.replaceAssignGroup(domainId, courseId, className, newClassName);
            exam = await ContestModel.get(domainId, examId);
            assert.deepStrictEqual(exam.assign, [newClassName]);
            course = await ContestModel.get(domainId, courseId);
            assert.equal(course.dag[0].assessment.contestTid, examId.toString());
            await assert.rejects(ContestModel.edit(domainId, examId, { rated: true }));
            await ContestModel.replaceAssignGroup(domainId, courseId, newClassName, className);
            await teacher.post(`${prefix}/domain/class/${classId}/edit`).accept('json')
                .send({ operation: 'delete' }).expect(403);
            assert(await ContestModel.get(domainId, courseId));
        } finally {
            await renderer?.dispose();
            if (previousUiAddon === undefined) delete global.addons['ui-default'];
            else global.addons['ui-default'] = previousUiAddon;
            await DomainModel.del(domainId);
            await RecordModel.coll.deleteMany({ domainId });
            await UserModel.coll.deleteMany({ _id: { $in: users.map((user) => user.uid) } });
            require('../packages/hydrooj/src/model/user').deleteUserCache(true, true);
        }
    });
}
