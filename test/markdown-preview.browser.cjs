// Run after `node packages/ui-default/build` (development bundle).
// PLAYWRIGHT_MODULE can point at an existing playwright installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
require('@hydrooj/register');
const markdown = require('../packages/ui-default/backendlib/markdown');
const { normalizeLectureMarkdown } = require('../packages/ui-default/backendlib/lecture-markdown');

const publicDir = path.resolve(__dirname, '../packages/ui-default/public');
const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.json')));
const entry = manifest['hydro.js'] || Object.values(manifest).find((s) => /^\/hydro-[^/]+\.js/.test(s));
const diagram = [
    '```mermaid', 'graph TD', 'subgraph 计算机', 'subgraph 软件',
    'S1[系统软件<br/>常见的有Windows、Linux等]',
    'S2[应用软件<br/>如Office、QQ、Xmind等]', 'end',
    'A[硬件] --> B[运算器<br/>用于信息处理]', 'end', '```',
].join('\n');
const wrapped = `\x60\x60\x60markdown\n# 计算机讲义\n\n讲义正文。\n\n${diagram}\n\x60\x60\x60`;

async function assertUnclippedLabels(page, root) {
    const labels = await page.locator(`${root} .course-mermaid foreignObject`).evaluateAll((elements) => elements
        .filter((element) => element.textContent.trim())
        .map((element) => {
            const box = element.getBoundingClientRect();
            const content = element.firstElementChild.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element.firstElementChild);
            const text = range.getBoundingClientRect();
            return {
                label: element.textContent,
                fits: content.height <= box.height + 1 && content.width <= box.width + 1
                    && text.top >= box.top - 1 && text.bottom <= box.bottom + 1
                    && text.left >= box.left - 1 && text.right <= box.right + 1,
            };
        }));
    assert(labels.some(({ label }) => label.includes('Windows、Linux等')), 'multiline wrapped label is present');
    assert(labels.some(({ label }) => label.includes('Office、QQ、Xmind等')), 'explicit line break is present');
    assert.deepEqual(labels.filter(({ fits }) => !fits), [], `${root}: HTML labels must fit their SVG clipping boxes`);
    // The Mermaid reset must not remove paragraph spacing from the article.
    assert(await page.locator(`${root} > p`).first().evaluate((p) => parseFloat(getComputedStyle(p).paddingTop) > 0));
}

async function main() {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname === '/fixture') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><html data-page="contest_manage" class="theme--light"><body><form><textarea name="lecture"></textarea></form></body></html>');
            return;
        }
        const file = path.resolve(publicDir, `.${pathname}`);
        if (!file.startsWith(`${publicDir}/`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404).end();
            return;
        }
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
        await page.evaluate(() => {
            window.UiContext = JSON.stringify({ cdn_prefix: '/', domainId: 'test' });
            window.UserContext = JSON.stringify({ _id: 1, viewLang: 'zh', preferredEditorType: 'markdown' });
        });
        await page.addStyleTag({ url: manifest['theme.css'] });
        await page.addScriptTag({ url: entry });
        await page.evaluate(async () => {
            window.webpackChunk_hydrooj_ui_default.push([['preview-test'], {}, (require) => { window.testRequire = require; }]);
            await Promise.all(['theme', 'n.mantine', 'n.prismjs', 'n.dompurify', 'n.flatpickr',
                'n.react-dom', 'n.floating-ui', 'n.moment', 'n.lodash', 'n.js-yaml',
                'vendors-node_modules_simplewebauthn_browser_esm_index_js-node_modules_ansi_up_ansi_up_js-node-760d02',
                'default-api_ts'].map((id) => window.testRequire.e(id)));
            window.HydroExports = window.testRequire('./api.ts');
            // This fixture boots selected modules manually, without the normal
            // page loader that dismisses the loading overlay on real pages.
            document.querySelector('.page-loader')?.remove();
        });

        const lectureHtml = markdown.render(normalizeLectureMarkdown(wrapped));
        await page.evaluate(async (html) => {
            const root = document.createElement('main');
            root.id = 'lecture-main';
            root.className = 'typo';
            root.innerHTML = html;
            document.body.append(root);
            await window.testRequire('./pages/course_lecture.page.ts').default.afterLoading();
        }, lectureHtml);
        await page.waitForSelector('#lecture-main .course-mermaid svg');
        assert.equal(await page.locator('#lecture-main h1').textContent(), '计算机讲义');
        await assertUnclippedLabels(page, '#lecture-main');
        await page.setViewportSize({ width: 390, height: 844 });
        await assertUnclippedLabels(page, '#lecture-main');
        await page.setViewportSize({ width: 1280, height: 720 });

        await page.evaluate((source) => {
            document.querySelector('#lecture-main').remove();
            const field = document.querySelector('textarea');
            field.value = source;
            const Editor = window.testRequire('./components/editor/index.tsx').default;
            window.testEditor = new Editor(window.HydroExports.$(field));
            window.previewUpdates = 0;
            window.HydroExports.$(document).on('vjContentNew.test', () => { window.previewUpdates++; });
        }, wrapped);
        await page.waitForSelector('.md-editor-preview .course-mermaid svg', { timeout: 20000 });
        await assertUnclippedLabels(page, '.md-editor-preview');

        // A realistic >10k draft with many formulas, plus a Markdown code block
        // that used to enter Prism's synchronous Markdown grammar.
        const long = '# 长讲义\n\n' + '一段说明 **硬件** $a+b$ 与 `code`。\n\n'.repeat(1200)
            + '\n```markdown\n' + '**nested** [link](https://example.com)\n'.repeat(400) + '```\n';
        assert(long.length > 10000);
        await page.evaluate((source) => {
            window.tickGaps = [];
            let last = performance.now();
            window.tickTimer = setInterval(() => {
                const now = performance.now();
                window.tickGaps.push(now - last);
                last = now;
            }, 20);
            window.testEditor.value(source);
        }, long);
        await page.waitForFunction(() => document.querySelector('.md-editor-preview h1')?.textContent === '长讲义', { timeout: 20000 });
        await page.locator('.cm-content').click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type('\nLATEST-DRAFT', { delay: 12 });
        // Save immediately, before the asynchronous preview finishes.
        const saved = await page.evaluate(() => ({ value: window.testEditor.value(), field: document.querySelector('textarea').value }));
        assert(saved.value.endsWith('LATEST-DRAFT'));
        assert.equal(saved.value, saved.field);
        await page.waitForFunction(() => document.querySelector('.md-editor-preview')?.textContent.includes('LATEST-DRAFT'), { timeout: 20000 });
        // onHtmlChanged emits vjContentNew after a trailing 200ms debounce.
        await page.waitForTimeout(500);
        const before = await page.evaluate(() => window.previewUpdates);
        await page.waitForTimeout(1500);
        const result = await page.evaluate(() => {
            clearInterval(window.tickTimer);
            return { updates: window.previewUpdates, maxTickGap: Math.max(...window.tickGaps), workers: performance.getEntriesByType('resource').filter((e) => e.name.includes('markdown')).length };
        });
        assert.equal(result.updates, before, 'idle preview must stop updating');
        assert(result.maxTickGap < 2000, `UI stalled for ${result.maxTickGap}ms`);
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ lectureSvg: true, editSvg: true, characters: long.length, immediateSave: true, ...result }));
    } finally {
        await browser?.close();
        await new Promise((resolve) => server.close(resolve));
    }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
