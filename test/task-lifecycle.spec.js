const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../packages/hydrooj/src/model/task.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const event = { event: 'review/event', payload: '[]', ack: [] };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, fail) => {
        resolve = accept;
        reject = fail;
    });
    return { promise, resolve, reject };
}

async function fixture({ query = async () => null, dispatch = async () => {}, manualDeadline = false } = {}) {
    const listeners = {};
    const stream = new EventEmitter();
    const timers = new Set();
    const errors = [];
    const warnings = [];
    const dispatched = [];
    let dispose;
    let queryCount = 0;
    let closeCount = 0;
    let querySignal;
    let streamSignal;
    let expireDeadline;
    let deadlineHandle;
    const collection = {
        watch: (_pipeline, options) => { streamSignal = options.signal; return stream; },
        findOneAndUpdate: async (_filter, _update, options) => {
            queryCount += 1;
            querySignal = options.signal;
            return query(queryCount, options.signal);
        },
    };
    stream.close = async () => { closeCount += 1; };
    const mocks = {
        cac: () => ({ parse: () => ({ options: {} }) }),
        nanoid: { nanoid: () => 'lifecycle-test' },
        '../logger': { Logger: class { info() {} error(error) { errors.push(error); } warn(message) { warnings.push(message); } } },
        '../service/db': { collection: () => collection, ensureIndexes: async () => {} },
        '../service/bus': { parallel: async (...args) => { dispatched.push(args); await dispatch(...args); } },
        '@hydrooj/utils/lib/utils': { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    };
    const exports = {};
    vm.runInNewContext(compiled, {
        exports,
        global: { Hydro: { model: {} } },
        process: { env: { NODE_APP_INSTANCE: '0' } },
        AbortController,
        setTimeout: (callback, ms) => {
            if (manualDeadline && ms === 5000) {
                expireDeadline = callback;
                deadlineHandle = {};
                timers.add(deadlineHandle);
                return deadlineHandle;
            }
            const handle = setTimeout(() => {
                timers.delete(handle);
                callback();
            }, ms);
            timers.add(handle);
            return handle;
        },
        clearTimeout: (handle) => {
            timers.delete(handle);
            if (handle !== deadlineHandle) clearTimeout(handle);
        },
        require: (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    }, { filename });
    await exports.apply({
        on: (name, callback) => { listeners[name] = callback; },
        effect: (factory) => { dispose = factory(); },
    });
    return {
        stream, dispatched, errors, warnings, timers,
        stop: listeners['app/exit'], dispose,
        startPolling: () => stream.emit('error', new Error('Standalone MongoDB')),
        forceTimeout: () => expireDeadline(),
        get queryCount() { return queryCount; },
        get closeCount() { return closeCount; },
        get querySignal() { return querySignal; },
        get streamSignal() { return streamSignal; },
    };
}

for (const mode of ['stop', 'dispose']) {
    test(`${mode} drains a query and its claimed event before completing`, async () => {
        const query = deferred();
        const handling = deferred();
        const started = deferred();
        const app = await fixture({
            query: () => query.promise,
            dispatch: async () => { started.resolve(); await handling.promise; },
        });
        app.startPolling();
        app.startPolling();
        assert.equal(app.queryCount, 1);
        let stopped = false;
        const stopping = app[mode]().then(() => { stopped = true; });
        await tick();
        assert.equal(stopped, false);
        query.resolve(event);
        await started.promise;
        await tick();
        assert.equal(stopped, false);
        handling.resolve();
        await stopping;
        assert.equal(app.dispatched.length, 1);
        assert.equal(app.queryCount, 1);
        assert.equal(app.querySignal.aborted, false);
        assert.equal(app.timers.size, 0);
        assert.equal(app.stop(), app.dispose());
        await app.stop();
        app.startPolling();
        app.stream.emit('change', { operationType: 'insert', fullDocument: event });
        assert.equal(app.dispatched.length, 1);
        assert.equal(app.closeCount, 1);
    });
}

test('stop wakes idle polling and waits for change stream handlers', async () => {
    const handler = deferred();
    const app = await fixture({ dispatch: () => handler.promise });
    app.startPolling();
    await tick();
    app.stream.emit('change', { operationType: 'insert', fullDocument: event });
    let stopped = false;
    const stopping = app.stop().then(() => { stopped = true; });
    await tick();
    assert.equal(stopped, false);
    handler.resolve();
    await stopping;
    assert.equal(app.queryCount, 1);
    assert.equal(app.dispatched.length, 1);
    assert.equal(app.timers.size, 0);
});

test('stop wakes retry waits and suppresses shutdown query errors', async () => {
    const error = new Error('Database unavailable');
    const app = await fixture({ query: async () => { throw error; } });
    app.startPolling();
    await tick();
    assert.deepEqual(app.errors, [error]);
    await app.stop();
    assert.equal(app.queryCount, 1);
    assert.equal(app.timers.size, 0);

    const query = deferred();
    const closing = await fixture({ query: () => query.promise });
    closing.startPolling();
    const stopping = closing.stop();
    query.reject(error);
    await stopping;
    assert.deepEqual(closing.errors, []);
    assert.equal(closing.timers.size, 0);
});

test('shutdown deadline aborts queries and prevents late query results from dispatching', async () => {
    const query = deferred();
    const app = await fixture({ query: () => query.promise, manualDeadline: true });
    app.startPolling();
    const stopping = app.stop();
    app.forceTimeout();
    await stopping;
    assert.equal(app.querySignal.aborted, true);
    assert.equal(app.streamSignal.aborted, true);
    assert.equal(app.warnings.length, 1);
    assert.equal(app.timers.size, 0);
    query.resolve(event);
    await tick();
    assert.equal(app.dispatched.length, 0);
    assert.equal(app.queryCount, 1);
    await app.dispose();
    assert.equal(app.closeCount, 1);
});

test('event handler failures are logged and do not leave unhandled promises or stop polling', async () => {
    const error = new Error('Event handler failed');
    const app = await fixture({
        query: async (count) => count === 1 ? event : null,
        dispatch: async () => { throw error; },
    });
    app.stream.emit('change', { operationType: 'insert', fullDocument: event });
    app.startPolling();
    await tick();
    await app.stop();
    assert.deepEqual(app.errors, [error, error]);
    assert.equal(app.dispatched.length, 2);
    assert.equal(app.queryCount, 2);
    assert.equal(app.timers.size, 0);
});

test('real MongoDB honors query cancellation and closes aborted change streams', async () => {
    let mongod;
    let client;
    try {
        mongod = await MongoMemoryServer.create({ instance: { args: ['--setParameter', 'enableTestCommands=1'] } });
        client = await MongoClient.connect(mongod.getUri());
        const admin = client.db('admin');
        const collection = client.db('event-shutdown-test').collection('event');
        await collection.insertOne({ _id: 1, ack: [] });
        await admin.command({
            configureFailPoint: 'failCommand', mode: { times: 1 },
            data: { failCommands: ['findAndModify'], blockConnection: true, blockTimeMS: 2000 },
        });
        const controller = new AbortController();
        const reason = new Error('Event shutdown deadline');
        const cancelled = assert.rejects(collection.findOneAndUpdate(
            { _id: 1 }, { $push: { ack: 'shutdown-test' } }, { signal: controller.signal },
        ), (error) => error === reason);
        // Wait until MongoDB has received and blocked the query before cancelling it.
        await admin.command({ waitForFailPoint: 'failCommand', timesEntered: 1, maxTimeMS: 2000 });
        controller.abort(reason);
        await cancelled;

        const streamController = new AbortController();
        const stream = collection.watch([], { signal: streamController.signal });
        streamController.abort(reason);
        await tick();
        assert.equal(stream.closed, true);
        await assert.rejects(stream.next());
        await stream.close();
    } finally {
        await client?.close();
        await mongod?.stop();
    }
});
