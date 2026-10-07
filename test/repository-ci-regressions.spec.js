const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { Worker } = require('node:worker_threads');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
function compile(source) {
    return ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
}

function functions(file, names) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    return names.map((name) => {
        const node = ast.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === name);
        assert.ok(node, 'Missing production function ' + name);
        return node.getText(ast).replace(/^export /, '');
    }).join('\n');
}

const auditSource = compile(fs.readFileSync(path.join(root, 'packages/url-audit/index.ts'), 'utf8'));
const defaultConfig = {
    enabled: true, retentionDays: 30, includeAnonymous: false,
    methods: 'GET,POST', ignorePrefixes: '/fs/,/public/', ignoreExtensions: '.js,.css',
    maskQueryKeys: 'token,password',
};

async function auditFixture(overrides = {}, failWrite = false) {
    let middleware;
    const docs = [];
    const warnings = [];
    const schema = new Proxy(function () {}, { apply: () => schema, get: () => schema });
    const exports = {};
    vm.runInNewContext(auditSource, {
        exports, process: { env: {} }, URLSearchParams,
        require: (name) => {
            assert.equal(name, 'hydrooj');
            return {
                Handler: class {}, PRIV: {}, Schema: schema,
                Logger: class { warn(...args) { warnings.push(args); } },
            };
        },
    });
    await exports.apply({
        i18n: { load() {} }, Route() {}, injectUI() {},
        inject: async (_dependencies, callback) => callback({
            server: { addHandlerLayer: (_name, layer) => { middleware = layer; } },
            db: {
                ensureIndexes: async () => {},
                db: { collection: () => ({
                    insertOne: async (doc) => {
                        if (failWrite) throw new Error('audit unavailable');
                        docs.push(doc);
                    },
                }) },
            },
        }),
    }, { ...defaultConfig, ...overrides });
    const context = {
        path: '/d/class/course', request: { method: 'GET', querystring: 'token=secret&search=abc' },
        HydroContext: { user: { _id: 12, uname: 'Teacher' }, domain: { _id: 'class' }, response: { status: 200 } },
        handler: { constructor: { name: 'CourseHandler' } },
    };
    return { middleware, context, docs, warnings };
}

for (const [label, config, change] of [
    ['disabled', { enabled: false }, () => {}],
    ['request opt-out', {}, (c) => { c.nolog = true; }],
    ['response opt-out', {}, (c) => { c.response = { headers: { nolog: true } }; }],
    ['websocket', {}, (c) => { c.HydroContext.request = { websocket: true }; }],
    ['unsupported method', {}, (c) => { c.request.method = 'OPTIONS'; }],
    ['ignored prefix', {}, (c) => { c.path = '/d/class/fs/file'; }],
    ['ignored extension', {}, (c) => { c.path = '/course.js'; }],
    ['anonymous', {}, (c) => { delete c.HydroContext.user; }],
]) test('URL audit ' + label + ' preserves downstream errors and results', async () => {
    const { middleware, context, docs } = await auditFixture(config);
    change(context);
    const failure = new Error('downstream failure');
    await assert.rejects(middleware(context, async () => { throw failure; }), (error) => error === failure);
    const result = {};
    assert.equal(await middleware(context, async () => result), result);
    assert.equal(docs.length, 0);
});

test('URL audit records completion while preserving errors and masking sensitive query keys', async () => {
    const { middleware, context, docs } = await auditFixture();
    const failure = new Error('page error');
    await assert.rejects(middleware(context, async () => {
        context.HydroContext.response.status = 500;
        throw failure;
    }), (error) => error === failure);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].status, 500);
    assert.equal(docs[0].route, 'Course');
    assert.equal(docs[0].domainId, 'class');
    assert.equal(docs[0].uid, 12);
    assert.equal(new URLSearchParams(docs[0].querystring).get('token'), '[masked]');
    assert.equal(new URLSearchParams(docs[0].querystring).get('search'), 'abc');
});

test('URL audit storage failures preserve the downstream outcome and produce a warning', async () => {
    const { middleware, context, warnings } = await auditFixture({}, true);
    const failure = new Error('page error');
    await assert.rejects(middleware(context, async () => { throw failure; }), (error) => error === failure);
    const result = {};
    assert.equal(await middleware(context, async () => result), result);
    assert.equal(warnings.length, 2);
    assert.equal(warnings[0][1], 'audit unavailable');
});

const reviewFunctions = compile(functions('packages/xxwl-review/index.ts', [
    'buildStatusParts', 'summarizeRawStatus', 'replaceRawStatusStrings', 'displayReviewText',
]));
const review = vm.runInNewContext(reviewFunctions + '\n({ replaceRawStatusStrings, displayReviewText })');

test('review summaries accept optional colons, mixed case and parentheses without modifying code blocks', () => {
    for (const input of ['评测串 xxx', '评测串：xxx', '评测串 : XXX', '评测串 \t: \txxx']) {
        assert.equal(review.replaceRawStatusStrings(input), '评测结果：WA 3');
    }
    assert.equal(review.replaceRawStatusStrings('评测串***'), '评测结果：全 AC');
    assert.equal(review.replaceRawStatusStrings('（rr***）'), '（AC 3，RE 2）');
    const tick = String.fromCharCode(96);
    const code = tick.repeat(3) + 'cpp\n// 评测串 xxx\n' + tick.repeat(3);
    assert.equal(review.displayReviewText(code + '\n代码审核：评测串 xxx'), code + '\n代码点评：评测结果：WA 3');
});

test('long malformed review labels finish in a terminable isolated worker', { timeout: 15000 }, async () => {
    function isolated() {
        const { parentPort, workerData } = require('node:worker_threads');
        const vm = require('node:vm');
        const replace = vm.runInNewContext(workerData.source + '\nreplaceRawStatusStrings');
        parentPort.postMessage('ready');
        parentPort.once('message', () => {
            for (const suffix of ['X', ': X', '： X', '9'.repeat(100000)]) {
                const value = '评测串' + ' '.repeat(100000) + suffix;
                if (replace(value) !== value) throw new Error('Malformed label changed');
            }
            parentPort.postMessage('done');
        });
    }
    const worker = new Worker('(' + isolated.toString() + ')()', { eval: true, workerData: { source: reviewFunctions } });
    let timer;
    try {
        await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Worker startup timed out')), 10000);
            worker.on('error', reject);
            worker.on('message', (message) => {
                clearTimeout(timer);
                if (message === 'ready') {
                    timer = setTimeout(() => reject(new Error('Long review text exceeded 2 seconds')), 2000);
                    worker.postMessage('run');
                } else if (message === 'done') resolve();
            });
        });
    } finally {
        clearTimeout(timer);
        await worker.terminate();
    }
});

const originFunctions = compile(functions('packages/hydrooj/src/builtin/course-management/handler/class.ts', [
    'fillMessage', 'resolveProblemOrigin',
]));

function originFixture(docs) {
    const calls = [];
    let active = 0;
    const resolve = vm.runInNewContext(originFunctions + '\nresolveProblemOrigin', {
        BadRequestError: Error,
        ProblemModel: { get: async (domainId, pid) => {
            active++;
            assert.equal(active, 1, 'Reference lookups must remain serial');
            calls.push([domainId, pid]);
            await new Promise(setImmediate);
            active--;
            return docs[domainId + '/' + pid];
        } },
    });
    return { resolve, calls };
}

test('course problem references follow the complete chain in order', async () => {
    const { resolve, calls } = originFixture({
        'class/1': { reference: { domainId: 'template', pid: 2 } },
        'template/2': { reference: { domainId: 'system', pid: 3 } },
        'system/3': { domainId: 'system', docId: 3 },
    });
    const result = await resolve('class', 1);
    assert.equal(result.originDomainId, 'system');
    assert.equal(result.originPid, 3);
    assert.deepEqual(calls, [['class', 1], ['template', 2], ['system', 3]]);
});

test('missing course reference retains the original course problem in its error', async () => {
    for (const docs of [{}, { 'class/1': { reference: { domainId: 'system', pid: 2 } } }]) {
        const { resolve } = originFixture(docs);
        await assert.rejects(resolve('class', 1), /Referenced source problem 1 in domain class does not exist/);
    }
});

const llmFunctions = compile(functions('packages/ai-assistant/index.ts', ['callLLM']));
test('AI provider fallback and retry rounds remain serial and stop on success', async () => {
    const calls = [];
    let active = 0;
    const llm = vm.runInNewContext(llmFunctions + '\ncallLLM', {
        runtimeConfig: { providers: [{ name: 'first' }, { name: 'second' }], retryTimes: 2 },
        logger: { warn() {} },
        callProvider: async (provider, prompt) => {
            assert.equal(++active, 1);
            assert.equal(prompt, 'question');
            calls.push(provider.name);
            await new Promise(setImmediate);
            active--;
            if (calls.length !== 4) throw new Error('provider unavailable');
            return 'answer';
        },
    });
    const result = await llm('question');
    assert.deepEqual(calls, ['first', 'second', 'first', 'second']);
    assert.equal(result.text, 'answer');
    assert.equal(result.provider, 'second');
    assert.equal(result.retry, 1);
});

test('AI provider failure reports every configured attempt in order', async () => {
    const llm = vm.runInNewContext(llmFunctions + '\ncallLLM', {
        runtimeConfig: { providers: [{ name: 'first' }, { name: 'second' }], retryTimes: 1 },
        logger: { warn() {} },
        callProvider: async () => { throw new Error('unavailable'); },
    });
    await assert.rejects(llm('question'), (error) => error.message === [
        'first[0]: unavailable', 'second[0]: unavailable',
        'first[1]: unavailable', 'second[1]: unavailable',
    ].join('\n'));
});

test('maintenance readiness checks retain deadlines, serial retries and check failures', async () => {
    let now = 0;
    const waitFor = vm.runInNewContext(functions('packages/hydrooj/bin/hydro-maintenance.js', ['waitFor']) + '\nwaitFor', {
        Date: { now: () => now },
        sleep: async (milliseconds) => { now += milliseconds; },
    });
    const remaining = [];
    await waitFor(async (milliseconds) => { remaining.push(milliseconds); return remaining.length === 2; }, 'test', 2500);
    assert.deepEqual(remaining, [2500, 1500]);
    const failure = new Error('check failure');
    await assert.rejects(waitFor(async () => { throw failure; }, 'test', 2500), (error) => error === failure);
    now = 0;
    let attempts = 0;
    await assert.rejects(waitFor(async () => { attempts++; return false; }, 'test', 1500), /等待test超时/);
    assert.equal(attempts, 2);
    assert.equal(now, 1500);
});
