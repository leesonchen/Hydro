const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const nunjucks = require('nunjucks');
const { JSDOM } = require('jsdom');
const { applyMiddleware, combineReducers, createStore } = require('redux');
const reduxPromise = require('redux-promise-middleware').default;

function loadSource(relativePath, mocks = {}, globals = {}) {
    const filename = path.resolve(__dirname, '..', relativePath);
    const exports = {};
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText, { exports,
        require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), ...globals,
    }, { filename });
    return exports.default;
}

function pageContext(mode) {
    const UiContext = { ws_prefix: '/d/test/' };
    const template = fs.readFileSync(path.resolve(__dirname, '../packages/ui-default/templates/problem_detail.html'), 'utf8');
    const env = new nunjucks.Environment(null, { autoescape: true });
    env.addGlobal('set', (target, key, value) => typeof key === 'object' ? Object.assign(target, key) : target[key] = value);
    env.renderString(template.match(/<script>([\s\S]*?)<\/script>/)[1], {
        UiContext, mode,
        pdoc: { domainId: 'test', docId: 42 }, tdoc: { docId: '0123456789abcdef01234567' },
        handler: { user: { _id: 7 }, args: { domainId: 'test' } },
        model: { contest: { canShowSelfRecord: () => true } },
        url: (route, { query } = {}) => `/${route}?${new URLSearchParams(query)}`,
    });
    return UiContext;
}

async function scratchpad(mode) {
    const UiContext = pageContext(mode);
    const dom = new JSDOM('<body><div class="section"><div class="problem-content-container"><div class="problem-content"></div></div></div>'
        + '<div class="scratchpad-container"><div id="scratchpad"></div></div></body>', { url: 'http://localhost/p/42' });
    const $ = require('jquery')(dom.window);
    $.fn.transition = function () { return this; };
    $.fn.promise = function () { return Promise.resolve(this); };
    dom.window.scrollTo = () => {};
    const records = loadSource('packages/ui-default/components/scratchpad/reducers/records.ts');
    const pretest = loadSource('packages/ui-default/components/scratchpad/reducers/pretest.ts', {
        '@hydrooj/common': { STATUS_TEXTS: { 0: 'Waiting', 1: 'Accepted' } },
    });
    const reducer = combineReducers({ records, pretest, editor: (state = {}) => state });
    const store = createStore(reducer, applyMiddleware(reduxPromise));
    const sockets = [];
    class Socket {
        constructor(url) { this.url = url; sockets.push(this); }
        receive(rdoc) { this.onmessage({ data: JSON.stringify({ rdoc }) }); }
    }
    let loaded = 0;
    let requestCount = 0;
    let fetched = [];
    let fetchPromise;
    const page = loadSource('packages/ui-default/pages/problem_detail.page.tsx', {
        jquery: $, 'vj/misc/Page': { NamedPage: class { constructor(_name, run) { this.run = run; } } },
        'vj/components/dialog': {}, 'vj/components/notification': {}, 'vj/components/zipDownloader': {},
        'vj/utils/db': { openDB: Promise.resolve({ get: async () => null }) },
        'vj/utils': { delay: async () => {}, request: { get: async (url) => {
            assert.equal(url, UiContext.getSubmissionsUrl);
            requestCount++;
            return fetchPromise || { rdocs: fetched };
        } }, loadReactRedux: async () => { loaded++; return { Provider: () => null, store }; } },
        '../components/socket': { default: Socket, __esModule: true },
        '../components/scratchpad': { default: () => null, __esModule: true },
        '../components/scratchpad/reducers': { default: reducer, __esModule: true },
        'react-dom/client': { createRoot: () => ({ render() {}, unmount() {} }) },
    }, { UiContext, UserContext: { _id: 7 }, window: dom.window, document: dom.window.document, Event: dom.window.Event });
    await page.run();
    const tick = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };
    const click = async (name) => {
        const button = $(`<button name="problem-sidebar__${name}-scratchpad"></button>`).appendTo('body');
        button.trigger('click');
        await tick();
        button.remove();
    };
    await click('open');
    return { UiContext, store, sockets, click, tick, dom, get loaded() { return loaded; },
        get requestCount() { return requestCount; }, setFetched: (rows) => { fetched = rows; },
        setFetchPromise: (promise) => { fetchPromise = promise; } };
}

test('practice page generates a personal practice stream alongside its pretest stream', () => {
    const context = pageContext('practice');
    const query = new URL(context.ws_prefix + context.practiceConnUrl, 'http://localhost').searchParams;
    assert.equal(query.get('practice'), '1');
    assert.equal(query.get('noTemplate'), '1');
    assert.equal(query.get('pretest'), null);
    assert.equal(query.get('uidOrName'), '7');
    assert.equal(query.get('pid'), '42');
    assert.equal(query.get('domainId'), 'test');
    assert.equal(query.get('tid'), '0123456789abcdef01234567');
    assert.equal(pageContext('contest').practiceConnUrl, undefined);
});

test('practice scratchpad updates one result row, isolates pretests, reloads on reconnect and reuses sockets', async () => {
    const f = await scratchpad('practice');
    try {
        assert.equal(f.sockets.length, 2);
        const practice = f.sockets.find((socket) => new URL(socket.url, 'http://localhost').searchParams.has('practice'));
        const pretest = f.sockets.find((socket) => new URL(socket.url, 'http://localhost').searchParams.has('pretest'));
        const waiting = { _id: 'personal', uid: 7, pid: 42, status: 0, compilerTexts: [], testCases: [] };
        f.setFetched([waiting]);
        practice.onopen();
        await f.tick();
        assert.equal(f.requestCount, 1);
        assert.equal(f.store.getState().records.items.personal.status, 0);
        practice.receive({ ...waiting, status: 1, score: 100 });
        assert.deepEqual(Array.from(f.store.getState().records.rows), ['personal']);
        assert.equal(f.store.getState().records.items.personal.status, 1);
        practice.onmessage({ data: JSON.stringify({ error: { name: 'PermissionError' } }) });
        assert.deepEqual(Array.from(f.store.getState().records.rows), ['personal']);
        f.store.dispatch({ type: 'SCRATCHPAD_POST_PRETEST_FULFILLED', payload: { rid: 'pretest' } });
        pretest.receive({ ...waiting, _id: 'pretest', status: 1, time: 3, memory: 4,
            testCases: [{ message: 'output' }] });
        assert.match(f.store.getState().pretest.output, /Accepted 3ms 4KiB\noutput/);
        pretest.receive({ ...waiting, _id: 'formal' });
        assert.deepEqual(Array.from(f.store.getState().records.rows), ['personal']);
        f.setFetched([{ ...waiting, status: 1, score: 100 }, { ...waiting, _id: 'missed' }]);
        practice.onopen();
        await f.tick();
        assert.equal(f.requestCount, 2);
        assert.deepEqual(Array.from(f.store.getState().records.rows), ['personal', 'missed']);
        await f.click('quit');
        await f.click('open');
        assert.equal(f.sockets.length, 2);
        assert.equal(f.loaded, 1);
    } finally { f.dom.window.close(); }
});

test('ordinary contest scratchpad retains the existing single stream and pretest results', async () => {
    const f = await scratchpad('contest');
    try {
        assert.equal(f.sockets.length, 1);
        f.store.dispatch({ type: 'SCRATCHPAD_POST_PRETEST_FULFILLED', payload: { rid: 'pretest' } });
        f.sockets[0].receive({ _id: 'pretest', status: 1, time: 1, memory: 2, compilerTexts: [], testCases: [] });
        assert.match(f.store.getState().pretest.output, /Accepted/);
        assert.deepEqual(Array.from(f.store.getState().records.rows), ['pretest']);
    } finally { f.dom.window.close(); }
});

test('practice reconnect snapshot cannot overwrite a newer live result', async () => {
    const f = await scratchpad('practice');
    try {
        const practice = f.sockets.find((socket) => new URL(socket.url, 'http://localhost').searchParams.has('practice'));
        let resolve;
        f.setFetchPromise(new Promise((r) => { resolve = r; }));
        practice.onopen();
        practice.receive({ _id: 'personal', status: 1, score: 100 });
        resolve({ rdocs: [{ _id: 'personal', status: 0 }] });
        await f.tick();
        assert.equal(f.store.getState().records.items.personal.status, 1);
        assert.deepEqual(Array.from(f.store.getState().records.rows), ['personal']);
    } finally { f.dom.window.close(); }
});

test('a superseded practice reconnect request cannot overwrite the latest snapshot', async () => {
    const f = await scratchpad('practice');
    try {
        const practice = f.sockets.find((socket) => new URL(socket.url, 'http://localhost').searchParams.has('practice'));
        let resolveOld;
        f.setFetchPromise(new Promise((r) => { resolveOld = r; }));
        practice.onopen();
        f.setFetchPromise(Promise.resolve({ rdocs: [{ _id: 'personal', status: 1 }] }));
        practice.onopen();
        await f.tick();
        resolveOld({ rdocs: [{ _id: 'personal', status: 0 }] });
        await f.tick();
        assert.equal(f.store.getState().records.items.personal.status, 1);
    } finally { f.dom.window.close(); }
});
