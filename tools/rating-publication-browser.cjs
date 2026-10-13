// Live acceptance uses the local test administrator and restores configuration/publication afterwards.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../doc/test/scripts/lib/browser.cjs');
const H = require('../doc/test/scripts/lib/http.cjs');
const out = path.resolve('review/rating-publication-2026-10-13');
const checks = [];
const restoration = { attempted: false, config: false, publication: 'not-started', notes: [] };
const check = (name, result, details = {}) => { assert(result, name); checks.push({ name, pass: true, ...details }); };
async function adminPage(browser) {
    await browser.send('Page.navigate', { url: H.base + '/manage/rating' });
    await browser.waitFor(`document.readyState==='complete'&&(location.pathname.endsWith('/manage/rating')||location.pathname.endsWith('/user/sudo'))`, 25000);
    if ((await browser.location()).includes('/user/sudo')) {
        await browser.fill('input[name=password]', H.credential('admin').password);
        await browser.evaluate(`document.querySelector('form').requestSubmit()`);
        await browser.waitFor(`document.readyState==='complete'&&location.pathname.endsWith('/manage/rating')&&!!document.querySelector('select[name=algorithm]')`, 25000);
    }
}
async function dashboard(browser) {
    return browser.evaluate(`fetch('/manage/rating',{headers:{Accept:'application/json'}}).then(r=>r.json()).then(x=>x.dashboard)`);
}
async function save(browser, algorithm, domains = ['exam']) {
    await adminPage(browser);
    await browser.fill('select[name=algorithm]', algorithm);
    await browser.fill('textarea[name=domains]', domains.join('\n'));
    await browser.evaluate(`document.querySelector('input[name=op][value=save]').form.requestSubmit()`);
    await browser.waitFor(`document.readyState==='complete'&&!!document.querySelector('select[name=algorithm]')`, 15000);
    const expectedDomains = [...new Set(domains.map((domain) => domain.trim()).filter(Boolean))].sort();
    for (let i = 0; i < 30; i++) {
        const config = (await dashboard(browser)).config;
        if (config.algorithm === algorithm && [...config.domains].sort().join('\n') === expectedDomains.join('\n')) return;
        await B.delay(200);
    }
    throw Error('Configuration save did not complete');
}
async function action(browser, op) {
    await adminPage(browser);
    const selector = await browser.evaluate(`(()=>{const f=[...document.querySelectorAll('form')].find(f=>f.querySelector('[name=op]')?.value===${JSON.stringify(op)}&&f.querySelector('[name=domainId]')?.value==='exam');if(!f)throw Error('Missing exam action');f.setAttribute('data-rating-action','yes');return 'form[data-rating-action=yes] button'})()`);
    await browser.click(selector);
    await browser.navigation('/manage/rating');
}
async function awaitAlgorithm(browser, algorithm) {
    for (let i = 0; i < 240; i++) {
        const item = (await dashboard(browser)).domains.find((d) => d.domainId === 'exam');
        if (item.job?.status === 'failed') throw Error('Rating calculation failed: ' + item.job.error);
        if (item.active?.algorithm === algorithm && item.job?.status === 'complete') return item;
        await B.delay(500);
    }
    throw Error('Rating application did not finish');
}
async function waitForIdle(browser) {
    for (let i = 0; i < 240; i++) {
        const item = (await dashboard(browser)).domains.find((d) => d.domainId === 'exam');
        if (!['queued', 'running', 'ready'].includes(item.job?.status)) return item;
        await B.delay(500);
    }
    throw Error('Rating job did not leave queued/running state within two minutes');
}
async function restore(browser, original, oldActive) {
    restoration.attempted = true;
    if (!original) { restoration.notes.push('Original state was not captured.'); return; }
    try {
        let current = await waitForIdle(browser);
        if (oldActive?.runId && current.active?.runId !== oldActive.runId) {
            if (!current.active) throw Error('Original active run is missing and cannot be restored through the admin API');
            await action(browser, 'rollback');
            current = (await dashboard(browser)).domains.find((d) => d.domainId === 'exam');
            if (current.active?.runId !== oldActive.runId) throw Error('Admin rollback did not restore the original active run');
            restoration.publication = 'original-pointer-restored';
        } else if (!oldActive && current.active) {
            if (current.active.algorithm === 'legacy') {
                restoration.notes.push('The original pointer was absent. The current legacy bootstrap snapshot is an equivalent state; the admin API cannot remove the pointer.');
                restoration.publication = 'legacy-bootstrap-equivalent';
            } else {
                try { await action(browser, 'rollback'); } catch (error) { restoration.notes.push('Rollback to bootstrap snapshot was unavailable: ' + error.message); }
                current = (await dashboard(browser)).domains.find((d) => d.domainId === 'exam');
                if (!current.active || current.active.algorithm !== 'legacy') {
                    await save(browser, 'legacy', original.domains);
                    await action(browser, 'apply');
                    current = await awaitAlgorithm(browser, 'legacy');
                }
                restoration.notes.push('The original pointer was absent. Restored an equivalent legacy bootstrap state; the admin API cannot remove its pointer.');
                restoration.publication = 'legacy-bootstrap-equivalent';
            }
        } else restoration.publication = 'already-original';
    } catch (error) {
        restoration.publication = 'failed';
        restoration.notes.push('Publication restore failed: ' + error.message);
    }
    try {
        // Fallback publication may temporarily change the desired algorithm. Finish by
        // restoring the exact original algorithm and domain list through the admin form.
        await save(browser, original.algorithm, original.domains);
        restoration.config = true;
    } catch (error) { restoration.notes.push('Configuration restore failed: ' + error.message); }
}
async function main() {
    fs.mkdirSync(out, { recursive: true });
    const admin = await B.create('admin');
    let original;
    let oldActive;
    let primaryError;
    try {
        await adminPage(admin);
        const initial = await dashboard(admin);
        original = initial.config;
        oldActive = initial.domains.find((d) => d.domainId === 'exam')?.active || null;
        check('administrator can open rating management', !!original);
        await admin.screenshot(out + '/admin-initial.png');
        const probeAlgorithm = oldActive?.algorithm === 'v2_trial' ? 'legacy' : 'v2_trial';
        const probeDomains = probeAlgorithm === 'v2_trial' ? [...new Set([...original.domains, 'exam'])] : original.domains;
        await save(admin, probeAlgorithm, probeDomains);
        let pending = (await dashboard(admin)).domains.find((d) => d.domainId === 'exam');
        check('saving a configuration does not change active publication', pending.pending && pending.active?.runId === oldActive?.runId);
        await save(admin, 'v2_trial', [...new Set([...original.domains, 'exam'])]);
        pending = (await dashboard(admin)).domains.find((d) => d.domainId === 'exam');
        check('saving V2 preserves the active pointer until apply', pending.pending === (oldActive?.algorithm !== 'v2_trial') && pending.active?.runId === oldActive?.runId);
        await adminPage(admin);
        await admin.screenshot(out + '/admin-pending.png');
        await action(admin, 'apply');
        const active = await awaitAlgorithm(admin, 'v2_trial');
        check('manual apply publishes V2', active.active.algorithm === 'v2_trial', { runId: active.active.runId });
        check('admin comparison is available', active.comparison.length > 0, { top: active.comparison.slice(0, 5) });
        await adminPage(admin);
        await admin.screenshot(out + '/admin-v2.png');
        await admin.navigate('/d/exam/ranking');
        const content = await admin.text();
        check('public ranking displays V2 fields', content.includes('V2（试用）') && content.includes('能力 Rating') && content.includes('题目分 P'));
        await admin.screenshot(out + '/exam-ranking-v2.png');
        const uid = active.comparison[0].uid;
        await admin.navigate('/d/exam/user/' + uid);
        check('user profile displays V2 score', (await admin.text()).includes('V2（试用）'));
        await admin.screenshot(out + '/exam-profile-v2.png');
        const student = await B.create('student');
        try {
            const denied = await H.get(student.agent, '/manage/rating');
            check('student cannot access rating management', denied.status === 403, { status: denied.status });
            const mutation = await H.post(student.agent, '/manage/rating', { op: 'save', algorithm: 'legacy', domains: 'exam' });
            check('student cannot switch algorithm', mutation.status === 403, { status: mutation.status });
        } finally { await student.close(); }
        await action(admin, 'rollback');
        const rolled = (await dashboard(admin)).domains.find((d) => d.domainId === 'exam');
        const expectedAlgorithm = oldActive?.algorithm || 'legacy';
        check('rollback restores the original publication algorithm', rolled.active.algorithm === expectedAlgorithm);
        if (oldActive?.runId) check('rollback restores the exact original active run', rolled.active.runId === oldActive.runId);
        await admin.navigate('/d/exam/ranking');
        check('ranking returns to the original algorithm after rollback', (await admin.text()).includes(expectedAlgorithm === 'v2_trial' ? 'V2（试用）' : '旧版') );
        await admin.screenshot(out + '/exam-ranking-rollback.png');
        check('no browser JavaScript exceptions', admin.exceptions.length === 0, { exceptions: admin.exceptions });
    } catch (error) {
        primaryError = error;
    } finally {
        try {
            if (original) await restore(admin, original, oldActive);
            await adminPage(admin);
            await admin.screenshot(out + '/admin-restored.png');
        } catch (error) { restoration.notes.push('Final evidence capture failed: ' + error.message); }
        fs.writeFileSync(out + '/browser-results.json', JSON.stringify({ checks, originalConfig: original, originalActive: oldActive, restoration, error: primaryError?.message }, null, 2));
        await admin.close();
    }
    if (primaryError) throw primaryError;
    if (restoration.publication === 'failed' || !restoration.config) throw Error('Acceptance passed but environment restoration failed; see browser-results.json');
    console.log(JSON.stringify({ passed: checks.length, evidence: out }));
}
module.exports = { restore, restoration };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
