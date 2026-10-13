#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const B = require('./lib/browser.cjs');
const h = require('./lib/http.cjs');
const { Fixtures } = require('./lib/fixtures.cjs');
const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf('--' + name); return i < 0 ? fallback : argv[i + 1]; };
if (argv.includes('--help')) {
  console.log('node doc/test/scripts/course-datetime-test.cjs --out doc/test/fixes/<run>/evidence/datetime --container hydro\nTests precise assessment times, started-test metadata, profile/browser timezone defaults and native contest settings in an isolated temporary domain.');
  process.exit(0);
}
const output = option('out');
if (!output || output.startsWith('--')) {
  console.error('Required: --out <new evidence directory>. Use an independent output directory for each run.');
  process.exit(2);
}
const out = path.resolve(output);
fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
const plan = [
  { id: 'DATE-01', title: '达标分数及监控编辑保留时间精度', expected: '浏览器修改分数/监控并保存，开始结束的秒和毫秒完全保留。' },
  { id: 'DATE-02', title: '单独修改结束时间', expected: '浏览器明确修改结束时间时仅该时间变化，开始时间保持完整精度。' },
  { id: 'DATE-03', title: '已开始测评允许修改分数及监控', expected: '开始后修改分数/监控正常保存，无时间变化和403。' },
  { id: 'DATE-04', title: '不同时区的默认测评时间', expected: '两个不同浏览器时区下将普通章节改成测评，默认值均对应用户时区的原始课时UTC时间。' },
  { id: 'CSET-01', title: '原生比赛设置切换赛制及保存', expected: 'OI→ACM→OI正确禁用/启用封榜控件并改变FormData；OI保存监控和封榜选项成功。' },
];
const only = option('only', '').split(',').filter(Boolean);
if (only.some(id => !plan.some(c => c.id === id))) throw Error('Unknown selected datetime case');
const results = [];
let admin; let student; let fixture; let cleanup; let fatal;
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n');
const persist = () => write('results.json', { updatedAt: new Date().toISOString(), baseUrl: h.base, cases: results, cleanup, fatal });
write('case-plan.json', plan);
async function run(id, action) {
  if (only.length && !only.includes(id)) return;
  const row = { ...plan.find(c => c.id === id), status: 'pass', grade: 'A', startedAt: new Date().toISOString(), evidence: [] };
  const start = admin.responses.length;
  const exceptionStart = admin.exceptions.length;
  try { row.actual = await action(); }
  catch (error) { row.status = 'fail'; row.actual = { error: error.message }; }
  try { const file = 'screenshots/' + id + '.png'; await admin.screenshot(path.join(out, file)); row.evidence.push(file); row.url = await admin.location(); } catch { }
  row.browserResponses = admin.responses.slice(start);
  row.jsExceptions = admin.exceptions.slice(exceptionStart);
  if (row.jsExceptions.length && row.status === 'pass') {
    row.status = 'fail'; row.actual = { ...row.actual, jsExceptions: row.jsExceptions };
  }
  row.finishedAt = new Date().toISOString(); results.push(row); persist();
  console.log(JSON.stringify({ id, status: row.status, actual: row.actual }));
}
async function editNode(id) {
  await admin.navigate(fixture.prefix + fixture.course + '/edit');
  const data = await fixture.read(fixture.course);
  const index = data.tdoc.dag.findIndex(n => n._id === id);
  assert(index >= 0);
  await admin.waitFor(`document.querySelectorAll('.dag-node').length > ${index}`);
  await admin.evaluate(`(()=>{document.querySelectorAll('.dag-node')[${index}].setAttribute('data-datetime-test','target');return true})()`);
  return '[data-datetime-test="target"]';
}
async function saveCourse() {
  await admin.click('form button[type="submit"]:not([name])');
  await admin.navigation('/course/' + fixture.courseTid);
}
async function assessment(id) { return (await fixture.read(fixture.course)).tdoc.dag.find(n => n._id === id).assessment; }
async function prepareWindow(beginAt, endAt) {
  const course = (await fixture.read(fixture.course)).tdoc;
  const dag = structuredClone(course.dag);
  Object.assign(dag.find(n => n._id === 3).assessment, { beginAt, endAt });
  fixture.checked(await fixture.post(admin.agent, fixture.prefix + fixture.course + '/edit', {
    ...fixture.coursePayload(dag), dagRevision: course.dagRevision,
    nodeIdHighWatermark: course.nodeIdHighWatermark || Math.max(...dag.map(n => n._id)),
  }), 'prepare precise assessment window');
  return assessment(3);
}
(async () => {
  try {
    [admin, student] = await Promise.all([B.create('admin'), B.create('student')]);
    fixture = new Fixtures(admin, student, out, option('container', 'hydro')); await fixture.setup();
    await admin.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
    let begin = new Date(Date.now() + 3600000); begin.setUTCSeconds(47, 321);
    let end = new Date(begin.getTime() + 1800000); end.setUTCMilliseconds(654);
    let expected = await prepareWindow(begin.toISOString(), end.toISOString());
    await run('DATE-01', async () => {
      const selector = await editNode(3);
      const display = await admin.evaluate(`({begin:document.querySelector('${selector} .dag-assessment-begin').value,end:document.querySelector('${selector} .dag-assessment-end').value,secondsEnabled:document.querySelector('${selector} .dag-assessment-begin')._flatpickr.config.enableSeconds})`);
      assert.equal(display.secondsEnabled, true); assert(display.begin.endsWith(':47'));
      await admin.fill(selector + ' .dag-assessment-pass', '75');
      await admin.fill(selector + ' .dag-assessment-monitor', 'browser');
      await saveCourse(); const stored = await assessment(3);
      assert.equal(stored.beginAt, expected.beginAt); assert.equal(stored.endAt, expected.endAt);
      assert.equal(stored.passScore, 75); assert.equal(stored.monitorMode, 'browser');
      return { display, stored, exactMillisecondsPreserved: true };
    });
    await run('DATE-02', async () => {
      const original = await assessment(3); const selector = await editNode(3);
      const newEnd = new Date(new Date(original.endAt).getTime() + 60000); newEnd.setUTCMilliseconds(0);
      await admin.fill(selector + ' .dag-assessment-end', newEnd.toISOString().slice(0, 19).replace('T', ' '));
      await admin.click('input[name="title"]'); await saveCourse(); const stored = await assessment(3);
      assert.equal(stored.beginAt, original.beginAt); assert.equal(stored.endAt, newEnd.toISOString());
      return { originalBegin: original.beginAt, storedBegin: stored.beginAt, storedEnd: stored.endAt, onlyEndChanged: true };
    });
    begin = new Date(Date.now() - 600000); begin.setUTCSeconds(47, 321);
    end = new Date(Date.now() + 1800000); end.setUTCSeconds(47, 654);
    expected = await prepareWindow(begin.toISOString(), end.toISOString());
    await run('DATE-03', async () => {
      const selector = await editNode(3); await admin.fill(selector + ' .dag-assessment-pass', '90');
      await admin.fill(selector + ' .dag-assessment-monitor', 'off'); await saveCourse();
      const stored = await assessment(3); assert.equal(stored.beginAt, expected.beginAt); assert.equal(stored.endAt, expected.endAt);
      assert.equal(stored.passScore, 90); assert.equal(stored.monitorMode, 'off');
      const exam = (await fixture.read('/contest/' + stored.contestTid)).tdoc;
      assert.equal(exam.beginAt, expected.beginAt); assert.equal(exam.endAt, expected.endAt);
      return { started: new Date(exam.beginAt).getTime() < Date.now(), stored, childTimesUnchanged: true };
    });
    await run('DATE-04', async () => {
      const source = (await fixture.read(fixture.course)).tdoc;
      await editNode(1);
      const profileZone = await admin.evaluate("document.querySelector('[data-course-time-zone]')?.getAttribute('data-course-time-zone')");
      assert(profileZone, 'Course form must expose the profile timezone');
      // Navigate after each override so all Date constructors and pickers share the new browser zone.
      const zones = ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'].filter(z => z !== profileZone).slice(0, 2);
      const observations = [];
      for (const [index, zone] of zones.entries()) {
        await admin.send('Emulation.setTimezoneOverride', { timezoneId: zone });
        const nodeId = index ? 4 : 1; const selector = await editNode(nodeId);
        const actualProfileZone = await admin.evaluate("document.querySelector('[data-course-time-zone]').getAttribute('data-course-time-zone')");
        assert.notEqual(actualProfileZone, zone);
        await admin.fill(selector + ' .dag-kind', 'assessment');
        const displayed = await admin.evaluate(`({browserZone:Intl.DateTimeFormat().resolvedOptions().timeZone,begin:document.querySelector('${selector} .dag-assessment-begin').value,end:document.querySelector('${selector} .dag-assessment-end').value})`);
        const screen = 'screenshots/DATE-04-' + index + '-defaults.png'; await admin.screenshot(path.join(out, screen));
        await saveCourse(); const stored = await assessment(nodeId);
        assert.equal(stored.beginAt, source.lessonBeginAt); assert.equal(stored.endAt, source.lessonEndAt);
        observations.push({ profileZone: actualProfileZone, browserZone: zone, displayed, storedBegin: stored.beginAt, storedEnd: stored.endAt, screenshot: screen });
      }
      return { expectedUtc: { beginAt: source.lessonBeginAt, endAt: source.lessonEndAt }, observations };
    });
    await run('CSET-01', async () => {
      await admin.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
      await admin.navigate(fixture.prefix + '/contest/' + fixture.settingsTid + '/edit');
      await admin.waitFor("!!document.querySelector('select[name=rule]')");
      await admin.fill('select[name="rule"]', 'oi');
      if (!await admin.evaluate("document.querySelector('input[type=checkbox][name=keepScoreboardHidden]').checked")) await admin.click('input[type="checkbox"][name="keepScoreboardHidden"]');
      const capture = () => admin.evaluate("(()=>{const e=document.querySelector('input[type=checkbox][name=keepScoreboardHidden]');return {disabled:e.disabled,submitted:new FormData(e.form).get('keepScoreboardHidden')}})()");
      const oiBefore = await capture(); assert.equal(oiBefore.disabled, false); assert.equal(oiBefore.submitted, 'on');
      await admin.fill('select[name="rule"]', 'acm'); const acm = await capture(); assert.equal(acm.disabled, true); assert.equal(acm.submitted, null);
      await admin.screenshot(path.join(out, 'screenshots/CSET-01-acm-disabled.png'));
      await admin.fill('select[name="rule"]', 'oi'); const oiAfter = await capture(); assert.equal(oiAfter.disabled, false); assert.equal(oiAfter.submitted, 'on');
      await admin.fill('select[name="monitorMode"]', 'browser');
      await admin.click('form button[name="operation"][value="update"]:not([formaction])'); await admin.navigation('/contest/' + fixture.settingsTid);
      const stored = (await fixture.read('/contest/' + fixture.settingsTid + '/edit')).tdoc;
      assert.equal(stored.keepScoreboardHidden, true); assert.equal(stored.monitorMode, 'browser');
      return { oiBefore, acm, oiAfter, saved: { rule: stored.rule, keepScoreboardHidden: stored.keepScoreboardHidden, monitorMode: stored.monitorMode } };
    });
  } catch (error) { fatal = error.message; console.log(JSON.stringify({ fatal })); }
  finally {
    try { if (fixture?.created) cleanup = await fixture.cleanup(); } catch (error) { fatal = 'Cleanup: ' + error.message; }
    await Promise.allSettled([admin?.close(), student?.close()]);
    for (const c of plan) if (!results.some(r => r.id === c.id)) {
      const skipped = only.length && !only.includes(c.id);
      results.push({ ...c, status: skipped ? 'skipped' : 'blocked', actual: skipped ? '未选定此项' : fatal || '前置初始化未完成', evidence: [] });
    }
    persist();
  }
  console.log(JSON.stringify({ completed: true, statuses: results.map(c => ({ id: c.id, status: c.status })), cleanup: cleanup?.domainId, fatal }));
  if (fatal || results.length !== plan.length || results.some(c => ['fail', 'blocked'].includes(c.status))) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
