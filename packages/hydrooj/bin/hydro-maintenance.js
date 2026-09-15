#!/usr/bin/env node

'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fsp = fs.promises;
const hydroHome = process.env.HYDRO_HOME || path.join(os.homedir(), '.hydro');
const explicitMaintenanceDir = process.env.HYDRO_MAINTENANCE_DIR;
const maintenanceDir = explicitMaintenanceDir || path.join(hydroHome, 'maintenance');
const caddyRoot = explicitMaintenanceDir || path.join(hydroHome, 'maintenance');
const stateFile = path.join(maintenanceDir, 'maintenance.json');
const runtimeFile = path.join(maintenanceDir, '.runtime.json');
const activeFile = path.join(maintenanceDir, 'active');
const caddyfile = process.env.HYDRO_CADDYFILE || path.join(hydroHome, 'Caddyfile');
const healthUrl = process.env.HYDRO_MAINTENANCE_HEALTH_URL || 'http://127.0.0.1:8888/status';
const lockDir = process.env.HYDRO_OPERATION_LOCK_DIR
    || process.env.HYDRO_MAINTENANCE_LOCK
    || path.join(hydroHome, 'maintenance.lock');
const lockOwnerFile = path.join(lockDir, 'owner');
const caddyMarkerBegin = '  # hydro-maintenance begin';
const caddyMarkerEnd = '  # hydro-maintenance end';
const serviceOrder = ['mongodb', 'hydro-sandbox', 'hydrojudge', 'hydrooj'];
const serviceTimeout = 120000;

let lockHandle;
let lockOwned = false;

function fail(message, code = 1) {
    console.error(`hydro-maintenance: ${message}`);
    process.exitCode = code;
}

function findBinary(name, fallback) {
    const candidates = [
        process.env[`${name.toUpperCase()}_BIN`],
        name,
        fallback,
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (candidate === name) {
            try {
                childProcess.execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
                return candidate;
            } catch (e) { }
        } else if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`找不到 ${name}`);
}

function pm2Path() {
    return findBinary('pm2', '/root/.nix-profile/bin/pm2');
}

function caddyPath() {
    return findBinary('caddy', '/root/.nix-profile/bin/caddy');
}

function run(command, args, options = {}) {
    const result = childProcess.spawnSync(command, args, {
        encoding: 'utf8',
        stdio: options.stdio || 'pipe',
        timeout: options.timeout,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
        const details = (result.stderr || result.stdout || '').trim();
        throw new Error(`${path.basename(command)} ${args.join(' ')} 失败${details ? `: ${details}` : ''}`);
    }
    return result;
}

function readPm2() {
    const result = run(pm2Path(), ['jlist']);
    try {
        return JSON.parse(result.stdout || '[]');
    } catch (e) {
        throw new Error(`无法解析 PM2 列表: ${e.message}`);
    }
}

function getPm2App(name, apps = readPm2()) {
    return apps.find((app) => app.name === name);
}

function isOnline(app) {
    return app?.pm2_env?.status === 'online';
}

async function acquireLock() {
    await fsp.mkdir(path.dirname(lockDir), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await fsp.mkdir(lockDir, 0o700);
            lockHandle = await fsp.open(lockOwnerFile, 'wx', 0o600);
            await lockHandle.writeFile(`${process.pid}\n`);
            lockOwned = true;
            return;
        } catch (e) {
            if (e.code !== 'EEXIST' || attempt) {
                if (e.code === 'EEXIST') throw new Error('已有另一个维护或升级操作正在执行');
                throw e;
            }
            try {
                const pid = Number.parseInt(await fsp.readFile(lockOwnerFile, 'utf8'), 10);
                if (!Number.isInteger(pid) || pid <= 0) throw new Error('维护锁没有有效的进程号，请手工检查并清理锁目录');
                process.kill(pid, 0);
                throw new Error('已有另一个维护或升级操作正在执行');
            } catch (error) {
                if (error.message.includes('已有另一个') || error.message.includes('没有有效的进程号')) throw error;
                if (!['ESRCH', 'ENOENT'].includes(error.code)) throw error;
                await fsp.unlink(lockOwnerFile).catch(() => undefined);
                await fsp.rmdir(lockDir).catch(() => undefined);
            }
        }
    }
}

async function releaseLock() {
    if (!lockOwned) return;
    lockOwned = false;
    await lockHandle?.close().catch(() => undefined);
    await fsp.unlink(lockOwnerFile).catch(() => undefined);
    await fsp.rmdir(lockDir).catch(() => undefined);
}

async function ensureMaintenanceDir() {
    await fsp.mkdir(hydroHome, { recursive: true });
    if (!explicitMaintenanceDir && !fs.existsSync(maintenanceDir) && fs.existsSync('/data-host')) {
        try {
            await fsp.access('/data-host', fs.constants.W_OK);
            await fsp.mkdir('/data-host/maintenance', { recursive: true });
            await fsp.symlink('/data-host/maintenance', maintenanceDir, 'dir');
        } catch (e) {
            if (e.code !== 'EEXIST') await fsp.mkdir(maintenanceDir, { recursive: true });
        }
    }
    await fsp.mkdir(maintenanceDir, { recursive: true });
}

async function atomicWrite(file, content, mode = 0o644) {
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    await fsp.writeFile(temporary, content, { mode });
    await fsp.chmod(temporary, mode);
    await fsp.rename(temporary, file);
}

function defaultState() {
    return {
        state: 'inactive',
        id: null,
        startAt: null,
        message: '',
        updatedAt: 0,
    };
}

async function readState() {
    try {
        const state = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
        if (!['inactive', 'scheduled', 'active'].includes(state.state)) throw new Error('状态值无效');
        return { ...defaultState(), ...state };
    } catch (e) {
        if (e.code === 'ENOENT') return defaultState();
        throw new Error(`无法读取维护状态: ${e.message}`);
    }
}

async function writeState(state) {
    await atomicWrite(stateFile, `${JSON.stringify({ ...defaultState(), ...state, updatedAt: Date.now() }, null, 2)}\n`);
}

async function readRuntime() {
    try {
        return JSON.parse(await fsp.readFile(runtimeFile, 'utf8'));
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw new Error(`无法读取维护服务快照: ${e.message}`);
    }
}

async function writeRuntime(runtime) {
    await atomicWrite(runtimeFile, `${JSON.stringify(runtime, null, 2)}\n`, 0o600);
}

function parseDuration(raw) {
    const match = /^(\d+)(s|m|h)$/.exec(String(raw || ''));
    if (!match || Number(match[1]) <= 0) throw new Error('--in 必须是正数秒/分钟/小时，例如 30s、10m 或 2h');
    const factor = { s: 1000, m: 60000, h: 3600000 }[match[2]];
    const duration = Number(match[1]) * factor;
    if (!Number.isSafeInteger(duration) || duration > 30 * 24 * 3600000) throw new Error('--in 最大支持 30 天');
    return duration;
}

function parseArgs(argv) {
    const command = argv.shift() || 'status';
    const options = { delay: 0, message: '' };
    if (command === '--help' || command === '-h' || command === 'help') options.help = true;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--in') options.delay = parseDuration(argv[++i]);
        else if (arg.startsWith('--in=')) options.delay = parseDuration(arg.slice(5));
        else if (arg === '--message' || arg === '-m') options.message = argv[++i] || '';
        else if (arg.startsWith('--message=')) options.message = arg.slice(10);
        else throw new Error(`未知参数 ${arg}`);
    }
    if (options.message.length > 500) throw new Error('--message 最多 500 个字符');
    return { command, options };
}

function caddyBlock() {
    return `${caddyMarkerBegin}
  @hydro_maintenance_json path /maintenance.json
  handle @hydro_maintenance_json {
    root * ${caddyRoot}
    header Cache-Control "no-store"
    file_server
  }
  @hydro_maintenance_page path /maintain.html
  handle @hydro_maintenance_page {
    root * ${caddyRoot}
    header Cache-Control "no-store"
    file_server
  }
  @hydro_maintenance_active file {
    root ${caddyRoot}
    try_files /active
  }
  handle @hydro_maintenance_active {
    redir * /maintain.html 302
  }
${caddyMarkerEnd}`;
}

function removeKnownVerificationOverride(content) {
    const override = `
http://localhost, http://127.0.0.1 {
  root * /root/.hydro/static
  rewrite * /maintain.html
  file_server
}
`;
    return content.includes(override) ? content.replace(override, '\n') : content;
}

function injectCaddyBlock(content) {
    const withoutManaged = content.replace(
        new RegExp(`${caddyMarkerBegin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${caddyMarkerEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g'),
        '',
    );
    const targets = [
        '  # Handle static files directly, for better performance.\n',
        '  @static {\n',
        '  handle @static {\n',
        '  handle {\n',
    ];
    let index = targets
        .map((target) => withoutManaged.indexOf(target))
        .filter((targetIndex) => targetIndex >= 0)
        .sort((a, b) => a - b)[0] ?? -1;
    if (index < 0) {
        const site = /^[ \t]*[^\s#{}][^{\n]*\{[ \t]*$/m.exec(withoutManaged);
        if (site) {
            const opening = site.index + site[0].lastIndexOf('{');
            let depth = 0;
            for (let i = opening; i < withoutManaged.length; i++) {
                if (withoutManaged[i] === '{') depth++;
                else if (withoutManaged[i] === '}' && --depth === 0) {
                    index = i;
                    break;
                }
            }
        }
    }
    if (index < 0) throw new Error('无法识别 Caddyfile：未找到可插入维护路由的 site，请手工加入维护路由');
    return `${withoutManaged.slice(0, index)}${caddyBlock()}\n${withoutManaged.slice(index)}`;
}

async function installPage() {
    const target = path.join(maintenanceDir, 'maintain.html');
    if (fs.existsSync(target)) return;
    const packagePage = path.resolve(__dirname, '..', 'static', 'maintain.html');
    const existingPage = path.join(hydroHome, 'static', 'maintain.html');
    const source = fs.existsSync(packagePage) ? packagePage : existingPage;
    if (!source || !fs.existsSync(source)) throw new Error(`找不到维护页，请放置到 ${target}`);
    await fsp.copyFile(source, target);
    await fsp.chmod(target, 0o644);
}

async function setup() {
    await ensureMaintenanceDir();
    await installPage();
    if (!fs.existsSync(stateFile)) await writeState(defaultState());
    if (!fs.existsSync(caddyfile)) throw new Error(`找不到 Caddyfile: ${caddyfile}`);

    const original = await fsp.readFile(caddyfile, 'utf8');
    const cleaned = removeKnownVerificationOverride(original);
    const updated = injectCaddyBlock(cleaned);
    let backup = null;
    if (updated !== original) {
        backup = `${caddyfile}.before-maintain-${Date.now()}`;
        await fsp.copyFile(caddyfile, backup);
        await atomicWrite(caddyfile, updated);
    }
    try {
        const caddy = caddyPath();
        run(caddy, ['validate', '--config', caddyfile, '--adapter', 'caddyfile'], { stdio: 'inherit' });
        run(caddy, ['reload', '--config', caddyfile, '--adapter', 'caddyfile'], { stdio: 'inherit' });
    } catch (e) {
        if (backup) {
            await fsp.copyFile(backup, caddyfile);
            try {
                const caddy = caddyPath();
                run(caddy, ['reload', '--config', caddyfile, '--adapter', 'caddyfile'], { stdio: 'inherit' });
            } catch (restoreError) {
                throw new Error(`Caddy 配置未能生效，原配置已写回但恢复 reload 失败: ${restoreError.message}`);
            }
            throw new Error(`Caddy 配置未能生效，已恢复原配置: ${e.message}`);
        }
        throw new Error(`Caddy 现有维护配置校验或 reload 失败: ${e.message}`);
    }
    console.log(backup
        ? `Caddy 维护路由已安装，备份: ${backup}`
        : 'Caddy 维护路由已存在，已完成 validate 和 reload。');
}

async function assertCaddyReady() {
    const apps = readPm2();
    const app = getPm2App('caddy', apps);
    if (!isOnline(app)) throw new Error('Caddy 不在线，已取消维护切换');
    const content = await fsp.readFile(caddyfile, 'utf8');
    if (!content.includes(caddyMarkerBegin) || !content.includes(caddyMarkerEnd)) {
        throw new Error('Caddyfile 尚未安装维护路由，请先执行 hydro-maintenance setup');
    }
}

function snapshotServices() {
    const apps = readPm2();
    return serviceOrder
        .map((name) => getPm2App(name, apps))
        .filter((app) => isOnline(app))
        .map((app) => app.name);
}

async function waitFor(check, description, timeout = serviceTimeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`等待${description}超时`);
}

async function waitPm2Online(name) {
    await waitFor(() => isOnline(getPm2App(name)), `${name} 启动`);
}

async function waitHydroReady() {
    await waitFor(async () => {
        try {
            const response = await fetch(healthUrl);
            return response.ok;
        } catch (e) {
            return false;
        }
    }, 'Hydro 健康检查');
}

async function activate(id, message) {
    await assertCaddyReady();
    const services = snapshotServices();
    if (!services.length) throw new Error('未检测到可停止的 Hydro 服务，未进入维护模式');
    await writeRuntime({ id, services, activatedAt: Date.now() });
    await writeState({ state: 'active', id, startAt: Date.now(), message });
    await atomicWrite(activeFile, `${id}\n`, 0o600);

    const failures = [];
    for (const name of services) {
        try {
            run(pm2Path(), ['stop', name], { stdio: 'inherit' });
        } catch (e) {
            failures.push(`${name}: ${e.message}`);
        }
    }
    try {
        run(pm2Path(), ['save'], { stdio: 'inherit' });
    } catch (e) {
        failures.push(`pm2 save: ${e.message}`);
    }
    if (failures.length) throw new Error(`维护切换已生效，但部分服务停止失败：${failures.join('; ')}`);
    console.log('维护模式已开启，Caddy 保持运行。');
}

async function schedule(options) {
    const state = await readState();
    if (state.state !== 'inactive' || fs.existsSync(activeFile)) throw new Error('维护模式已经处于 scheduled 或 active 状态');
    await assertCaddyReady();
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const startAt = Date.now() + options.delay;
    await writeState({ state: 'scheduled', id, startAt, message: options.message });
    console.log(`维护预告已发布，将于 ${new Date(startAt).toLocaleString()} 自动进入维护。`);
    let cancelled = false;
    const cancel = async () => {
        if (cancelled) return;
        cancelled = true;
        let acquired = false;
        try {
            await acquireLock();
            acquired = true;
            const current = await readState();
            if (current.id === id && current.state === 'scheduled') await writeState(defaultState());
            console.log('\n已取消维护预告。');
            process.exitCode = 130;
        } catch (e) {
            console.error(`\n取消维护预告失败: ${e.message}`);
            process.exitCode = 1;
        } finally {
            if (acquired) await releaseLock();
        }
    };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    await releaseLock();
    await new Promise((resolve) => setTimeout(resolve, options.delay));
    if (cancelled) return;
    await acquireLock();
    const current = await readState();
    if (current.id !== id || current.state !== 'scheduled') return;
    await activate(id, options.message);
}

async function turnOn(options) {
    if (options.delay) await schedule(options);
    else {
        const state = await readState();
        if (state.state !== 'inactive' || fs.existsSync(activeFile)) throw new Error('维护模式已经处于 scheduled 或 active 状态');
        const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
        await activate(id, options.message);
    }
}

async function turnOff() {
    const state = await readState();
    if (state.state === 'inactive' && !fs.existsSync(activeFile)) {
        console.log('当前未处于维护模式。');
        return;
    }
    if (state.state === 'scheduled' && !fs.existsSync(activeFile)) {
        await writeState(defaultState());
        console.log('已取消维护预告，服务未被停止。');
        return;
    }
    const runtime = await readRuntime();
    if (!Array.isArray(runtime?.services) || runtime.services.length === 0) {
        throw new Error('维护前服务快照为空或无效，保留维护状态以避免暴露未恢复的服务');
    }
    const failures = [];
    for (const name of serviceOrder) {
        if (!runtime.services.includes(name)) continue;
        try {
            run(pm2Path(), ['restart', name, '--update-env'], { stdio: 'inherit' });
            await waitPm2Online(name);
            if (name === 'hydrooj') await waitHydroReady();
        } catch (e) {
            failures.push(`${name}: ${e.message}`);
            break;
        }
    }
    if (failures.length) throw new Error(`服务尚未完全恢复，继续保持维护状态：${failures.join('; ')}`);
    await writeState(defaultState());
    await fsp.unlink(activeFile).catch(() => undefined);
    await fsp.unlink(runtimeFile).catch(() => undefined);
    run(pm2Path(), ['save'], { stdio: 'inherit' });
    console.log('维护模式已关闭，服务已恢复。');
}

async function status() {
    const state = await readState();
    const active = fs.existsSync(activeFile);
    console.log(`状态: ${state.state}${active ? ' (Caddy active 标记存在)' : ''}`);
    if (state.startAt) console.log(`开始时间: ${new Date(state.startAt).toLocaleString()}`);
    if (state.message) console.log(`提示: ${state.message}`);
    try {
        const apps = readPm2();
        for (const name of ['caddy', ...serviceOrder]) {
            const app = getPm2App(name, apps);
            console.log(`${name}: ${app ? app.pm2_env?.status || 'unknown' : 'not-found'}${app?.pid ? ` (PID ${app.pid})` : ''}`);
        }
    } catch (e) {
        console.log(`PM2: ${e.message}`);
    }
}

function printHelp() {
    console.log(`用法:
  hydro-maintenance setup
  hydro-maintenance on [--in 10m] [--message "..."]
  hydro-maintenance off
  hydro-maintenance status

--in 支持 s/m/h，例如 30s、10m、2h；不指定时立即进入维护。
维护状态目录可通过 HYDRO_MAINTENANCE_DIR 覆盖，恢复检查地址可通过 HYDRO_MAINTENANCE_HEALTH_URL 覆盖。`);
}

async function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.options.help) return printHelp();
    if (parsed.command === 'status') return status();
    if (!['setup', 'on', 'off'].includes(parsed.command)) throw new Error(`未知命令 ${parsed.command}`);
    await acquireLock();
    try {
        if (parsed.command === 'setup') await setup();
        if (parsed.command === 'on') await turnOn(parsed.options);
        if (parsed.command === 'off') await turnOff();
    } finally {
        await releaseLock();
    }
}

main().catch((error) => fail(error.message));
