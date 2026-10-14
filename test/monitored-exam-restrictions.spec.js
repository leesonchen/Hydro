const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const source = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('monitored exam warns on return, requires acknowledgement and cleans listeners', () => {
    const html = source('packages/ui-default/templates/partials/contest_monitor_client.html');
    assert.match(html, /role="alertdialog"/);
    assert.match(html, /我知道了，继续测试/);
    assert.match(html, /function reportReturn\(\)/);
    assert.match(html, /function acknowledge\(\)/);
    assert.match(html, /internalClipboard = null/);
    assert.match(html, /function visibility\(\)/);
    assert.match(html, /function focus\(\)/);
    assert.match(html, /function fullscreen\(\)/);
    assert.match(html, /document\.removeEventListener\('keydown', clipboardKeydown, true\)/);
});
test('monitored clipboard intercepts shortcuts, native paste and drag/drop', () => {
    const html = source('packages/ui-default/templates/partials/contest_monitor_client.html');
    for (const name of ['copy', 'cut', 'paste']) assert.match(html, new RegExp(`'${name}'`));
    for (const key of ['beforeinput', 'dragover', 'drop', 'keydown']) {
        assert.ok(html.includes(`addEventListener('${key}'`));
    }
    assert.match(html, /editor\.executeEdits\('contest-monitor-paste'/);
    assert.match(html, /pasteSelection\(target, internalClipboard\.text\)/);
    assert.match(html, /if \(!internalClipboard/);
    assert.match(html, /function blockDrop\(event\)/);
});
test('monitored exam starts without template and isolates earlier drafts', () => {
    const detail = source('packages/ui-default/templates/problem_detail.html');
    const reducer = source('packages/ui-default/components/scratchpad/reducers/editor.ts');
    const page = source('packages/ui-default/pages/problem_detail.page.tsx');
    assert.match(detail, /codeTemplate: '' if monitoredExam else handler\.user\.codeTemplate/);
    assert.match(detail, /monitoredExam: monitoredExam/);
    assert.match(detail, /monitoredAttempt:/);
    assert.match(reducer, /UiContext\.monitoredExam \? '' : UiContext\.codeTemplate/);
    assert.match(page, /@monitored:/);
});
test('server rejects source file uploads and accepts blocked clipboard events', () => {
    const handler = source('packages/hydrooj/src/handler/problem.ts');
    const model = source('packages/hydrooj/src/model/contestMonitor.ts');
    assert.match(handler, /测试监控模式下不允许提交本地文件/);
    assert.match(model, /clipboard_blocked/);
    assert.match(model, /drop_blocked/);
});

test('top monitor status is compact and student-facing only', () => {
    const html = source('packages/ui-default/templates/partials/contest_monitor_client.html');
    assert.match(html, /测试监控中/);
    assert.match(html, /测试结束前，请保持全屏模式/);
    assert.match(html, /max-width:1024px/);
    assert.doesNotMatch(html, /继续考试|考试监控提醒|background:#fff4d3/);
});
test('monitor clipboard uses optional metadata and plain-text internal comparison', () => {
    const html = source('packages/ui-default/templates/partials/contest_monitor_client.html');
    assert.match(html, /application\/x-hydro-monitored-code/);
    assert.match(html, /data\.setData\('text\/plain', text\)/);
    assert.match(html, /clipboardComparable\(plain\) !== clipboardComparable\(internalClipboard\.text\)/);
    assert.match(html, /marker !== internalClipboard\.marker/);
    assert.match(html, /function pasteSelection/);
    assert.match(html, /function blockDrop/);
});
test('online programming only, including independently rendered basic textarea', () => {
    const list = source('packages/ui-default/templates/contest_problemlist.html');
    const side = source('packages/ui-default/templates/partials/problem_sidebar_contest.html');
    const detail = source('packages/ui-default/templates/problem_detail.html');
    const handler = source('packages/hydrooj/src/handler/problem.ts');
    assert.match(list, /editor:'online'/);
    assert.match(side, /基础编辑模式/);
    assert.match(detail, /id="monitored-basic-code"/);
    assert.match(detail, /form method="post" action=/);
    assert.match(detail, /monitoredAttempt/);
    assert.match(handler, /this\.response\.redirect = this\.url\('problem_detail'/);
});
test('standard IDE allows a Monaco failure or timeout and a manual basic switch', () => {
    const editor = source('packages/ui-default/components/scratchpad/ScratchpadEditorContainer.tsx');
    const page = source('packages/ui-default/pages/problem_detail.page.tsx');
    assert.match(editor, /Monaco loading timed out/);
    assert.match(editor, /this\.initPlainTextarea/);
    assert.match(editor, /切换基础编辑模式/);
    assert.match(page, /hydro-monitor-draft:/);
    assert.match(page, /@monitored:/);
});

const vm = require('node:vm');

function monitoredHarness(options = {}) {
    const script = source('packages/ui-default/templates/partials/contest_monitor_client.html')
        .match(/<script>([\s\S]*?)<\/script>/)[1];
    const storage = new Map();
    let time = 100000;
    let serial = 0;
    const events = [];
    const xhrRequests = [];
    const elements = {};
    function emitter() {
        const callbacks = new Map();
        return {
            addEventListener(name, cb) {
                if (!callbacks.has(name)) callbacks.set(name, new Set());
                callbacks.get(name).add(cb);
            },
            removeEventListener(name, cb) { callbacks.get(name)?.delete(cb); },
            fire(name, props = {}) {
                for (const cb of callbacks.get(name) || []) {
                    cb({ type: name, preventDefault() {}, stopImmediatePropagation() {}, ...props });
                }
            },
        };
    }
    const win = emitter();
    Object.assign(win, { crypto: { randomUUID: () => 'test-id-' + (++serial) + '-123456789' },
        ClipboardEvent: function ClipboardEvent() {}, navigator: { clipboard: options.clipboard } });
    const doc = emitter();
    Object.assign(doc, {
        hidden: false, fullscreenElement: null, hasFocus: () => true, documentElement: {},
        getElementById: (id) => elements[id] || null,
    });
    elements['contest-monitor-warning'] = { hidden: true, textContent: '' };
    elements['contest-monitor-dialog'] = { hidden: true, style: { display: 'none' } };
    elements['contest-monitor-dialog-body'] = { textContent: '' };
    elements['contest-monitor-dialog-confirm'] = Object.assign(emitter(), { focus() {} });
    elements['contest-monitor-fullscreen'] = Object.assign(emitter(), { hidden: false });
    vm.runInNewContext(script, {
        window: win, document: doc, Date: { now: () => time },
        sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        Event: class { constructor(type) { this.type = type; } },
        ...(options.legacyXHR ? { XMLHttpRequest: options.legacyXHR } : { fetch: () => new Promise(() => {}) }),
        setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    });
    function clipboard() {
        const data = new Map();
        return { setData: (name, value) => data.set(name, value), getData: (name) => data.get(name) || '' };
    }
    const input = {
        tagName: 'TEXTAREA', name: 'code', className: 'ScratchpadPlainEditor',
        value: 'first ABC', selectionStart: 6, selectionEnd: 9,
        setRangeText(value, start, end) {
            this.value = this.value.slice(0, start) + value + this.value.slice(end);
            this.selectionStart = this.selectionEnd = start + value.length;
        },
        dispatchEvent(event) { events.push(event.type); },
    };
    return { window: win, document: doc, elements, input, clipboard, events, xhrRequests,
        advance(ms) { time += ms; },
        queue() { return JSON.parse([...storage].find(([key]) => key.startsWith('hydro-monitor-queue:'))[1]); },
    };
}

test('IDE clipboard supports signed native copy/paste and blocks a different OS clipboard', () => {
    const h = monitoredHarness();
    const internal = h.clipboard();
    h.document.fire('copy', { target: h.input, clipboardData: internal });
    assert.equal(internal.getData('text/plain'), 'ABC');
    assert.ok(internal.getData('application/x-hydro-monitored-code'));
    h.input.selectionStart = h.input.selectionEnd = 0;
    h.document.fire('paste', { target: h.input, clipboardData: internal });
    assert.equal(h.input.value, 'ABCfirst ABC');
    assert.ok(!h.input.value.includes('test-id-'), 'the signature must not enter source code');
    const outside = h.clipboard();
    outside.setData('text/plain', 'untrusted code');
    h.document.fire('paste', { target: h.input, clipboardData: outside });
    assert.equal(h.input.value, 'ABCfirst ABC');
    assert.ok(h.queue().some((event) => event.eventType === 'paste_detected'));
});
test('browser clipboard custom MIME may be stripped without breaking same-editor paste', () => {
    const h = monitoredHarness();
    h.document.fire('copy', { target: h.input, clipboardData: h.clipboard() });
    const plain = h.clipboard();
    plain.setData('text/plain', 'ABC');
    h.input.selectionStart = h.input.selectionEnd = 0;
    h.document.fire('paste', { target: h.input, clipboardData: plain });
    assert.equal(h.input.value, 'ABCfirst ABC');
});

function commandEditor(h) {
    const edits = [];
    const editor = { getModel: () => ({}), getSelections: () => [{}], pushUndoStop() {},
        executeEdits(_source, changes) { edits.push(...changes.map((change) => change.text)); } };
    h.window.editor = editor;
    return { editor, edits, paste() { h.document.fire('hydro:monitored-paste', { detail: { editor } }); } };
}

test('Monaco clipboard command blocks OS text even after a legitimate copy', async () => {
    const h = monitoredHarness({ clipboard: { readText: async () => 'external code' } });
    h.document.fire('copy', { target: h.input, clipboardData: h.clipboard() });
    const command = commandEditor(h);
    command.paste();
    await Promise.resolve();
    assert.deepEqual(command.edits, []);
    assert.ok(h.queue().some((event) => event.eventType === 'paste_detected'));
});

test('Monaco clipboard command accepts the current internal copy with equivalent newlines', async () => {
    const h = monitoredHarness({ clipboard: { readText: async () => 'line1\r\nline2' } });
    h.input.value = 'line1\nline2';
    h.input.selectionStart = 0;
    h.input.selectionEnd = h.input.value.length;
    h.document.fire('copy', { target: h.input, clipboardData: h.clipboard() });
    const command = commandEditor(h);
    command.paste();
    await Promise.resolve();
    assert.deepEqual(command.edits, ['line1\nline2']);
});

test('Monaco clipboard command fails closed when clipboard read is unavailable or denied', async () => {
    for (const clipboard of [undefined, { readText: async () => { throw new Error('Denied'); } },
        { readText() { throw new Error('Denied'); } }]) {
        const h = monitoredHarness({ clipboard });
        h.document.fire('copy', { target: h.input, clipboardData: h.clipboard() });
        const command = commandEditor(h);
        command.paste();
        await Promise.resolve();
        assert.deepEqual(command.edits, []);
        assert.ok(h.queue().some((event) => event.eventType === 'paste_detected'));
    }
});

test('a clipboard read completing after blur, editor replacement or cleanup cannot insert text', async () => {
    for (const invalidate of [(h) => h.window.fire('blur'), (h) => { h.window.editor = {}; },
        (h) => h.window.__contestMonitorCleanup()]) {
        let complete;
        const h = monitoredHarness({ clipboard: { readText: () => new Promise((resolve) => { complete = resolve; }) } });
        h.document.fire('copy', { target: h.input, clipboardData: h.clipboard() });
        const command = commandEditor(h);
        command.paste();
        invalidate(h);
        complete('ABC');
        await Promise.resolve();
        assert.deepEqual(command.edits, []);
    }
});

test('Monaco guard consumes its focused editor command before the default OS reader and disposes on unmount', () => {
    const ts = require('typescript');
    let command;
    let priority;
    let disposeEditor;
    let disposed = false;
    let focused = true;
    const events = [];
    const exports = {};
    vm.runInNewContext(ts.transpileModule(source('packages/ui-default/components/monaco/monitored-clipboard.ts'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText, {
        exports,
        require: () => ({ PasteAction: { addImplementation(value, _name, handler) {
            priority = value;
            command = handler;
            return { dispose() { disposed = true; } };
        } } }),
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        document: { dispatchEvent(event) { events.push(event); } },
    });
    const editor = { hasTextFocus: () => focused, onDidDispose(handler) { disposeEditor = handler; } };
    exports.registerMonitoredClipboard(editor);
    assert.ok(priority > 10000, 'the built-in clipboard reader has priority 10000');
    assert.equal(command(), true);
    assert.equal(events[0].type, 'hydro:monitored-paste');
    assert.equal(events[0].detail.editor, editor);
    focused = false;
    assert.equal(command(), false, 'other editors retain their default clipboard commands');
    assert.equal(events.length, 1);
    disposeEditor();
    assert.equal(disposed, true);
});
test('focus warning is acknowledged once; leaving page invalidates IDE copy state', () => {
    const h = monitoredHarness();
    h.document.fire('copy', { target: h.input, clipboardData: h.clipboard() });
    h.window.fire('blur');
    h.advance(3100);
    h.window.fire('focus');
    assert.equal(h.elements['contest-monitor-dialog'].hidden, false);
    assert.match(h.elements['contest-monitor-dialog-body'].textContent, /测试页面（约 3 秒）/);
    h.elements['contest-monitor-dialog-confirm'].fire('click');
    assert.equal(h.elements['contest-monitor-dialog'].hidden, true);
    h.input.selectionStart = h.input.selectionEnd = 0;
    h.document.fire('paste', { target: h.input, clipboardData: h.clipboard() });
    assert.equal(h.input.value, 'first ABC');
    h.window.fire('focus');
    assert.equal(h.elements['contest-monitor-dialog'].hidden, true);
});
test('drag/drop is recorded and does not inject source code', () => {
    const h = monitoredHarness();
    h.document.fire('drop', { target: h.input });
    assert.equal(h.input.value, 'first ABC');
    assert.ok(h.queue().some((event) => event.eventType === 'drop_blocked'));
});

test('legacy XMLHttpRequest records and acknowledges events without fetch', () => {
    const requests = [];
    class LegacyXHR {
        open(method, url) { this.method = method; this.url = url; }
        setRequestHeader() {}
        send(text) { this.payload = JSON.parse(text); requests.push(this); }
        respond(data = { ok: true }) {
            this.readyState = 4;
            this.status = 200;
            this.responseText = JSON.stringify(data);
            this.onreadystatechange();
        }
    }
    const h = monitoredHarness({ legacyXHR: LegacyXHR });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].payload.eventType, 'heartbeat');
    requests[0].respond();
    assert.equal(h.queue().length, 0);
    h.window.fire('blur');
    assert.equal(requests[1].payload.eventType, 'window_blur');
    requests[1].respond();
    assert.equal(h.queue().length, 0);
});
test('CRLF conversion of a legitimate copied multi-line code is allowed', () => {
    const h = monitoredHarness();
    h.input.value = 'line1\nline2';
    h.input.selectionStart = 0;
    h.input.selectionEnd = h.input.value.length;
    const original = h.clipboard();
    h.document.fire('copy', { target: h.input, clipboardData: original });
    const converted = h.clipboard();
    converted.setData('text/plain', 'line1\r\nline2');
    converted.setData('application/x-hydro-monitored-code', original.getData('application/x-hydro-monitored-code'));
    h.input.selectionStart = h.input.selectionEnd = 0;
    h.document.fire('paste', { target: h.input, clipboardData: converted });
    assert.equal(h.input.value, 'line1\nline2line1\nline2');
    const incorrectMarker = h.clipboard();
    incorrectMarker.setData('text/plain', 'line1\nline2');
    incorrectMarker.setData('application/x-hydro-monitored-code', 'incorrect');
    h.document.fire('paste', { target: h.input, clipboardData: incorrectMarker });
    assert.equal(h.input.value, 'line1\nline2line1\nline2');
});

test('HTML editor is hidden only after a usable React editor reports ready', () => {
    const page = source('packages/ui-default/pages/problem_detail.page.tsx');
    const editor = source('packages/ui-default/components/scratchpad/ScratchpadEditorContainer.tsx');
    assert.match(page, /if \(readiness\) await readiness\.promise;\s*monitoredDraft\?\.activate\(\);\s*if \(basic\) basic\.style\.display = 'none'/);
    assert.match(page, /MonitoredEditorBoundary/);
    assert.match(page, /hydro:monitored-editor-failed/);
    assert.match(editor, /hydro:monitored-editor-ready/);
    assert.match(editor, /this\.notifyEditorReady\(\)/);
});
test('contest and classroom-test settings prevent file-upload-only questions', () => {
    const contest = source('packages/hydrooj/src/handler/contest.ts');
    const classroom = source('packages/hydrooj/src/builtin/course-management/model/assessment.ts');
    assert.match(contest, /测试监控模式不支持文件提交题/);
    assert.match(classroom, /课堂测试监控模式不支持文件提交题/);
});
test('invigilators see readable Chinese names for newly blocked events', () => {
    const monitor = source('packages/ui-default/templates/contest_monitor.html');
    assert.match(monitor, /clipboard_blocked: '剪贴板操作被阻止'/);
    assert.match(monitor, /drop_blocked: '拖拽内容被阻止'/);
    assert.match(monitor, /测试活跃会话/);
});

test('basic textarea uses native edit commands for Tab and Shift+Tab where supported', () => {
    const html = source('packages/ui-default/templates/problem_detail.html');
    const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
    const handlers = {};
    const edits = [];
    const textarea = {
        value: '    code', selectionStart: 4, selectionEnd: 4,
        addEventListener(event, fn) { handlers[event] = fn; },
        focus() {},
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
        setRangeText(text, start, end) {
            this.value = this.value.slice(0, start) + text + this.value.slice(end);
            this.selectionStart = this.selectionEnd = start + text.length;
        },
    };
    const form = { addEventListener() {} };
    const lang = { value: 'cpp', addEventListener() {} };
    const attributes = new Map();
    const section = {
        getAttribute: (name) => attributes.get(name) || null,
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: (name) => attributes.delete(name),
        querySelector(q) { return q === 'select[name="lang"]' ? lang : form; },
    };
    const document = {
        getElementById(id) { return id === 'monitored-basic-code' ? textarea : section; },
        execCommand(command, _ui, insertion) {
            assert.equal(command, 'insertText');
            edits.push(insertion);
            textarea.setRangeText(insertion, textarea.selectionStart, textarea.selectionEnd);
            return true;
        },
    };
    vm.runInNewContext(js, {
        document, window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
    });
    handlers.keydown({ keyCode: 9, shiftKey: false, preventDefault() {} });
    assert.equal(textarea.value, '        code');
    handlers.keydown({ keyCode: 9, shiftKey: true, preventDefault() {} });
    assert.equal(textarea.value, '    code');
    assert.deepEqual(edits, ['    ', '']);
});
