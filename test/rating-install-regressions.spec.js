const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const installerPath = path.resolve(__dirname, '../packages/hydrooj/bin/install-dev-from-private-npm.sh');
const installer = fs.readFileSync(installerPath, 'utf8');

test('installer can be executed directly to show help', () => {
    const result = spawnSync(installerPath, ['--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.match(result.stdout, /用法:/);
});

function extract(name) {
    const pattern = new RegExp('^' + name + '\\(\\) \\{[\\s\\S]*?^\\}', 'm');
    const match = installer.match(pattern);
    assert(match, 'installer function not found: ' + name);
    return match[0];
}

const fixture = [
    'set -euo pipefail',
    "RED='' NC=''",
    'PACKAGE_KEYS=(hydrooj)',
    'SELECTED_PACKAGE_KEYS=()',
    'declare -A CURRENT_PACKAGE_VERSIONS=()',
    'declare -A REMOTE_PACKAGE_VERSIONS=()',
    'declare -A SELECTED_PACKAGE_VERSIONS=()',
    'RELEASE_INCREMENTAL_INSTALL=0',
    'log_title(){ :; }',
    'log_warn(){ :; }',
    'log_ok(){ :; }',
    'log_error(){ echo "$*" >&2; }',
    'package_name_for_key(){ printf "%s" "$1"; }',
    'remote_package_version(){ printf "%s" "$TEST_REMOTE"; }',
    'load_package_versions(){ CURRENT_PACKAGE_VERSIONS=(); REMOTE_PACKAGE_VERSIONS=(); CURRENT_PACKAGE_VERSIONS[hydrooj]="5.0.7-dev.1"; REMOTE_PACKAGE_VERSIONS[hydrooj]="$TEST_REMOTE"; }',
    'print_update_table(){ :; }',
    'select_all_packages(){ SELECTED_PACKAGE_KEYS=(hydrooj); }',
    'add_selected_package_key(){ SELECTED_PACKAGE_KEYS=(hydrooj); }',
    'check_maintenance_state(){ :; }',
    'check_tools(){ :; }',
    'check_node_version(){ :; }',
    'setup_registry(){ :; }',
    'run_selected_install(){ echo INSTALL_STARTED; }',
    'is_key_selected(){ [ "$1" = "hydrooj" ]; }',
    'package_version_from_dir(){ printf "%s" "$TEST_INSTALLED"; }',
].join('\n');

function run(body, names = ['has_unknown_remote_versions', 'select_outdated_packages', 'prepare_selected_packages', 'install_flow'], opts = {}) {
    const shell = [fixture, ...names.map(extract), body].join('\n');
    return spawnSync('bash', ['-c', shell, 'rating-installer', opts.release || ''], {
        encoding: 'utf8',
        env: { ...process.env, TEST_REMOTE: opts.remote || '', TEST_INSTALLED: opts.installed || '5.0.7-dev.1' },
    });
}

test('default update does not mistake registry failure for no updates', () => {
    const result = run('install_flow update');
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /查询失败/);
    assert.doesNotMatch(result.stdout, /INSTALL_STARTED/);
});

test('explicit package update fails if remote metadata is unknown', () => {
    const result = run('SELECTED_PACKAGE_KEYS=(hydrooj)\ninstall_flow update');
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /无法确认/);
    assert.doesNotMatch(result.stdout, /INSTALL_STARTED/);
});

test('known matching version is a successful verified no-op', () => {
    const result = run('install_flow update', undefined, { remote: '5.0.7-dev.1' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /INSTALL_STARTED/);
});

test('newer known remote version enters the installation flow', () => {
    const result = run('install_flow update', undefined, { remote: '5.0.7-dev.2' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /INSTALL_STARTED/);
});

test('installed dev version must match the expected selected version', () => {
    const release = fs.mkdtempSync(path.join(os.tmpdir(), 'rating-installer-'));
    try {
        const dir = path.join(release, 'node_modules/.bin');
        fs.mkdirSync(dir, { recursive: true });
        for (const name of ['hydrooj', 'hydro-maintenance']) {
            const file = path.join(dir, name);
            fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
            fs.chmodSync(file, 0o755);
        }
        const result = run('SELECTED_PACKAGE_KEYS=(hydrooj)\nREMOTE_PACKAGE_VERSIONS[hydrooj]="5.0.7-dev.2"\nverify_release "$1"',
            ['verify_release'], { release, installed: '5.0.7-dev.1' });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /实际安装版本不匹配/);
    } finally {
        fs.rmSync(release, { recursive: true, force: true });
    }
});
