const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function transpileFile(filePath) {
    const code = fs.readFileSync(filePath, 'utf8');
    return ts.transpileModule(code, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            experimentalDecorators: true,
            esModuleInterop: true,
        },
    }).outputText;
}

test('contest.ts: canShowProblemStatus enforces showRecord for homework and handles course safely', () => {
    const contestFile = path.resolve(__dirname, '../packages/hydrooj/src/model/contest.ts');
    const compiledContest = transpileFile(contestFile);

    const exports = {};
    const mocks = {
        '../service/bus': { emit: async () => {}, parallel: async () => {} },
        '../service/db': { collection: () => ({}) },
        '../model/domain': { get: async () => ({}) },
        '../model/document': { TYPE_CONTEST: 20 },
        '../model/problem': { getList: async () => ({}) },
        '../model/user': { getListForRender: async () => ({}) },
        '@hydrooj/utils': { Logger: class { warn() {} error() {} info() {} } },
        '@hydrooj/utils/lib/utils': { Logger: class { warn() {} error() {} info() {} }, formatSeconds: (s) => String(s) },
        '@hydrooj/common': {
            PRIV: {},
            PERM: {
                PERM_VIEW: 1,
                PERM_VIEW_HIDDEN_CONTEST: 2,
                PERM_VIEW_HIDDEN_HOMEWORK: 4,
                PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD: 8,
                PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD: 64,
                PERM_EDIT_HOMEWORK: 16,
                PERM_EDIT_HOMEWORK_SELF: 32,
            },
            STATUS: { STATUS_ACCEPTED: 1 },
        },
        '../utils': { Logger: class { warn() {} error() {} info() {} } },
        './builtin': {
            PERM: {
                PERM_VIEW: 1,
                PERM_VIEW_HIDDEN_CONTEST: 2,
                PERM_VIEW_HIDDEN_HOMEWORK: 4,
                PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD: 8,
                PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD: 64,
                PERM_EDIT_HOMEWORK: 16,
                PERM_EDIT_HOMEWORK_SELF: 32,
            },
            STATUS: { STATUS_ACCEPTED: 1 },
        },
        mongodb: require('mongodb'),
        lodash: require('lodash'),
    };

    vm.runInNewContext(
        compiledContest,
        {
            global: { Hydro: { model: {} } },
            exports,
            require: (name) => mocks[name] || {},
            Date,
        },
        { filename: contestFile },
    );

    const { canShowProblemStatus, canShowRecord, canShowSelfRecord, canShowScoreboard } = exports;

    const now = Date.now();
    const activeHomework = {
        rule: 'homework',
        beginAt: new Date(now - 3600 * 1000),
        endAt: new Date(now + 3600 * 1000), // In progress!
        keepScoreboardHidden: false,
    };

    const hiddenHomework = {
        rule: 'homework',
        beginAt: new Date(now - 3600 * 1000),
        endAt: new Date(now + 3600 * 1000),
        keepScoreboardHidden: true,
    };

    const endedHomework = {
        rule: 'homework',
        beginAt: new Date(now - 7200 * 1000),
        endAt: new Date(now - 3600 * 1000), // Ended!
        keepScoreboardHidden: false,
    };

    const courseDoc = {
        rule: 'course',
        keepScoreboardHidden: false,
    };

    const hiddenCourseDoc = {
        rule: 'course',
        keepScoreboardHidden: true,
    };

    // Homework in progress should be counted towards RP if scoreboard is unhidden (supports long cycle homework)
    assert.equal(canShowProblemStatus(null, 100, activeHomework), true, 'Active unhidden homework must be visible to null user to count towards RP');
    assert.equal(canShowProblemStatus(null, 100, hiddenHomework), false, 'Hidden homework must not be visible to null user');
    assert.equal(canShowProblemStatus(null, 100, endedHomework), true, 'Ended unhidden homework should be visible to null user');

    // Course should be visible if not hidden
    assert.equal(canShowProblemStatus(null, 100, courseDoc), true, 'Unhidden course should be visible to null user');
    assert.equal(canShowProblemStatus(null, 100, hiddenCourseDoc), false, 'Hidden course must not be visible to null user');

    // Regular contest must still enforce rated flag
    const unratedContest = {
        rule: 'oi',
        rated: false,
        keepScoreboardHidden: false,
    };
    assert.equal(canShowProblemStatus(null, 100, unratedContest), false, 'Unrated contest must not count towards RP');

    // Verify safe handling of rule: 'course' where RULES['course'] is undefined
    const fakeUser = {
        _id: 1,
        own: () => false,
        hasPerm: () => false,
        hasPriv: () => false,
    };
    // Verify Fail-Closed defense: regular user must NOT view hidden scoreboard or records
    assert.equal(
        canShowScoreboard.call({ user: fakeUser }, hiddenCourseDoc),
        false,
        '无特殊权限的普通用户绝不可查看设置了 keepScoreboardHidden 的课程榜单',
    );
    assert.equal(
        canShowRecord.call({ user: fakeUser }, hiddenCourseDoc),
        false,
        '无特殊权限的普通用户绝不可查看设置了 keepScoreboardHidden 的课程记录',
    );
    assert.equal(
        canShowSelfRecord.call({ user: fakeUser }, hiddenCourseDoc),
        false,
        '无特殊权限的普通用户绝不可查看设置了 keepScoreboardHidden 的课程自身记录',
    );
});

test('config.ts: updateEnvFileKey sanitizes newlines and validates key; config set rejects prototype keys', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-config-test-'));
    try {
        const configFile = path.resolve(__dirname, '../packages/hydrooj/src/commands/config.ts');
        const compiledConfig = transpileFile(configFile);

        const exports = {};
        const mocks = {
            '../options': { hydroPath: tmpDir },
            '@hydrooj/utils': { Logger: class { warn() {} error() {} info() {} success() {} } },
            cac: { CAC: class {} },
            'fs-extra': require('fs-extra'),
            path,
        };

        vm.runInNewContext(
            compiledConfig,
            {
                exports,
                require: (name) => mocks[name] || require(name),
                process: { env: {}, exitCode: 0 },
                console,
            },
            { filename: configFile },
        );

        const { updateEnvFileKey, readEnvFileKey, removeEnvFileKey, register } = exports;

        // 1. Valid key and value
        updateEnvFileKey('NPM_REGISTRY', 'https://npm.example.com');
        assert.equal(readEnvFileKey('NPM_REGISTRY'), 'https://npm.example.com');

        // 2. Value with newlines must be sanitized (newlines stripped)
        updateEnvFileKey('NPM_REGISTRY', 'https://npm.example.com\nEVIL_VAR=hacked\r\n');
        assert.equal(readEnvFileKey('NPM_REGISTRY'), 'https://npm.example.comEVIL_VAR=hacked');
        assert.equal(readEnvFileKey('EVIL_VAR'), undefined, 'Newlines must not create new env keys');

        // 3. Invalid key name must throw
        assert.throws(() => {
            updateEnvFileKey('INVALID=KEY', 'test');
        }, /非法环境变量键名/);
        assert.throws(() => {
            removeEnvFileKey('INVALID=KEY');
        }, /非法环境变量键名/);

        // 4. Prototype keys rejected in CLI action
        let actionHandler;
        const fakeCli = {
            command: () => ({
                action: (fn) => { actionHandler = fn; },
            }),
        };
        register(fakeCli);
        assert.ok(actionHandler);

        const proc = { exitCode: 0 };
        vm.runInNewContext(
            compiledConfig,
            {
                exports,
                require: (name) => mocks[name] || require(name),
                process: proc,
                console,
            },
            { filename: configFile },
        );
        exports.register(fakeCli);

        actionHandler('set', '__proto__', 'polluted');
        assert.equal(proc.exitCode, 1, 'Setting __proto__ must set exitCode 1');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('upgrade.ts: executeUpgrade rejects argument injection and path traversal', () => {
    const upgradeFile = path.resolve(__dirname, '../packages/hydrooj/src/commands/upgrade.ts');
    const compiledUpgrade = transpileFile(upgradeFile);

    const exports = {};
    const errorLogs = [];
    const mocks = {
        '../options': { hydroPath: '/tmp' },
        './config': { getRegistryUrl: () => 'https://npm.example.com' },
        '@hydrooj/utils': {
            Logger: class {
                warn() {}
                error(msg) { errorLogs.push(msg); }
                info() {}
            },
        },
        cac: { CAC: class {} },
        'fs-extra': { existsSync: () => true, accessSync: () => true },
        'child_process': { spawnSync: () => ({ status: 0 }) },
        path,
        os: { homedir: () => '/tmp' },
    };

    const proc = { exitCode: 0, env: {} };
    vm.runInNewContext(
        compiledUpgrade,
        {
            exports,
            require: (name) => mocks[name] || require(name),
            process: proc,
            console,
        },
        { filename: upgradeFile },
    );

    const { executeUpgrade } = exports;

    // 1. Argument injection attempt (--eval, -f)
    proc.exitCode = 0;
    executeUpgrade('--eval=alert(1)', {});
    assert.equal(proc.exitCode, 1, 'Argument injection starting with - must be rejected');

    // 2. Path traversal attempt (../../foo)
    proc.exitCode = 0;
    executeUpgrade('../../evil-package', {});
    assert.equal(proc.exitCode, 1, 'Path traversal must be rejected');

    // 3. Rollback argument injection
    proc.exitCode = 0;
    executeUpgrade(undefined, { rollback: '--flag-injection' });
    assert.equal(proc.exitCode, 1, 'Rollback flag injection must be rejected');

    // 4. Packages argument injection
    proc.exitCode = 0;
    executeUpgrade(undefined, { packages: '--injection,framework' });
    assert.equal(proc.exitCode, 1, 'Packages flag injection must be rejected');
});
