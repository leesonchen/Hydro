'use strict';
// Release-specific browser checks. Credentials stay in memory; all mutable data belongs to one temporary domain.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../../../..');
const B = require(path.join(repo, 'doc/test/scripts/lib/browser.cjs'));
const h = require(path.join(repo, 'doc/test/scripts/lib/http.cjs'));
const { Fixtures, sleep } = require(path.join(repo, 'doc/test/scripts/lib/fixtures.cjs'));
const flag = name => { const at=process.argv.indexOf('--'+name); return at<0 ? null : process.argv[at+1]; };
const displayFixture=process.argv.includes('--display-fixture');
const only=(flag('only')||'').split(',').filter(Boolean);
const out = path.resolve(flag('out') || path.join(__dirname, 'evidence/supplemental'));
fs.mkdirSync(path.join(out, 'screenshots'), { recursive: true });
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-cases.json'))).filter(c => /^(PUB|RANK|TIME|RECALC)-/.test(c.id) && (!displayFixture || ['RANK-01','RANK-02','RANK-03','PUB-05'].includes(c.id)) && (!only.length || only.includes(c.id)));
const cases = [];
let a, s, f, original, cleanup, fatal, configurationTouched = false;
const write = (file, value) => fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2) + '\n');
const persist = () => write('browser-results.json', { updatedAt: new Date().toISOString(), cases, cleanup, fatal });
async function run(id, browser, action, dependencies = [], grade = 'A') {
  if(!plan.some(c=>c.id===id))return;
  if(displayFixture)dependencies=dependencies.filter(id=>id!=='PUB-04');
  const c = { ...plan.find(x => x.id === id), status: 'pass', grade, startedAt: new Date().toISOString(), evidence: [] };
  const missing = dependencies.find(x => cases.find(c => c.id === x)?.status !== 'pass');
  if (missing) { c.status = 'blocked'; c.actual = { prerequisite: missing }; }
  else {
    const responseStart = browser.responses.length;
    const exceptionStart = browser.exceptions.length;
    try { c.actual = await action(); }
    catch (e) { const driver=/Browser wait|CDP timeout|Missing browser|Browser evaluation|context.*destroy/i.test(e.message); c.status = e.applicationFailure ? 'fail' : driver ? 'blocked' : 'fail'; c.failureClass=e.applicationFailure?'application':driver?'driver':'needs-triage'; c.actual = { error: e.message, ...(e.observed?{observed:e.observed}:{}) }; }
    c.browserResponses = browser.responses.slice(responseStart);
    c.jsExceptions = browser.exceptions.slice(exceptionStart);
    if (c.jsExceptions.length && c.status === 'pass') { c.status = 'fail'; c.actual.jsExceptions = c.jsExceptions; }
    try { const image = 'screenshots/' + id + '.png'; await browser.screenshot(path.join(out, image)); c.evidence.push(image); c.url = await browser.location(); } catch { }
  }
  c.finishedAt = new Date().toISOString(); cases.push(c); persist(); console.log(JSON.stringify({ id, status: c.status, actual: c.actual }));
}
async function manage() {
  await a.navigate('/manage/rating');
  if ((await a.location()).includes('/user/sudo')) {
    await a.fill('input[name="password"]', h.credential('admin').password);
    await a.click('form:has(input[name="password"]) button[type="submit"]');
    await a.navigation('/manage/rating');
  }
  await a.waitFor("!!document.querySelector('textarea[name=domains]')");
}
async function saveConfig(algorithm, domains) {
  await manage(); await a.fill('select[name=algorithm]', algorithm); await a.fill('textarea[name=domains]', domains.join('\n'));
  await a.click('form:has(input[name=op][value=save]) button[type=submit]');
  await a.navigation('/manage/rating');
}
const readControl = () => f.mongo(`const doc=await db.collection('system').findOne({_id:'rating.publication'});const v=doc?.value||{algorithm:'legacy',domains:['exam'],revision:0,active:{}};const key=Buffer.from(options.domainId).toString('base64url');const active={...v.active};delete active[key];const crypto=load('node:crypto');console.log(JSON.stringify({algorithm:v.algorithm,domains:v.domains,revision:v.revision,otherActiveHash:crypto.createHash('sha256').update(JSON.stringify(active)).digest('hex'),active:v.active?.[key]?{algorithm:v.active[key].algorithm,runId:v.active[key].runId}:null}));`);
async function tagDomain() {
  return a.evaluate(`(()=>{const input=[...document.querySelectorAll('input[name=domainId]')].find(e=>e.value===${JSON.stringify(f.domainId)});if(!input)throw Error('Temporary domain card missing');const card=input.closest('.section');card.setAttribute('data-test-rating-domain','owned');card.scrollIntoView({block:'center'});return '[data-test-rating-domain=owned]'})()`);
}
async function waitApplied(algorithm) {
  const deadline = Date.now() + 100000;
  const observations=[];
  while (Date.now() < deadline) {
    await manage(); const selector = await tagDomain();
    const text = await a.evaluate(`document.querySelector(${JSON.stringify(selector)}).innerText`);
    await a.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    const state=f.mongo(`const r=await db.collection('rating_publication_runs').find({domainId:options.domainId,referenceOnly:{$ne:true}},{projection:{algorithm:1,status:1,asOf:1}}).sort({asOf:-1}).limit(1).toArray();console.log(JSON.stringify(r.map(x=>({algorithm:x.algorithm,status:x.status}))));`);
    observations.push({at:new Date().toISOString(),ui:text,job:state[0]});write('queue-observations.json',observations);
    const active = readControl().active;
    if (text.includes('最近任务：已应用') && active?.algorithm === algorithm) return text;
    if (text.includes('最近任务：失败')) throw Error('Temporary domain rating task failed');
    await sleep(1500);
  }
  const error=Error('手工应用等待 100 秒仍未完成');error.applicationFailure=true;error.observed=observations.at(-1);throw error;
}
async function enroll() {
  await s.navigate(f.prefix + f.course); await s.click('form:has(input[name=operation][value=attend]) button[type=submit]'); await s.navigation(f.course);
}
(async () => {
  try {
    [a, s] = await Promise.all([B.create('admin'), B.create('student')]);
    write('environment.json', { baseUrl: h.base, browser: await a.send('Browser.getVersion'), viewport: { width: 1500, height: 1000 }, externalNetworkBlocked: true, credentials: 'testuser.txt local labels' });
    f = new Fixtures(a, s, out, 'hydro'); await f.setup(); original = readControl();
    write('initial-configuration.json', { algorithm: original.algorithm, domains: original.domains, revision:original.revision, otherActiveHash: original.otherActiveHash });
    if(!displayFixture){
    await run('PUB-01', a, async () => {
      await manage(); const state = await a.evaluate("({heading:document.querySelector('h1').innerText,algorithm:document.querySelector('[name=algorithm]').value,manualNotice:document.body.innerText.includes('不会自动切换'),buttons:[...document.querySelectorAll('button')].filter(e=>e.innerText.includes('重算并应用')).length})");
      assert.equal(state.heading, '评分发布管理'); assert(state.manualNotice && state.buttons > 0); return state;
    });
    await run('PUB-02', s, async () => {
      await s.navigate('/manage/rating'); const response = [...s.responses].reverse().find(r => r.path === '/manage/rating');
      assert.equal(response?.status, 403); assert(!await s.evaluate("!!document.querySelector('textarea[name=domains]')")); return { http: 403, managementFormAbsent: true };
    });
    await run('PUB-06', a, async () => {
      const before = readControl(); await saveConfig('v2_trial', [f.domainId + '-missing']);
      await a.waitFor("document.body.innerText.includes('试用域不存在')"); const after = readControl();
      if (after.algorithm !== before.algorithm || JSON.stringify(after.domains) !== JSON.stringify(before.domains)) configurationTouched = true;
      assert.equal(after.algorithm, before.algorithm); assert.deepEqual(after.domains, before.domains); assert.equal(after.revision, before.revision);
      return { invalidDomainRejected: true, configurationUnchanged: true };
    });
    await run('TIME-05', a, async () => {
      await a.navigate(f.prefix + '/contest/' + f.settingsTid + '/edit');
      const before = (await f.read('/contest/' + f.settingsTid)).tdoc;
      await a.fill('input[name=duration]', '2'); await a.click('form button[name=operation][value=update]:not([formaction])');
      await a.waitFor("document.body.innerText.includes('修改时间可能影响')"); await a.clickText('是', 'button'); await a.navigation('/contest/' + f.settingsTid);
      await a.navigate(f.prefix + '/contest/' + f.settingsTid + '/edit'); await a.waitFor("!!document.querySelector('.contest-time-history')"); await a.click('.contest-time-history summary');
      const visible = await a.evaluate("document.querySelector('.contest-time-history').innerText");
      assert(visible.includes('修改前') && visible.includes('修改后') && visible.includes('UID ' + f.adminUid));
      const after = (await f.read('/contest/' + f.settingsTid)).tdoc; assert.equal(after.beginAt, before.beginAt); assert.notEqual(after.endAt, before.endAt);
      const count = after.timeChangeHistory.length; await a.navigate(f.prefix + '/contest/' + f.settingsTid + '/edit'); await a.click('.contest-time-history summary');
      assert.equal(await a.evaluate("document.querySelectorAll('.contest-time-history tbody tr').length"), count);
      return { warningConfirmed: true, persistedHistoryCount: count, actorDisplayed: true, onlyEndChanged: true };
    });
    if(plan.some(c=>c.id.startsWith('RECALC-')))await enroll();
    await run('RECALC-01', a, async () => {
      const state = f.mongo(`const {ObjectId}=load('mongodb');const q={domainId:options.domainId,docType:30,docId:new ObjectId(${JSON.stringify(f.examTid)})};const t=await db.collection('document').findOne(q);await db.collection('document').updateOne(q,{$set:{statsRecalc:{revision:t.statsRevision||0,token:new ObjectId(),state:'failed',requestedAt:new Date(),settingsSaved:true}}});console.log(JSON.stringify({prepared:true}));`);
      assert(state.prepared); await a.navigate(f.prefix + f.course + '/edit'); await a.waitFor("document.body.innerText.includes('设置已保存，成绩重算失败')");
      assert(await a.evaluate("!!document.querySelector('form[data-retry-recalc] button')"));await a.evaluate("document.querySelector('.contest-recalc-state').scrollIntoView({block:'center'})");
      await s.navigate(f.prefix + f.course); await s.waitFor("document.body.innerText.includes('测试成绩重算失败')");await s.evaluate("[...document.querySelectorAll('[role=status]')].find(e=>e.innerText.includes('测试成绩重算失败')).scrollIntoView({block:'center'})"); await s.screenshot(path.join(out, 'screenshots/RECALC-01-student.png'));
      assert((await s.text()).includes('达标结果待确认') || (await s.text()).includes('请教师'));
      return { failureFixture: true, teacherRetryVisible: true, studentPendingVisible: true, studentScreenshot: 'screenshots/RECALC-01-student.png' };
    }, [], 'B');
    await run('RECALC-02', a, async () => {
      await a.click('form[data-retry-recalc] button'); await a.navigation(f.course + '/edit');
      assert(!await a.evaluate("!!document.querySelector('.contest-recalc-state')")); const exam = (await f.read(f.exam)).tdoc; assert(!exam.statsRecalc);
      await s.navigate(f.prefix + f.course); assert(!(await s.text()).includes('测试成绩重算失败'));
      return { retryClicked: true, teacherFailureStateRemoved: true, studentFailureStateRemoved: true, backendRecalculationComplete: true };
    }, ['RECALC-01'], 'B');
    // Prepare genuine public achievement input through the student browser before rating publication.
    if(plan.some(c=>c.id==='PUB-04')){
    await s.navigate(f.prefix + '/p/' + f.p1); await s.waitFor("!!document.querySelector('.objective-input[name=\"1\"]')");
    await s.fill('.objective-input[name="1"]', 'A'); await s.click('.problem-content input[type=submit]'); await s.navigation('/record/');
    await s.waitFor("document.body.innerText.includes('Accepted')", 45000); await s.screenshot(path.join(out, 'screenshots/public-achievement-input.png'));}
    await run('PUB-03', a, async () => {
      configurationTouched = true; await saveConfig('v2_trial', [f.domainId]); await manage(); const control = readControl(); assert.equal(control.algorithm, 'v2_trial'); assert.deepEqual(control.domains, [f.domainId]); assert.equal(control.active, null);
      const selector = await tagDomain(); const text = await a.evaluate(`document.querySelector(${JSON.stringify(selector)}).innerText`); assert(text.includes('公开算法：旧版') && text.includes('等待手工重算并应用'));
      return { savedAlgorithm: 'v2_trial', savedOnlyTemporaryDomain: true, publicAlgorithmStillLegacy: true, manualApplyRequired: true };
    });
    await run('PUB-04', a, async () => {
      const selector = await tagDomain(); await a.click(selector + ' form:has(input[value=apply]) button'); const text = await waitApplied('v2_trial');
      assert(text.includes('公开算法：V2 试用版') && /比赛 \d+ 场，课堂测试 \d+ 场/.test(text)); return { taskComplete: true, publicAlgorithm: 'v2_trial', sourceBreakdownVisible: true, temporaryDomainOnly: true };
    }, ['PUB-03'], 'B');
    }else{
      f.mongo(`const {randomUUID}=load('node:crypto');const now=Date.now(),key=Buffer.from(options.domainId).toString('base64url');const legacy=randomUUID(),v2=randomUUID();const rows=[{uid:${f.adminUid},rp:90,rank:1,join:true,visible:true,level:0,rpInfo:{problem:90,contest:0},rating:null,ratedEvents:0,achievement:4,tier:'bronze',tierName:'青铜'},{uid:${f.studentUid},rp:50,rank:2,join:true,visible:true,level:0,rpInfo:{problem:50,contest:0},rating:null,ratedEvents:0,achievement:2,tier:'bronze',tierName:'青铜'}];for(const [id,algorithm]of [[legacy,'legacy'],[v2,'v2_trial']]){await db.collection('rating_publication_runs').insertOne({_id:id,domainId:options.domainId,algorithm,status:'complete',asOf:now,completedAt:now,count:2,diagnostics:{fixture:true}});await db.collection('rating_publication_users').insertMany(rows.map(row=>({domainId:options.domainId,runId:id,...row})));}const previous={domainId:options.domainId,algorithm:'legacy',runId:legacy,version:randomUUID(),updatedAt:now};await db.collection('system').updateOne({_id:'rating.publication'},{$set:{['value.active.'+key]:{domainId:options.domainId,algorithm:'v2_trial',runId:v2,version:randomUUID(),updatedAt:now,previous}}});await db.collection('domain.user').updateOne({domainId:options.domainId,uid:${f.adminUid}},{$set:{join:true}});console.log(JSON.stringify({fixturePrepared:true}));`);
      write('display-fixture.json',{preparation:'Scoped synthetic legacy/V2 snapshots in temporary domain; does not prove manual apply works',globalTargetConfigurationChanged:false});
    }
    await run('RANK-01', s, async () => {
      await s.navigate(f.prefix + '/ranking'); const text = await s.text(); assert(text.includes('V2（限域试用，非认证竞赛能力）') && text.includes('试用 Rating') && text.includes('成就 A') && text.includes('比赛分 C'));
      const row = await s.evaluate(`([...document.querySelectorAll('tbody tr')].find(r=>r.querySelector('a[href$="/user/${f.studentUid}"]')))?.innerText`);
      assert(row && row.includes('暂定')); return { v2ExplanationVisible: true, ratingColumnsVisible: true, studentProvisionalVisible: true, studentRow: row };
    }, ['PUB-04'], 'B');
    await run('RANK-02', s, async () => {
      await s.navigate(f.prefix + '/user/' + f.studentUid); const text = await s.text(); assert(text.includes('试用 Rating') && text.includes('成就 A') && text.includes('分项 P / C') && text.includes('暂定'));
      return { trialRatingVisible: true, achievementVisible: true, ratingPartsVisible: true, provisionalVisible: true };
    }, ['PUB-04'], 'B');
    await run('RANK-03', s, async () => {
      f.mongo(`const key=Buffer.from(options.domainId).toString('base64url');const ctl=await db.collection('system').findOne({_id:'rating.publication'});const runId=ctl.value.active[key].runId;for(const [uid,rp,rank]of [[${f.adminUid},90,1],[${f.studentUid},50,2]])await db.collection('rating_publication_users').updateOne({domainId:options.domainId,runId,uid},{$set:{rp,rank,join:true,visible:true,rpInfo:{problem:rp,contest:0}}},{upsert:true});await db.collection('domain.user').updateOne({domainId:options.domainId,uid:${f.adminUid}},{$set:{join:true}});console.log(JSON.stringify({prepared:true}));`);
      await s.navigate(f.prefix + '/ranking');
      const visibleRows = () => s.evaluate("[...document.querySelectorAll('tbody tr')].map(r=>({rank:r.querySelector('td.col--rank')?.innerText.trim(),uid:r.querySelector('a.user-profile-name')?.getAttribute('href')?.split('/').pop()}))");
      const before = await visibleRows(); assert(before.some(r => r.uid === String(f.studentUid) && r.rank === '2'));
      await s.screenshot(path.join(out, 'screenshots/RANK-03-before-leave.png'));
      f.mongo(`await db.collection('domain.user').updateOne({domainId:options.domainId,uid:${f.adminUid}},{$set:{join:false}});console.log(JSON.stringify({prepared:true}));`);
      await s.navigate(f.prefix + '/ranking'); const after = await visibleRows(); assert(!after.some(r => r.uid === String(f.adminUid))); write('live-ranking-observation.json',{before,after}); assert(after.some(r => r.uid === String(f.studentUid) && r.rank === '1'));assert(after.filter(r=>r.uid===String(f.studentUid)).every(r=>r.rank==='1'),'Current user and leaderboard ranks must both recompact to 1');
      return { fixture: 'owned publication rows with deterministic scores', studentRankBefore: 2, studentRankAfter: 1, departedMemberAbsent: true };
    }, ['PUB-04'], 'B');
    await run('PUB-05', a, async () => {
      await manage(); const selector = await tagDomain(); await a.click(selector + ' form:has(input[value=rollback]) button'); await a.navigation('/manage/rating'); const card = await tagDomain();
      const text = await a.evaluate(`document.querySelector(${JSON.stringify(card)}).innerText`); assert(text.includes('公开算法：旧版'));
      assert.equal(readControl().active.algorithm, 'legacy'); await s.navigate(f.prefix + '/ranking'); assert(!(await s.text()).includes('V2（限域试用'));
      return { rollbackClicked: true, publicAlgorithmRestored: 'legacy', studentRankingLegacy: true };
    }, ['PUB-04'], 'B');
  } catch (e) { fatal = e.message; console.log(JSON.stringify({ fatal })); }
  finally {
    if (f?.created) {
      if (configurationTouched && original) {
        try { await saveConfig(original.algorithm, original.domains); const restored = readControl(); assert.equal(restored.algorithm, original.algorithm); assert.deepEqual(restored.domains, original.domains); assert.equal(restored.otherActiveHash, original.otherActiveHash); write('configuration-restoration.json', { restored: true, otherDomainsUnchanged: true, algorithm: restored.algorithm, domains: restored.domains,revisionBefore:original.revision,revisionAfter:restored.revision,revisionNote:'Monotonic revision is intentionally not rewound' }); }
        catch (e) { fatal = (fatal ? fatal + '; ' : '') + 'Configuration restore: ' + e.message; }
      }
      try { const runIds=f.mongo(`const ids=await db.collection('rating_publication_runs').distinct('_id',{domainId:options.domainId});if(await db.collection('rating_publication_runs').countDocuments({domainId:options.domainId,status:{$in:['running','ready']}}))throw Error('Publication still running');const deleted=await db.collection('schedule').deleteMany({subType:'task.rating-publication',runId:{$in:ids}});console.log(JSON.stringify(ids));`); cleanup = await f.cleanup(); const publication = f.mongo(`const key=Buffer.from(options.domainId).toString('base64url');const c=await db.collection('system').findOne({_id:'rating.publication'});console.log(JSON.stringify({runs:await db.collection('rating_publication_runs').countDocuments({domainId:options.domainId}),users:await db.collection('rating_publication_users').countDocuments({domainId:options.domainId}),pendingSchedules:await db.collection('schedule').countDocuments({runId:{$in:${JSON.stringify(runIds)}}}),activePointer:!!c?.value?.active?.[key],lock:!!c?.value?.locks?.[key],receipt:!!c?.value?.receipts?.[key]}));`); assert.equal(publication.runs, 0); assert.equal(publication.users, 0); assert.equal(publication.pendingSchedules,0); assert(!publication.activePointer && !publication.lock && !publication.receipt); write('publication-cleanup.json', publication); }
      catch (e) { fatal = (fatal ? fatal + '; ' : '') + 'Cleanup: ' + e.message; }
    }
    await Promise.allSettled([a?.close(), s?.close()]);
    for (const c of plan) if (!cases.some(r => r.id === c.id)) cases.push({ ...c, status: 'blocked', grade: 'C', actual: fatal || 'Prerequisite unavailable', evidence: [] });
    persist(); console.log(JSON.stringify({ complete: true, counts: Object.fromEntries(['pass','fail','blocked'].map(status => [status, cases.filter(c => c.status === status).length])), fatal }));
    if (fatal || cases.some(c => c.status !== 'pass')) process.exitCode = 1;
  }
})();
