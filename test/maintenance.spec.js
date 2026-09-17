const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const script = path.resolve(__dirname, '../packages/hydrooj/bin/hydro-maintenance.js');
const source = fs.readFileSync(script, 'utf8');
const installer = fs.readFileSync(path.resolve(__dirname, '../packages/hydrooj/bin/install-dev-from-private-npm.sh'), 'utf8');
const shellLockFunctions = installer.slice(installer.indexOf('acquire_operation_lock()'), installer.indexOf('log_title()'));
const services = ['mongodb', 'hydro-sandbox', 'hydrojudge', 'hydrooj'];

async function fixture(t) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hydro-maintenance-test-'));
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const calls = [];
    let apps = ['caddy', ...services].map((name) => ({ name, pm2_env: { status: 'online' } }));
    let failRestart;
    const env = { HYDRO_HOME: dir, PM2_BIN: process.execPath };
    const module = { exports: {} };
    const fakeChild = {
        spawnSync(command, args) {
            calls.push([...args]);
            if (args[0] === 'jlist') return { status: 0, stdout: JSON.stringify(apps) };
            if (args[0] === 'restart' && args[1] === failRestart) return { status: 1, stderr: 'restart failed' };
            if (args[0] === 'delete') apps = apps.filter((app) => app.name !== args[1]);
            if (args[0] === 'start') apps.push({ name: args[args.indexOf('--name') + 1], pm2_env: { status: 'online' } });
            if (args[0] === 'stop' || args[0] === 'restart') {
                apps.find((app) => app.name === args[1]).pm2_env.status = args[0] === 'stop' ? 'stopped' : 'online';
            }
            return { status: 0, stdout: '' };
        },
        spawn(command, args, options) {
            calls.push(['spawn', ...args, options.timeout]);
            return { on() {}, unref() {} };
        },
    };
    const context = vm.createContext({
        require: (name) => (name === 'child_process' ? fakeChild : require(name)),
        module, __filename: script, __dirname: path.dirname(script),
        process: { env, pid: process.pid, argv: [process.execPath, script] },
        console: { log() {}, error() {} }, setTimeout, clearTimeout, AbortController,
        fetch: async () => ({ ok: true }),
    });
    vm.runInContext(`${source}\nObject.assign(module.exports, {
        acquireLock, releaseLock, ensureMaintenanceDir, writeState, readState,
        activate, turnOff, schedule, reconcileScheduled, restoreScheduler,
    });`, context, { filename: script });
    const api = module.exports;
    await api.ensureMaintenanceDir();
    await fs.promises.writeFile(path.join(dir, 'Caddyfile'), '  # hydro-maintenance begin\n  # hydro-maintenance end\n');
    return { api, dir, calls, apps, failRestart: (name) => { failRestart = name; } };
}

test('maintenance stops dependents first and restores the original services before removing the scheduler', async (t) => {
    const { api, dir, calls, apps } = await fixture(t);
    apps.push({ name: 'hydro-maintenance-scheduler', pm2_env: { status: 'stopped' } });
    await api.activate('test', 'upgrade');
    assert.deepEqual(calls.filter((call) => call[0] === 'stop').map((call) => call[1]), [...services].reverse());
    assert.equal((await api.readState()).state, 'active');
    assert.ok(fs.existsSync(path.join(dir, 'maintenance/active')));
    await api.turnOff();
    assert.deepEqual(calls.filter((call) => call[0] === 'restart').map((call) => call[1]), services);
    const deletion = calls.findIndex((call) => call[0] === 'delete');
    assert.ok(deletion > calls.findLastIndex((call) => call[0] === 'restart'));
    assert.equal(calls.at(-1)[0], 'save');
    assert.equal((await api.readState()).state, 'inactive');
    assert.equal(fs.existsSync(path.join(dir, 'maintenance/active')), false);
});

test('failed recovery keeps maintenance active and its snapshot available', async (t) => {
    const { api, dir, calls, failRestart } = await fixture(t);
    await api.activate('test', 'upgrade');
    failRestart('mongodb');
    await assert.rejects(api.turnOff(), /继续保持维护状态/);
    assert.equal((await api.readState()).state, 'active');
    assert.ok(fs.existsSync(path.join(dir, 'maintenance/.runtime.json')));
    assert.ok(fs.existsSync(path.join(dir, 'maintenance/active')));
    assert.equal(calls.some((call) => call[0] === 'delete'), false);
});

test('startup repairs a missing scheduler once, and cancellation cleans it up', async (t) => {
    const { api, calls } = await fixture(t);
    api.restoreSchedulerOnStartup();
    assert.equal(calls.length, 0);
    await api.writeState({ state: 'scheduled', id: 'test', startAt: Date.now() + 60000 });
    api.restoreSchedulerOnStartup();
    assert.equal(calls[0][2], 'restore-scheduler');
    assert.equal(calls[0][3], 30000);
    await api.restoreScheduler();
    await api.restoreScheduler();
    assert.equal(calls.filter((call) => call[0] === 'start').length, 1);
    await api.turnOff();
    assert.equal((await api.readState()).state, 'inactive');
    assert.equal(calls.some((call) => call[0] === 'stop'), false);
    assert.ok(calls.some((call) => call[0] === 'delete'));
});

test('a persisted overdue announcement activates and releases its lock', async (t) => {
    const { api, dir } = await fixture(t);
    await api.writeState({ state: 'scheduled', id: 'test', startAt: Date.now() - 1 });
    await api.reconcileScheduled();
    assert.equal((await api.readState()).state, 'active');
    assert.equal(fs.existsSync(path.join(dir, 'maintenance.lock')), false);
});

test('missing, partial, stale, and live owner files never cause an existing lock to be deleted', async (t) => {
    const { api, dir } = await fixture(t);
    const lock = path.join(dir, 'maintenance.lock');
    await fs.promises.mkdir(lock);
    for (const owner of [null, '', '2147483647\n', `${process.pid}\n`]) {
        if (owner !== null) await fs.promises.writeFile(path.join(lock, 'owner'), owner);
        await assert.rejects(api.acquireLock(), /已有维护或升级操作锁/);
        const shell = spawnSync('bash', ['-c', `${shellLockFunctions}\nacquire_operation_lock`], {
            env: { PATH: process.env.PATH, OPERATION_LOCK_DIR: lock }, encoding: 'utf8',
        });
        assert.equal(shell.status, 1);
        assert.match(shell.stdout, /已有维护或升级操作锁/);
        assert.ok(fs.existsSync(lock));
        if (owner !== null) assert.equal(await fs.promises.readFile(path.join(lock, 'owner'), 'utf8'), owner);
    }
    await fs.promises.rm(lock, { recursive: true });
    await api.acquireLock();
    await api.releaseLock();
    assert.equal(fs.existsSync(lock), false);
});
