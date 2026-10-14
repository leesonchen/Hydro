const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const lodash = require('lodash');
const { JSDOM } = require('jsdom');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const template = read('packages/ui-default/templates/problem_detail.html');
const basicScript = template.match(/<script>\s*(\(function \(\) \{\s*var section = document\.getElementById\('monitored-basic-editor'\)[\s\S]*?)<\/script>/)[1];
const page = read('packages/ui-default/pages/problem_detail.page.tsx');
const bridgeSource = page.slice(page.indexOf('function createMonitoredDraftBridge('), page.indexOf('class ProblemPageExtender'));
const bridgeScript = ts.transpileModule(bridgeSource, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

function target(extra = {}) {
    const listeners = new Map();
    return Object.assign({
        addEventListener(name, handler) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(handler);
        },
        fire(name, event = {}) {
            for (const handler of listeners.get(name) || []) handler(event);
        },
    }, extra);
}

function setup(initial = { code: '', lang: 'cpp' }) {
    const code = target({ value: '' });
    const lang = target({ value: 'cpp' });
    const form = target();
    const attributes = new Map();
    const basic = target({
        getAttribute: (name) => attributes.get(name) ?? null,
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: (name) => attributes.delete(name),
        querySelector: (selector) => {
            if (selector === 'form') return form;
            return selector.includes('select') ? lang : code;
        },
    });
    const window = target();
    let saved = initial;
    let editor = initial;
    let writes = 0;
    const context = vm.createContext({
        document: { getElementById: (id) => (id === 'monitored-basic-editor' ? basic : code) },
        window,
        localStorage: {
            getItem: () => JSON.stringify(saved),
            setItem: (key, value) => { saved = JSON.parse(value); writes++; },
        },
        _: lodash,
    });
    vm.runInContext(basicScript, context);
    vm.runInContext(bridgeScript, context);
    const bridge = context.createMonitoredDraftBridge({
        getState: () => ({ editor }),
        dispatch: (action) => { editor = action.payload; },
    }, 'test-attempt');
    return {
        code, lang, form, window, bridge,
        edit: (next) => { editor = next; bridge.update(); },
        saved: () => saved,
        writes: () => writes,
    };
}

test('completed advanced debounce survives pagehide despite the earlier basic listener', async () => {
    const h = setup({ code: 'previous', lang: 'cpp' });
    h.bridge.activate();
    h.edit({ code: 'advanced draft', lang: 'python3' });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(h.saved(), { code: 'advanced draft', lang: 'python3' });
    // A stale hidden form must never get a chance to overwrite advanced state.
    h.code.value = 'stale hidden value';
    const writesBeforeLeave = h.writes();
    h.window.fire('pagehide');
    assert.equal(h.writes(), writesBeforeLeave + 1);
    assert.deepEqual(h.saved(), { code: 'advanced draft', lang: 'python3' });
    h.bridge.restore();
});

test('pagehide immediately persists the latest store before debounce runs', () => {
    const h = setup();
    h.bridge.activate();
    h.edit({ code: 'last keystroke', lang: 'rust' });
    h.window.fire('pagehide');
    assert.deepEqual(h.saved(), { code: 'last keystroke', lang: 'rust' });
    assert.equal(h.code.value, 'last keystroke');
    assert.equal(h.lang.value, 'rust');
    h.bridge.restore();
});

test('advanced failure restores current draft and cancels writes that could overwrite basic edits', async () => {
    const h = setup();
    h.bridge.activate();
    h.edit({ code: 'pending advanced edit', lang: 'python3' });
    h.bridge.restore();
    assert.equal(h.code.value, 'pending advanced edit');
    assert.equal(h.lang.value, 'python3');
    h.code.value += '\nbasic recovery edit';
    h.code.fire('input');
    h.lang.value = 'cpp';
    h.lang.fire('change');
    await new Promise((resolve) => setTimeout(resolve, 180));
    h.window.fire('pagehide');
    assert.deepEqual(h.saved(), { code: 'pending advanced edit\nbasic recovery edit', lang: 'cpp' });
});

test('basic mode retains typing, language, submit and pagehide saves without advanced activation', () => {
    const h = setup({ code: 'restored basic draft', lang: 'python3' });
    assert.equal(h.code.value, 'restored basic draft');
    assert.equal(h.lang.value, 'python3');
    h.code.value = 'basic only';
    h.code.fire('input');
    assert.equal(h.saved().code, 'basic only');
    h.lang.value = 'rust';
    h.lang.fire('change');
    assert.equal(h.saved().lang, 'rust');
    h.code.value = 'submit value';
    h.form.fire('submit');
    assert.equal(h.saved().code, 'submit value');
    h.code.value = 'pagehide value';
    h.window.fire('pagehide');
    assert.equal(h.saved().code, 'pagehide value');
});


test('advanced activation adopts basic edits made while advanced assets were loading', () => {
    const h = setup({ code: 'loading snapshot', lang: 'cpp' });
    h.code.value = 'typed during startup';
    h.code.fire('input');
    h.lang.value = 'rust';
    h.lang.fire('change');
    h.bridge.activate();
    h.window.fire('pagehide');
    assert.deepEqual(h.saved(), { code: 'typed during startup', lang: 'rust' });
    h.bridge.restore();
});

test('advanced retry hydrates the latest recovered basic form instead of stale store state', () => {
    const h = setup();
    h.bridge.activate();
    h.edit({ code: 'before failure', lang: 'cpp' });
    h.bridge.restore();
    h.code.value = 'edited after failure';
    h.code.fire('input');
    h.lang.value = 'python3';
    h.lang.fire('change');
    h.bridge.activate();
    h.window.fire('pagehide');
    assert.deepEqual(h.saved(), { code: 'edited after failure', lang: 'python3' });
    h.bridge.restore();
});


test('failure before activation restores an IDB draft without replacing newer basic input', () => {
    const h = setup({ code: 'IDB draft', lang: 'rust' });
    // Simulate local storage being empty while asynchronous IDB hydration found a draft.
    h.code.value = '';
    h.lang.value = 'cpp';
    h.bridge.restore();
    assert.equal(h.code.value, 'IDB draft');
    assert.equal(h.lang.value, 'rust');
    h.code.value = 'typed before failed mount';
    h.code.fire('input');
    h.bridge.restore();
    assert.equal(h.code.value, 'typed before failed mount');
    assert.equal(h.saved().code, 'typed before failed mount');
});

async function editorPage(failFirstMount = false) {
    const dom = new JSDOM('<body><div class="main"><div class="row"><div class="section">'
        + '<div class="problem-content-container"><div class="problem-content">题面</div></div></div></div></div>'
        + '<div class="scratchpad-container"><div id="scratchpad"></div></div>'
        + '<div id="monitored-basic-editor"><textarea name="code"></textarea>'
        + '<select name="lang"><option value="cpp">cpp</option></select></div></body>', { url: 'http://localhost/p/1' });
    const $ = require('jquery')(dom.window);
    $.fn.transition = function () { return this; };
    $.fn.promise = function () { return Promise.resolve(this); };
    dom.window.scrollTo = () => {};
    let editor = { code: 'saved code', lang: 'cpp' };
    const listeners = [];
    const store = {
        getState: () => ({ editor }),
        subscribe: (fn) => listeners.push(fn),
        dispatch(action) {
            if (action.type !== 'SCRATCHPAD_EDITOR_HYDRATE') return;
            editor = action.payload;
            listeners.forEach((fn) => fn());
        },
    };
    let mounts = 0;
    const mocks = {
        jquery: $, 'vj/misc/Page': { NamedPage: class { constructor(_name, run) { this.run = run; } } },
        'vj/components/dialog': {}, 'vj/components/notification': { error() {} }, 'vj/components/zipDownloader': {},
        'vj/utils/db': { openDB: Promise.resolve({ get: async () => editor, put: async () => {} }) },
        'vj/utils': { delay: async () => {}, loadReactRedux: async () => ({ Provider: () => null, store }) },
        '../components/socket': { __esModule: true, default: class {} },
        '../components/scratchpad': { __esModule: true, default: () => null },
        '../components/scratchpad/reducers': { __esModule: true, default: {} },
        'react-dom/client': { createRoot: () => ({
            render() {
                mounts++;
                $('#scratchpad').append($('.problem-content'));
                dom.window.document.dispatchEvent(new dom.window.Event(
                    failFirstMount && mounts === 1 ? 'hydro:monitored-editor-failed' : 'hydro:monitored-editor-ready',
                ));
            },
            unmount() { $('#scratchpad').empty(); },
        }) },
    };
    const exports = {};
    vm.runInNewContext(ts.transpileModule(page, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } }).outputText, { exports,
        require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
        UiContext: { monitoredExam: true, monitoredAttempt: 1, pdoc: { domainId: 'test', docId: 1 },
            tdoc: { _id: 'exam' }, codeLang: 'cpp' }, UserContext: { _id: 7 },
        document: dom.window.document, window: dom.window, localStorage: dom.window.localStorage,
        Event: dom.window.Event, console: { warn() {} },
    });
    await exports.default.run();
    return { dom, async click(action) {
        const button = $(`<button name="problem-sidebar__${action}-scratchpad"></button>`).appendTo('body');
        button.trigger('click');
        for (let i = 0; i < 12; i++) await new Promise(setImmediate);
        button.remove();
    } };
}

test('leaving online programming restores the visible basic editor and its current draft', async () => {
    const h = await editorPage();
    try {
        const basic = h.dom.window.document.getElementById('monitored-basic-editor');
        await h.click('open');
        assert.equal(basic.style.display, 'none');
        await h.click('quit');
        assert.equal(basic.style.display, 'block');
        assert.equal(basic.querySelector('textarea').value, 'saved code');
        assert.equal(h.dom.window.document.activeElement, basic.querySelector('textarea'));
        assert.equal(h.dom.window.document.querySelector('.problem-content-container').textContent, '题面');
        await h.click('quit');
        assert.equal(basic.style.display, 'block');
        await h.click('open');
        assert.equal(basic.style.display, 'none');
        await h.click('quit');
    } finally { h.dom.window.close(); }
});

test('a failed editor mount returns the same statement node and allows an advanced retry', async () => {
    const h = await editorPage(true);
    try {
        const statement = h.dom.window.document.querySelector('.problem-content');
        const basic = h.dom.window.document.getElementById('monitored-basic-editor');
        await h.click('open');
        assert.equal(basic.style.display, 'block');
        assert.equal(h.dom.window.document.querySelector('.problem-content-container').firstChild, statement);
        assert.equal(statement.textContent, '题面');
        await h.click('open');
        assert.equal(basic.style.display, 'none');
        await h.click('quit');
        assert.equal(h.dom.window.document.querySelector('.problem-content-container').firstChild, statement);
    } finally { h.dom.window.close(); }
});

test('React error-boundary cleanup returns borrowed DOM before discarding the subtree', async () => {
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const dom = new JSDOM('<div id="original"><div id="statement">题面</div><span>after</span></div><div id="root"></div>');
    const previous = { window: global.window, document: global.document,
        IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
    global.window = dom.window;
    global.document = dom.window.document;
    global.IS_REACT_ACT_ENVIRONMENT = true;
    const exports = {};
    vm.runInNewContext(ts.transpileModule(read('packages/ui-default/components/react/DomComponent.tsx'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText, { exports, require });
    const Dom = exports.default;
    const statement = dom.window.document.getElementById('statement');
    const original = statement.parentNode;
    const next = statement.nextSibling;
    const root = createRoot(dom.window.document.getElementById('root'), { onCaughtError() {} });
    class Boundary extends React.Component {
        state = { failed: false };
        static getDerivedStateFromError() { return { failed: true }; }
        render() { return this.state.failed ? null : this.props.children; }
    }
    function Failure({ fail }) { if (fail) throw new Error('injected render failure'); return null; }
    const render = (fail, key = 'first') => React.createElement(Boundary, { key },
        React.createElement(Dom, { childDom: statement }), React.createElement(Failure, { fail }));
    try {
        await React.act(async () => root.render(React.createElement(React.StrictMode, null, render(false))));
        assert.equal(original.contains(statement), false);
        await React.act(async () => root.render(React.createElement(React.StrictMode, null, render(true))));
        assert.equal(statement.parentNode, original);
        assert.equal(statement.nextSibling, next);
        await React.act(async () => root.render(render(false, 'retry')));
        assert.equal(original.contains(statement), false);
        await React.act(async () => root.unmount());
        assert.equal(statement.parentNode, original);
    } finally {
        Object.assign(global, previous);
        dom.window.close();
    }
});
