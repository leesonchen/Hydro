import childProcess from 'child_process';
import os from 'os';
import path from 'path';
import { CAC } from 'cac';
import fs from 'fs-extra';
import { Logger } from '@hydrooj/utils';
import { hydroPath } from '../options';
import { getRegistryUrl } from './config';

const logger = new Logger('upgrade');

function buildEnhancedPath(): string {
    const extraDirs = [
        path.join(os.homedir(), '.nix-profile', 'bin'),
        '/nix/var/nix/profiles/default/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
    ];
    const currentPaths = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const existing = new Set(currentPaths);
    const missing = extraDirs.filter((dir) => fs.existsSync(dir) && !existing.has(dir));
    return [...currentPaths, ...missing].join(path.delimiter);
}

function findUpgradeScript(): string {
    const candidates = [
        process.env.HYDRO_UPGRADE_SCRIPT,
        path.resolve(__dirname, '../../bin/install-dev-from-private-npm.sh'),
        path.resolve(__dirname, '../bin/install-dev-from-private-npm.sh'),
        path.resolve(__dirname, '../../bin/hydro-upgrade.sh'),
        path.resolve(hydroPath, 'install-dev-from-private-npm.sh'),
        '/usr/local/bin/hydro-upgrade',
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
            } catch (_) {
                try {
                    fs.chmodSync(candidate, 0o755);
                    logger.warn(`已为更新脚本添加执行权限: ${candidate}`);
                } catch { }
            }
            return candidate;
        }
    }

    throw new Error(
        '未找到更新执行脚本 install-dev-from-private-npm.sh，请设置环境变量 HYDRO_UPGRADE_SCRIPT 指定脚本绝对路径。',
    );
}

export interface UpgradeOptions {
    registry?: string;
    restart?: boolean;
    noRestart?: boolean;
    skipRestart?: boolean;
    packages?: string;
    interactive?: boolean;
    rollback?: string | boolean;
    check?: boolean;
    listBackups?: boolean;
    [key: string]: any;
}

export function executeUpgrade(targetPackage: string | undefined, options: UpgradeOptions): void {
    let scriptPath: string;
    try {
        scriptPath = findUpgradeScript();
    } catch (e: any) {
        logger.error(e.message);
        process.exitCode = 1;
        return;
    }

    let registry: string;
    try {
        registry = getRegistryUrl(options.registry);
    } catch (e: any) {
        logger.error(e.message);
        process.exitCode = 1;
        return;
    }
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: buildEnhancedPath(),
        NPM_REGISTRY: registry,
        HYDRO_HOME: hydroPath,
    };

    const isSkipRestart = options.restart === false
        || options.skipRestart === true
        || process.env.SKIP_RESTART === '1'
        || process.env.SKIP_RESTART === 'true';

    if (isSkipRestart) {
        env.SKIP_RESTART = '1';
    }

    const scriptArgs: string[] = [];

    if (options.listBackups) {
        scriptArgs.push('list-backups');
    } else if (options.rollback !== undefined) {
        scriptArgs.push('rollback');
        if (typeof options.rollback === 'string' && options.rollback.trim()) {
            scriptArgs.push(options.rollback.trim());
        }
    } else if (options.check) {
        scriptArgs.push('check-updates');
    } else if (options.interactive) {
        scriptArgs.push('upgrade-interactive');
    } else {
        scriptArgs.push('update');
        if (targetPackage) {
            scriptArgs.push(targetPackage);
        }
        if (options.packages) {
            scriptArgs.push(`--packages=${options.packages}`);
        }
    }

    if (isSkipRestart && !scriptArgs.includes('list-backups') && !scriptArgs.includes('check-updates')) {
        scriptArgs.push('--no-restart');
    }

    logger.info(`使用仓库: ${registry}`);
    logger.info(`调用更新引擎: ${scriptPath} ${scriptArgs.join(' ')}`);

    const result = childProcess.spawnSync(scriptPath, scriptArgs, {
        stdio: 'inherit',
        env,
    });

    if (result.error) {
        logger.error(`更新执行失败: ${result.error.message}`);
        process.exitCode = 1;
        return;
    }

    if (result.signal) {
        logger.error(`更新脚本被信号 ${result.signal} 终止`);
        process.exitCode = 1;
        return;
    }

    process.exitCode = result.status ?? 1;
}

export function register(cli: CAC): void {
    cli.command('upgrade [package]', '从私有 npm 仓库更新/回退 Hydro 开发版本并管理服务')
        .alias('update')
        .option('--registry <url>', '指定私有 npm 仓库地址')
        .option('--no-restart', '更新完成后跳过自动重启服务与在线验证')
        .option('--skip-restart', '更新完成后跳过自动重启服务与在线验证')
        .option('--packages <packages>', '指定更新的模块，如 framework,hydrojudge')
        .option('-i, --interactive', '交互式选择待更新模块')
        .option('--rollback [id]', '回退到指定备份或最新备份')
        .option('--check', '仅检查 dev 版本更新，不执行安装')
        .option('--list-backups', '列出所有可用的历史备份')
        .action((target, options) => {
            executeUpgrade(target, options);
        });
}
