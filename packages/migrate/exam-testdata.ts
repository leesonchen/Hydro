/*
 * Pure planner for repairing testdata omitted by an earlier exam merge.
 *
 * This module deliberately does not read the package, inspect MongoDB, or
 * touch the storage root.  The caller supplies the immutable materialized
 * snapshot produced by export and the documents observed before repair; the
 * resulting plan can therefore be reviewed and hashed before any write.
 */

import {
    FileEntry,
    hashObject,
    MaterializedProblemClonedFile,
    MaterializedProblemSnapshot,
    MigrationPlan,
    ProblemDecision,
    sha256,
    stableStringify,
} from './exam';

export const TESTDATA_REPAIR_SCHEMA_VERSION = 1;

export interface TestdataRepairFile {
    /** The immutable file descriptor from the export sidecar. */
    sourceFile: FileEntry;
    /** The descriptor to insert for the repaired target problem. */
    file: FileEntry;
    /** The storage document to insert alongside `file`. */
    storage: Record<string, any>;
}

export interface TestdataRepairItem {
    sourceDocId: number | string;
    targetDocId: number | string;
    sourcePid?: number | string;
    sourceReference: Record<string, any>;
    effectiveSource: MaterializedProblemSnapshot['effectiveSource'];
    targetDocumentFingerprint: string;
    files: TestdataRepairFile[];
}

export interface TestdataRepairPlan {
    schemaVersion: typeof TESTDATA_REPAIR_SCHEMA_VERSION;
    kind: 'hydro.exam-testdata-repair-plan';
    runId: string;
    sourcePackageHash: string;
    priorPlanHash: string;
    items: TestdataRepairItem[];
    planHash: string;
}

export interface TestdataRepairPlannerInput {
    /** The plan which was applied before this repair is planned. */
    priorPlan: Pick<MigrationPlan, 'problems'>;
    /** Immutable sidecar records from the corresponding export package. */
    snapshots: readonly MaterializedProblemSnapshot[];
    /** The original exam problem documents from the source package. */
    sourceProblems: readonly Record<string, any>[];
    /** Current target exam problem documents, observed before repair. */
    targetProblems: readonly Record<string, any>[];
    /** A stable repair run identifier, also used in storage IDs. */
    runId: string;
    sourcePackageHash: string;
    priorPlanHash: string;
}

function idKey(value: unknown): string {
    return String(value);
}

function hasValue(value: any): boolean {
    return value !== undefined && value !== null;
}

function dataCount(value: any): number {
    return Array.isArray(value) ? value.length : hasValue(value) ? 1 : 0;
}

function referenceKey(value: any): string {
    if (!value || typeof value !== 'object') return '';
    return `${String(value.domainId ?? '')}:${String(value.pid ?? '')}`;
}

function problemIndex(documents: readonly Record<string, any>[], label: string): Map<string, Record<string, any>> {
    const result = new Map<string, Record<string, any>>();
    for (const document of documents) {
        if (document.docId === undefined || document.docId === null) continue;
        const key = idKey(document.docId);
        if (result.has(key)) throw new Error(`${label} 题目 docId 重复: ${key}`);
        result.set(key, document);
    }
    return result;
}

function decisionIndex(decisions: readonly ProblemDecision[]): Map<string, ProblemDecision> {
    const result = new Map<string, ProblemDecision>();
    for (const decision of decisions) {
        const key = idKey(decision.sourceDocId);
        if (result.has(key)) throw new Error(`迁移计划题目 sourceDocId 重复: ${key}`);
        result.set(key, decision);
    }
    return result;
}

function snapshotIndex(snapshots: readonly MaterializedProblemSnapshot[]): Map<string, MaterializedProblemSnapshot> {
    const result = new Map<string, MaterializedProblemSnapshot>();
    for (const snapshot of snapshots) {
        const key = idKey(snapshot.sourceDocId);
        if (result.has(key)) throw new Error(`题目快照 sourceDocId 重复: ${key}`);
        result.set(key, snapshot);
    }
    return result;
}

function isP105(decision: ProblemDecision): boolean {
    return idKey(decision.sourceDocId) === '105' || String(decision.sourcePid) === 'P105';
}

function isPrepareReference(source: Record<string, any>, snapshot?: MaterializedProblemSnapshot): boolean {
    return String(source.reference?.domainId || '') === 'prepare'
        || String(snapshot?.effectiveSource?.domainId || '') === 'prepare';
}

function sourcePathParts(file: FileEntry, sourceDocId: number | string): { suffix: string, name: string } {
    const prefix = `problem/exam/${idKey(sourceDocId)}/`;
    if (!file.sourcePath.startsWith(prefix)) {
        throw new Error(`题目 ${idKey(sourceDocId)} 的源存储路径不匹配: ${file.sourcePath}`);
    }
    const suffix = file.sourcePath.slice(prefix.length);
    const slash = suffix.indexOf('/');
    if (slash <= 0 || slash === suffix.length - 1) {
        throw new Error(`题目 ${idKey(sourceDocId)} 的源存储路径无效: ${file.sourcePath}`);
    }
    return { suffix, name: suffix.slice(slash + 1) };
}

function targetStorageId(runId: string, sourceDocId: number | string, targetDocId: number | string, file: FileEntry): string {
    const suffix = file.sourcePath.slice(file.sourcePath.lastIndexOf('/'))
        .replace(/[^a-z0-9.]/gi, '').toLowerCase();
    const digest = sha256(`${idKey(sourceDocId)}:${file.sourcePath}:${file.sourceStorageId}`).slice(0, 24);
    return `migration/${runId}/repair/${idKey(targetDocId)}/${digest}${suffix}`;
}

function storageEtag(storageId: string): string {
    return Buffer.from(`/data/file/hydro/${storageId}`).toString('base64');
}

function repairFile(
    runId: string,
    sourceDocId: number | string,
    targetDocId: number | string,
    cloned: MaterializedProblemClonedFile,
): TestdataRepairFile {
    const sourceFile = cloned.file;
    const { suffix, name } = sourcePathParts(sourceFile, sourceDocId);
    const folder = cloned.kind === 'data' ? 'testdata' : 'additional_file';
    if (suffix !== `${folder}/${cloned.name}` || name !== cloned.name) {
        throw new Error(`题目 ${idKey(sourceDocId)} 的源文件类型或名称不匹配: ${sourceFile.sourcePath}`);
    }
    if (sourceFile.targetPath !== sourceFile.sourcePath
        || String(cloned.storage?._id) !== sourceFile.sourceStorageId
        || String(cloned.storage?.path) !== sourceFile.sourcePath
        || cloned.storage?.etag !== storageEtag(sourceFile.sourceStorageId)) {
        throw new Error(`题目 ${idKey(sourceDocId)} 的源文件 storage 元数据不一致: ${sourceFile.sourcePath}`);
    }
    if (!sourceFile.included || !sourceFile.packagePath || !sourceFile.sha256) {
        throw new Error(`题目 ${idKey(sourceDocId)} 的源文件缺少 packagePath/SHA-256: ${sourceFile.sourcePath}`);
    }
    if (!sourceFile.sourceStorageId) {
        throw new Error(`题目 ${idKey(sourceDocId)} 的源文件缺少 storage ID: ${sourceFile.sourcePath}`);
    }
    const targetPath = sourceFile.sourcePath.replace(
        `problem/exam/${idKey(sourceDocId)}/`,
        `problem/exam/${idKey(targetDocId)}/`,
    );
    const targetId = targetStorageId(runId, sourceDocId, targetDocId, sourceFile);
    const file: FileEntry = {
        ...sourceFile,
        targetPath,
        targetStorageId: targetId,
    };
    const storage = {
        ...cloned.storage,
        _id: targetId,
        path: targetPath,
        etag: storageEtag(targetId),
    };
    return { sourceFile: { ...sourceFile }, file, storage };
}

function withoutPlanHash(plan: Omit<TestdataRepairPlan, 'planHash'>): Omit<TestdataRepairPlan, 'planHash'> {
    return plan;
}

export function computeTestdataRepairPlanHash(plan: Omit<TestdataRepairPlan, 'planHash'>): string {
    return hashObject(withoutPlanHash(plan));
}

export function planExamTestdataRepair(input: TestdataRepairPlannerInput): TestdataRepairPlan {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(input.runId)) throw new Error('测试数据修复 runId 不安全');
    if (!input.sourcePackageHash || !input.priorPlanHash) throw new Error('测试数据修复计划缺少源包或原计划哈希');
    const sources = problemIndex(input.sourceProblems, '源');
    const targets = problemIndex(input.targetProblems, '目标');
    const snapshots = snapshotIndex(input.snapshots);
    decisionIndex(input.priorPlan.problems);
    const selected: TestdataRepairItem[] = [];
    const sourceStoragePaths = new Set<string>();
    const sourceStorageIds = new Set<string>();
    const targetStoragePaths = new Set<string>();
    const targetStorageIds = new Set<string>();

    for (const decision of input.priorPlan.problems) {
        if (decision.action !== 'copy' || decision.sourceHasFiles || isP105(decision)) continue;
        const source = sources.get(idKey(decision.sourceDocId));
        if (!source) throw new Error(`题目 ${idKey(decision.sourceDocId)} 的源文档不存在`);
        const snapshot = snapshots.get(idKey(decision.sourceDocId));
        if (!isPrepareReference(source, snapshot)) continue;
        if (!snapshot) throw new Error(`题目 ${idKey(decision.sourceDocId)} 缺少 materialized 题目快照`);
        if (idKey(snapshot.sourceDocId) !== idKey(source.docId)) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 快照 docId 不匹配`);
        }
        if (referenceKey(snapshot.sourceReference) !== referenceKey(source.reference)) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 快照引用不匹配`);
        }
        if (String(snapshot.effectiveSource.domainId) !== 'prepare') {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 快照最终引用不是 prepare`);
        }
        if (!Array.isArray(snapshot.data) || snapshot.data.length === 0) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 源测试数据为空`);
        }
        if (decision.targetDocId === undefined || decision.targetDocId === null) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 缺少目标 docId`);
        }
        const target = targets.get(idKey(decision.targetDocId));
        if (!target) throw new Error(`题目 ${idKey(decision.sourceDocId)} 的目标文档不存在: ${idKey(decision.targetDocId)}`);
        if (String(target.domainId || 'exam') !== 'exam') {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 的目标文档不在 exam 域`);
        }
        if (idKey(target.docId) !== idKey(decision.targetDocId)) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 目标 docId 不匹配`);
        }
        if (!Number.isInteger(Number(target.owner))) {
            throw new TypeError(`题目 ${idKey(decision.sourceDocId)} 目标 owner 无效`);
        }
        if (source.title !== target.title) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 源/目标标题不匹配`);
        }
        if (stableStringify(source.content ?? null) !== stableStringify(target.content ?? null)) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 源/目标题面不匹配`);
        }
        if (dataCount(target.data) > 0) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 目标已有测试数据`);
        }
        if (dataCount(target.additional_file) > 0) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 目标已有附加文件`);
        }
        if (hasValue(target.reference)) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 目标仍有引用`);
        }
        if (!Array.isArray(snapshot.clonedFiles) || snapshot.clonedFiles.length === 0) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 快照缺少源文件`);
        }
        const sourceDataNames = new Set(snapshot.data.map((file) => String(file?.name || file?._id || '')));
        const clonedDataNames = new Set(snapshot.clonedFiles
            .filter((file) => file.kind === 'data')
            .map((file) => file.name));
        const sourceAdditionalNames = new Set((snapshot.additional_file || []).map((file) => String(file?.name || file?._id || '')));
        const clonedAdditionalNames = new Set(snapshot.clonedFiles
            .filter((file) => file.kind === 'additional_file')
            .map((file) => file.name));
        if (!sourceDataNames.size || sourceDataNames.size !== clonedDataNames.size
            || [...sourceDataNames].some((name) => !clonedDataNames.has(name))
            || sourceAdditionalNames.size !== clonedAdditionalNames.size
            || [...sourceAdditionalNames].some((name) => !clonedAdditionalNames.has(name))
            || snapshot.clonedFiles.length !== snapshot.data.length + (snapshot.additional_file || []).length) {
            throw new Error(`题目 ${idKey(decision.sourceDocId)} 快照测试文件清单不完整`);
        }
        const files = snapshot.clonedFiles
            .slice()
            .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`))
            .map((file) => {
                const repaired = repairFile(input.runId, decision.sourceDocId, decision.targetDocId!, file);
                repaired.storage.owner = target.owner;
                return repaired;
            });
        for (const file of files) {
            if (sourceStoragePaths.has(file.sourceFile.sourcePath)) {
                throw new Error(`修复源存储路径重复: ${file.sourceFile.sourcePath}`);
            }
            if (sourceStorageIds.has(file.sourceFile.sourceStorageId)) {
                throw new Error(`修复源 storage ID 重复: ${file.sourceFile.sourceStorageId}`);
            }
            if (targetStoragePaths.has(file.file.targetPath)) {
                throw new Error(`修复目标存储路径重复: ${file.file.targetPath}`);
            }
            if (targetStorageIds.has(file.file.targetStorageId!)) {
                throw new Error(`修复目标 storage ID 重复: ${file.file.targetStorageId}`);
            }
            sourceStoragePaths.add(file.sourceFile.sourcePath);
            sourceStorageIds.add(file.sourceFile.sourceStorageId);
            targetStoragePaths.add(file.file.targetPath);
            targetStorageIds.add(file.file.targetStorageId!);
        }
        selected.push({
            sourceDocId: decision.sourceDocId,
            targetDocId: decision.targetDocId,
            ...(snapshot.sourcePid !== undefined ? { sourcePid: snapshot.sourcePid } : {}),
            sourceReference: snapshot.sourceReference,
            effectiveSource: snapshot.effectiveSource,
            targetDocumentFingerprint: hashObject(target),
            files,
        });
    }

    // A plan is a review artifact: order must not depend on MongoDB cursor or
    // JSONL order.  Keep the exact source/target identifier values in output.
    selected.sort((a, b) => `${idKey(a.sourceDocId)}:${idKey(a.targetDocId)}`
        .localeCompare(`${idKey(b.sourceDocId)}:${idKey(b.targetDocId)}`));
    const plan: Omit<TestdataRepairPlan, 'planHash'> = {
        schemaVersion: TESTDATA_REPAIR_SCHEMA_VERSION,
        kind: 'hydro.exam-testdata-repair-plan',
        runId: input.runId,
        sourcePackageHash: input.sourcePackageHash,
        priorPlanHash: input.priorPlanHash,
        items: selected,
    };
    return { ...plan, planHash: computeTestdataRepairPlanHash(plan) };
}
