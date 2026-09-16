const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../packages/ui-default/service-worker.ts');
const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
    const listeners = {};
    const fetched = [];
    const cacheReads = [];
    const self = { addEventListener: (name, callback) => { listeners[name] = callback; } };
    vm.runInNewContext(source, {
        exports: {}, self, URL, Request, Response, Headers, ReadableStream,
        location: new URL('https://oj.example/'),
        process: { env: { VERSION: 'test', NODE_ENV: 'production' } },
        console: { log() {}, debug() {}, warn() {} },
        caches: { open: async () => ({ match: async (url) => { cacheReads.push(url); return new Response('cached'); } }) },
        fetch: async (url) => { fetched.push(url); return new Response('network'); },
    }, { filename });
    self.onmessage({ data: { type: 'service-worker-config', config: {
        hosts: ['https://oj.example/'], domains: ['oj.example', 'mirror.example'], assets: [],
    } } });
    return { listeners, fetched, cacheReads };
}

test('maintenance endpoints bypass old caches and mirror rewriting even with query parameters', () => {
    const { listeners, fetched, cacheReads } = fixture();
    for (const url of ['/maintenance.json', '/maintenance.json?_=123', '/maintain.html', '/maintain.html?return=%2Fp']) {
        listeners.fetch({ request: new Request(`https://oj.example${url}`), respondWith: () => assert.fail('must use browser network request') });
    }
    assert.deepEqual(fetched, []);
    assert.deepEqual(cacheReads, []);
});

test('ordinary static resources still use the versioned cache', async () => {
    const { listeners, cacheReads } = fixture();
    let response;
    listeners.fetch({ request: new Request('https://oj.example/app.js'), respondWith: (value) => { response = value; } });
    assert.equal(await (await response).text(), 'cached');
    assert.ok(cacheReads.includes('https://oj.example/app.js'));
});
