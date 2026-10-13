#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const browser = require('./lib/browser.cjs');
const { Fixtures, sleep } = require('./lib/fixtures.cjs');
const http = require('./lib/http.cjs');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const at = argv.indexOf('--' + name); return at < 0 ? fallback : argv[at + 1]; };
if (argv.includes('--help')) { console.log('node doc/test/scripts/extra-course-test.cjs --out doc/test/releases/<run>/evidence/extra-course [--container hydro]\nUses isolated temporary fixtures and browser Save as Template / Add Course actions; does not send messages.'); process.exit(0); }
const container = option('container', 'hydro');
const out = path.resolve(option('out', path.join(root, 'releases/2026-10-12-dev.2/evidence/extra-course')));
const stamp = () => new Date().toISOString();
const attemptId = new Date().toISOString().replace(/[:.]/g, '-');
const attemptDir = path.join(out, 'attempts', attemptId);
const shotDir = path.join(attemptDir, 'screenshots');
const shot = (name) => `attempts/${attemptId}/screenshots/${name}`;
const plan = [
  {
    id: 'TPL-01', change: '课程模板保存', setup: '独立临时域内由 fixture helper 准备一个含课堂测评节点的课程；管理员 Chrome 会话。',
    browserAction: '打开现有课程编辑页，点击显式 button[name="isTemplate"][value="true"]（Save as Template）。',
    expected: '保存出一个独立模板；模板保留 assessment.kind 与题目，但不带已实例化的 assessment.contestTid，原课程仍存在。',
  },
  {
    id: 'TPL-02', change: '班级复制含测评模板', setup: '同一独立临时域内由 helper/API 准备模板和两个班级；真实浏览器操作每个班级的 Add Course 对话框。',
    browserAction: '真实选择 sourceDomain、Autocomplete 中的模板，再确认 Add Course；为两个班级各复制一次并读取结果核对。',
    expected: '每个班级都出现复制课程；测评节点保留且各自获得不同的新 assessment.contestTid，题目 PID 对应有效目标题目，不引用源模板中的测评实例。',
  },
  {
    id: 'TPL-03', change: '已有模板编辑', setup: '使用 TPL-01 在浏览器中保存的模板。',
    browserAction: '打开模板编辑页，核对模板隐藏标记，修改标题并点击普通 Update。',
    expected: '同一模板保存成功，仍分配给 teachers；测评节点不产生实例绑定，源课程及其测评不变。',
  },
];

function writeJson(name, value) { fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`); }
function localParts(date) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${Number(p.month)}-${Number(p.day)}`, time: `${Number(p.hour)}:${p.minute}` };
}
function safeMessage(error) {
  const message = String(error?.message || error || 'unknown error');
  return message.replace(/(?:password|cookie|token|authorization|session)[^\s]*/ig, '[redacted]').slice(0, 350);
}
function docSummary(doc) {
  return {
    docId: String(doc?.docId ?? doc?._id ?? ''),
    title: String(doc?.title || ''),
    assign: Array.isArray(doc?.assign) ? doc.assign.map(String) : [],
    dag: (Array.isArray(doc?.dag) ? doc.dag : []).map((node) => ({
      kind: String(node?.kind || 'lesson'),
      _id: node?._id ?? null,
      assessmentContestTid: node?.assessment?.contestTid == null ? null : String(node.assessment.contestTid),
    })),
  };
}

async function markInput(page, name, marker) {
  await page.waitFor(`(()=>{const e=document.querySelector('input[name="${name}"]');return !!e&&!!e.nextElementSibling?.querySelector('input')})()`);
  await page.evaluate(`(()=>{const e=document.querySelector('input[name="${name}"]').nextElementSibling.querySelector('input');e.setAttribute('data-extra-input','${marker}');return true})()`);
  return `[data-extra-input="${marker}"]`;
}

async function clickOption(page, label) {
  const selector = await page.evaluate(`(()=>{const norm=s=>String(s||'').replace(/\\s+/g,' ').trim();const choices=[...document.querySelectorAll('.autocomplete-list li')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height);const e=choices.find(x=>norm(x.innerText)===${JSON.stringify(label)})||choices.find(x=>norm(x.innerText).includes(${JSON.stringify(label)}));if(!e)return {found:false,choices:choices.map(x=>norm(x.innerText)).slice(0,20)};const key='extra-choice-'+Math.random().toString(36).slice(2);e.setAttribute('data-extra-choice',key);return {found:true,selector:'[data-extra-choice="'+key+'"]'}})()`);
  if (!selector?.found) throw new Error(`Autocomplete option not shown: ${label}; visible options=${(selector?.choices || []).join(', ')}`);
  await page.click(selector.selector);
}

async function clickDialogConfirm(page) {
  const selector = await page.evaluate(`(()=>{const ok=/^(ok|确定|添加|add|confirm)$/i;const es=[...document.querySelectorAll('button,input[type="button"],input[type="submit"]')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height);const e=es.reverse().find(x=>ok.test(String(x.innerText||x.value||'').trim()));if(!e)return null;const key='extra-confirm-'+Math.random().toString(36).slice(2);e.setAttribute('data-extra-confirm',key);return '[data-extra-confirm="'+key+'"]'})()`);
  if (!selector) throw new Error('Add Course dialog confirmation control not found');
  await page.click(selector);
}

async function main() {
  fs.mkdirSync(shotDir, { recursive: true });
  fs.mkdirSync(attemptDir, { recursive: true });
  // Persist the plan before creating any fixtures or opening the target flows.
  writeJson('case-plan.json', { createdAt: stamp(), cases: plan });
  const results = plan.map((c) => ({ id: c.id, status: 'blocked', evidenceGrade: 'C', startedAt: null, completedAt: null, observed: '尚未执行', evidence: [], supplemental: [] }));
  writeJson('results.json', { startedAt: stamp(), cases: results });

  let admin; let student; let fixtures; let cleanup = { status: 'not-started' };
  const saveResults = () => writeJson('results.json', { startedAt: results.find((x) => x.startedAt)?.startedAt || null, updatedAt: stamp(), cases: results });
  const resultFor = (id) => results.find((r) => r.id === id);
  const finish = (id, status, observed, evidence = [], supplemental = []) => {
    const row = resultFor(id); row.status = status; row.observed = observed; row.evidenceGrade = evidence.length ? 'A — 真实浏览器直接证据' : 'C — 间接/夹具证据'; row.evidence = evidence; row.supplemental = supplemental; row.completedAt = stamp(); saveResults();
  };
  try {
    [admin, student] = await Promise.all([browser.create('admin'), browser.create('student')]);
    fixtures = new Fixtures(admin, student, out, container);
    await fixtures.setup();

    const original = await fixtures.read(fixtures.course);
    const sourceTid = fixtures.courseTid;
    const sourceTitle = original.tdoc.title;
    const originalAssessment = original.tdoc.dag.find((n) => n.kind === 'assessment');
    if (!originalAssessment?.assessment?.contestTid) throw new Error('Fixture source course has no instantiated assessment');

    const tpl1 = resultFor('TPL-01'); tpl1.startedAt = stamp(); saveResults();
    let savedTemplate = null;
    try {
      await admin.navigate(`${fixtures.prefix}${fixtures.course}/edit`);
      await admin.waitFor(`!!document.querySelector('button[name="isTemplate"][value="true"]')`);
      await admin.screenshot(path.join(out, shot('TPL-01-before.png')));
      await admin.click('button[name="isTemplate"][value="true"]');
      await admin.waitFor(`document.readyState==='complete'&&!location.pathname.endsWith('/edit')&&document.body.innerText.length>0`, 25000);
      await sleep(400);
      const afterLocation = await admin.location();
      const landedUrl = new URL(afterLocation, http.base);
      const landedOid = landedUrl.pathname.split('/').filter(Boolean).at(-1) || '';
      const landedTemplate = /^[a-f\d]{24}$/i.test(landedOid)
        ? await fixtures.read(`/course/${landedOid}/edit`)
        : null;
      savedTemplate = landedTemplate?.tdoc || null;
      const sourceSnapshot = await fixtures.read(`/course/${sourceTid}`);
      const sourceAssessmentAfter = (sourceSnapshot.tdoc?.dag || []).find((n) => n.kind === 'assessment');
      fs.writeFileSync(path.join(attemptDir, 'TPL-01-structure.json'), `${JSON.stringify({
        capturedAt: stamp(),
        actualPageUrl: landedUrl.origin + landedUrl.pathname,
        landedCourseOid: landedOid,
        sourceCourse: docSummary(sourceSnapshot.tdoc),
        targetTemplate: docSummary(savedTemplate),
        sourceExamPreserved: sourceAssessmentAfter?.assessment?.contestTid === originalAssessment.assessment.contestTid,
      }, null, 2)}\n`);
      await admin.screenshot(path.join(out, shot('TPL-01-after.png')));
      if (!savedTemplate) throw new Error(`Save As Template browser landing did not resolve to an editable target course; path=${landedUrl.pathname}`);
      const templateAssessment = (savedTemplate.dag || []).find((n) => n.kind === 'assessment');
      const sourceStillExists = !!sourceSnapshot.tdoc;
      const sourceExamPreserved = sourceAssessmentAfter?.assessment?.contestTid === originalAssessment.assessment.contestTid;
      const valid = !!templateAssessment && !templateAssessment.assessment?.contestTid && sourceStillExists && sourceExamPreserved;
      if (!valid) throw new Error(`Browser template read-back mismatch: target=${landedOid}, assessmentNode=${!!templateAssessment}, templateContestTid=${templateAssessment?.assessment?.contestTid || 'undefined'}, sourceStillExists=${sourceStillExists}, sourceExamPreserved=${sourceExamPreserved}`);
      finish('TPL-01', 'pass', '显式 Save as Template 按钮完成浏览器提交；以实际落地的新 course OID 读取模板，保留 assessment 节点，模板 assessment.contestTid 未定义，源课程及其原 exam 引用保留。', [shot('TPL-01-before.png'), shot('TPL-01-after.png')], [`结构核对：attempts/${attemptId}/TPL-01-structure.json（仅本临时域 source/target 的 docId、assign、DAG kind/_id/assessment.contestTid、source exam 保留状态及实际页面 URL）`]);
    } catch (error) {
      try { await admin.screenshot(path.join(out, shot('TPL-01-after.png'))); } catch { }
      finish('TPL-01', 'fail', `真实浏览器操作未达到预期：${safeMessage(error)}`, [shot('TPL-01-before.png'), shot('TPL-01-after.png')].filter((f) => fs.existsSync(path.join(out, f))), ['已知普通 Update HTTP 400 缺陷没有通过普通 Update 绕过；本例点击的是显式 Save as Template。']);
    }

    if (savedTemplate && resultFor('TPL-01').status === 'pass') {
      const tpl3 = resultFor('TPL-03'); tpl3.startedAt = stamp(); saveResults();
      try {
        const templateId = String(savedTemplate._id);
        await admin.navigate(`${fixtures.prefix}/course/${templateId}/edit`);
        await admin.waitFor(`document.querySelector('input[type="hidden"][name="isTemplate"]')?.value === 'true'`);
        const state = await admin.evaluate(`({templateMarker:document.querySelector('input[type="hidden"][name="isTemplate"]').value,assign:document.querySelector('[name="assign"]').value,saveAsTemplateButtons:document.querySelectorAll('button[name="isTemplate"]').length})`);
        const title = `${savedTemplate.title}（模板编辑回归）`;
        await admin.fill('input[name="title"]', title);
        await admin.screenshot(path.join(out, shot('TPL-03-before.png')));
        await admin.click('form button[type="submit"]:not([name])');
        await admin.navigation(`/course/${templateId}`);
        const updated = (await fixtures.read(`/course/${templateId}/edit`)).tdoc;
        const assessment = updated.dag.find((n) => n.kind === 'assessment');
        const source = (await fixtures.read(`/course/${sourceTid}`)).tdoc;
        if (updated.title !== title || !(updated.assign || []).includes('teachers') || !assessment || assessment.assessment?.contestTid
          || source.dag.find((n) => n.kind === 'assessment')?.assessment?.contestTid !== originalAssessment.assessment.contestTid) {
          throw new Error('Existing template Update changed template classification or assessment binding');
        }
        savedTemplate = updated;
        fs.writeFileSync(path.join(attemptDir, 'TPL-03-structure.json'), `${JSON.stringify({state, template:docSummary(updated), sourceExamPreserved:true}, null, 2)}\n`);
        await admin.screenshot(path.join(out, shot('TPL-03-after.png')));
        finish('TPL-03', 'pass', '模板编辑页使用隐藏的 isTemplate=true 标记，普通 Update 成功保留 teachers 分类及无实例的测评节点；源课程测评绑定保留。', [shot('TPL-03-before.png'), shot('TPL-03-after.png')], [`结构核对：attempts/${attemptId}/TPL-03-structure.json`]);
      } catch (error) {
        try { await admin.screenshot(path.join(out, shot('TPL-03-failure.png'))); } catch { }
        finish('TPL-03', 'fail', `模板编辑未达到预期：${safeMessage(error)}`, [shot('TPL-03-failure.png')].filter((f) => fs.existsSync(path.join(out, f))));
      }
    } else {
      finish('TPL-03', 'blocked', '前置 TPL-01 浏览器模板保存未通过。');
    }

    // If the browser template action failed, prepare a separate template by API solely as TPL-02 fixture.
    if (!savedTemplate) {
      const current = await fixtures.read(fixtures.course);
      const dag = current.tdoc.dag;
      const payload = { ...fixtures.coursePayload(dag), title: '浏览器补测夹具测评模板', isTemplate: true, assign: '' };
      const created = fixtures.checked(await fixtures.post(admin.agent, `${fixtures.prefix}/course/create`, payload), 'prepare fallback assessment template fixture');
      const fixtureTemplate = await fixtures.read(`/course/${created.tid}`);
      savedTemplate = fixtureTemplate.tdoc;
      if (!(savedTemplate.assign || []).includes('teachers')) throw new Error('API-prepared TPL-02 fixture is not classified as a template');
      resultFor('TPL-02').supplemental.push('TPL-01 浏览器保存未成功；仅为 TPL-02 准备的含测评模板由 fixture API 建立，不计作浏览器通过。');
    }

    const classNames = [`额外补测班级甲-${fixtures.domainId.slice(-5)}`, `额外补测班级乙-${fixtures.domainId.slice(-5)}`];
    const classIds = [];
    for (const name of classNames) {
      const begin = localParts(new Date(Date.now() + 86400000));
      const end = localParts(new Date(Date.now() + 9 * 86400000));
      const classResponse = await fixtures.post(admin.agent, `${fixtures.prefix}/domain/class/create`, {
        operation: 'update', name, teachers: String(fixtures.adminUid), students: String(fixtures.studentUid),
        teacherGroups: '', studentGroups: '', beginAtDate: begin.date, beginAtTime: '0:00',
        EndAtDate: end.date, EndAtTime: '23:59', intervalDays: 1, archive: false,
        publicScoreboard: true, enablePenalty: true,
      });
      const responseUrl = String(classResponse.headers?.location || classResponse.body?.url || '');
      const createInfo = {
        status: classResponse.status,
        responseUrl,
        bodyKeys: Object.keys(classResponse.body || {}),
        errorName: classResponse.body?.error?.name || null,
        errorMessage: classResponse.body?.error?.message ? safeMessage(classResponse.body.error.message) : null,
      };
      resultFor('TPL-02').supplemental.push(`班级夹具创建响应：${JSON.stringify(createInfo)}`);
      fixtures.checked(classResponse, 'create class fixture');
      const groups = (await fixtures.read('/domain/class')).groups || [];
      const group = groups.find((g) => g.name === name);
      if (!group?._id) {
        resultFor('TPL-02').supplemental.push(`班级列表可见项：${JSON.stringify(groups.map((g) => ({ name: g.name, id: String(g._id || '') })))}`);
        throw new Error('Fixture class creation succeeded but no class identity was visible at /domain/class');
      }
      classIds.push(String(group._id));
    }
    resultFor('TPL-02').startedAt = stamp(); saveResults();
    const copies = [];
    const interactionDiagnostics = [];
    let activePhase = '准备 TPL-02 浏览器流程';
    try {
      const sourceDomainName = `发布系统测试 ${fixtures.domainId}`;
      for (let i = 0; i < classIds.length; i++) {
        activePhase = `班级 ${i + 1} 打开编辑页`;
        await admin.navigate(`${fixtures.prefix}/domain/class/${classIds[i]}/edit`);
        activePhase = `班级 ${i + 1} 等待 Add Course 控件`;
        await admin.waitFor(`!!document.querySelector('button[name="add_course"]')`);
        activePhase = `班级 ${i + 1} 打开 Add Course 对话框`;
        await admin.click('button[name="add_course"]');
        activePhase = `班级 ${i + 1} 等待 Autocomplete 控件`;
        await admin.waitFor(`!!document.querySelector('input[name="sourceDomain"]')?.nextElementSibling?.querySelector('input')&&!!document.querySelector('input[name="template"]')?.nextElementSibling?.querySelector('input')`);

        activePhase = `班级 ${i + 1} 选择 Source Domain`;
        const sourceInput = await markInput(admin, 'sourceDomain', 'source');
        await admin.click(sourceInput);
        await admin.waitFor(`document.querySelectorAll('.autocomplete-list li').length>0`, 10000);
        await clickOption(admin, sourceDomainName);

        activePhase = `班级 ${i + 1} 选择模板`;
        const templateInput = await markInput(admin, 'template', 'template');
        await admin.click(templateInput);
        await admin.fill(templateInput, String(savedTemplate.title));
        await admin.waitFor(`(()=>[...document.querySelectorAll('.autocomplete-list li')].some(e=>e.getBoundingClientRect().height&&e.innerText.includes(${JSON.stringify(String(savedTemplate.title))})))()`, 15000);
        await clickOption(admin, String(savedTemplate.title));
        await sleep(300);
        activePhase = `班级 ${i + 1} 确认 Add Course`;
        const responseStart = admin.responses.length;
        await clickDialogConfirm(admin);
        await sleep(700);
        interactionDiagnostics.push({
          classIndex: i + 1,
          pageUrlAfterConfirm: await admin.location(),
          visibleNotices: await admin.evaluate(`(()=>[...document.querySelectorAll('[role="alert"],[role="status"],.notification,.notification__body,.toast')].filter(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height).map(e=>String(e.innerText||'').trim()).filter(Boolean).slice(-8))()`),
          networkResponses: admin.responses.slice(responseStart).map((r) => ({ path: r.path, status: r.status })),
        });
        activePhase = `班级 ${i + 1} 等待课程出现在页面`;
        await admin.waitFor(`document.body.innerText.includes(${JSON.stringify(String(savedTemplate.title))})&&document.querySelectorAll('.course-tbody tr').length>=1`, 25000);
        await sleep(300);
        const screenshot = shot(`TPL-02-class-${i + 1}.png`);
        await admin.screenshot(path.join(out, screenshot));

        const rowLink = await admin.evaluate(`(()=>{const links=[...document.querySelectorAll('.course-tbody a[href*="/course/"]')];return links.map(a=>a.getAttribute('href')).find(h=>h&&!h.endsWith('/edit'))||''})()`);
        const copiedId = rowLink ? new URL(rowLink, http.base).pathname.split('/').filter(Boolean).at(-1) : '';
        if (!copiedId) throw new Error(`Browser Add Course action did not append a course visit link for class ${i + 1}`);
        activePhase = `班级 ${i + 1} 回读复制课程及测评映射`;
        const copyDoc = (await fixtures.read(`/course/${copiedId}`)).tdoc;
        if (copyDoc.title !== savedTemplate.title || !(copyDoc.assign || []).includes(classNames[i])) throw new Error(`The UI-added course did not belong to class ${i + 1}`);
        const copiedAssessment = (copyDoc.dag || []).find((n) => n.kind === 'assessment');
        const sourceAssessment = (savedTemplate.dag || []).find((n) => n.kind === 'assessment');
        const copiedExam = copiedAssessment?.assessment?.contestTid ? await fixtures.read(`/contest/${copiedAssessment.assessment.contestTid}`) : {};
        const childPids = (copiedExam.tdoc?.pids || []).map(Number).sort((a, b) => a - b);
        const assessmentPids = (copiedAssessment?.pids || []).map(Number).sort((a, b) => a - b);
        const problemChecks = await Promise.all(childPids.map(async (pid) => {
          try { const problem = await fixtures.read(`/p/${pid}`); return { pid, exists: !!problem.pdoc }; }
          catch { return { pid, exists: false }; }
        }));
        const pidsMapped = childPids.length > 0 && JSON.stringify(childPids) === JSON.stringify(assessmentPids) && problemChecks.every((x) => x.exists);
        const tid = copiedAssessment?.assessment?.contestTid;
        const childSourceCourseTid = String(copiedExam.tdoc?.sourceCourseTid || '');
        if (!copiedAssessment || !tid || tid === sourceAssessment?.assessment?.contestTid || tid === originalAssessment.assessment.contestTid || !pidsMapped || childSourceCourseTid !== String(copiedId)) {
          throw new Error(`Copied course ${i + 1} did not have an independent assessment and valid mapped problem references`);
        }
        copies.push({ className: classNames[i], courseTid: String(copiedId), contestTid: String(tid), childSourceCourseTid, assessmentPids, childContestPids: childPids, problemChecks, pidsMapped, screenshot });
      }
      const independent = copies.length === 2 && copies[0].courseTid !== copies[1].courseTid && copies[0].contestTid !== copies[1].contestTid;
      if (!independent) throw new Error('The two browser-created class copies reused course or assessment identity');
      finish('TPL-02', 'pass', '管理员在两个班级页面分别通过 Add Course 对话框和真实 Autocomplete 选项完成复制；两份课程均保留测评节点并获得独立 contestTid，child contest.pids 与 assessment 节点 pids 一致、题目在本测试域可读，child sourceCourseTid 分别指向对应复制课程。', copies.map((x) => x.screenshot), [`source template title=${savedTemplate.title}`, `copies=${JSON.stringify(copies)}`, ...(resultFor('TPL-02').supplemental || [])]);
    } catch (error) {
      let pageContext = { url: '', text: '' };
      try { pageContext = { url: await admin.location(), text: (await admin.text()).slice(0, 1800) }; } catch { }
      const failureShot = shot('TPL-02-failure.png');
      try { await admin.screenshot(path.join(out, failureShot)); } catch { }
      fs.writeFileSync(path.join(attemptDir, 'TPL-02-failure.json'), `${JSON.stringify({ capturedAt: stamp(), phase: activePhase, url: pageContext.url, visiblePageText: pageContext.text, interactionDiagnostics, error: safeMessage(error) }, null, 2)}\n`);
      const foundScreens = [...copies.map((x) => x.screenshot), ...(fs.existsSync(path.join(out, failureShot)) ? [failureShot] : [])];
      finish('TPL-02', 'fail', `真实班级复制流程在“${activePhase}”未完成：${safeMessage(error)}`, foundScreens, [...(resultFor('TPL-02').supplemental || []), `失败页与阶段：TPL-02-failure.json；已完成浏览器复制数=${copies.length}；已有复制观察=${JSON.stringify(copies)}`]);
    }
  } catch (error) {
    const message = `准备或执行前置条件失败：${safeMessage(error)}`;
    for (const row of results.filter((r) => !r.completedAt)) finish(row.id, 'blocked', message, [], row.supplemental || []);
  } finally {
    if (fixtures?.created) {
      let helperError = null;
      let helperResult = null;
      try { helperResult = await fixtures.cleanup(); } catch (error) { helperError = safeMessage(error); }
      try {
        const verification = fixtures.mongo(`const domainExists=!!await db.collection('domain').findOne({_id:options.domainId});const classesBefore=await db.collection('user.group').countDocuments({domainId:options.domainId,class:true});const classCleanup=await db.collection('user.group').deleteMany({domainId:options.domainId,class:true});const residuals={};for(const n of ['domain.user','document','document.status','record','record.stat','record.history','contest.practiceAccess','contest.monitor','contest.monitor.sessions','classroom.feedback.events','task','user.group','vuser','feedback','message'])residuals[n]=await db.collection(n).countDocuments({domainId:options.domainId});residuals.storage=await db.collection('storage').countDocuments({path:{$regex:'^(problem|contest|training)/'+options.domainId+'(/|$)'},autoDelete:null});const deferredStorageDeletes=await db.collection('storage').countDocuments({path:{$regex:'^(problem|contest|training)/'+options.domainId+'(/|$)'},autoDelete:{$type:'date'}});console.log(JSON.stringify({domainExists,classesBefore,domainScopedClassRowsDeleted:classCleanup.deletedCount,residuals,deferredStorageDeletes}));`);
        const clean = !verification.domainExists && Object.values(verification.residuals || {}).every((count) => !count);
        cleanup = { status: clean ? 'complete' : 'incomplete', domainId: fixtures.domainId, fixtureHelperResult: helperResult, fixtureHelperPostCheckError: helperError, verification };
      } catch (error) {
        cleanup = { status: 'failed', reason: safeMessage(error), fixtureHelperPostCheckError: helperError, fixtureHelperResult: helperResult, domainId: fixtures.domainId };
      }
    }
    await Promise.allSettled([admin?.close?.(), student?.close?.()]);
    cleanup.completedAt = stamp();
    writeJson('cleanup.json', cleanup);
    saveResults();
  }
  process.stdout.write(JSON.stringify({
    plan: path.relative(root, path.join(out, 'case-plan.json')),
    results: path.relative(root, path.join(out, 'results.json')),
    cleanup: path.relative(root, path.join(out, 'cleanup.json')),
    statuses: Object.fromEntries(results.map((r) => [r.id, r.status])),
    cleanupStatus: cleanup.status,
  }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write(`独立补测运行器异常：${safeMessage(error)}\n`);
  process.exitCode = 1;
});
