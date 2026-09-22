/* eslint-disable max-len, style/quotes */
import fs from 'fs/promises';
import path from 'path';
import {
    analyzeExamPackage, applyExamPackage, exportExamPackage, generateMergeReport, redactForLog,
    rollbackExamMigration, verifyExamMigration,
} from './exam';

interface ParsedArgs {
    _: string[];
    [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): ParsedArgs {
    const result: ParsedArgs = { _: [] };
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (!value.startsWith('-')) {
            result._.push(value);
            continue;
        }
        const stripped = value.replace(/^--?/, '');
        const equals = stripped.indexOf('=');
        if (equals >= 0) {
            result[stripped.slice(0, equals)] = stripped.slice(equals + 1);
            continue;
        }
        const next = argv[index + 1];
        if (next && !next.startsWith('-')) {
            result[stripped] = next;
            index++;
        } else result[stripped] = true;
    }
    return result;
}

function env(args: ParsedArgs, key: string, ...names: string[]): string | undefined {
    for (const argKey of [key, ...names]) {
        const value = args[argKey];
        if (typeof value === 'string') return value;
    }
    for (const name of names) if (process.env[name]) return process.env[name];
    return undefined;
}

function flag(args: ParsedArgs, key: string): boolean {
    return args[key] === true || args[key] === 'true' || args[key] === '1';
}

function options(args: ParsedArgs) {
    const packageDir = env(args, 'package', 'run-dir', 'HYDRO_EXAM_PACKAGE', 'HYDRO_EXAM_RUN_DIR');
    return {
        sourceUri: env(args, 'source-uri', 'HYDRO_EXAM_SOURCE_URI'),
        targetUri: env(args, 'target-uri', 'HYDRO_EXAM_TARGET_URI'),
        sourceDatabase: env(args, 'source-db', 'HYDRO_EXAM_SOURCE_DB'),
        targetDatabase: env(args, 'target-db', 'HYDRO_EXAM_TARGET_DB'),
        domainId: env(args, 'domain', 'HYDRO_EXAM_DOMAIN'),
        runDir: packageDir ? path.resolve(packageDir) : undefined,
        packageDir: packageDir ? path.resolve(packageDir) : undefined,
        sourceStorageRoot: env(args, 'source-storage-root', 'HYDRO_EXAM_SOURCE_STORAGE_ROOT'),
        targetStorageRoot: env(args, 'target-storage-root', 'HYDRO_EXAM_TARGET_STORAGE_ROOT'),
        planHash: env(args, 'plan-hash', 'HYDRO_EXAM_PLAN_HASH'),
        dryRun: flag(args, 'dry-run'),
        noStop: flag(args, 'no-stop'),
        noBackup: flag(args, 'no-backup'),
        yes: flag(args, 'yes'),
        mergeExisting: flag(args, 'merge-existing'),
    };
}

function print(value: any) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function logCommand(runDir: string | undefined, args: ParsedArgs) {
    if (!runDir) return;
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    await fs.appendFile(
        path.join(runDir, 'commands.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), argv: redactForLog(args) })}\n`,
        { mode: 0o600 },
    );
}

function help() {
    process.stdout.write(`exam migration (read-only source, immutable package)\n\nUsage:\n  exam-migrate export  --source-uri URI [--source-db DB] [--run-dir DIR]\n  exam-migrate analyze --package DIR --target-uri URI [--target-db DB] [--merge-existing]\n  exam-migrate apply   --package DIR --target-uri URI --plan-hash HASH [--target-storage-root DIR] [--merge-existing]\n  exam-migrate verify  --package DIR --target-uri URI [--target-storage-root DIR]\n  exam-migrate rollback --package DIR --target-uri URI --yes\n\nOptions:\n  --no-stop       Do not run pm2 stop/start (only for an explicitly isolated target)\n  --no-backup     Skip the pre-apply mongodump (not recommended)\n  --dry-run       Validate apply preconditions without writing\n  --merge-existing  Preserve an existing exam domain and merge only new objects\n  --yes           Confirm rollback\n\nCredentials are accepted through environment variables as well:\n  HYDRO_EXAM_SOURCE_URI, HYDRO_EXAM_TARGET_URI, HYDRO_EXAM_SOURCE_DB,\n  HYDRO_EXAM_TARGET_DB, HYDRO_EXAM_RUN_DIR, HYDRO_EXAM_PLAN_HASH\n`);
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const command = args._[0];
    if (!command || command === 'help' || flag(args, 'help')) {
        help();
        return;
    }
    const common = options(args);
    if (command === 'export') {
        const result = await exportExamPackage(common);
        await logCommand(path.resolve(common.runDir || path.join('migration-runs', result.runId)), args);
        print({ runId: result.runId, packageHash: result.packageHash, counts: result.counts });
        return;
    }
    if (command === 'analyze') {
        const result = await analyzeExamPackage(common);
        await logCommand(common.runDir, args);
        print({ runId: result.runId, planHash: result.planHash, packageHash: result.packageHash });
        return;
    }
    if (command === 'apply') {
        await logCommand(common.runDir, args);
        const result = await applyExamPackage({
            ...common,
            serviceControl: common.noStop ? 'none' : 'pm2',
        });
        if (result.dryRun) {
            print({ runId: result.runId, dryRun: true, planHash: result.planHash });
            return;
        }
        // The target remains stopped while verification runs.  If verification
        // fails, leave it stopped so an operator can inspect and roll back.
        const verification = await verifyExamMigration(common);
        if (!verification.ok) throw new Error(`迁移验证失败，服务保持停止: ${verification.errors.join('; ')}`);
        const mergeReport = await generateMergeReport(common);
        if (!common.noStop) {
            const { spawn } = await import('child_process');
            await new Promise<void>((resolve, reject) => {
                const child = spawn('pm2', ['start', 'hydrooj'], { stdio: 'inherit' });
                child.once('error', reject);
                child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`pm2 start hydrooj exited ${code}`)));
            });
        }
        print({ runId: result.runId, applied: true, verified: true, inserted: result.inserted.length, mergeReport: 'merge-report.json', identities: mergeReport.identities.length, contests: mergeReport.contests.length, problems: mergeReport.problems.length });
        return;
    }
    if (command === 'verify') {
        await logCommand(common.runDir, args);
        const result = await verifyExamMigration(common);
        const mergeReport = result.ok ? await generateMergeReport(common) : null;
        print(result);
        if (mergeReport) print({ mergeReport: 'merge-report.json' });
        if (!result.ok) process.exitCode = 2;
        return;
    }
    if (command === 'report') {
        await logCommand(common.runDir, args);
        const result = await generateMergeReport(common);
        print({ runId: result.runId, mergeReport: 'merge-report.json', identities: result.identities.length, contests: result.contests.length, problems: result.problems.length });
        return;
    }
    if (command === 'rollback') {
        if (!common.yes) throw new Error('rollback 需要 --yes');
        await logCommand(common.runDir, args);
        const result = await rollbackExamMigration({
            ...common,
            serviceControl: common.noStop ? 'none' : 'pm2',
            startService: common.noStop ? undefined : async () => {
                const { spawn } = await import('child_process');
                await new Promise<void>((resolve, reject) => {
                    const child = spawn('pm2', ['start', 'hydrooj'], { stdio: 'inherit' });
                    child.once('error', reject);
                    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`pm2 start hydrooj exited ${code}`)));
                });
            },
        });
        print(result);
        return;
    }
    throw new Error(`未知子命令: ${command}`);
}
