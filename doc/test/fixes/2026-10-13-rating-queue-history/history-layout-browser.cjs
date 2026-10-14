const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../../..');
const nunjucks = require(path.join(root, 'node_modules/nunjucks'));
const browser = require(path.join(root, 'doc/test/scripts/lib/browser.cjs'));
const templatePath = 'packages/ui-default/templates/partials/contest_time_history.html';
const cssPath = 'packages/ui-default/public/theme-4.58.5.css';
const source = fs.readFileSync(path.join(root, templatePath), 'utf8');
const css = fs.readFileSync(path.join(root, cssPath), 'utf8');
const out = path.join(__dirname, 'evidence/history-layout');
fs.mkdirSync(out, { recursive: true });
const env = new nunjucks.Environment(null, { autoescape: true });
env.addGlobal('datetimeSpan', (value) => new Date(value).toISOString());
const history = [{ at: Date.UTC(2026, 9, 13, 8), uid: 2, state: 'ongoing', attend: 3, ratingEnabled: true,
    before: { beginAt: Date.UTC(2026, 9, 13, 7), endAt: Date.UTC(2026, 9, 13, 9), duration: 1 },
    after: { beginAt: Date.UTC(2026, 9, 13, 7), endAt: Date.UTC(2026, 9, 13, 10), duration: 2 } }];
const results = [];
async function run() {
    // Real Chrome login uses only the labelled local admin from testuser.txt.
    const b = await browser.create('admin');
    try {
        for (const width of [1500, 800, 375]) {
            await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
            for (const title of ['比赛', '课堂测试']) {
                for (const variant of ['before', 'fixed']) {
                    const template = variant === 'before' ? source.replace(' style="margin-top: 0;"', '') : source;
                    const html = env.renderString(template, { timeChangeHistory: history, timeHistoryTitle: title });
                    const { frameTree } = await b.send('Page.getFrameTree');
                    await b.send('Page.setDocumentContent', { frameId: frameTree.frame.id,
                        html: `<!doctype html><html data-app="Hydro" class="layout--basic theme--default hasjs" lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main class="section visible" style="margin:32px 16px;padding:24px"><h1>${title}设置：本地源码预览</h1>${html}</main></body></html>` });
                    await b.waitFor("document.querySelector('.contest-time-history summary')");
                    await b.click('.contest-time-history summary');
                    const observed = await b.evaluate(`(() => {
                        const summary = document.querySelector('.contest-time-history summary');
                        const help = document.querySelector('.contest-time-history .help-text');
                        const rect = e => { const r = e.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, height:r.height }; };
                        const a=rect(summary), c=rect(help);
                        return { open:summary.parentElement.open, sectionOpacity:getComputedStyle(document.querySelector('main')).opacity,
                            summary:a, help:c, marginTop:getComputedStyle(help).marginTop,
                            overlap:Math.max(0, a.bottom-c.top), horizontalTableScroll:document.querySelector('.data-table').parentElement.scrollWidth>document.querySelector('.data-table').parentElement.clientWidth };
                    })()`);
                    assert.equal(observed.open, true);
                    assert.equal(observed.sectionOpacity, '1');
                    if (variant === 'before') {
                        assert.ok(observed.overlap > 0, 'must reproduce the negative-margin regression');
                        assert.equal(observed.overlap, -parseFloat(observed.marginTop));
                    }
                    else { assert.equal(observed.overlap, 0); assert.equal(observed.marginTop, '0px'); }
                    const file = `${width}-${title === '比赛' ? 'contest' : 'course'}-${variant}.png`;
                    await b.send('Page.bringToFront');
                    await b.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
                    await browser.delay(500);
                    await b.screenshot(path.join(out, file));
                    results.push({ width, title, variant, ...observed, screenshot: file, status: 'pass' });
                }
            }
        }
    } finally { await b.close(); }
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({
        scope: 'Authenticated real Chrome; repository template preview using existing production CSS. The installed Hydro packages were not changed.',
        templatePath, cssPath, templateSha256: createHash('sha256').update(source).digest('hex'),
        cssSha256: createHash('sha256').update(css).digest('hex'), results,
    }, null, 2));
    console.log(JSON.stringify({ status: 'pass', cases: results.length, fixedCases: results.filter(x=>x.variant==='fixed').length, evidence: path.relative(root,out) }));
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
