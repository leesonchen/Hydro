/* eslint-disable no-await-in-loop, max-len, style/member-delimiter-style */
/*
 * The testdata repair runner is deliberately separate from the original exam
 * migration.  It can only add files to already-materialised exam problems;
 * it never reads from or writes to the source MongoDB.
 */

import childProcess from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { EJSON } from 'bson';
import { Db, MongoClient, ObjectId } from 'mongodb';
import {
    computePlanHash,
    FileEntry,
    hashObject,
    loadManifest,
    loadMaterializedProblems,
    loadPackageCollections,
    MaterializedProblemSnapshot,
    MigrationPlan,
    redactForLog,
    rewriteStorageReference,
    safeRelativePath,
    sha256,
    stableStringify,
} from './exam';
import {
    computeTestdataRepairPlanHash,
    planExamTestdataRepair,
    TestdataRepairFile,
    TestdataRepairPlan,
} from './exam-testdata';

export const TESTDATA_REPAIR_SCHEMA_VERSION = 1;
export const TESTDATA_REPAIR_KIND = 'hydro.exam-testdata-repair';

const REPAIR_FIELDS = ['config', 'data', 'additional_file'] as const;
type RepairField = typeof REPAIR_FIELDS[number];

export interface TestdataRepairOptions {
    priorRunDir?: string;
    sourcePackageDir?: string;
    repairRunDir?: string;
    targetUri?: string;
    targetDatabase?: string;
    targetStorageRoot?: string;
    planHash?: string;
    dryRun?: boolean;
    noStop?: boolean;
    noBackup?: boolean;
    yes?: boolean;
    /** Test seams; production callers should leave these unset. */
    stopService?: () => Promise<void>;
    mongoDump?: (args: string[]) => Promise<void>;
}

export interface TestdataRepairApplyItem {
    sourceDocId: number | string;
    targetDocId: number | string;
    targetObjectId?: string;
    targetDocumentFingerprint: string;
}

export interface TestdataRepairState {
    schemaVersion: number;
    kind: typeof TESTDATA_REPAIR_KIND;
    runId: string;
    sourcePackageHash: string;
    priorRunId: string;
    priorPlanHash: string;
    planHash: string;
    startedAt: string;
    completedAt?: string;
    failedAt?: string;
    dryRun?: boolean;
    preimage: string;
    items: TestdataRepairApplyItem[];
    files: Array<{ path: string; storageId: string; sha256: string; copied?: boolean }>;
    storage: Array<{ path: string; storageId: string; etag?: string; inserted?: boolean }>;
    updated: Array<{ targetDocId: number | string; targetObjectId?: string }>;
    error?: string;
    rollback?: { completedAt: string; files: number; storage: number; documents: number };
}

export interface TestdataRepairVerifyReport {
    schemaVersion: number;
    kind: typeof TESTDATA_REPAIR_KIND;
    runId: string;
    verifiedAt: string;
    applied: boolean;
    ok: boolean;
    problems: { expected: number; checked: number; errors: string[] };
    files: { expected: number; checked: number; errors: string[] };
    marker: { present: boolean; status?: string; ok: boolean };
    errors: string[];
}

export interface TestdataRepairRollbackResult {
    runId: string;
    documents: number;
    storage: number;
    files: number;
}

interface RepairPreimage {
    schemaVersion: number;
    kind: typeof TESTDATA_REPAIR_KIND;
    runId: string;
    planHash: string;
    capturedAt: string;
    problems: Array<{ targetDocId: number | string; document: any }>;
}

interface Marker {
    _id: string;
    kind?: string;
    runId?: string;
    status?: string;
    sourcePackageHash?: string;
    packageHash?: string;
    priorRunId?: string;
    priorPlanHash?: string;
    planHash?: string;
    startedAt?: Date | string;
}

function assert(condition: any, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function idKey(value: unknown): string {
    return String(value);
}

function directoryOf(options: TestdataRepairOptions): string {
    const value = options.repairRunDir;
    assert(value, '测试数据修复需要 --repair-run-dir');
    return path.resolve(value);
}

export function assertSeparateRepairDirectories(options: TestdataRepairOptions) {
    const directories = [
        ['原迁移', options.priorRunDir],
        ['新源包', options.sourcePackageDir],
        ['回填运行', options.repairRunDir],
    ] as const;
    for (const [label, value] of directories) assert(value, `${label}目录缺失`);
    const inside = (directory: string, parent: string) => {
        const relative = path.relative(parent, directory);
        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative));
    };
    for (let index = 0; index < directories.length; index++) {
        for (let other = index + 1; other < directories.length; other++) {
            const [leftLabel, leftValue] = directories[index];
            const [rightLabel, rightValue] = directories[other];
            const left = path.resolve(leftValue!);
            const right = path.resolve(rightValue!);
            assert(!inside(left, right) && !inside(right, left), `${leftLabel}目录与${rightLabel}目录不能重叠`);
        }
    }
}

function requireTargetUri(options: TestdataRepairOptions): string {
    assert(options.targetUri, '测试数据修复需要 --target-uri');
    return options.targetUri;
}

function targetDatabaseName(options: TestdataRepairOptions): string {
    if (options.targetDatabase) return options.targetDatabase;
    const uri = requireTargetUri(options);
    let database = '';
    try { database = decodeURIComponent(new URL(uri).pathname.replace(/^\//, '')); } catch { /* invalid URI is handled on connect */ }
    assert(database, '测试数据修复需要 --target-db，或在目标 URI 中指定数据库');
    return database;
}

async function ensurePrivateDirectory(directory: string) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    try { await fsp.chmod(directory, 0o700); } catch { /* read-only or Windows */ }
}

async function writePrivateFile(file: string, value: string | Buffer) {
    await ensurePrivateDirectory(path.dirname(file));
    await fsp.writeFile(file, value, { mode: 0o600 });
    try { await fsp.chmod(file, 0o600); } catch { /* read-only or Windows */ }
}

async function writeJson(file: string, value: any) {
    await writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T = any>(file: string): Promise<T> {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
}

async function writeEjson(file: string, value: any) {
    await writePrivateFile(file, `${EJSON.stringify(value, { relaxed: false })}\n`);
}

async function readEjson<T = any>(file: string): Promise<T> {
    return EJSON.parse(await fsp.readFile(file, 'utf8')) as T;
}

async function audit(runDir: string, event: string, data: any = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...redactForLog(data) });
    await fsp.appendFile(path.join(runDir, 'audit.jsonl'), `${line}\n`, { mode: 0o600 });
    try { await fsp.chmod(path.join(runDir, 'audit.jsonl'), 0o600); } catch { /* read-only or Windows */ }
}

function planHash(plan: TestdataRepairPlan): string {
    const { planHash: _, ...body } = plan;
    return computeTestdataRepairPlanHash(body);
}

function validateRepairPlan(plan: TestdataRepairPlan) {
    assert(plan.schemaVersion === 1 && plan.kind === 'hydro.exam-testdata-repair-plan', '不是有效的测试数据修复计划');
    assert(typeof plan.runId === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(plan.runId), '测试数据修复 runId 不安全');
    assert(typeof plan.sourcePackageHash === 'string' && plan.sourcePackageHash, '修复计划缺少源包哈希');
    assert(typeof plan.priorPlanHash === 'string' && plan.priorPlanHash, '修复计划缺少原迁移计划哈希');
    assert(plan.planHash === planHash(plan), '测试数据修复计划哈希不匹配');
    const sourceIds = new Set<string>();
    const targetIds = new Set<string>();
    const targetPaths = new Set<string>();
    const targetStorageIds = new Set<string>();
    for (const item of plan.items) {
        assert(!sourceIds.has(idKey(item.sourceDocId)), `修复计划源题目重复: ${item.sourceDocId}`);
        assert(!targetIds.has(idKey(item.targetDocId)), `修复计划目标题目重复: ${item.targetDocId}`);
        sourceIds.add(idKey(item.sourceDocId));
        targetIds.add(idKey(item.targetDocId));
        assert(item.files.length > 0, `修复计划题目 ${item.sourceDocId} 没有文件`);
        for (const file of item.files) {
            assert(file.file.included && file.file.packagePath && file.file.sha256, `修复计划文件不完整: ${file.file.sourcePath}`);
            assert(file.file.targetStorageId, `修复计划文件缺少目标 storage ID: ${file.file.sourcePath}`);
            assert(!path.isAbsolute(file.file.targetPath) && !file.file.targetPath.split(/[\\/]/).includes('..'),
                `修复计划目标存储路径不安全: ${file.file.targetPath}`);
            assert(!targetPaths.has(file.file.targetPath), `修复计划目标存储路径重复: ${file.file.targetPath}`);
            assert(!targetStorageIds.has(file.file.targetStorageId), `修复计划目标 storage ID 重复: ${file.file.targetStorageId}`);
            targetPaths.add(file.file.targetPath);
            targetStorageIds.add(file.file.targetStorageId);
        }
    }
}

async function loadRepairPlan(runDir: string): Promise<TestdataRepairPlan> {
    const plan = await readEjson<TestdataRepairPlan>(path.join(runDir, 'plan.json'));
    validateRepairPlan(plan);
    return plan;
}

async function loadPriorPlan(runDir: string): Promise<MigrationPlan> {
    const plan = await readJson<MigrationPlan>(path.join(runDir, 'plan.json'));
    assert(plan.schemaVersion === 1 && plan.kind === 'hydro.exam-migration-plan', '原迁移计划不是有效的 exam 计划');
    assert(plan.planHash && computePlanHash(plan) === plan.planHash, '原迁移计划哈希不匹配');
    return plan;
}

async function validatePriorRun(db: Db, priorRunDir: string): Promise<MigrationPlan> {
    const plan = await loadPriorPlan(priorRunDir);
    const state = await readJson<any>(path.join(priorRunDir, 'apply.json'));
    assert(state.runId === plan.runId && state.planHash === plan.planHash, '原迁移 apply 记录和计划不一致');
    assert(state.packageHash === plan.packageHash && state.completedAt && !state.dryRun,
        '原迁移没有完成正式 apply');
    if (Array.isArray(state.phases)) assert(state.phases.every((phase: any) => phase.ok), '原迁移存在未完成阶段');
    const marker = await db.collection<Marker>('exam.migration').findOne({ _id: plan.runId });
    assert(marker?.status === 'complete' && marker.planHash === plan.planHash && marker.packageHash === plan.packageHash,
        `目标数据库缺少已完成的原迁移标记: ${plan.runId}`);
    assert(plan.domainId === 'exam', `原迁移域不是 exam: ${plan.domainId}`);
    return plan;
}

function sourceProblems(docs: Record<string, any[]>): any[] {
    return (docs.document || []).filter((doc) => Number(doc.docType) === 10 && String(doc.domainId || 'exam') === 'exam');
}

function expectedRepairSourceIds(
    prior: MigrationPlan,
    sources: any[],
): string[] {
    const byId = new Map(sources.map((doc) => [idKey(doc.docId), doc]));
    return prior.problems
        .filter((decision) => decision.action === 'copy' && !decision.sourceHasFiles)
        .filter((decision) => String(byId.get(idKey(decision.sourceDocId))?.reference?.domainId || '') === 'prepare')
        .map((decision) => idKey(decision.sourceDocId))
        .sort();
}

function compareIdLists(expected: string[], actual: string[], label: string) {
    assert(stableStringify(expected) === stableStringify(actual),
        `${label} 不匹配: expected=${expected.join(',')} actual=${actual.join(',')}`);
}

async function validatePackageFiles(runDir: string, manifest: any, plan?: TestdataRepairPlan) {
    const entries = new Map<string, FileEntry>();
    for (const file of manifest.files || []) entries.set(file.sourcePath, file);
    const files = plan?.items.flatMap((item) => item.files.map((file) => file.sourceFile)) || [];
    for (const file of files) {
        const manifestFile = entries.get(file.sourcePath);
        assert(manifestFile?.sha256 === file.sha256 && manifestFile.sourceStorageId === file.sourceStorageId,
            `源文件不在不可变迁移包中: ${file.sourcePath}`);
        assert(file.packagePath, `源文件缺少包路径: ${file.sourcePath}`);
    }
    for (const file of files) {
        const bytes = await fsp.readFile(safeRelativePath(runDir, file.packagePath!));
        assert(sha256(bytes) === file.sha256, `源测试文件 SHA-256 不匹配: ${file.sourcePath}`);
        if (file.size !== undefined) assert(bytes.length === Number(file.size), `源测试文件大小不匹配: ${file.sourcePath}`);
    }
}

function targetProblemFilter(item: { targetDocId: number | string }) {
    return { domainId: 'exam', docType: 10, docId: item.targetDocId };
}

function sourceStorageMap(item: TestdataRepairPlan['items'][number]): Map<string, string> {
    return new Map(item.files.map((file) => [file.sourceFile.sourceStorageId, file.file.targetStorageId!]));
}

function mappedField(value: any, item: TestdataRepairPlan['items'][number]) {
    return rewriteStorageReference(value, sourceStorageMap(item));
}

function expectedFields(snapshot: MaterializedProblemSnapshot, item: TestdataRepairPlan['items'][number]): Record<RepairField, any> {
    return {
        config: mappedField(snapshot.config, item),
        data: mappedField(snapshot.data || [], item),
        additional_file: mappedField(snapshot.additional_file || [], item),
    };
}

function withoutRepairFields(value: any): any {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const copy = { ...value };
    for (const field of REPAIR_FIELDS) delete copy[field];
    return copy;
}

function sameOutsideRepairFields(actual: any, before: any): boolean {
    return stableStringify(withoutRepairFields(actual)) === stableStringify(withoutRepairFields(before));
}

function sameRepairFields(actual: any, expected: Record<RepairField, any>): boolean {
    return REPAIR_FIELDS.every((field) => stableStringify(actual?.[field] ?? null) === stableStringify(expected[field] ?? null));
}

function repairFieldsFromDocument(document: any): Record<RepairField, any> {
    return {
        config: document?.config,
        data: document?.data || [],
        additional_file: document?.additional_file || [],
    };
}

function storageId(file: TestdataRepairFile): string {
    assert(file.file.targetStorageId, `目标文件缺少 storage ID: ${file.file.targetPath}`);
    return file.file.targetStorageId;
}

function storageDocument(file: TestdataRepairFile, item: TestdataRepairPlan['items'][number]): any {
    const map = sourceStorageMap(item);
    const source = rewriteStorageReference(file.storage, map);
    const id = storageId(file);
    return {
        ...source,
        _id: id,
        path: file.file.targetPath,
        etag: Buffer.from(`/data/file/hydro/${id}`).toString('base64'),
        domainId: 'exam',
    };
}

function objectIdString(value: any): string | undefined {
    if (value instanceof ObjectId) return value.toHexString();
    if (value && typeof value === 'object' && value._bsontype === 'ObjectId') return value.toHexString();
    if (typeof value === 'string') return value;
    return undefined;
}

async function preflight(
    db: Db,
    sourceDir: string,
    manifest: any,
    plan: TestdataRepairPlan,
    snapshots: Map<string, MaterializedProblemSnapshot>,
    targetStorageRoot?: string,
): Promise<any[]> {
    await validatePackageFiles(sourceDir, manifest, plan);
    assert(plan.items.length > 0, '没有需要补全测试数据的题目');
    assert(targetStorageRoot, '测试数据修复包含文件，必须提供 --target-storage-root');
    const preimage: any[] = [];
    const ids = plan.items.map((item) => item.targetDocId);
    const targetDocs = await db.collection<any>('document').find({
        domainId: 'exam', docType: 10, docId: { $in: ids },
    }).toArray();
    assert(targetDocs.length === plan.items.length, '修复计划目标题目数量已变化');
    const byId = new Map(targetDocs.map((doc) => [idKey(doc.docId), doc]));
    const targetStorageIds = plan.items.flatMap((item) => item.files.map((file) => storageId(file)));
    const targetPaths = plan.items.flatMap((item) => item.files.map((file) => file.file.targetPath));
    const existingStorage = await db.collection<any>('storage').find({
        $or: [
            { _id: { $in: targetStorageIds } },
            { path: { $in: targetPaths } },
        ],
    }).project({ _id: 1, path: 1 }).toArray();
    assert(!existingStorage.length,
        `目标存储已存在，拒绝覆盖: ${existingStorage.map((item) => `${String(item._id)}:${item.path}`).join(', ')}`);
    const physical: string[] = [];
    for (const item of plan.items) {
        const target = byId.get(idKey(item.targetDocId));
        assert(target, `目标题目不存在: exam/${item.targetDocId}`);
        assert(hashObject(target) === item.targetDocumentFingerprint,
            `目标题目已变化，拒绝补全: exam/${item.targetDocId}`);
        const snapshot = snapshots.get(idKey(item.sourceDocId));
        assert(snapshot, `缺少源题目快照: ${item.sourceDocId}`);
        const expected = expectedFields(snapshot, item);
        assert((target.data || []).length === 0 && (target.additional_file || []).length === 0 && !target.reference,
            `目标题目已有测试数据或引用，拒绝覆盖: exam/${item.targetDocId}`);
        assert(Array.isArray(expected.data) && expected.data.length > 0,
            `源题目测试数据为空: ${item.sourceDocId}`);
        preimage.push({ targetDocId: item.targetDocId, document: target });
        for (const file of item.files) {
            assert(file.file.packagePath, `文件包路径缺失: ${file.file.sourcePath}`);
            const destination = safeRelativePath(targetStorageRoot, storageId(file));
            if (fs.existsSync(destination)) throw new Error(`禁止覆盖既有物理文件: ${destination}`);
            physical.push(destination);
        }
    }
    // Detect collisions before any write even when a malformed plan was
    // constructed by an older tool version.
    assert(new Set(physical).size === physical.length, '修复计划物理存储路径重复');
    return preimage;
}

async function runCommand(command: string, args: string[]) {
    await new Promise<void>((resolve, reject) => {
        const child = childProcess.spawn(command, args, { stdio: 'ignore' });
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
    });
}

async function defaultStopService() {
    await runCommand('pm2', ['stop', 'hydrooj']);
}

async function defaultMongoDump(uri: string, database: string, output: string) {
    await runCommand('mongodump', ['--uri', uri, '--db', database, '--out', output]);
}

async function targetDb(options: TestdataRepairOptions): Promise<{ client: MongoClient; db: Db }> {
    const uri = requireTargetUri(options);
    const database = targetDatabaseName(options);
    const client = await MongoClient.connect(uri);
    return { client, db: client.db(database) };
}

async function loadSource(
    sourceDir: string,
): Promise<{ manifest: any; docs: Record<string, any[]>; snapshots: MaterializedProblemSnapshot[] }> {
    const manifest = await loadManifest(sourceDir);
    assert(manifest.domainId === 'exam', `源包域不是 exam: ${manifest.domainId}`);
    const docs = await loadPackageCollections(sourceDir, manifest);
    const snapshots = await loadMaterializedProblems(sourceDir, manifest);
    return { manifest, docs, snapshots };
}

async function assertPriorAndSource(
    options: TestdataRepairOptions,
    db: Db,
): Promise<{ prior: MigrationPlan; source: Awaited<ReturnType<typeof loadSource>>; requiredSourceIds: string[] }> {
    assert(options.priorRunDir, '测试数据修复需要 --prior-run-dir');
    assert(options.sourcePackageDir, '测试数据修复需要 --source-package-dir');
    const priorDir = path.resolve(options.priorRunDir);
    const sourceDir = path.resolve(options.sourcePackageDir);
    assert(priorDir !== sourceDir, '原迁移目录和新的源包目录必须不同');
    const prior = await validatePriorRun(db, priorDir);
    const priorManifest = await loadManifest(priorDir);
    assert(priorManifest.runId === prior.runId && priorManifest.packageHash === prior.packageHash,
        '原迁移包和已应用计划不一致');
    const priorDocs = await loadPackageCollections(priorDir, priorManifest);
    const requiredSourceIds = expectedRepairSourceIds(prior, sourceProblems(priorDocs));
    const source = await loadSource(sourceDir);
    return { prior, source, requiredSourceIds };
}

export async function testdataAnalyze(options: TestdataRepairOptions = {}): Promise<TestdataRepairPlan> {
    assertSeparateRepairDirectories(options);
    const runDir = directoryOf(options);
    assert(options.priorRunDir && options.sourcePackageDir, '分析需要原迁移目录和新的源包目录');
    try {
        const existing = await fsp.readdir(runDir);
        assert(existing.length === 0, `修复运行目录已存在且非空: ${runDir}`);
    } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
    }
    await ensurePrivateDirectory(runDir);
    const { client, db } = await targetDb(options);
    try {
        const { prior, source, requiredSourceIds } = await assertPriorAndSource(options, db);
        const targetProblems = await db.collection<any>('document').find({ domainId: 'exam', docType: 10 }).toArray();
        const priorHash = prior.planHash!;
        const runId = path.basename(runDir);
        const plan = planExamTestdataRepair({
            priorPlan: prior,
            snapshots: source.snapshots,
            sourceProblems: sourceProblems(source.docs),
            targetProblems,
            runId,
            sourcePackageHash: source.manifest.packageHash,
            priorPlanHash: priorHash,
        });
        compareIdLists(requiredSourceIds, plan.items.map((item) => idKey(item.sourceDocId)).sort(), '可修复题目清单');
        await validatePackageFiles(path.resolve(options.sourcePackageDir!), source.manifest, plan);
        await writeEjson(path.join(runDir, 'plan.json'), plan);
        await audit(runDir, 'testdata.analyze.complete', {
            runId, planHash: plan.planHash, sourcePackageHash: plan.sourcePackageHash,
            priorPlanHash: plan.priorPlanHash, problems: plan.items.length,
            files: plan.items.reduce((sum, item) => sum + item.files.length, 0),
        });
        return plan;
    } catch (error) {
        await audit(runDir, 'testdata.analyze.failed', { error: error instanceof Error ? error.message : String(error) });
        throw error;
    } finally {
        await client.close();
    }
}

async function markerFor(db: Db, runId: string): Promise<Marker | null> {
    return db.collection<Marker>('exam.migration').findOne({ _id: runId });
}

function assertOwnMarker(marker: Marker | null, plan: TestdataRepairPlan, prior: MigrationPlan, status?: string) {
    assert(marker && marker.kind === TESTDATA_REPAIR_KIND && marker.runId === plan.runId,
        `缺少本次测试数据修复标记: ${plan.runId}`);
    assert(marker.sourcePackageHash === plan.sourcePackageHash
        && marker.priorRunId === prior.runId
        && marker.priorPlanHash === prior.planHash
        && marker.planHash === plan.planHash, '测试数据修复标记哈希不一致');
    if (status) assert(marker.status === status, `测试数据修复标记不是 ${status}: ${marker.status}`);
}

async function writeApplyState(runDir: string, state: TestdataRepairState) {
    await writeJson(path.join(runDir, 'apply.json'), state);
}

function stateFromPlan(plan: TestdataRepairPlan, prior: MigrationPlan): TestdataRepairState {
    return {
        schemaVersion: TESTDATA_REPAIR_SCHEMA_VERSION,
        kind: TESTDATA_REPAIR_KIND,
        runId: plan.runId,
        sourcePackageHash: plan.sourcePackageHash,
        priorRunId: prior.runId,
        priorPlanHash: prior.planHash!,
        planHash: plan.planHash,
        startedAt: new Date().toISOString(),
        preimage: 'preimage.ejson',
        items: plan.items.map((item) => ({
            sourceDocId: item.sourceDocId,
            targetDocId: item.targetDocId,
            targetDocumentFingerprint: item.targetDocumentFingerprint,
        })),
        files: [], storage: [], updated: [],
    };
}

async function updateTargetFields(db: Db, target: any, fields: Record<RepairField, any>) {
    const filter = { _id: target._id, domainId: 'exam', docType: 10, docId: target.docId };
    const result = await db.collection<any>('document').updateOne(filter, { $set: fields });
    assert(result.matchedCount === 1 && result.modifiedCount === 1, `目标题目更新失败: exam/${target.docId}`);
}

async function cleanupWrites(
    db: Db,
    options: TestdataRepairOptions,
    runDir: string,
    state: TestdataRepairState,
    preimage: RepairPreimage,
    plan: TestdataRepairPlan,
): Promise<{ documents: number; storage: number; files: number; errors: string[] }> {
    const errors: string[] = [];
    let documents = 0;
    let storage = 0;
    let files = 0;
    const beforeById = new Map(preimage.problems.map((entry) => [idKey(entry.targetDocId), entry.document]));
    const updatedIds = new Set(state.updated.map((item) => idKey(item.targetDocId)));
    // The preimage contains the exact document fields.  We only restore the
    // three fields this runner owns, and only when the current values still
    // match the values written by this run.
    for (const item of plan.items) {
        if (!updatedIds.has(idKey(item.targetDocId))) continue;
        const before = beforeById.get(idKey(item.targetDocId));
        if (!before) {
            errors.push(`缺少题目前像: ${item.targetDocId}`);
            continue;
        }
        const target = await db.collection<any>('document').findOne(targetProblemFilter(item));
        if (!target) {
            errors.push(`回滚时目标题目不存在: ${item.targetDocId}`);
            continue;
        }
        const itemFiles = item.files;
        if (sameRepairFields(target, repairFieldsFromDocument(before))) {
            state.updated = state.updated.filter((entry) => idKey(entry.targetDocId) !== idKey(item.targetDocId));
            await writeApplyState(runDir, state);
            continue;
        }
        // A current document must still reference this run's storage IDs.
        const currentIds = new Set<string>();
        const collect = (value: any) => {
            if (typeof value === 'string') currentIds.add(value);
            else if (Array.isArray(value)) {
                for (const child of value) collect(child);
            } else if (value && typeof value === 'object') {
                for (const child of Object.values(value)) collect(child);
            }
        };
        collect(target.data);
        collect(target.additional_file);
        collect(target.config);
        const ownsFields = itemFiles.every((file) => currentIds.has(storageId(file))
            || currentIds.has(Buffer.from(`/data/file/hydro/${storageId(file)}`).toString('base64')));
        if (!ownsFields) {
            errors.push(`目标题目字段已被外部修改，拒绝恢复: ${item.targetDocId}`);
            continue;
        }
        const unset: Record<string, ''> = {};
        const set: Record<string, any> = {};
        for (const field of REPAIR_FIELDS) {
            if (Object.hasOwn(before, field)) set[field] = before[field];
            else unset[field] = '';
        }
        const update: any = {};
        if (Object.keys(set).length) update.$set = set;
        if (Object.keys(unset).length) update.$unset = unset;
        const result = await db.collection<any>('document').updateOne(
            { _id: target._id, domainId: 'exam', docType: 10, docId: target.docId }, update,
        );
        if (result.modifiedCount !== 1) errors.push(`恢复题目失败: ${item.targetDocId}`);
        else {
            documents++;
            state.updated = state.updated.filter((entry) => idKey(entry.targetDocId) !== idKey(item.targetDocId));
            await writeApplyState(runDir, state);
        }
    }
    // Keep all file data intact if any document still points at it.
    if (errors.length) {
        await audit(runDir, 'testdata.rollback.cleanup', { documents, storage, files, errors });
        return { documents, storage, files, errors };
    }
    for (const item of state.storage) {
        const filter: any = { _id: item.storageId, path: item.path, domainId: 'exam' };
        if (item.etag) filter.etag = item.etag;
        const existing = await db.collection<any>('storage').findOne({ _id: item.storageId });
        if (!existing) {
            item.inserted = false;
            await writeApplyState(runDir, state);
            continue;
        }
        if (existing.path !== item.path || existing.domainId !== 'exam' || (item.etag && existing.etag !== item.etag)) {
            errors.push(`存储元数据已被外部修改，拒绝删除: ${item.path}`);
            continue;
        }
        const result = await db.collection<any>('storage').deleteOne(filter);
        storage += result.deletedCount;
        if (result.deletedCount !== 1) errors.push(`删除存储元数据异常: ${item.path}`);
        else {
            item.inserted = false;
            await writeApplyState(runDir, state);
        }
    }
    // Metadata with a conflicting identity is not ours; do not remove the
    // corresponding physical file while that conflict remains unresolved.
    if (errors.length) {
        await audit(runDir, 'testdata.rollback.cleanup', { documents, storage, files, errors });
        return { documents, storage, files, errors };
    }
    if (options.targetStorageRoot) {
        for (const item of state.files) {
            const target = safeRelativePath(options.targetStorageRoot, item.storageId);
            try {
                const bytes = await fsp.readFile(target);
                if (sha256(bytes) !== item.sha256) {
                    errors.push(`物理文件已被修改，拒绝删除: ${item.path}`);
                    continue;
                }
                await fsp.unlink(target);
                files++;
                item.copied = false;
                await writeApplyState(runDir, state);
            } catch (error: any) {
                if (error?.code === 'ENOENT') {
                    item.copied = false;
                    await writeApplyState(runDir, state);
                } else errors.push(`删除物理文件失败: ${item.path}`);
            }
        }
    } else if (state.files.length) errors.push('回滚缺少目标存储根目录，未删除物理文件');
    await audit(runDir, 'testdata.rollback.cleanup', { documents, storage, files, errors });
    return { documents, storage, files, errors };
}

async function verifyRepairData(
    db: Db,
    options: TestdataRepairOptions,
    sourceDir: string,
    manifest: any,
    plan: TestdataRepairPlan,
    snapshots: Map<string, MaterializedProblemSnapshot>,
    requireCompleteMarker: boolean,
): Promise<TestdataRepairVerifyReport> {
    const marker = await markerFor(db, plan.runId);
    const markerOk = !!marker && marker.kind === TESTDATA_REPAIR_KIND
        && marker.planHash === plan.planHash && marker.sourcePackageHash === plan.sourcePackageHash
        && (!requireCompleteMarker || marker.status === 'complete');
    const problemErrors: string[] = [];
    const fileErrors: string[] = [];
    let problemChecked = 0;
    let fileChecked = 0;
    try {
        await validatePackageFiles(sourceDir, manifest, plan);
    } catch (error) {
        fileErrors.push(error instanceof Error ? error.message : String(error));
    }
    for (const item of plan.items) {
        const target = await db.collection<any>('document').findOne(targetProblemFilter(item));
        const snapshot = snapshots.get(idKey(item.sourceDocId));
        problemChecked++;
        if (!target || !snapshot) {
            problemErrors.push(`题目或快照不存在: ${item.targetDocId}`);
            continue;
        }
        if (!sameRepairFields(target, expectedFields(snapshot, item))) {
            problemErrors.push(`题目测试数据/config 不一致: exam/${item.targetDocId}`);
        }
        for (const file of item.files) {
            fileChecked++;
            const id = storageId(file);
            const metadata = await db.collection<any>('storage').findOne({ _id: id, path: file.file.targetPath });
            if (!metadata) {
                fileErrors.push(`存储元数据不存在: ${file.file.targetPath}`);
                continue;
            }
            if (!options.targetStorageRoot) {
                fileErrors.push(`缺少目标存储根目录: ${file.file.targetPath}`);
                continue;
            }
            try {
                const bytes = await fsp.readFile(safeRelativePath(options.targetStorageRoot, id));
                if (sha256(bytes) !== file.file.sha256) fileErrors.push(`文件 SHA-256 不一致: ${file.file.targetPath}`);
            } catch {
                fileErrors.push(`物理文件不存在: ${file.file.targetPath}`);
            }
        }
    }
    const errors = [...problemErrors, ...fileErrors, ...(markerOk ? [] : ['本次修复标记不存在、哈希不匹配或未完成'])];
    return {
        schemaVersion: TESTDATA_REPAIR_SCHEMA_VERSION,
        kind: TESTDATA_REPAIR_KIND,
        runId: plan.runId,
        verifiedAt: new Date().toISOString(),
        applied: !!marker && marker.status === 'complete',
        ok: errors.length === 0,
        problems: { expected: plan.items.length, checked: problemChecked, errors: problemErrors },
        files: { expected: plan.items.reduce((sum, item) => sum + item.files.length, 0), checked: fileChecked, errors: fileErrors },
        marker: { present: !!marker, status: marker?.status, ok: markerOk },
        errors,
    };
}

export async function testdataApply(options: TestdataRepairOptions = {}): Promise<TestdataRepairState> {
    assertSeparateRepairDirectories(options);
    const runDir = directoryOf(options);
    assert(options.sourcePackageDir, '应用测试数据修复需要 --source-package-dir');
    const sourceDir = path.resolve(options.sourcePackageDir);
    const plan = await loadRepairPlan(runDir);
    assert(options.planHash && options.planHash === plan.planHash, `测试数据修复计划哈希不匹配: ${options.planHash}`);
    const { manifest, snapshots: snapshotList } = await loadSource(sourceDir);
    assert(manifest.packageHash === plan.sourcePackageHash, '源包哈希与修复计划不一致');
    const snapshots = new Map(snapshotList.map((snapshot) => [idKey(snapshot.sourceDocId), snapshot]));
    const { client, db } = await targetDb(options);
    let stopped = false;
    let state: TestdataRepairState | undefined;
    try {
        const { prior, requiredSourceIds } = await assertPriorAndSource(options, db);
        assert(plan.priorPlanHash === prior.planHash, '修复计划和原迁移计划哈希不一致');
        compareIdLists(requiredSourceIds, plan.items.map((item) => idKey(item.sourceDocId)).sort(), '可修复题目清单');
        const marker = await markerFor(db, plan.runId);
        assert(!marker, `测试数据修复已存在标记: ${plan.runId}`);
        let preimage = await preflight(db, sourceDir, manifest, plan, snapshots, options.targetStorageRoot);
        state = stateFromPlan(plan, prior);
        await writeApplyState(runDir, state);
        if (options.dryRun) {
            state.dryRun = true;
            state.completedAt = new Date().toISOString();
            await writeApplyState(runDir, state);
            await audit(runDir, 'testdata.apply.dry-run', { planHash: plan.planHash, problems: plan.items.length });
            return state;
        }
        const stop = options.stopService || (options.noStop ? null : defaultStopService);
        if (stop) {
            await stop();
            stopped = true;
            await audit(runDir, 'testdata.apply.service.stopped', { service: 'hydrooj' });
        }
        if (!options.noBackup) {
            const backupDir = path.join(runDir, 'backup');
            await ensurePrivateDirectory(backupDir);
            const dump = options.mongoDump || ((args: string[]) => defaultMongoDump(
                options.targetUri!, targetDatabaseName(options), args[0],
            ));
            await dump([backupDir]);
            await audit(runDir, 'testdata.apply.backup.complete', { backupDir });
        }
        // The target may have changed while the service was being stopped or
        // while mongodump was running.  Repeat every collision/fingerprint
        // check immediately before the first write and use this fresh image.
        preimage = await preflight(db, sourceDir, manifest, plan, snapshots, options.targetStorageRoot);
        await audit(runDir, 'testdata.apply.preflight.rechecked', { problems: preimage.length });
        const preimageRecord: RepairPreimage = {
            schemaVersion: TESTDATA_REPAIR_SCHEMA_VERSION,
            kind: TESTDATA_REPAIR_KIND,
            runId: plan.runId,
            planHash: plan.planHash,
            capturedAt: new Date().toISOString(),
            problems: preimage,
        };
        await writeEjson(path.join(runDir, state.preimage), preimageRecord);
        await audit(runDir, 'testdata.apply.preimage.complete', { problems: preimage.length });
        await db.collection<Marker>('exam.migration').insertOne({
            _id: plan.runId,
            kind: TESTDATA_REPAIR_KIND,
            runId: plan.runId,
            status: 'running',
            sourcePackageHash: plan.sourcePackageHash,
            priorRunId: prior.runId,
            priorPlanHash: prior.planHash,
            planHash: plan.planHash,
            startedAt: new Date(),
        });
        await audit(runDir, 'testdata.apply.marker.running');
        try {
            for (const item of plan.items) {
                for (const file of item.files) {
                    const destination = safeRelativePath(options.targetStorageRoot!, storageId(file));
                    await ensurePrivateDirectory(path.dirname(destination));
                    const journal = { path: file.file.targetPath, storageId: storageId(file), sha256: file.file.sha256!, copied: false };
                    state.files.push(journal);
                    await writeApplyState(runDir, state);
                    await fsp.copyFile(safeRelativePath(sourceDir, file.file.packagePath!), destination, fs.constants.COPYFILE_EXCL);
                    journal.copied = true;
                    await writeApplyState(runDir, state);
                }
            }
            for (const item of plan.items) {
                for (const file of item.files) {
                    const metadata = storageDocument(file, item);
                    const id = storageId(file);
                    const etag = Buffer.from(`/data/file/hydro/${id}`).toString('base64');
                    const journal = { path: file.file.targetPath, storageId: id, etag, inserted: false };
                    state.storage.push(journal);
                    await writeApplyState(runDir, state);
                    await db.collection<any>('storage').insertOne(metadata);
                    journal.inserted = true;
                    await writeApplyState(runDir, state);
                }
            }
            for (const item of plan.items) {
                const target = await db.collection<any>('document').findOne(targetProblemFilter(item));
                assert(target && hashObject(target) === item.targetDocumentFingerprint,
                    `目标题目在写入前发生变化: ${item.targetDocId}`);
                const snapshot = snapshots.get(idKey(item.sourceDocId));
                assert(snapshot, `修复题目快照不存在: ${item.sourceDocId}`);
                state.updated.push({ targetDocId: item.targetDocId, targetObjectId: objectIdString(target._id) });
                await writeApplyState(runDir, state);
                await updateTargetFields(db, target, expectedFields(snapshot, item));
            }
            const verification = await verifyRepairData(db, options, sourceDir, manifest, plan, snapshots, false);
            await writeJson(path.join(runDir, 'verify-report.json'), verification);
            if (!verification.ok) throw new Error(`测试数据修复验证失败: ${verification.errors.join('; ')}`);
            const completedMarker = await db.collection<Marker>('exam.migration').updateOne(
                { _id: plan.runId, kind: TESTDATA_REPAIR_KIND, status: 'running' },
                { $set: { status: 'complete', completedAt: new Date(), files: state.files.length, storage: state.storage.length } },
            );
            assert(completedMarker.matchedCount === 1, '修复标记在完成前发生变化');
            state.completedAt = new Date().toISOString();
            await writeApplyState(runDir, state);
            await audit(runDir, 'testdata.apply.complete', { files: state.files.length, storage: state.storage.length, problems: state.updated.length });
            return state;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            state.failedAt = new Date().toISOString();
            state.error = message;
            await writeApplyState(runDir, state);
            await audit(runDir, 'testdata.apply.failed', { error: message });
            const cleanup = await cleanupWrites(db, options, runDir, state, preimageRecord, plan);
            if (!cleanup.errors.length) {
                const removedMarker = await db.collection<Marker>('exam.migration').deleteOne({ _id: plan.runId, kind: TESTDATA_REPAIR_KIND });
                assert(removedMarker.deletedCount === 1, '自动回滚后修复标记未移除');
                await audit(runDir, 'testdata.apply.auto-rollback.complete', cleanup);
            } else {
                await db.collection<Marker>('exam.migration').updateOne(
                    { _id: plan.runId, kind: TESTDATA_REPAIR_KIND },
                    { $set: { status: 'failed', error: message, cleanupErrors: cleanup.errors } },
                );
                await audit(runDir, 'testdata.apply.auto-rollback.failed', cleanup);
            }
            throw error;
        }
    } finally {
        await client.close();
        // Keep the target stopped after a failed apply so an operator can
        // inspect the audit/preimage before deciding whether to start it.
        void stopped;
    }
}

export async function testdataVerify(options: TestdataRepairOptions = {}): Promise<TestdataRepairVerifyReport> {
    assertSeparateRepairDirectories(options);
    const runDir = directoryOf(options);
    assert(options.sourcePackageDir, '验证测试数据修复需要 --source-package-dir');
    const sourceDir = path.resolve(options.sourcePackageDir);
    const plan = await loadRepairPlan(runDir);
    const { manifest, snapshots: snapshotList } = await loadSource(sourceDir);
    assert(manifest.packageHash === plan.sourcePackageHash, '源包哈希与修复计划不一致');
    const snapshots = new Map(snapshotList.map((snapshot) => [idKey(snapshot.sourceDocId), snapshot]));
    const { client, db } = await targetDb(options);
    try {
        const { prior, requiredSourceIds } = await assertPriorAndSource(options, db);
        assert(plan.priorPlanHash === prior.planHash, '修复计划和原迁移计划哈希不一致');
        compareIdLists(requiredSourceIds, plan.items.map((item) => idKey(item.sourceDocId)).sort(), '可修复题目清单');
        const report = await verifyRepairData(db, options, sourceDir, manifest, plan, snapshots, true);
        await writeJson(path.join(runDir, 'verify-report.json'), report);
        await audit(runDir, 'testdata.verify.complete', { ok: report.ok, errors: report.errors.length });
        return report;
    } finally {
        await client.close();
    }
}

export async function testdataRollback(options: TestdataRepairOptions = {}): Promise<TestdataRepairRollbackResult> {
    assert(options.yes, '测试数据修复回滚需要 --yes');
    assertSeparateRepairDirectories(options);
    const runDir = directoryOf(options);
    const plan = await loadRepairPlan(runDir);
    const state = await readJson<TestdataRepairState>(path.join(runDir, 'apply.json'));
    assert(state.kind === TESTDATA_REPAIR_KIND && !state.dryRun && state.planHash === plan.planHash,
        '没有有效的测试数据修复 apply 记录');
    const preimage = await readEjson<RepairPreimage>(path.join(runDir, state.preimage));
    assert(preimage.kind === TESTDATA_REPAIR_KIND && preimage.planHash === plan.planHash, '测试数据修复前像哈希不一致');
    assert(options.sourcePackageDir, '回滚测试数据修复需要 --source-package-dir');
    const sourceDir = path.resolve(options.sourcePackageDir);
    const { manifest, snapshots: snapshotList } = await loadSource(sourceDir);
    assert(manifest.packageHash === plan.sourcePackageHash, '源包哈希与修复计划不一致');
    const snapshots = new Map(snapshotList.map((snapshot) => [idKey(snapshot.sourceDocId), snapshot]));
    const { client, db } = await targetDb(options);
    try {
        const { prior, requiredSourceIds } = await assertPriorAndSource(options, db);
        assert(plan.priorPlanHash === prior.planHash && state.priorRunId === prior.runId,
            '修复计划和原迁移计划不一致');
        compareIdLists(requiredSourceIds, plan.items.map((item) => idKey(item.sourceDocId)).sort(), '可修复题目清单');
        const marker = await markerFor(db, plan.runId);
        assertOwnMarker(marker, plan, prior);
        assert(['complete', 'failed', 'running'].includes(marker!.status || ''), `不可回滚的修复标记状态: ${marker!.status}`);
        // Preflight all target state before restoring the first document.  This
        // makes an external edit fail closed instead of producing a partial
        // rollback.
        const updatedIds = new Set(state.updated.map((entry) => idKey(entry.targetDocId)));
        for (const item of plan.items) {
            const before = preimage.problems.find((entry) => idKey(entry.targetDocId) === idKey(item.targetDocId))?.document;
            const target = await db.collection<any>('document').findOne(targetProblemFilter(item));
            const snapshot = snapshots.get(idKey(item.sourceDocId));
            assert(before && target && snapshot, `回滚目标题目或前像不存在: ${item.targetDocId}`);
            assert(sameOutsideRepairFields(target, before), `目标题目非测试数据字段已变化，拒绝回滚: ${item.targetDocId}`);
            const isBefore = sameRepairFields(target, repairFieldsFromDocument(before));
            const isWritten = sameRepairFields(target, expectedFields(snapshot, item));
            assert(isBefore || (updatedIds.has(idKey(item.targetDocId)) && isWritten),
                `目标题目测试数据已被修改，拒绝回滚: ${item.targetDocId}`);
        }
        assert(options.targetStorageRoot, '回滚需要 --target-storage-root');
        for (const item of state.storage) {
            const metadata = await db.collection<any>('storage').findOne({ _id: item.storageId });
            if (metadata) {
                assert(metadata.path === item.path && metadata.domainId === 'exam'
                    && (!item.etag || metadata.etag === item.etag), `回滚存储元数据已变化: ${item.path}`);
            }
        }
        for (const item of state.files) {
            const filename = safeRelativePath(options.targetStorageRoot, item.storageId);
            try {
                const bytes = await fsp.readFile(filename);
                assert(sha256(bytes) === item.sha256, `回滚文件 SHA-256 不一致: ${item.path}`);
            } catch (error: any) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
        const cleanup = await cleanupWrites(db, options, runDir, state, preimage, plan);
        assert(!cleanup.errors.length, `回滚未完成: ${cleanup.errors.join('; ')}`);
        const removedMarker = await db.collection<Marker>('exam.migration').deleteOne({ _id: plan.runId, kind: TESTDATA_REPAIR_KIND });
        assert(removedMarker.deletedCount === 1, '回滚后修复标记未移除');
        state.rollback = { completedAt: new Date().toISOString(), files: cleanup.files, storage: cleanup.storage, documents: cleanup.documents };
        await writeApplyState(runDir, state);
        await writeJson(path.join(runDir, 'rollback.json'), {
            schemaVersion: TESTDATA_REPAIR_SCHEMA_VERSION,
            kind: TESTDATA_REPAIR_KIND,
            runId: plan.runId,
            rolledBackAt: state.rollback.completedAt,
            ...cleanup,
        });
        await audit(runDir, 'testdata.rollback.complete', cleanup);
        return { runId: plan.runId, documents: cleanup.documents, storage: cleanup.storage, files: cleanup.files };
    } finally {
        await client.close();
    }
}
