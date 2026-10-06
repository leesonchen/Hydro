// Run against classroom-feedback-browser.js's disposable runtime only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.HYDRO_PLAYWRIGHT_MODULE || 'playwright');
const url = process.argv[2];
if (!url?.includes('/feedback-preview')) throw new Error('Pass the isolated harness FEEDBACK_PREVIEW_URL.');
const output = path.resolve(process.env.HYDRO_FEEDBACK_BROWSER_OUTPUT || 'review/assets/course-feedback-2026-10-06');
fs.mkdirSync(output, { recursive: true });

(async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => {
        console.error('BROWSER_PAGE_ERROR', page.url(), error.stack || error.message);
        errors.push(error.message);
    });
    page.on('console', (message) => {
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
            console.error('BROWSER_CONSOLE_ERROR', page.url(), message.text());
            errors.push(message.text());
        }
    });
    page.on('response', (response) => {
        if (response.status() >= 400 && ['script', 'stylesheet', 'font'].includes(response.request().resourceType())) {
            errors.push('Asset ' + response.status() + ': ' + response.url());
        }
    });
    const origin = new URL(url).origin;
    const count = async () => (await (await page.request.get(origin + '/feedback-preview-audit')).json()).events.length;
    const status = page.locator('.cf-notice');
    const row = (uid) => page.locator(`[data-feedback-student="${uid}"]`);
    const waitMessage = (text) => page.waitForFunction((expected) => document.querySelector('.cf-notice')?.textContent.includes(expected), text);
    const checks = [];
    const check = async (name, run) => { await run(); checks.push(name); console.log('BROWSER_PASS', name); };
    try {
        await page.goto(url);
        await page.locator('.cf-roster').waitFor();
        const builtUI = await page.locator('script[src*="hydro-"]').count() > 0;
        if (builtUI) {
            await page.waitForFunction(() => window.Hydro?.pageInstances?.length > 0);
            const productionScript = await page.locator('script[src*="hydro-"]').getAttribute('src');
            assert(productionScript.includes('hydro-' + require('../packages/ui-default/package.json').version + '.js'));
            assert.equal(await page.locator('script[src="/feedback-preview.js"]').count(), 0);
        }
        const endpoint = page.url().split('?')[0];
        const base = endpoint.replace(/\/feedback$/, '');
        if (builtUI) await check('production Monaco loads real TypeScript declarations as text', async () => {
            const libraries = await page.evaluate(async () => {
                const { monaco } = await window.HydroExports.loadMonaco(['typescript']);
                const libs = monaco.languages.typescript.javascriptDefaults.getExtraLibs();
                return { count: Object.keys(libs).length,
                    fs: Object.values(libs).some((lib) => lib.content.includes('declare module "fs"')) };
            });
            assert(libraries.count > 50, JSON.stringify(libraries));
            assert.equal(libraries.fs, true);
        });
        await check('A records once with an optional draft, preserves context, and rejects mismatched details', async () => {
            await page.getByLabel('课时', { exact: true }).selectOption('1');
            await page.getByLabel('题目', { exact: true }).selectOption('1');
            await row(3).getByRole('button', { name: '细项 / 备注', exact: true }).click();
            await page.getByLabel('备注（可空，最多 500 字）').fill('需要再检查循环边界');
            await page.getByLabel('细项（可空）').selectOption('GUIDED:IDEA');
            await page.getByLabel('题目', { exact: true }).selectOption('2');
            await page.getByLabel('题目', { exact: true }).selectOption('1');
            assert.equal(await page.getByLabel('备注（可空，最多 500 字）').inputValue(), '需要再检查循环边界');
            const before = await count();
            await row(3).getByRole('button', { name: '核对过', exact: true }).click();
            await waitMessage('细项属于其他动作');
            assert.equal(await count(), before);
            await row(3).getByRole('button', { name: '指导过', exact: true }).click();
            await waitMessage('已记录：陈同学');
            assert.equal(await count(), before + 1);
            assert.equal(await page.getByLabel('备注（可空，最多 500 字）').inputValue(), '');
            await page.screenshot({ path: path.join(output, 'a-roster.png'), fullPage: true });
        });
        await check('pending retests complete and undo the exact resolution while retaining history', async () => {
            await row(4).getByRole('button', { name: '需复测', exact: true }).click();
            await waitMessage('已记录：何同学');
            await page.getByRole('tab', { name: /待复测/ }).click();
            await page.getByRole('button', { name: '完成跟进', exact: true }).click();
            await waitMessage('已完成跟进');
            await status.getByRole('button', { name: '撤销这次处理', exact: true }).click();
            await waitMessage('恢复待跟进');
            await page.getByRole('button', { name: '详情', exact: true }).click();
            await page.getByRole('region', { name: '观察详情' }).waitFor();
            const detail = await page.getByRole('region', { name: '观察详情' }).innerText();
            assert(detail.includes('完成跟进') && detail.includes('撤销处理') && detail.includes('记录时提交') && detail.includes('跟进时提交'));
            await page.screenshot({ path: path.join(output, 'pending-retest.png'), fullPage: true });
            await page.getByRole('button', { name: '关闭详情', exact: true }).click();
            await page.getByRole('tab', { name: '名单录入', exact: true }).click();
        });
        await check('lost receipt and a denied replay retain the original request without duplicating the observation', async () => {
            const before = await count();
            await page.request.post(origin + '/feedback-preview-fault', { data: {} });
            await row(5).getByRole('button', { name: '指导过', exact: true }).click();
            await waitMessage('保存状态待确认');
            await page.request.post(origin + '/feedback-preview-fault', { data: { deny: true } });
            await page.getByRole('button', { name: '重试本次操作', exact: true }).click();
            await waitMessage('原操作状态仍待确认');
            await page.getByRole('button', { name: '重试本次操作', exact: true }).click();
            await waitMessage('已记录：林同学');
            assert.equal(await count(), before + 1);
        });
        await check('a confirmed save survives read failure and does not offer a new write retry', async () => {
            const before = await count();
            await page.route('**/feedback?*', async (route) => route.request().method() === 'GET' ? route.abort() : route.continue());
            await row(6).getByRole('button', { name: '核对过', exact: true }).click();
            await waitMessage('已记录：王同学');
            await page.getByRole('alert').filter({ hasText: '已确认保存' }).waitFor();
            assert.equal(await page.getByRole('button', { name: '重试本次操作', exact: true }).count(), 0);
            await page.unroute('**/feedback?*');
            await page.getByRole('button', { name: '刷新', exact: true }).click();
            assert.equal(await count(), before + 1);
        });
        await check('B remembers lesson and draft across real PJAX, filters, collapse and re-opening', async () => {
            await page.goto(base + '/scoreboard/0');
            const entry = page.locator('.cf-scoreboard-entry[data-feedback-uid="3"][data-feedback-pid="1"]');
            await entry.click();
            const panel = page.locator('.cf-scoreboard-editor');
            await panel.getByLabel('课时', { exact: true }).selectOption('1');
            await panel.getByRole('button', { name: '细项 / 备注', exact: true }).click();
            await panel.getByLabel('备注（可空，最多 500 字）').fill('刷新也保留本学生草稿');
            await page.request.post(origin + '/feedback-preview-score-change', { data: {} });
            await page.evaluate(() => { window.__feedbackOldFragment = document.querySelector('[data-fragment-id="scoreboard"]'); });
            const refreshed = page.waitForResponse((response) => response.url().includes('pjax=1'));
            await page.evaluate(() => window.__feedbackRefresh ? window.__feedbackRefresh()
                : window.HydroExports.pjax.request({ url: location.pathname, push: false }));
            const response = await refreshed;
            assert.equal(response.status(), 200);
            assert(Array.isArray((await response.json()).fragments));
            await page.waitForFunction(() => !window.__feedbackOldFragment.isConnected);
            assert((await entry.locator('xpath=ancestor::tr').innerText()).includes('36'));
            if (!await panel.getByLabel('备注（可空，最多 500 字）').isVisible()) {
                await panel.getByRole('button', { name: '继续编辑', exact: true }).click();
            }
            assert.equal(await panel.getByLabel('课时', { exact: true }).inputValue(), '1');
            assert.equal(await panel.getByLabel('备注（可空，最多 500 字）').inputValue(), '刷新也保留本学生草稿');
            await entry.evaluate((link) => {
                window.__feedbackMissingStudentRow = link.closest('tr');
                window.__feedbackMissingStudentRow.remove();
                window.$(document).trigger('vjContentNew');
            });
            await panel.getByRole('status').filter({ hasText: '当前成绩表已无原学生' }).waitFor();
            assert(await panel.getByRole('button', { name: '指导过', exact: true }).isDisabled());
            assert.equal(await panel.getByLabel('备注（可空，最多 500 字）').inputValue(), '刷新也保留本学生草稿');
            await page.evaluate(() => {
                document.querySelector('[data-fragment-id="scoreboard"] tbody').prepend(window.__feedbackMissingStudentRow);
                window.$(document).trigger('vjContentNew');
            });
            await panel.getByRole('status').filter({ hasText: '当前成绩表已无原学生' }).waitFor({ state: 'hidden' });
            await page.locator('.select.filter').selectOption('star');
            await panel.waitFor({ state: 'hidden' });
            await page.locator('.select.filter').selectOption('all');
            await panel.waitFor({ state: 'visible' });
            await entry.click();
            await entry.click();
            await panel.getByRole('button', { name: '继续编辑', exact: true }).click();
            assert.equal(await panel.getByLabel('备注（可空，最多 500 字）').inputValue(), '刷新也保留本学生草稿');
            await page.screenshot({ path: path.join(output, 'b-progress.png'), fullPage: true });
            await panel.getByRole('button', { name: '指导过', exact: true }).click();
            await waitMessage('已记录：陈同学');
            const exported = await (await page.request.get(base + '/scoreboard/0/html')).text();
            assert(!exported.includes('cf-scoreboard-entry') && !exported.includes('OBSERVATION_RECORDED'));
        });
        await check('management names exact batch scope, reports individual results and preserves feedback', async () => {
            await page.goto(base + '/manage');
            await page.getByRole('tab', { name: '课时访问设置', exact: true }).click();
            const before = await count();
            await page.request.post(origin + '/feedback-preview-fault', { data: { management: true } });
            await page.getByRole('button', { name: '关闭全部题目', exact: true }).click();
            const confirmation = page.getByRole('region', { name: '确认批量操作' });
            assert((await confirmation.innerText()).includes('6 人'));
            await confirmation.getByRole('button', { name: '确认执行', exact: true }).click();
            await page.getByRole('status').filter({ hasText: '已确认成功 11 项；需核实或重试 1 项' }).waitFor();
            const retry = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/manage'));
            await page.getByRole('button', { name: '只重试以上失败项', exact: true }).click();
            const retriedCommand = (await retry).postDataJSON();
            assert.equal(retriedCommand.uid, 3);
            assert.equal(retriedCommand.node, 1);
            assert.equal(retriedCommand.operation, 'allowUser');
            await page.getByRole('status').filter({ hasText: '已确认成功 1 项；需核实或重试 0 项' }).waitFor();
            assert.equal(await count(), before);
            await page.screenshot({ path: path.join(output, 'course-manage.png'), fullPage: true });
        });
        if (builtUI) await check('course edit rejects invalid JSON inline, preserves the draft and focuses its actual editor', async () => {
            await page.goto(base + '/edit');
            await page.locator('.dag-visual-editor').waitFor();
            const dialogs = [];
            const onDialog = async (dialog) => { dialogs.push(dialog.type()); await dialog.dismiss(); };
            page.on('dialog', onDialog);
            try {
                const original = await page.locator('textarea[name="dag"]').inputValue();
                for (const [source, message] of [['{broken JSON', 'JSON 错误'], ['[]', '请至少保留一个章节']]) {
                    const result = await page.evaluate(({ source }) => {
                        const field = document.querySelector('textarea[name="dag"]');
                        const $field = window.HydroExports.$(field);
                        const instance = $field.data('vjEditorInstance');
                        if (instance?.isValid) instance.value(source);
                        field.value = source;
                        $field.trigger('input');
                        const accepted = field.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                        return { accepted, source: field.value,
                            focused: document.activeElement === field || instance?.editor?.hasTextFocus() === true };
                    }, { source });
                    assert.equal(result.accepted, false);
                    assert.equal(result.source, source);
                    assert.equal(result.focused, true);
                    await page.locator('.dag-status[role="alert"]').filter({ hasText: message }).waitFor();
                }
                assert.deepEqual(dialogs, []);
                await page.screenshot({ path: path.join(output, 'course-edit-invalid.png'), fullPage: true });
                const recovered = await page.evaluate((source) => {
                    const field = document.querySelector('textarea[name="dag"]');
                    const instance = window.HydroExports.$(field).data('vjEditorInstance');
                    if (instance?.isValid) instance.value(source);
                    field.value = source;
                    return field.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                }, original);
                assert.equal(recovered, true);
            } finally { page.off('dialog', onDialog); }
        });
        if (builtUI) await check('packed lecture unwraps its body, renders Mermaid and recognizes only matched sample headings', async () => {
            await page.goto(base + '/lecture/1');
            await page.locator('#lecture-main .course-mermaid svg').waitFor();
            assert.equal(await page.locator('#lecture-main h1').innerText(), '讲义核验');
            assert.equal(await page.locator('#lecture-main .scratchpad-run-pretest-button').count(), 1);
            assert(!(await page.locator('#lecture-main').innerText()).includes('````markdown'));
            await page.screenshot({ path: path.join(output, 'course-lecture.png'), fullPage: true });
        });
        if (builtUI) await check('packed YAML worker validates input while formatting stays disabled', async () => {
            await page.evaluate(async () => {
                const { monaco } = await window.HydroExports.loadMonaco(['yaml']);
                const element = document.createElement('div');
                element.style.cssText = 'height:160px;width:600px';
                document.querySelector('.main').append(element);
                const model = monaco.editor.createModel('answer: [\n', 'yaml', monaco.Uri.parse('hydro://e2/validation.yaml'));
                const editor = monaco.editor.create(element, { model });
                window.__e2Yaml = { monaco, model, editor, element };
            });
            await page.waitForFunction(() => window.__e2Yaml.monaco.editor.getModelMarkers({ resource: window.__e2Yaml.model.uri })
                .some((marker) => marker.severity === window.__e2Yaml.monaco.MarkerSeverity.Error));
            const result = await page.evaluate(async () => {
                const { model, editor } = window.__e2Yaml;
                const source = 'answer:   42\n';
                model.setValue(source);
                await editor.getAction('editor.action.formatDocument').run();
                const value = model.getValue();
                return { source, value };
            });
            assert.equal(result.value, result.source);
            await page.waitForFunction(() => window.__e2Yaml.monaco.editor.getModelMarkers({ resource: window.__e2Yaml.model.uri }).length === 0);
            await page.evaluate(() => {
                const { model, editor, element } = window.__e2Yaml;
                editor.dispose(); model.dispose(); element.remove();
            });
        });
        await check('native mobile layout keeps the table scroll inside the page and keyboard controls available', async () => {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.goto(endpoint + '?view=pending');
            await page.getByRole('tab', { name: /待复测/, selected: true }).waitFor();
            const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
            assert(widths.page <= widths.viewport + 2, JSON.stringify(widths));
            await page.getByLabel('课时', { exact: true }).focus();
            await page.keyboard.press('Tab');
            await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
        });
        assert.deepEqual(errors, []);
        console.log('BROWSER_RESULT', JSON.stringify({ passed: checks.length, errors, checks, ui: builtUI ? 'production-webpack' : 'page-module' }));
    } catch (error) {
        await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
        console.error('BROWSER_FAILURE', await page.locator('.main').innerText().catch(() => 'no main'), errors);
        throw error;
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
