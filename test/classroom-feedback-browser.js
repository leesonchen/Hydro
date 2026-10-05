// Local component/HTTP smoke harness. No production config, database or accounts.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const esbuild = require('esbuild');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ObjectId } = require('mongodb');

process.env.CI = 'true';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-feedback-browser-'));
const homedir = os.homedir;
os.homedir = () => path.join(profile, 'home');
fs.mkdirSync(os.homedir());
process.env.HYDRO_PROFILE = profile;
fs.writeFileSync(path.join(profile, 'config.json'), '{}');
fs.writeFileSync(path.join(profile, 'addon.json'), '[]');
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
        require('hydrooj/bin/hydrooj');
    });
    const model = global.Hydro.model;
    const { PERM } = model.builtin;
    const teacherUid = await model.user.create('feedback-teacher@example.com', 'feedback-teacher', 'test-only-password');
    const studentUid = await model.user.create('feedback-student@example.com', 'feedback-student', 'test-only-password');
    const domainId = 'feedback-browser';
    await model.domain.add(domainId, teacherUid, '隔离反馈测试', '');
    await model.domain.edit(domainId, { enableCourse: true, classroomFeedback: true });
    await model.domain.setUserRole(domainId, studentUid, 'default', true);
    await model.user.collGroup.insertOne({
        _id: new ObjectId(), domainId, name: '试验班', class: true, teachers: [teacherUid], students: [studentUid], uids: [teacherUid, studentUid],
    });
    const pid = await model.problem.add(domainId, '', '课堂测试题', '临时测试题', teacherUid);
    const tid = await model.contest.add(domainId, '课堂反馈测试课程', '', teacherUid, 'course',
        new Date(Date.now() - 60000), new Date(Date.now() + 3600000), [pid], false,
        { assign: ['试验班'], dag: [{ _id: 0, title: '第一课', pids: [pid] }] });
    const endpoint = `/d/${domainId}/course/${tid}/feedback`;
    const bundle = await esbuild.build({
        stdin: {
            contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
                import Feedback from './packages/ui-default/components/classroom-feedback';
                createRoot(document.getElementById('feedback-root')).render(<Feedback url=${JSON.stringify(endpoint)} />);`,
            resolveDir: path.resolve(__dirname, '..'), loader: 'tsx',
        }, bundle: true, write: false, platform: 'browser', define: { 'process.env.NODE_ENV': '"development"' },
    });
    const { Handler } = require('../packages/hydrooj/src/service/server');
    const { ForbiddenError } = require('../packages/hydrooj/src/error');
    const ctx = await new Promise((resolve) => global.app.inject(['server'], resolve));
    let loseNextReceipt = false;
    let denyNextRead = false;
    const coll = require('../packages/hydrooj/src/model/classroomFeedback').coll;
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
            this.response.type = 'text/html';
            this.response.body = `<!DOCTYPE html><html lang="zh"><meta charset="utf-8"><title>Hydro 课堂反馈 · 隔离验证</title>
                <style>body{font-family:system-ui;margin:24px auto;max-width:1050px;padding:0 16px;color:#17243a;background:#f3f5f8}
                #feedback-root{background:white;padding:24px;border-radius:12px}label{display:block;margin:14px 0}select,textarea,input{display:block;padding:8px;min-width:260px}
                input[type=checkbox]{display:inline;min-width:0}textarea{width:90%}button{padding:9px 16px;margin:6px;border:1px solid #b9c6d8;background:#edf3ff;border-radius:6px;cursor:pointer}
                button:disabled{opacity:.45}table{width:100%;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #dde4ef;text-align:left}p[role=status]{color:#245ab4}fieldset{border:1px solid #dce3ee}</style>
                <p>隔离验证环境 · 仅含临时测试班级、教师和学生</p>
                <button onclick="fetch('/feedback-preview-fault',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(()=>document.getElementById('fault').textContent='下一次保存将模拟回执丢失')">模拟下一次回执丢失</button><span id="fault"></span>
                <button onclick="fetch('/feedback-preview-fault',{method:'POST',headers:{'Content-Type':'application/json'},body:'{&quot;deny&quot;:true}'}).then(()=>document.getElementById('fault').textContent='下一次重试将暂时拒绝')">模拟下一次重试被拒绝</button>
                <div id="feedback-root"></div><script src="/feedback-preview.js"></script></html>`;
        }
    });
    ctx.Route('feedback_preview_js', '/feedback-preview.js', class FeedbackPreviewScriptHandler extends Handler {
        async get() { this.response.type = 'application/javascript'; this.response.body = bundle.outputFiles[0].text; }
    });
    ctx.Route('feedback_preview_fault', '/feedback-preview-fault', class FeedbackPreviewFaultHandler extends Handler {
        async post() {
            if (this.request.body.deny) denyNextRead = true;
            else loseNextReceipt = true;
            this.response.body = { enabled: true };
        }
    });
    ctx.Route('feedback_preview_audit', '/feedback-preview-audit', class FeedbackPreviewAuditHandler extends Handler {
        async get() { this.response.body = { events: await coll.find({ domainId }).toArray() }; }
    });
    console.log(`FEEDBACK_PREVIEW_URL=http://127.0.0.1:${port}/feedback-preview`);
    const stop = async () => {
        await global.app.parallel('app/exit');
        await global.app.root.fiber.dispose();
        await Promise.all(instances.map((instance) => instance.stop()));
        os.homedir = homedir;
        fs.rmSync(profile, { recursive: true, force: true });
        process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
})().catch((error) => { console.error(error); process.exitCode = 1; });
