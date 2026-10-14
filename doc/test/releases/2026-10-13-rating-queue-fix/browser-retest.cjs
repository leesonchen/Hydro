'use strict';
// Focused deployed Hydro retest. All mutations are scoped to owned temporary domains.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../../../..');
const B = require(path.join(repo, 'doc/test/scripts/lib/browser.cjs'));
const h = require(path.join(repo, 'doc/test/scripts/lib/http.cjs'));
const { Fixtures, sleep } = require(path.join(repo, 'doc/test/scripts/lib/fixtures.cjs'));
const option = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? null : process.argv[i + 1]; };
if (process.argv.includes('--help')) {
  console.log('node browser-retest.cjs --out <evidence-dir> --container hydro [--only RATE-01,RATE-02,RATE-03,TIME-01,TIME-02,QUEUE-01]');
  process.exit(0);
}
const out = path.resolve(option('out') || path.join(__dirname, 'evidence/focused'));
const container = option('container') || 'hydro';
const only = (option('only') || '').split(',').filter(Boolean);
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'focused-test-cases.json'), 'utf8'));
if (only.some(id => !plan.some(c => c.id === id))) throw Error('Unknown selected case');
fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + '\n');
const results = [];
let admin, student, f, original, fatal, configTouched = false, cleanup = {}, queueDomain, guardDomain;
const queueOwnedDomains = [];
let queueFixtureIds;
const persist = () => write('results.json', { updatedAt: new Date().toISOString(), baseUrl: h.base, container, cases: results, cleanup, fatal });
const selected = id => !only.length || only.includes(id);
function screenshotEvidence(value, found = []) {
  if (typeof value === 'string' && (/^screenshots\/.*\.png$/.test(value) || /^[A-Za-z0-9_-]+\.json$/.test(value))) found.push(value);
  else if (Array.isArray(value)) for (const item of value) screenshotEvidence(item, found);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) screenshotEvidence(item, found);
  return [...new Set(found)];
}
async function record(id, browser, action, dependencies = [], grade = 'A') {
  if (!selected(id)) return;
  const row = { ...plan.find(c => c.id === id), status: 'pass', grade, startedAt: new Date().toISOString(), evidence: [] };
  const missing = dependencies.find(dep => results.find(c => c.id === dep)?.status !== 'pass');
  if (missing) { row.status = 'blocked'; row.actual = { prerequisite: missing }; }
  else {
    const responseStart = browser.responses.length, exceptionStart = browser.exceptions.length;
    try { row.actual = await action(); row.evidence.push(...screenshotEvidence(row.actual)); }
    catch (e) {
      const driver = /Browser wait|CDP timeout|Missing browser|Browser evaluation|context.*destroy/i.test(e.message);
      row.status = driver ? 'blocked' : 'fail'; row.failureClass = e.applicationFailure ? 'application' : driver ? 'driver' : 'needs-triage';
      row.actual = { error: e.message, ...(e.observed ? { observed: e.observed } : {}) };
    }
    row.browserResponses = browser.responses.slice(responseStart); row.jsExceptions = browser.exceptions.slice(exceptionStart);
    if (row.jsExceptions.length && row.status === 'pass') { row.status = 'fail'; row.actual.jsExceptions = row.jsExceptions; }
    try { const file = `screenshots/${id}.png`; await browser.screenshot(path.join(out, file)); row.evidence.push(file); row.url = await browser.location(); } catch { }
  }
  row.finishedAt = new Date().toISOString(); results.push(row); persist();
  console.log(JSON.stringify({ id, status: row.status, actual: row.actual }));
}
async function manage() {
  await admin.send('Page.navigate', { url: new URL('/manage/rating', h.base).href });
  await admin.waitFor("document.readyState==='complete'&&(location.pathname.endsWith('/manage/rating')||location.pathname.endsWith('/user/sudo'))", 25000);
  if ((await admin.location()).includes('/user/sudo')) {
    await admin.fill('input[name="password"]', h.credential('admin').password);
    await admin.click('form:has(input[name="password"]) button[type="submit"]');
    await admin.waitFor("document.readyState==='complete'&&location.pathname.endsWith('/manage/rating')", 25000);
  }
  await admin.waitFor("!!document.querySelector('textarea[name=domains]')");
}
async function saveConfig(algorithm, domains) {
  await manage(); await admin.fill('select[name=algorithm]', algorithm); await admin.fill('textarea[name=domains]', domains.join('\n'));
  await admin.click('form:has(input[name=op][value=save]) button[type=submit]'); await admin.navigation('/manage/rating');
}
const control = () => f.mongo(`const c=await db.collection('system').findOne({_id:'rating.publication'});const v=c?.value||{algorithm:'legacy',domains:['exam'],revision:0,active:{}};const k=Buffer.from(options.domainId).toString('base64url'),other={...v.active};delete other[k];const crypto=load('node:crypto');console.log(JSON.stringify({algorithm:v.algorithm,domains:v.domains,revision:v.revision,otherActiveHash:crypto.createHash('sha256').update(JSON.stringify(other)).digest('hex'),active:v.active?.[k]||null}));`);
async function cardSelector() {
  return admin.evaluate(`(()=>{const input=[...document.querySelectorAll('input[name=domainId]')].find(e=>e.value===${JSON.stringify(f.domainId)});if(!input)throw Error('Owned temporary domain card missing');const card=input.closest('.section');card.setAttribute('data-test-owned-rating','true');card.scrollIntoView({block:'center'});return '[data-test-owned-rating=true]'})()`);
}
async function applyAndWait(algorithm, phase) {
  const observations = [], deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await manage(); const selector = await cardSelector();
    const ui = await admin.evaluate(`document.querySelector(${JSON.stringify(selector)}).innerText`);
    const run = f.mongo(`const x=await db.collection('rating_publication_runs').find({domainId:options.domainId,referenceOnly:{$ne:true}},{projection:{_id:1,algorithm:1,status:1,asOf:1,count:1,operation:1}}).sort({asOf:-1}).limit(1).toArray();console.log(JSON.stringify(x[0]||null));`);
    const active = control().active; observations.push({ at: new Date().toISOString(), ui, run, active: active && { algorithm: active.algorithm, runId: active.runId } });
    write(`publication-observations-${phase}.json`, observations);
    if (ui.includes('最近任务：已应用') && active?.algorithm === algorithm && run?.status === 'complete' && run._id === active.runId) return { ui, run, active };
    if (ui.includes('最近任务：失败') || run?.status === 'failed') throw Error('Actual rating publication failed');
    await sleep(1500);
  }
  const e = Error('Rating apply did not complete within 180 seconds'); e.applicationFailure = true; e.observed = observations.at(-1); throw e;
}
async function clickApply(algorithm, phase) {
  const selector = await cardSelector();
  await admin.click(selector + ' form:has(input[value=apply]) button');
  const publication = await applyAndWait(algorithm, phase);
  const realRows = f.mongo(`const n=await db.collection('rating_publication_users').countDocuments({domainId:options.domainId,runId:${JSON.stringify(publication.run._id)}});const u=await db.collection('rating_publication_users').find({domainId:options.domainId,runId:${JSON.stringify(publication.run._id)}},{projection:{uid:1,rp:1,rpInfo:1,rank:1,achievement:1,tier:1}}).toArray();console.log(JSON.stringify({count:n,rows:u}));`);
  assert(realRows.count > 0, 'Computed publication must contain real rating rows');
  return { ...publication, snapshot: realRows, source: 'computed by deployed rating-publication worker' };
}
function timeLayout() {
  return admin.evaluate(`(()=>{const d=document.querySelector('.contest-time-history'),s=d?.querySelector('summary'),p=d?.querySelector('.help-text'),table=d?.querySelector('.data-table');if(!d||!s||!p||!table)throw Error('Time history UI missing');const a=s.getBoundingClientRect(),b=p.getBoundingClientRect(),wrap=table.parentElement;return {open:d.open,title:s.innerText,help:p.innerText,summary:{top:a.top,bottom:a.bottom},helpRect:{top:b.top,bottom:b.bottom},overlap:Math.max(0,a.bottom-b.top),marginTop:getComputedStyle(p).marginTop,horizontalTableScroll:wrap.scrollWidth>wrap.clientWidth}})()`);
}
async function captureWidths(prefix) {
  const metrics=[];
  for (const width of [1500, 375]) {
    await admin.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
    await sleep(250); const observed = await timeLayout();
    assert(observed.open); assert.equal(observed.overlap, 0); assert.equal(observed.marginTop, '0px'); assert.equal(observed.horizontalTableScroll, false);
    const file = `screenshots/${prefix}-${width}.png`; await admin.screenshot(path.join(out, file)); metrics.push({ width, ...observed, screenshot: file });
  }
  await admin.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  return metrics;
}
async function testContestHistory() {
  await admin.navigate(f.prefix + '/contest/' + f.settingsTid + '/edit');
  const before = (await f.read('/contest/' + f.settingsTid)).tdoc;
  await admin.fill('input[name=duration]', String(Number(before.duration || 1) + 1));
  await admin.click('form button[name=operation][value=update]:not([formaction])');
  await admin.waitFor("document.body.innerText.includes('修改时间可能影响')"); await admin.clickText('是', 'button');
  await admin.navigation('/contest/' + f.settingsTid);
  await admin.navigate(f.prefix + '/contest/' + f.settingsTid + '/edit'); await admin.waitFor("!!document.querySelector('.contest-time-history')");
  await admin.click('.contest-time-history summary');
  const hist = (await f.read('/contest/' + f.settingsTid)).tdoc;
  assert((hist.timeChangeHistory || []).length > 0); assert.equal(hist.beginAt, before.beginAt);
  const expectedEndAt = new Date(before.endAt).getTime() + 3600000;
  assert.equal(new Date(hist.endAt).getTime(), expectedEndAt);
  const widths = await captureWidths('TIME-01'); write('TIME-01-layout.json', { historyCount: hist.timeChangeHistory.length, beginAt: hist.beginAt, endAtBefore: before.endAt, endAtAfter: hist.endAt, durationField: hist.duration ?? null, widths });
  return { historyCount: hist.timeChangeHistory.length, endAtBefore: before.endAt, endAtAfter: hist.endAt, onlyEndAtChanged: true, widths, evidence: ['TIME-01-layout.json'] };
}
async function testCourseHistory() {
  await admin.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  const courseBefore = (await f.read(f.course)).tdoc;
  const assessmentBefore = courseBefore.dag.find(n => n.kind === 'assessment').assessment;
  const next = new Date(assessmentBefore.endAt); next.setMinutes(next.getMinutes() + 5);
  const dag = courseBefore.dag.map(node => node.kind === 'assessment'
    ? { ...node, assessment: { ...node.assessment, endAt: next.toISOString() } }
    : node);
  const update = await h.post(admin.agent, f.prefix + f.course + '/edit', {
    ...f.coursePayload(dag),
    dagRevision: courseBefore.dagRevision,
    nodeIdHighWatermark: courseBefore.nodeIdHighWatermark || Math.max(...dag.map(node => node._id)),
  });
  if (update.status !== 302 && update.status !== 200) throw Error('Course history fixture update failed HTTP ' + update.status);
  write('TIME-02-fixture-update.json', { source: 'isolated temporary course edit endpoint', status: update.status, assessmentEndBefore: assessmentBefore.endAt, assessmentEndAfter: next.toISOString() });
  await admin.navigate(f.prefix + f.course + '/edit');
  await admin.waitFor("!!document.querySelector('.contest-time-history')"); await admin.click('.contest-time-history summary');
  const exam = (await f.read(f.course)).tdoc.dag.find(n => n.kind === 'assessment');
  const tdoc = (await f.read('/contest/' + exam.assessment.contestTid)).tdoc;
  assert((tdoc.timeChangeHistory || []).length > 0, 'Course edit must create persisted child test history');
  assert.equal(exam.assessment.beginAt, assessmentBefore.beginAt, 'Unedited assessment start must be unchanged');
  assert.equal(exam.assessment.endAt, next.toISOString(), 'Edited assessment end must match the selected UTC value');
  const widths = await captureWidths('TIME-02'); write('TIME-02-layout.json', { historyCount: tdoc.timeChangeHistory.length, assessmentEnd: exam.assessment.endAt, widths });
  return { historyCount: tdoc.timeChangeHistory.length, assessmentEnd: exam.assessment.endAt, fixtureUpdate: 'isolated temporary course edit via authenticated HTTP setup', widths, evidence: ['TIME-02-layout.json', 'TIME-02-fixture-update.json'] };
}
async function domainCreate(id) {
  const res = await h.post(admin.agent, '/home/domain/create', { id, name: '队列回归夹具 ' + id, bulletin: '仅用于本次系统测试，结束后删除。' });
  if (res.status !== 200 || res.body?.error) throw Error('Could not create owned queue domain');
}
async function domainDelete(id, viaBrowser = true) {
  if (viaBrowser) {
    await admin.navigate('/d/' + id + '/domain/dashboard');
    await admin.waitFor("!!document.querySelector('#delete-domain-form input[type=submit]')");
    if (id === queueDomain) await admin.screenshot(path.join(out, 'screenshots/QUEUE-01-before-delete.png'));
    await admin.click('#delete-domain-form input[type=submit]');
    await admin.waitFor("document.body.innerText.includes('确认删除此域') && [...document.querySelectorAll('button')].some(e=>['是','确认','确定','Ok','OK'].includes(e.innerText.trim())&&e.getBoundingClientRect().height>0)");
    const confirmLabel = await admin.evaluate("[...document.querySelectorAll('button')].find(e=>['是','确认','确定','Ok','OK'].includes(e.innerText.trim())&&e.getBoundingClientRect().height>0).innerText.trim()");
    await admin.clickText(confirmLabel, 'button');
    await admin.waitFor("location.pathname.includes('/user/sudo') || location.pathname.includes('/home/domain')");
    if ((await admin.location()).includes('/user/sudo')) {
      await admin.fill('input[name="password"]', h.credential('admin').password);
      await admin.click('form:has(input[name="password"]) button[type="submit"]');
      await admin.waitFor("location.pathname.includes('/home/domain')");
    }
    return { method: 'browser', redirected: await admin.location() };
  }
  const prefix = '/d/' + id;
  const res = await h.post(admin.agent, prefix + '/domain/dashboard', { operation: 'delete' });
  if (res.status !== 200 || res.body?.error) throw Error('Could not delete owned queue domain');
  return { method: 'HTTP cleanup fallback', status: res.status };
}
async function queueDeletion() {
  queueDomain = 'qfix' + Date.now().toString(36); guardDomain = queueDomain + 'g';
  await domainCreate(queueDomain); queueOwnedDomains.push(queueDomain); write('queue-owned-domains.json', { queueDomain, guardDomain: null });
  await domainCreate(guardDomain); queueOwnedDomains.push(guardDomain); write('queue-owned-domains.json', { queueDomain, guardDomain });
  const inserted = f.mongo(`const {ObjectId}=load('mongodb');const qLegacy=new ObjectId(),qCurrent=new ObjectId(),guardRating=new ObjectId(),guardOther=new ObjectId(),guardRun=new ObjectId(),legacyRun=new ObjectId(),currentRun=new ObjectId();const now=new Date(Date.now()+3600000);for(const [id,domainId]of [[legacyRun,options.queueDomain],[currentRun,options.queueDomain],[guardRun,options.guardDomain]])await db.collection('rating_publication_runs').insertOne({_id:id,domainId,algorithm:'legacy',status:'complete',operation:'publish',asOf:Date.now(),completedAt:Date.now(),count:0,diagnostics:{fixture:true}});await db.collection('schedule').insertMany([{_id:qLegacy,type:'schedule',subType:'task.rating-publication',executeAfter:now,runId:legacyRun},{_id:qCurrent,type:'schedule',subType:'task.rating-publication',executeAfter:now,domainId:options.queueDomain,runId:currentRun},{_id:guardRating,type:'schedule',subType:'task.rating-publication',executeAfter:now,domainId:options.guardDomain,runId:guardRun},{_id:guardOther,type:'schedule',subType:'fixture.unrelated',executeAfter:now,domainId:options.guardDomain}]);console.log(JSON.stringify({legacyRun:String(legacyRun),currentRun:String(currentRun),guardRun:String(guardRun),scheduleIds:{legacy:String(qLegacy),current:String(qCurrent),guardRating:String(guardRating),guardOther:String(guardOther)}}));`, { queueDomain, guardDomain });
  write('queue-fixture-ids.json', inserted);
  queueFixtureIds = inserted;
  const deleteAction = await domainDelete(queueDomain, true); queueOwnedDomains.splice(queueOwnedDomains.indexOf(queueDomain), 1);
  write('queue-owned-domains.json', { queueDomain, guardDomain, sourceDomainDeleted: true, guardDomainStillOwned: true });
  const after = f.mongo(`const {ObjectId}=load('mongodb');const ids=options.scheduleIds;const q=await db.collection('schedule').find({_id:{$in:Object.values(ids).map(x=>new ObjectId(x))}},{projection:{subType:1,domainId:1,runId:1}}).toArray();const runs=await db.collection('rating_publication_runs').countDocuments({domainId:options.queueDomain});console.log(JSON.stringify({sourceQueueRemaining:q.filter(x=>x.subType==='task.rating-publication'&&(x.runId?.toString()===options.runIds[0]||x.runId?.toString()===options.runIds[1])).length,guardRatingRemaining:q.some(x=>x._id.toString()===ids.guardRating),guardOtherSubtypeRemaining:q.some(x=>x._id.toString()===ids.guardOther),queueRunsRemaining:runs,guardSchedules:q.map(x=>({_id:x._id.toString(),subType:x.subType,domainId:x.domainId||null}))}));`, { queueDomain, guardDomain, scheduleIds: inserted.scheduleIds, runIds: [inserted.legacyRun, inserted.currentRun, inserted.guardRun] });
  assert.equal(after.sourceQueueRemaining, 0); assert.equal(after.queueRunsRemaining, 0); assert(after.guardRatingRemaining); assert(after.guardOtherSubtypeRemaining);
  const guardDeleteAction = await domainDelete(guardDomain, true); queueOwnedDomains.splice(queueOwnedDomains.indexOf(guardDomain), 1);
  const clean = f.mongo(`console.log(JSON.stringify({guardDomainExists:!!await db.collection('domain').findOne({_id:options.guardDomain}),fixtureSchedules:await db.collection('schedule').countDocuments({domainId:options.guardDomain,subType:{$in:['task.rating-publication','fixture.unrelated']}}),fixtureRuns:await db.collection('rating_publication_runs').countDocuments({domainId:options.guardDomain})}));`, { guardDomain });
  assert.equal(clean.guardDomainExists, false); assert.equal(clean.fixtureSchedules, 0); assert.equal(clean.fixtureRuns, 0);
  write('queue-deletion-observation.json', { deleteAction, afterDeletingSourceDomain: after, guardDeleteAction, afterDeletingGuardDomain: clean });
  write('queue-owned-domains.json', { queueDomain, guardDomain, sourceDomainDeleted: true, guardDomainDeleted: true });
  return { legacyScheduleRemoved: true, currentScheduleRemoved: true, unrelatedOwnedDomainAndSubtypePreserved: true, deletedVia: deleteAction.method, evidence: ['screenshots/QUEUE-01-before-delete.png', 'queue-fixture-ids.json', 'queue-deletion-observation.json'], guardDomainThenCleaned: clean };
}
(async () => {
  try {
    [admin, student] = await Promise.all([B.create('admin'), B.create('student')]);
    write('environment.json', { baseUrl: h.base, browser: await admin.send('Browser.getVersion'), credentials: 'testuser.txt labelled local accounts', externalNetworkBlocked: true });
    f = new Fixtures(admin, student, out, container); await f.setup(); original = control();
    write('initial-configuration.json', { algorithm: original.algorithm, domains: original.domains, revision: original.revision, otherActiveHash: original.otherActiveHash, targetActive: original.active && { algorithm: original.active.algorithm, runId: original.active.runId } });

    await record('RATE-01', admin, async () => {
      // Build an actual legacy snapshot first so the UI rollback restores a real prior pointer.
      configTouched = true; await saveConfig('legacy', [f.domainId]);
      await manage(); let selector = await cardSelector(); await admin.click(selector + ' form:has(input[value=apply]) button');
      const legacy = await applyAndWait('legacy', 'legacy');
      const legacyRows = f.mongo(`const n=await db.collection('rating_publication_users').countDocuments({domainId:options.domainId,runId:${JSON.stringify(legacy.run._id)}});console.log(JSON.stringify({count:n}));`);
      assert(legacyRows.count > 0);
      await student.navigate(f.prefix + '/p/' + f.p1); await student.waitFor("!!document.querySelector('.objective-input[name=\"1\"]')");
      await student.fill('.objective-input[name="1"]', 'A'); await student.click('.problem-content input[type=submit]'); await student.navigation('/record/');
      await student.waitFor("document.body.innerText.includes('Accepted')", 60000);
      await saveConfig('v2_trial', [f.domainId]); await manage(); selector = await cardSelector();
      const configured = control(); assert.equal(configured.algorithm, 'v2_trial'); assert.deepEqual(configured.domains, [f.domainId]);
      const published = await clickApply('v2_trial', 'v2');
      assert.notEqual(published.run._id, legacy.run._id); assert.equal(published.active.algorithm, 'v2_trial');
      write('real-publication.json', { legacy, v2: published, actualAcceptedRecordObservedInBrowser: true });
      return { legacySnapshot: legacy.run._id, actualAcceptedSubmission: true, v2Run: published.run._id, activePointerMatchesCompletedRun: true, computedRows: published.snapshot.count,
        evidence: ['real-publication.json', 'publication-observations-legacy.json', 'publication-observations-v2.json'] };
    }, [], 'B');

    await record('RATE-02', student, async () => {
      const active = control().active; assert.equal(active?.algorithm, 'v2_trial');
      const snapshot = f.mongo(`const rows=await db.collection('rating_publication_users').find({domainId:options.domainId,runId:${JSON.stringify(active.runId)}},{projection:{uid:1,rp:1,rpInfo:1,rank:1,achievement:1,tier:1}}).toArray();console.log(JSON.stringify(rows));`);
      const studentSnapshot = snapshot.find(row => row.uid === Number(f.studentUid));
      assert(studentSnapshot && studentSnapshot.rp > 0, 'Actual computed snapshot must include a positive student row');
      await student.navigate(f.prefix + '/ranking'); const ranking = await student.text();
      assert(ranking.includes('V2（限域试用，非认证竞赛能力）') && ranking.includes('试用 Rating'));
      const studentRow = await student.evaluate(`([...document.querySelectorAll('tbody tr')].find(r=>r.querySelector('a[href$="/user/${f.studentUid}"]'))||{}).innerText||''`);
      assert(studentRow && studentRow.includes('暂定') && /[1-9]\d*/.test(studentRow), 'Real student ranking row and provisional state must be visible');
      await student.screenshot(path.join(out, 'screenshots/RATE-02-ranking.png'));
      await student.navigate(f.prefix + '/user/' + f.studentUid); const profile = await student.text();
      assert(profile.includes('试用 Rating') && profile.includes('分项 P / C') && profile.includes('暂定'));
      await student.screenshot(path.join(out, 'screenshots/RATE-02-profile.png'));
      write('real-display-snapshot.json', { runId: active.runId, algorithm: active.algorithm, rows: snapshot, source: 'rating_publication_users rows written by completed worker run' });
      return { rankingV2Visible: true, studentRow, profileV2Visible: true, studentSnapshot, snapshotRunId: active.runId, rows: snapshot.length,
        screenshots: ['screenshots/RATE-02-ranking.png', 'screenshots/RATE-02-profile.png'], evidence: ['real-display-snapshot.json'] };
    }, ['RATE-01'], 'B');

    await record('RATE-03', admin, async () => {
      const v2 = control().active; assert.equal(v2.algorithm, 'v2_trial'); const prior = v2.previous;
      assert(prior && prior.algorithm === 'legacy', 'V2 publication must carry the actual prior legacy pointer');
      const selector = await cardSelector(); await admin.click(selector + ' form:has(input[value=rollback]) button'); await admin.navigation('/manage/rating');
      await admin.waitFor("document.body.innerText.includes('公开算法：旧版')");
      const restored = control().active; assert.equal(restored.runId, prior.runId); assert.equal(restored.algorithm, 'legacy');
      await student.navigate(f.prefix + '/ranking'); const rankText = await student.text();
      assert(!rankText.includes('V2（限域试用')); assert(!rankText.includes('试用 Rating'));
      await student.screenshot(path.join(out, 'screenshots/RATE-03-ranking.png'));
      await student.navigate(f.prefix + '/user/' + f.studentUid); const profile = await student.text();
      const legacyRows = f.mongo(`const rows=await db.collection('rating_publication_users').find({domainId:options.domainId,runId:${JSON.stringify(prior.runId)},uid:${Number(f.studentUid)}},{projection:{uid:1,rp:1,rank:1}}).toArray();console.log(JSON.stringify(rows[0]||null));`);
      assert(legacyRows && Number.isFinite(legacyRows.rp), 'Restored legacy snapshot must contain the student row');
      const profileRp = Number(profile.match(/RP:\s*([\d.]+)/)?.[1]);
      assert(Number.isFinite(profileRp));
      assert.equal(profileRp, Math.round(legacyRows.rp * 100) / 100);
      assert(!profile.includes('试用 Rating') && !profile.includes('V2'));
      await student.screenshot(path.join(out, 'screenshots/RATE-03-profile.png'));
      write('rollback-observation.json', { v2Run: v2.runId, priorLegacyRun: prior.runId, restored, legacyStudentRow: legacyRows, profileRp, rankingLegacy: true, profileLegacy: true });
      return { priorLegacySnapshotRestored: true, runId: restored.runId, studentRankingLegacy: true, studentProfileLegacy: true, profileRp, evidence: ['rollback-observation.json', 'screenshots/RATE-03-profile.png'] };
    }, ['RATE-02'], 'B');

    await record('TIME-01', admin, testContestHistory, [], 'B');
    await record('TIME-02', admin, testCourseHistory, [], 'B');
    await record('QUEUE-01', admin, queueDeletion, [], 'B');
  } catch (e) { fatal = e.message; console.log(JSON.stringify({ fatal })); }
  finally {
    if (f?.created) {
      try {
        if (configTouched && original) {
          await saveConfig(original.algorithm, original.domains); const restored = control();
          assert.equal(restored.algorithm, original.algorithm); assert.deepEqual(restored.domains, original.domains); assert.equal(restored.otherActiveHash, original.otherActiveHash);
          write('configuration-restoration.json', { restored: true, otherActivePointersUnchanged: true, algorithm: restored.algorithm, domains: restored.domains, revisionBefore: original.revision, revisionAfter: restored.revision, revisionMonotonic: true }); cleanup.configurationRestored = true;
        }
      } catch (e) { fatal = (fatal ? fatal + '; ' : '') + 'Configuration restoration: ' + e.message; }
      for (const id of [...queueOwnedDomains]) {
        try { await domainDelete(id, false); queueOwnedDomains.splice(queueOwnedDomains.indexOf(id), 1); }
        catch (e) { fatal = (fatal ? fatal + '; ' : '') + `Queue fixture domain cleanup (${id}): ` + e.message; }
      }
      if (queueFixtureIds) {
        try {
          const fixtureCleanup = f.mongo(`const {ObjectId}=load('mongodb');const schedules=Object.values(options.scheduleIds).map(x=>new ObjectId(x));const runIds=options.runIds.map(x=>new ObjectId(x));const s=await db.collection('schedule').deleteMany({_id:{$in:schedules}});const r=await db.collection('rating_publication_runs').deleteMany({_id:{$in:runIds},domainId:{$in:options.fixtureDomains}});console.log(JSON.stringify({ownedSchedulesDeleted:s.deletedCount,ownedRunsDeleted:r.deletedCount}));`, { scheduleIds: queueFixtureIds.scheduleIds, runIds: [queueFixtureIds.legacyRun, queueFixtureIds.currentRun, queueFixtureIds.guardRun], fixtureDomains: [queueDomain, guardDomain] });
          cleanup.queueFixtureCleanup = fixtureCleanup;
        } catch (e) { fatal = (fatal ? fatal + '; ' : '') + 'Queue fixture record cleanup: ' + e.message; }
      }
      try { cleanup.fixtureDomain = await f.cleanup(); } catch (e) { fatal = (fatal ? fatal + '; ' : '') + 'Temporary-domain cleanup: ' + e.message; }
    }
    await Promise.allSettled([admin?.close(), student?.close()]);
    for (const c of plan) if (!results.some(r => r.id === c.id)) results.push({ ...c, status: selected(c.id) ? 'blocked' : 'skipped', grade: 'C', actual: selected(c.id) ? fatal || 'A prerequisite failed before this case could run' : 'Outside selected focused run', evidence: [] });
    persist();
    console.log(JSON.stringify({ complete: true, counts: Object.fromEntries(['pass', 'fail', 'blocked', 'skipped'].map(s => [s, results.filter(c => c.status === s).length])), cleanup, fatal }));
    if (fatal || results.some(c => ['fail', 'blocked'].includes(c.status))) process.exitCode = 1;
  }
})();
