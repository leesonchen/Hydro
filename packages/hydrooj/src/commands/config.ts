import path from 'path';
import { CAC } from 'cac';
import fs from 'fs-extra';
import { Logger } from '@hydrooj/utils';
import { hydroPath } from '../options';

const logger = new Logger('config');
const configFile = path.resolve(hydroPath, 'config.json');
const envFile = path.resolve(hydroPath, 'env');

export function readConfigFile(): Record<string, any> {
    if (!fs.existsSync(configFile)) return {};
    try {
        return JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    } catch (e: any) {
        logger.error(`无法解析配置文件 ${configFile}:`, e.message);
        throw new Error(`配置文件损坏或格式错误: ${configFile}，已阻止操作以防配置被覆写清空。`);
    }
}

function writeFileAtomic(file: string, content: string): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, file);
}

export function writeConfigFile(data: Record<string, any>): void {
    fs.ensureDirSync(hydroPath);
    writeFileAtomic(configFile, JSON.stringify(data, null, 2));
}

export function readEnvFileKey(key: string): string | undefined {
    if (!fs.existsSync(envFile)) return undefined;
    try {
        const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
            const [k, ...v] = trimmed.split('=');
            if (k.trim() === key) {
                let val = v.join('=').trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                return val;
            }
        }
    } catch (_) {}
    return undefined;
}

export function updateEnvFileKey(key: string, value: string): void {
    fs.ensureDirSync(hydroPath);
    let content = '';
    if (fs.existsSync(envFile)) {
        content = fs.readFileSync(envFile, 'utf-8');
    }
    const lines = content.trim() ? content.split('\n') : [];
    let replaced = false;
    const newLines = lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith(`${key}=`)) {
            replaced = true;
            return `${key}=${value}`;
        }
        return line;
    });
    if (!replaced) {
        newLines.push(`${key}=${value}`);
    }
    writeFileAtomic(envFile, `${newLines.join('\n').trim()}\n`);
}

export function removeEnvFileKey(key: string): void {
    if (!fs.existsSync(envFile)) return;
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    const newLines = lines.filter((line) => !line.trim().startsWith(`${key}=`));
    const output = newLines.join('\n').trim();
    writeFileAtomic(envFile, output ? `${output}\n` : '');
}

export function getRegistryUrl(cliRegistry?: string): string {
    if (cliRegistry) return cliRegistry;
    if (process.env.NPM_REGISTRY) return process.env.NPM_REGISTRY;

    const cfg = readConfigFile();
    if (cfg.registry) return cfg.registry;
    if (cfg.npm_registry) return cfg.npm_registry;

    const envVal = readEnvFileKey('NPM_REGISTRY');
    if (envVal) return envVal;

    throw new Error(
        '未检测到私有 npm 仓库配置。请先执行 `hydrooj config set registry <url>`，或通过 `--registry <url>` / 环境变量 `NPM_REGISTRY` 指定。',
    );
}

export function register(cli: CAC): void {
    cli.command('config [action] [key] [value]', '配置管理 (get, set, unset, list)。固定读写 ~/.hydro/config.json；dev 源码目录下运行的服务端可能读取 cwd 下的 config.json')
        .action((action = 'list', key, value) => {
            const normalizedAction = action.toLowerCase();
            let config: Record<string, any>;
            try {
                config = readConfigFile();
            } catch (e: any) {
                logger.error(e.message);
                process.exitCode = 1;
                return;
            }

            if (normalizedAction === 'list' || (!key && normalizedAction === 'get')) {
                let registry: string | undefined;
                try {
                    registry = getRegistryUrl();
                } catch (_) {
                    registry = undefined;
                }
                logger.info('当前 Hydro 配置:');
                console.log(JSON.stringify({
                    ...config,
                    registry_resolved: registry || '未配置 (请执行 `hydrooj config set registry <url>`)',
                }, null, 2));
                return;
            }

            if (normalizedAction === 'get') {
                if (key === 'registry' || key === 'npm_registry') {
                    try {
                        const registry = getRegistryUrl();
                        console.log(registry);
                    } catch (e: any) {
                        logger.error(e.message);
                        process.exitCode = 1;
                    }
                    return;
                }
                const val = config[key];
                if (val === undefined) {
                    logger.warn(`配置项 ${key} 未设置`);
                } else {
                    console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : val);
                }
                return;
            }

            if (normalizedAction === 'set') {
                if (!key || value === undefined) {
                    logger.error('用法: hydrooj config set <key> <value>');
                    process.exitCode = 1;
                    return;
                }
                config[key] = value;
                writeConfigFile(config);

                if (key === 'registry' || key === 'npm_registry') {
                    updateEnvFileKey('NPM_REGISTRY', value);
                }

                logger.success(`配置项 ${key} 已更新为: ${value}`);
                return;
            }

            if (normalizedAction === 'unset' || normalizedAction === 'delete') {
                if (!key) {
                    logger.error('用法: hydrooj config unset <key>');
                    process.exitCode = 1;
                    return;
                }
                delete config[key];
                writeConfigFile(config);

                if (key === 'registry' || key === 'npm_registry') {
                    removeEnvFileKey('NPM_REGISTRY');
                }

                logger.success(`配置项 ${key} 已删除`);
                return;
            }

            logger.error(`未知操作 ${action}。支持的操作: get, set, unset, list`);
            process.exitCode = 1;
        });
}
