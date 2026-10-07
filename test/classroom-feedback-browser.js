// Local page/HTTP smoke harness. No production config, database or accounts.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const esbuild = require('esbuild');
const stylus = require('stylus');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ObjectId } = require('mongodb');

const builtUI = process.argv.includes('--built-ui');
const packageRoot = process.env.HYDRO_FEEDBACK_PACKAGE_ROOT;
if (packageRoot && !builtUI) throw new Error('Packed runtime requires --built-ui.');
const core = (file) => require(packageRoot ? path.join(packageRoot, 'node_modules/hydrooj', file)
    : path.join(__dirname, '../packages/hydrooj', file));
process.env.CI = 'true';
if (builtUI) delete process.env.DEV;
else process.env.DEV = 'true';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-feedback-browser-'));
const homedir = os.homedir;
os.homedir = () => path.join(profile, 'home');
fs.mkdirSync(os.homedir());
process.env.HYDRO_PROFILE = profile;
fs.writeFileSync(path.join(profile, 'config.json'), '{}');
fs.writeFileSync(path.join(profile, 'addon.json'), JSON.stringify([
    packageRoot ? path.join(packageRoot, 'node_modules/@hydrooj/ui-default') : '@hydrooj/ui-default',
]));
const instances = [];
const create = MongoMemoryServer.create;
MongoMemoryServer.create = async function (...args) {
    const instance = await create.apply(this, args);
    instances.push(instance);
    return instance;
};

(async () => {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    process.argv.push(`--port=${port}`, '--host=127.0.0.1');
    await new Promise((resolve) => {
        process.send = (value) => { if (value === 'ready') resolve(); return true; };
        core('bin/hydrooj.js');
    });
    const model = global.Hydro.model;
    const { PERM } = model.builtin;
    const teacherUid = await model.user.create('feedback-teacher@example.com', 'feedback-teacher', 'test-only-password');
    const domainId = 'feedback-browser';
    await model.domain.add(domainId, teacherUid, '隔离反馈测试', '');
    await model.domain.edit(domainId, { enableCourse: true, classroomFeedback: true });
    await model.domain.setUserInDomain(domainId, teacherUid, { displayName: '示例教师' });
    const students = [];
    for (const [index, name] of ['陈同学', '何同学', '林同学', '王同学', '徐同学', '周同学'].entries()) {
        const uname = 'feedback-student-' + index;
        const uid = await model.user.create(uname + '@example.com', uname, 'test-only-password');
        await model.domain.setUserRole(domainId, uid, 'default', true);
        await model.domain.setUserInDomain(domainId, uid, { displayName: name });
        students.push(uid);
    }
    const [studentUid] = students;
    await model.user.collGroup.insertOne({
        _id: new ObjectId(), domainId, name: '试验班', class: true, teachers: [teacherUid], students, uids: [teacherUid, ...students],
    });
    const pid = await model.problem.add(domainId, '', '数字反转', '临时测试题', teacherUid);
    const secondPid = await model.problem.add(domainId, '', '循环求和', '临时测试题', teacherUid);
    const lectureBody = ['# 讲义核验', '', '```mermaid', 'graph TD', 'A-->B', '```', '',
        '### Sample Input #01', '', '```cpp', '1 2', '```', '', '### Sample Output #01', '', '```cpp', '3', '```', '',
        '### 输入2', '', '```cpp', '4', '```', '', '### 输出3', '', '```cpp', '5', '```'].join('\n');
    const tid = await model.contest.add(domainId, 'GESP 二级 · 循环练习', '', teacherUid, 'course',
        new Date(Date.now() - 60000), new Date(Date.now() + 3600000), [pid, secondPid], false,
        { assign: ['试验班'], lecture: { 1: '````markdown\n' + lectureBody + '\n````' }, dag: [
            { _id: 1, title: '第 3 课', pids: [pid, secondPid], lecture: true },
            { _id: 2, title: '复习巩固', pids: [pid] },
        ] });
    await model.contest.attend(domainId, tid, studentUid);
    await model.contest.setStatus(domainId, tid, studentUid, { score: { 0: 35 }, detail: { [pid]: { score: 35, status: 2 } } });
    const rid = new ObjectId();
    await model.record.coll.insertOne({
        _id: rid, domainId, uid: studentUid, pid: secondPid, contest: tid, code: 'int main() { return 0; }', lang: 'cc', status: 1, files: {},
    });
    const endpoint = `/d/${domainId}/course/${tid}/feedback`;
    const bundleOptions = {
        stdin: {
            contents: "import feedback from './packages/ui-default/pages/classroom_feedback.page';\nimport manage from './packages/ui-default/pages/course_manage.page';\nimport scoreboard from './packages/ui-default/pages/contest_scoreboard.page';\nimport content from './packages/ui-default/pages/training_detail.page';\nimport $ from 'jquery';\nimport pjax from './packages/ui-default/utils/pjax';\nwindow.$=$;window.__feedbackRefresh=()=>pjax.request({url:location.pathname,push:false});document.querySelectorAll('.section').forEach(el=>el.classList.add('visible'));new MutationObserver(()=>document.querySelectorAll('.section').forEach(el=>el.classList.add('visible'))).observe(document.body,{childList:true,subtree:true});\nconst name = document.documentElement.dataset.page;\nfor (const page of [feedback, manage, scoreboard, content]) if (page.isNameMatch(name)) page.afterLoading(name);",
            resolveDir: path.resolve(__dirname, '..'), loader: 'tsx',
        }, bundle: true, write: false, platform: 'browser',
        loader: { '.scss': 'empty', '.css': 'empty' },
        alias: { vj: path.resolve(__dirname, '../packages/ui-default') },
        define: { 'process.env.NODE_ENV': '"development"' },
    };
    if (!builtUI) await esbuild.build(bundleOptions);
    const { Handler } = core('src/service/server');
    const nativeCSS = fs.readFileSync(path.join(__dirname, '../review/ui-proposals-2026-10-05/hydro-native.css'), 'utf8');
    const { ForbiddenError } = core('src/error');
    const ctx = await new Promise((resolve) => global.app.inject(['server'], resolve));
    let loseNextReceipt = false;
    let denyNextRead = false;
    let failNextStudentAccess = false;
    const statusCollection = core('src/model/document').collStatus;
    const updateStatus = statusCollection.findOneAndUpdate;
    statusCollection.findOneAndUpdate = async function (...args) {
        if (failNextStudentAccess && args[0].uid === studentUid) {
            failNextStudentAccess = false;
            throw new Error('Injected single-student access failure');
        }
        return await updateStatus.apply(this, args);
    };
    const coll = core('src/model/classroomFeedback').coll;
    const find = coll.findOne;
    coll.findOne = async function (...args) {
        if (denyNextRead) {
            denyNextRead = false;
            throw new ForbiddenError('Injected temporary refusal on retry');
        }
        return await find.apply(this, args);
    };
    const insert = coll.insertOne;
    coll.insertOne = async function (...args) {
        const lose = loseNextReceipt;
        loseNextReceipt = false;
        const result = await insert.apply(this, args);
        if (lose) throw new Error('Simulated receipt loss after MongoDB commit');
        return result;
    };
    ctx.Route('feedback_preview', '/feedback-preview', class FeedbackPreviewHandler extends Handler {
        async get() {
            this.session.uid = teacherUid;
            this.session.scope = PERM.PERM_ALL.toString();
            this.response.redirect = endpoint;
        }
    });
    const fullTemplate = async (handler) => {
        if (handler.request.headers.accept?.includes('application/json') || handler.request.query.pjax) return;
        if (!handler.response.template) return;
        const html = await handler.renderHTML(handler.response.template, handler.response.body);
        handler.response.template = null;
        handler.response.type = 'text/html';
        if (builtUI) {
            handler.response.body = html;
            return;
        }
        handler.response.body = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '')
            + '<style>' + nativeCSS + stylus.render(fs.readFileSync(path.join(__dirname,
                '../packages/ui-default/components/classroom-feedback.page.styl'), 'utf8')) + '</style>'
            + '<script>window.Hydro={};window.UiContext=Object.assign(JSON.parse(window.UiContext),JSON.parse(window.UiContextNew));'
            + 'window.UserContext=Object.assign(JSON.parse(window.UserContext),JSON.parse(window.UserContextNew));</script>'
            + '<script src="/feedback-preview.js"></script>';
    };
    ctx.on('handler/after/ClassroomFeedback#get', fullTemplate);
    ctx.on('handler/after/CourseScoreboard#get', fullTemplate);
    ctx.on('handler/after/CourseManage#get', fullTemplate);
    ctx.on('handler/after/CourseDetail#get', fullTemplate);
    ctx.Route('feedback_preview_js', '/feedback-preview.js', class FeedbackPreviewScriptHandler extends Handler {
        async get() {
            const result = await esbuild.build(bundleOptions);
            this.response.type = 'application/javascript';
            this.response.body = result.outputFiles[0].text;
        }
    });
    ctx.Route('feedback_preview_fault', '/feedback-preview-fault', class FeedbackPreviewFaultHandler extends Handler {
        async post() {
            if (this.request.body.management) failNextStudentAccess = true;
            else if (this.request.body.deny) denyNextRead = true;
            else loseNextReceipt = true;
            this.response.body = { enabled: true };
        }
    });
    ctx.Route('feedback_preview_audit', '/feedback-preview-audit', class FeedbackPreviewAuditHandler extends Handler {
        async get() { this.response.body = { events: await coll.find({ domainId }).toArray() }; }
    });
    ctx.Route('feedback_preview_score_change', '/feedback-preview-score-change', class FeedbackPreviewScoreChangeHandler extends Handler {
        async post() {
            await model.contest.setStatus(domainId, tid, studentUid, { 'score.0': 36 });
            this.response.body = { updated: true };
        }
    });
    console.log(`FEEDBACK_PREVIEW_URL=http://127.0.0.1:${port}/feedback-preview`);
    console.log(`FEEDBACK_PREVIEW_UI=${builtUI ? 'production-webpack' : 'page-module'}`);
    if (packageRoot) console.log(`FEEDBACK_PREVIEW_PACKAGE=${packageRoot}`);
    const stop = async () => {
        await global.app.parallel('app/exit');
        await global.app.root.fiber.dispose();
        await Promise.all(instances.map((instance) => instance.stop()));
        os.homedir = homedir;
        fs.rmSync(profile, { recursive: true, force: true });
        process.exit(0);
    };
    ctx.Route('feedback_preview_stop', '/feedback-preview-stop', class FeedbackPreviewStopHandler extends Handler {
        async post() {
            this.response.body = { stopping: true };
            setTimeout(() => stop().catch((error) => { console.error(error); process.exit(1); }), 100);
        }
    });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
})().catch(async (error) => {
    console.error(error);
    if (global.app?.get('db')) {
        await global.app.parallel('app/exit');
        await global.app.root.fiber.dispose();
    }
    await Promise.all(instances.map((instance) => instance.stop()));
    os.homedir = homedir;
    fs.rmSync(profile, { recursive: true, force: true });
    process.exit(1);
});
