/* eslint-disable simple-import-sort/imports, no-await-in-loop, no-control-regex, max-len, regexp/no-misleading-capturing-group, regexp/no-super-linear-backtracking, regexp/no-useless-non-capturing-group, style/member-delimiter-style, style/max-statements-per-line, ts/no-use-before-define, unicorn/escape-case, github/array-foreach, object-shorthand, prefer-template */
/*
 * The exam migration is intentionally independent from Hydro's application
 * context.  It talks to MongoDB directly so that an export can be produced
 * while the source application is stopped and an apply can be performed with
 * the target application stopped.  The functions in the first half of this
 * file are pure and are also used by the migration unit tests.
 */

import crypto from 'crypto';
import childProcess from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Db, MongoClient, ObjectId } from 'mongodb';
import { EJSON } from 'bson';
import yaml from 'js-yaml';

export const EXAM_DOMAIN = 'exam';
export const MIGRATION_SCHEMA_VERSION = 1;
export const RUNS_DIRECTORY = 'migration-runs';
// Hydro's built-in PRIV_DEFAULT (USER_PROFILE | CREATE_FILE | SEND_MESSAGE).
export const DEFAULT_USER_PRIV = (1 << 2) + (1 << 16) + (1 << 24);

export const COLLECTIONS = [
    'domain',
    'domain.user',
    'user.group',
    'user',
    'document',
    'document.status',
    'record',
    'record.stat',
    'record.history',
    'discussion.history',
    'contest.balloon',
    'storage',
] as const;

export type MigrationCollection = typeof COLLECTIONS[number];

export const PHASES = [
    'users',
    'domain',
    'problems',
    'storage',
    'related-documents',
    'records',
    'statuses',
] as const;

export type MigrationPhase = typeof PHASES[number];

/**
 * The former hand-confirmed and username-first maps are intentionally empty.
 * They remain exported so older callers fail closed instead of silently
 * reviving a cancelled identity decision.
 */
export const CONFIRMED_USER_MAP: Record<number, number> = Object.freeze({});
export const USERNAME_CONFLICT_MAP: Record<number, number> = Object.freeze({});
/**
 * The only approved @test.com exception: these source accounts were checked
 * manually and may merge when both their stored e-mail and username match.
 */
export const CONFIRMED_TEST_EMAIL_SOURCE_UIDS = Object.freeze([
    270, 298, 314, 334, 415, 523, 600, 1204,
]);

export const CONFIRMED_DECISIONS = Object.freeze({
    manualUserMappings: CONFIRMED_USER_MAP,
    usernameConflictMappings: USERNAME_CONFLICT_MAP,
    identityPolicy: {
        match: 'exact-normalized-email-only',
        emailNormalization: 'trim-and-lowercase',
        rejectIdentityDomain: 'test.com',
        usernameMatching: false,
        usernameConflictMatching: false,
        testEmailExactNameSourceUids: CONFIRMED_TEST_EMAIL_SOURCE_UIDS,
        newUsernameSuffix: '_exam',
        conflictingEmailAction: 'new-account-with-reserved-placeholder',
    },
    problemReferences: {
        P11: { domainId: 'oler', pid: 1 },
        P12: { domainId: 'oler', pid: 2 },
        P13: { domainId: 'oler', pid: 3 },
        P14: { domainId: 'oler', pid: 4 },
        P27: { domainId: 'yizhong', pid: 417 },
        P28: { domainId: 'yizhong', pid: 418 },
        P29: { domainId: 'yizhong', pid: 419 },
        P72: { domainId: 'yizhong', pid: 480 },
    },
    problemReuses: {
        P105: {
            domainId: EXAM_DOMAIN,
            pid: 9,
            title: '翻转链（reversal）',
            reference: { domainId: 'contests', pid: 3230 },
            requiredReferenceDataFiles: 40,
        },
    },
    danglingOlerTestReferencesAreNotReused: true,
    testFilesDoNotDecideProblemReuse: true,
});

export interface SourceUser {
    _id: number;
    uname: string;
    unameLower?: string;
    mail?: string;
    mailLower?: string;
    [key: string]: any;
}

export interface TargetUser extends SourceUser { }

export type IdentityMethod = 'email' | 'new';

export interface IdentityDecision {
    sourceUid: number;
    targetUid: number;
    method: IdentityMethod;
    created: boolean;
    sourceUname: string;
    targetUname?: string;
    sourceMail?: string;
    targetMail?: string;
    alias?: boolean;
    emailConflict?: boolean;
    note?: string;
}

export interface IdentityOptions {
    /** Reserved for forward-compatible policy flags; no username matching is allowed. */
    allowAliases?: never;
}

export interface ProblemReference {
    domainId: string;
    pid: number | string;
}

export type ProblemAction = 'copy' | 'reference' | 'reuse';

export interface ProblemDecision {
    sourceDocId: number;
    sourcePid: string;
    action: ProblemAction;
    targetDomainId: string;
    targetPid: number | string;
    targetDocId?: number | string;
    reason: 'confirmed-reference' | 'confirmed-reuse' | 'matching-reference' | 'matching-existing' | 'entity';
    sourceHasFiles: boolean;
    targetHasFiles?: boolean;
    excludedFiles?: string[];
}

export interface ContestDecision {
    sourceDocId: string;
    action: 'copy' | 'reuse';
    targetDocId: string;
    targetObjectId: string;
    reason: 'matching-contest' | 'entity';
}

export interface ExcludedDocument {
    collection: 'document';
    docType: number;
    docId: string;
    reason: 'missing-parent';
}

export interface ProblemFileDifference {
    sourceDocId: number;
    targetDomainId: string;
    targetPid: number | string;
    sourceFiles: string[];
    targetFiles: string[];
    missingInTarget: string[];
    extraInTarget: string[];
}

export interface FileEntry {
    sourceStorageId: string;
    sourcePath: string;
    targetPath: string;
    targetStorageId?: string;
    packagePath?: string;
    size?: number;
    sha256?: string;
    required: boolean;
    included: boolean;
    missing?: boolean;
    excludedReason?: string;
}

export type MaterializedProblemFileKind = 'data' | 'additional_file';

/**
 * A storage record cloned from a referenced problem outside the exported
 * domain.  It is kept in the materialized-problem sidecar rather than the
 * source `storage.jsonl` snapshot so the latter remains an exact exam-domain
 * snapshot.
 */
export interface MaterializedProblemClonedFile {
    kind: MaterializedProblemFileKind;
    name: string;
    originPath: string;
    originStorageId: string;
    storage: Record<string, any>;
    file: FileEntry;
}

export interface MaterializedProblemSnapshot {
    sourceDocId: number | string;
    sourcePid?: number | string;
    sourceReference: ProblemReference & Record<string, any>;
    effectiveSource: {
        domainId: string;
        docId: number | string;
        pid: number | string;
        path: string;
        referenceChain: Array<ProblemReference & Record<string, any>>;
    };
    config: any;
    data: any[];
    additional_file: any[];
    clonedFiles: MaterializedProblemClonedFile[];
}

export interface MaterializedProblemsManifest {
    file: string;
    count: number;
    sha256: string;
    bytes: number;
}

export interface CollectionManifest {
    name: MigrationCollection;
    file: string;
    count: number;
    sha256: string;
    bytes: number;
}

export interface MigrationManifest {
    schemaVersion: number;
    kind: 'hydro.exam-migration';
    runId: string;
    domainId: string;
    createdAt: string;
    sourceFingerprint: string;
    sourceDatabase: string;
    collections: CollectionManifest[];
    files: FileEntry[];
    materializedProblems?: MaterializedProblemsManifest;
    excludedFiles: Array<{ sourcePath: string; reason: string; missing?: boolean }>;
    counts: Record<string, number>;
    packageHash?: string;
}

export interface ObjectIdMaps {
    /** source ObjectId hex -> target ObjectId hex */
    values: Record<string, string>;
}

export interface TargetFingerprint {
    hash: string;
    collections: Record<string, { count: number; idsHash: string }>;
    maxUid: number;
    defaultUserPriv: number;
    referenceProblemsHash: string;
    referenceDomainsHash: string;
    examDomainExists: boolean;
}

export interface MigrationPlan {
    schemaVersion: number;
    kind: 'hydro.exam-migration-plan';
    runId: string;
    domainId: string;
    packageHash: string;
    sourceFingerprint: string;
    targetBefore: TargetFingerprint;
    mergeExisting: boolean;
    identities: IdentityDecision[];
    problems: ProblemDecision[];
    problemIds: Record<string, number | string>;
    contests: ContestDecision[];
    excludedDocuments: ExcludedDocument[];
    problemFileDifferences: ProblemFileDifference[];
    objectIds: ObjectIdMaps;
    storage: FileEntry[];
    defaultUserPriv: number;
    expectedCounts: Record<string, number>;
    mergeKeys?: {
        domainMembers: string[];
        groups: string[];
        statuses: string[];
    };
    excludedFiles: MigrationManifest['excludedFiles'];
    confirmedDecisions: typeof CONFIRMED_DECISIONS;
    phases: typeof PHASES;
    planHash?: string;
}

export interface CommandOptions {
    sourceUri?: string;
    targetUri?: string;
    sourceDatabase?: string;
    targetDatabase?: string;
    domainId?: string;
    runDir?: string;
    packageDir?: string;
    sourceStorageRoot?: string;
    targetStorageRoot?: string;
    planHash?: string;
    dryRun?: boolean;
    noStop?: boolean;
    noBackup?: boolean;
    yes?: boolean;
    keepGoing?: boolean;
    mergeExisting?: boolean;
}

export interface ApplyOptions extends CommandOptions {
    serviceControl?: 'pm2' | 'none';
    backup?: boolean;
    mongoDump?: (args: string[]) => Promise<void>;
    stopService?: () => Promise<void>;
    startService?: () => Promise<void>;
}

export interface VerifyReport {
    schemaVersion: number;
    runId: string;
    verifiedAt: string;
    ok: boolean;
    applied: boolean;
    counts: Record<string, { expected: number; actual: number; ok: boolean }>;
    references: { checked: number; errors: string[] };
    files: { checked: number; errors: string[] };
    identities: { duplicateUsernames: string[]; duplicateEmails: string[] };
    errors: string[];
}

export interface MergeReport {
    schemaVersion: number;
    runId: string;
    generatedAt: string;
    packageHash: string;
    planHash: string;
    targetBeforeHash: string;
    verification: { ok: boolean; errors: string[] };
    identities: Array<{
        sourceUid: number;
        targetUid: number;
        username: string;
        targetUsername: string;
        method: IdentityMethod;
        result: 'created' | 'reused';
        alias?: boolean;
        examMember: boolean;
        systemMember: boolean;
        email: string;
        targetEmail: string;
        records: number;
        statuses: number;
        statistics: number;
    }>;
    contests: Array<{
        sourceObjectId: string;
        targetObjectId: string;
        title: string;
        action: ContestDecision['action'];
        sourcePids: Array<number | string>;
        targetPids: Array<number | string>;
        sourceStatusCount: number;
        targetStatusCount: number;
        sourceRecordCount: number;
        targetRecordCount: number;
        attachmentCount: number;
        referencesRewritten: boolean;
    }>;
    problems: Array<{
        sourcePid: string;
        sourceTitle: string;
        targetDomainId: string;
        targetPid: number | string;
        targetDocId?: number | string;
        action: ProblemAction;
        reason: ProblemDecision['reason'];
        comparison: 'equivalent' | 'different' | 'unavailable';
        sourceFiles: string[];
        targetFiles: string[];
        effectiveTestData: { source: string; files: number } | null;
        attachmentCount: number;
        filesIncluded: boolean;
        excluded: boolean;
    }>;
    statusCollisions: Array<{
        docType: number;
        docId: string;
        targetUid: number;
        sourceUids: number[];
    }>;
    summary: {
        identityMethods: Record<string, number>;
        problemActions: Record<string, number>;
        contestActions: Record<string, number>;
        excludedDocuments: number;
        excludedFiles: number;
        statusCollisionCount: number;
        sourceCounts: Record<string, number>;
        expectedCounts: Record<string, number>;
        actualCounts: Record<string, number>;
    };
}

const UID_KEYS = new Set([
    'uid', 'owner', 'editor', 'operator', 'sent', 'from', 'to', 'teachers', 'students',
    'uids', 'maintainer', 'extraStudents', 'author', 'processer', 'judger',
]);
const SECRET_KEYS = /(?:password|passwd|token|secret|oauth|authenticator|session|verification)/i;
const LOG_SECRET_KEYS = /(?:password|passwd|token|secret|oauth|authenticator|session|verification|(?:^|_)(?:hash|salt)$)/i;
const COLLECTION_FILE_NAMES: Record<MigrationCollection, string> = {
    domain: 'domain.jsonl',
    'domain.user': 'domain-user.jsonl',
    'user.group': 'user-group.jsonl',
    user: 'user.jsonl',
    document: 'document.jsonl',
    'document.status': 'document-status.jsonl',
    record: 'record.jsonl',
    'record.stat': 'record-stat.jsonl',
    'record.history': 'record-history.jsonl',
    'discussion.history': 'discussion-history.jsonl',
    'contest.balloon': 'contest-balloon.jsonl',
    storage: 'storage.jsonl',
};

function assert(condition: any, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function isBsonValue(value: any): boolean {
    return !!value && typeof value === 'object' && typeof value._bsontype === 'string';
}

export function normalizeUsername(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

/**
 * Normalize an e-mail only for identity matching.  The current policy is
 * deliberately conservative: trim and lowercase only.  Plus tags, dots in
 * local parts, and googlemail/gmail aliases are not identity evidence.
 */
export function normalizeIdentityEmail(value: unknown): string | null {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw || /\s/.test(raw)) return null;
    const at = raw.lastIndexOf('@');
    if (at <= 0 || at === raw.length - 1 || raw.indexOf('@') !== at) return null;
    const domain = raw.slice(at + 1);
    if (!/^[^@.]+(?:\.[^@.]+)*$/.test(domain)) return null;
    if (domain === 'test.com') return null;
    return raw;
}

/** Normalize a stored e-mail for uniqueness checks, including @test.com. */
function normalizeStoredEmail(value: unknown): string | null {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw || /\s/.test(raw)) return null;
    const at = raw.lastIndexOf('@');
    if (at <= 0 || at === raw.length - 1 || raw.indexOf('@') !== at) return null;
    const domain = raw.slice(at + 1);
    if (!/^[^@.]+(?:\.[^@.]+)*$/.test(domain)) return null;
    return raw;
}

function normalizeTestEmail(value: unknown): string | null {
    const raw = normalizeStoredEmail(value);
    return raw?.endsWith('@test.com') ? raw : null;
}

function indexBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
    const index = new Map<string, T[]>();
    for (const item of items) {
        const value = key(item);
        if (!value) continue;
        const bucket = index.get(value) || [];
        bucket.push(item);
        index.set(value, bucket);
    }
    return index;
}

/** Resolve identities using exact non-test.com e-mail matches plus the eight confirmed test-email exceptions. */
export function resolveIdentities(
    sourceUsers: SourceUser[], targetUsers: TargetUser[], options: IdentityOptions = {},
): IdentityDecision[] {
    void options;
    const byMail = indexBy(targetUsers, (user) => normalizeIdentityEmail(user.mailLower || user.mail) || '');
    const byStoredMail = indexBy(targetUsers, (user) => normalizeStoredEmail(user.mailLower || user.mail) || '');
    const usedTarget = new Set<number>();
    const existingMax = targetUsers.reduce((max, user) => Math.max(max, Number(user._id) || 0), 0);
    let nextUid = existingMax + 1;
    const decisions: IdentityDecision[] = [];
    const plannedNames = new Set<string>();
    const plannedEmails = new Set<string>(targetUsers
        .map((user) => normalizeStoredEmail(user.mailLower || user.mail))
        .filter((value): value is string => !!value));
    const sorted = [...sourceUsers].sort((a, b) => Number(a._id) - Number(b._id));

    for (const source of sorted) {
        const sourceUid = Number(source._id);
        const sourceName = normalizeUsername(source.unameLower || source.uname);
        const sourceMail = normalizeIdentityEmail(source.mailLower || source.mail);
        const sourceStoredMail = normalizeStoredEmail(source.mailLower || source.mail);
        const sourceTestMail = normalizeTestEmail(source.mailLower || source.mail);
        const testCandidates = sourceTestMail && CONFIRMED_TEST_EMAIL_SOURCE_UIDS.includes(sourceUid)
            ? (byStoredMail.get(sourceTestMail) || []).filter((candidate) =>
                normalizeUsername(candidate.unameLower || candidate.uname) === sourceName)
            : [];
        const candidates = sourceMail ? (byMail.get(sourceMail) || []) : testCandidates;
        if (candidates.length > 1) {
            throw new Error(`邮箱身份判定不唯一: source uid ${sourceUid} has ${candidates.length} candidates`);
        }
        const target = candidates.length === 1 && !usedTarget.has(Number(candidates[0]._id)) ? candidates[0] : undefined;
        const emailConflict = !!sourceStoredMail && (byStoredMail.has(sourceStoredMail) || plannedEmails.has(sourceStoredMail));
        let method: IdentityMethod = target ? 'email' : 'new';
        let targetUid: number;
        let targetUname: string | undefined;
        let targetMail: string | undefined;
        let note = '';
        if (target) {
            targetUid = Number(target._id);
            targetUname = target.uname;
            targetMail = target.mail;
            usedTarget.add(targetUid);
            note = sourceTestMail
                ? '明确例外：@test.com 邮箱和用户名完全相同'
                : '唯一依据：非 @test.com 的规范化邮箱完全相同';
        } else {
            targetUname = `${source.uname || `user_${sourceUid}`}_exam`;
            const targetNameKey = normalizeUsername(targetUname);
            if (!targetNameKey || plannedNames.has(targetNameKey)
                || targetUsers.some((user) => normalizeUsername(user.unameLower || user.uname) === targetNameKey)) {
                throw new Error(`新用户用户名会发生唯一性冲突: ${targetUname}`);
            }
            plannedNames.add(targetNameKey);
            while (targetUsers.some((user) => Number(user._id) === nextUid) || usedTarget.has(nextUid)) nextUid++;
            targetUid = nextUid++;
            targetMail = sourceStoredMail && !emailConflict
                ? sourceStoredMail
                : `exam-${sourceUid}-${targetUid}@invalid.exam`;
            let placeholderIndex = 1;
            while (plannedEmails.has(targetMail)) {
                targetMail = `exam-${sourceUid}-${targetUid}-${placeholderIndex++}@invalid.exam`;
            }
            plannedEmails.add(targetMail);
            if (emailConflict) note = '邮箱已存在或为 @test.com 冲突值，账号不合并，改用迁移占位邮箱';
            else if (!sourceStoredMail) note = '源邮箱无效或为空，使用迁移占位邮箱';
            else note = '未找到可确认的非 @test.com 邮箱，创建独立账号';
        }
        decisions.push({
            sourceUid,
            targetUid,
            method,
            created: !target,
            sourceUname: source.uname,
            targetUname,
            sourceMail: source.mail,
            targetMail,
            ...(emailConflict && !target ? { emailConflict: true } : {}),
            ...(note ? { note } : {}),
        });
    }
    return decisions;
}

export function identityMap(decisions: IdentityDecision[]): Map<number, number> {
    return new Map(decisions.map((decision) => [decision.sourceUid, decision.targetUid]));
}

export function normalizeProblemTitle(value: unknown): string {
    return String(value ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeContent(value: unknown): string {
    if (value && typeof value === 'object') return stableStringify(value);
    return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

export function parseEffectiveConfig(value: unknown): any {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return canonicalize(value);
    try {
        return canonicalize(yaml.load(value));
    } catch {
        return value.replace(/\r\n?/g, '\n').trim();
    }
}

function problemEquivalent(a: any, b: any): boolean {
    return normalizeProblemTitle(a.title) === normalizeProblemTitle(b.title)
        && normalizeContent(a.content) === normalizeContent(b.content)
        && stableStringify(parseEffectiveConfig(a.config)) === stableStringify(parseEffectiveConfig(b.config));
}

function problemFileNames(problem: any): string[] {
    return [...(problem?.data || []), ...(problem?.additional_file || [])]
        .map((file) => String(file.name || file._id || ''))
        .filter(Boolean)
        .sort();
}

export function isHealthyProblemReference(
    problem: any,
    targetProblems: any[],
    targetDomains: any[] = [],
    visited = new Set<any>(),
): boolean {
    if (!problem) return false;
    if (visited.has(problem)) return false;
    visited.add(problem);
    if (problem.domainId === 'test' || problem.domainId === 'prepare') return false;
    if (!problem.reference) {
        return targetDomains.length === 0 || targetDomains.some((candidate) => candidate._id === problem.domainId)
            || ['system', 'oler', 'yizhong'].includes(problem.domainId);
    }
    const reference = problem.reference as ProblemReference;
    if (reference.domainId === 'test' || reference.domainId === 'prepare') return false;
    const target = targetProblems.find((candidate) => candidate.domainId === reference.domainId
        && (String(candidate.docId) === String(reference.pid) || String(candidate.pid) === String(reference.pid)));
    if (!target) return false;
    const domain = targetDomains.find((candidate) => candidate._id === target.domainId);
    return (!!domain || target.domainId === 'system' || target.domainId === 'oler' || target.domainId === 'yizhong')
        && isHealthyProblemReference(target, targetProblems, targetDomains, visited);
}

export interface ProblemDecisionOptions {
    mergeExisting?: boolean;
    domainId?: string;
}

/**
 * Build problem decisions.  Explicitly confirmed references are considered
 * first; generic title/content/config matches are only reused when the source
 * and target are equivalent and the target entity is healthy.
 */
export function buildProblemDecisions(
    sourceProblems: any[], targetProblems: any[], targetDomains: any[] = [],
    options: ProblemDecisionOptions = {},
): ProblemDecision[] {
    const explicit = CONFIRMED_DECISIONS.problemReferences as Record<string, ProblemReference>;
    const decisions: ProblemDecision[] = [];
    const domainId = options.domainId || EXAM_DOMAIN;
    const existingIds = new Set<number>(targetProblems
        .filter((problem) => problem.domainId === domainId && Number.isFinite(Number(problem.docId)))
        .map((problem) => Number(problem.docId)));
    const sourceIds = new Set(sourceProblems
        .map((problem) => Number(problem.docId))
        .filter((value) => Number.isFinite(value)));
    let nextDocId = Math.max(0, ...existingIds, ...sourceIds) + 1;
    const reservedDocIds = new Set(existingIds);
    // Keep free source IDs stable. A conflicting source ID is assigned after
    // the complete source range, making the result deterministic regardless of
    // the order in which related collections are processed.
    for (const source of sourceProblems) {
        const sourceDocId = Number(source.docId);
        if (Number.isFinite(sourceDocId) && !reservedDocIds.has(sourceDocId)) reservedDocIds.add(sourceDocId);
    }
    const assignTargetDocId = (source: any, reuseTarget?: any): number | string => {
        if (reuseTarget?.docId !== undefined) return reuseTarget.docId;
        if (!options.mergeExisting) return source.docId;
        const sourceDocId = Number(source.docId);
        if (Number.isFinite(sourceDocId) && !existingIds.has(sourceDocId)) {
            // The source ID may have been reserved by an earlier source item;
            // that item is the only legitimate owner of it.
            const owner = decisions.find((item) => String(item.targetDocId) === String(sourceDocId));
            if (!owner) return sourceDocId;
        }
        while (reservedDocIds.has(nextDocId)) nextDocId++;
        reservedDocIds.add(nextDocId);
        return nextDocId++;
    };
    for (const source of [...sourceProblems].sort((a, b) => Number(a.docId) - Number(b.docId))) {
        const sourcePid = String(source.pid || `P${source.docId}`);
        const isConfirmedP105 = !!options.mergeExisting && (Number(source.docId) === 105 || sourcePid === 'P105');
        if (isConfirmedP105) {
            const confirmedReuse = CONFIRMED_DECISIONS.problemReuses.P105;
            const target = targetProblems.find((problem) => problem.domainId === confirmedReuse.domainId
                && String(problem.docId) === String(confirmedReuse.pid));
            const reference = target?.reference;
            const referenced = reference && targetProblems.find((problem) => problem.domainId === confirmedReuse.reference.domainId
                && (String(problem.docId) === String(reference.pid) || String(problem.pid) === String(reference.pid)));
            const valid = Number(source.docId) === 105
                && normalizeProblemTitle(source.title) === normalizeProblemTitle(confirmedReuse.title)
                && normalizeProblemTitle(target?.title) === normalizeProblemTitle(confirmedReuse.title)
                && reference?.domainId === confirmedReuse.reference.domainId
                && String(reference?.pid) === String(confirmedReuse.reference.pid)
                && !!referenced
                && isHealthyProblemReference(target, targetProblems, targetDomains)
                && isHealthyProblemReference(referenced, targetProblems, targetDomains)
                && Array.isArray(referenced.data)
                && referenced.data.length === confirmedReuse.requiredReferenceDataFiles;
            if (valid) {
                decisions.push({
                    sourceDocId: Number(source.docId), sourcePid, action: 'reuse',
                    targetDomainId: confirmedReuse.domainId, targetPid: confirmedReuse.pid,
                    targetDocId: confirmedReuse.pid,
                    reason: 'confirmed-reuse',
                    sourceHasFiles: !!(source.data?.length || source.additional_file?.length),
                    targetHasFiles: true,
                    excludedFiles: [...(source.data || []), ...(source.additional_file || [])].map((file) => file.name),
                });
                continue;
            }
            throw new Error('合并模式下 P105 必须复用已验证的 exam/9（contests/3230，40 个测试数据文件）');
        }
        const existingExam = options.mergeExisting
            ? targetProblems.filter((problem) => problem.domainId === domainId)
                .find((problem) => problemEquivalent(source, problem))
            : undefined;
        if (existingExam) {
            decisions.push({
                sourceDocId: Number(source.docId), sourcePid, action: 'reuse',
                targetDomainId: domainId, targetPid: existingExam.pid || existingExam.docId,
                targetDocId: existingExam.docId,
                reason: 'matching-existing',
                sourceHasFiles: !!(source.data?.length || source.additional_file?.length),
                targetHasFiles: !!(existingExam.data?.length || existingExam.additional_file?.length),
                excludedFiles: [...(source.data || []), ...(source.additional_file || [])].map((file) => file.name),
            });
            continue;
        }
        const reference = explicit[sourcePid] || explicit[`P${source.docId}`];
        if (reference) {
            const target = targetProblems.find((problem) => problem.domainId === reference.domainId
                && String(problem.pid || problem.docId) === String(reference.pid));
            const targetComparable = target && ['title', 'content', 'config'].every((key) => target[key] !== undefined);
            if (target && isHealthyProblemReference(target, targetProblems, targetDomains)
                && (!targetComparable || problemEquivalent(source, target))) {
                decisions.push({
                    sourceDocId: Number(source.docId), sourcePid, action: 'reference',
                    targetDomainId: reference.domainId, targetPid: reference.pid,
                    targetDocId: assignTargetDocId(source),
                    reason: 'confirmed-reference',
                    sourceHasFiles: !!(source.data?.length || source.additional_file?.length),
                    targetHasFiles: !!(target.data?.length || target.additional_file?.length),
                    excludedFiles: [...(source.data || []), ...(source.additional_file || [])].map((file) => file.name),
                });
                continue;
            }
        }

        const candidates = targetProblems.filter((target) => normalizeProblemTitle(target.title)
            === normalizeProblemTitle(source.title)
            && isHealthyProblemReference(target, targetProblems, targetDomains));
        const equivalent = candidates.find((target) => problemEquivalent(source, target));
        if (equivalent) {
            decisions.push({
                sourceDocId: Number(source.docId), sourcePid, action: 'reference',
                targetDomainId: equivalent.domainId, targetPid: equivalent.pid || equivalent.docId,
                targetDocId: assignTargetDocId(source),
                reason: 'matching-reference',
                sourceHasFiles: !!(source.data?.length || source.additional_file?.length),
                targetHasFiles: !!(equivalent.data?.length || equivalent.additional_file?.length),
                excludedFiles: [...(source.data || []), ...(source.additional_file || [])].map((file) => file.name),
            });
            continue;
        }

        const targetDocId = assignTargetDocId(source);
        decisions.push({
            sourceDocId: Number(source.docId), sourcePid, action: 'copy',
            targetDomainId: EXAM_DOMAIN,
            targetPid: source.pid || targetDocId,
            targetDocId,
            reason: 'entity',
            sourceHasFiles: !!(source.data?.length || source.additional_file?.length),
        });
    }
    return decisions;
}

function ejsonKey(value: any): string {
    return EJSON.stringify(value, { relaxed: false });
}

export function buildContestDecisions(
    sourceContests: any[], targetContests: any[], problemDecisions: ProblemDecision[],
    mergeExisting = false,
): ContestDecision[] {
    const problemIds = new Map(problemDecisions.map((decision) => [String(decision.sourceDocId), decision.targetDocId ?? decision.sourceDocId]));
    const targetBySignature = new Map<string, any[]>();
    for (const target of targetContests) {
        const signature = stableStringify({
            title: normalizeProblemTitle(target.title),
            pids: (target.pids || []).map((pid: any) => String(pid)),
            rule: target.rule || '',
            beginAt: target.beginAt || null,
            endAt: target.endAt || null,
        });
        const bucket = targetBySignature.get(signature) || [];
        bucket.push(target);
        targetBySignature.set(signature, bucket);
    }
    return [...sourceContests].sort((a, b) => ejsonKey(a.docId).localeCompare(ejsonKey(b.docId))).map((source) => {
        const pids = (source.pids || []).map((pid: any) => {
            const mapped = problemIds.get(String(pid));
            if (mapped === undefined) throw new Error(`比赛 ${String(source.docId)} 引用了未映射题目 ${String(pid)}`);
            return mapped;
        });
        const signature = stableStringify({
            title: normalizeProblemTitle(source.title),
            pids: pids.map((pid: any) => String(pid)),
            rule: source.rule || '',
            beginAt: source.beginAt || null,
            endAt: source.endAt || null,
        });
        const matched = mergeExisting ? targetBySignature.get(signature)?.[0] : undefined;
        const sourceObjectId = getObjectId(source._id || source.docId);
        assert(sourceObjectId, `比赛 ${String(source.docId)} 缺少 ObjectId`);
        const targetObjectId = getObjectId(matched?._id || matched?.docId) || sourceObjectId;
        return {
            sourceDocId: sourceObjectId.toHexString(),
            action: matched ? 'reuse' : 'copy',
            targetDocId: ejsonKey(matched?.docId ?? source.docId),
            targetObjectId: targetObjectId.toHexString(),
            reason: matched ? 'matching-contest' : 'entity',
        };
    });
}

/** Rewrite only fields that represent a user identity; ObjectIds are handled separately. */
export function rewriteUserIds(value: any, users: Map<number, number>, key = ''): any {
    if (typeof value === 'number' && UID_KEYS.has(key)) return users.get(value) ?? value;
    if (Array.isArray(value)) return value.map((item) => rewriteUserIds(item, users, key));
    if (!value || typeof value !== 'object' || value instanceof Date || isBsonValue(value)) return value;
    const output: Record<string, any> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
        output[childKey] = rewriteUserIds(childValue, users, childKey);
    }
    return output;
}

export function rewriteObjectIds(value: any, objectIds: Map<string, ObjectId>): any {
    if (value instanceof ObjectId || (isBsonValue(value) && value._bsontype === 'ObjectId')) {
        return objectIds.get(value.toHexString()) || value;
    }
    if (Array.isArray(value)) return value.map((item) => rewriteObjectIds(item, objectIds));
    if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value) || isBsonValue(value)) return value;
    const output: Record<string, any> = {};
    for (const [key, child] of Object.entries(value)) output[key] = rewriteObjectIds(child, objectIds);
    return output;
}

export function stableStringify(value: any): string {
    return EJSON.stringify(canonicalize(value), { relaxed: false }) || 'null';
}

export function canonicalize(value: any): any {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value) || isBsonValue(value)) {
        return value;
    }
    const result: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
}

export function sha256(value: string | Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashObject(value: any): string {
    return sha256(stableStringify(value));
}

export function deterministicObjectId(seed: string): ObjectId {
    return new ObjectId(sha256(seed).slice(0, 24));
}

export function redactForLog(value: any, key = ''): any {
    if (LOG_SECRET_KEYS.test(key)) return '[REDACTED]';
    if (typeof value === 'string' && /(?:mongodb(?:\+srv)?:\/\/)/i.test(value)) {
        return value
            .replace(/(mongodb(?:\+srv)?:\/\/)([^/@]+):([^/@]+)@/i, '$1[REDACTED]@')
            .replace(/([?&](?:password|passwd|pass|token|secret)=)[^&]*/gi, '$1[REDACTED]');
    }
    if (Array.isArray(value)) return value.map((item) => redactForLog(item, key));
    if (!value || typeof value !== 'object' || value instanceof Date || isBsonValue(value)) return value;
    const output: Record<string, any> = {};
    for (const [childKey, child] of Object.entries(value)) output[childKey] = redactForLog(child, childKey);
    return output;
}

function isoRunId(date = new Date()): string {
    const timestamp = date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `${timestamp}-${crypto.randomBytes(4).toString('hex')}`;
}

export function createRunId(): string {
    return isoRunId();
}

function databaseName(uri: string | undefined, explicit?: string): string | undefined {
    if (explicit) return explicit;
    if (!uri) return undefined;
    try {
        const pathname = new URL(uri).pathname.replace(/^\//, '');
        return pathname ? decodeURIComponent(pathname) : undefined;
    } catch {
        return undefined;
    }
}

function collectionFilter(name: MigrationCollection, domainId: string): any {
    if (name === 'domain') return { _id: domainId };
    if (name === 'user') return {};
    if (name === 'storage') {
        return {
            path: { $regex: `^(?:problem|contest)/${escapeRegex(domainId)}(?:/|$)` },
            autoDelete: null,
        };
    }
    return { domainId };
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrubExportDocument(name: MigrationCollection, value: any): any {
    if (Array.isArray(value)) return value.map((item) => scrubExportDocument(name, item));
    if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value) || isBsonValue(value)) return value;
    const output: Record<string, any> = {};
    for (const [key, child] of Object.entries(value)) {
        if (name === 'user' && (SECRET_KEYS.test(key) || key === 'tfa')) continue;
        output[key] = scrubExportDocument(name, child);
    }
    return output;
}

function getObjectId(value: any): ObjectId | null {
    if (value instanceof ObjectId || (isBsonValue(value) && value._bsontype === 'ObjectId')) return value;
    if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value);
    return null;
}

function collectUidValues(value: any, key = '', output = new Set<number>()): Set<number> {
    if (typeof value === 'number' && UID_KEYS.has(key)) {
        output.add(value);
        return output;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectUidValues(item, key, output);
    } else if (value && typeof value === 'object' && !(value instanceof Date) && !isBsonValue(value)) {
        for (const [childKey, child] of Object.entries(value)) collectUidValues(child, childKey, output);
    }
    return output;
}

function sourceStoragePathIsScoped(sourcePath: string, domainId: string): boolean {
    return new RegExp(`^(?:problem|contest|submission)/${escapeRegex(domainId)}(?:/|$)`).test(sourcePath);
}

function sourceStoragePathIsPersonal(sourcePath: string, domainId: string): boolean {
    return sourcePath.includes(`/${domainId}/`) || /^(?:user|avatar|profile)\//.test(sourcePath);
}

export function safeRelativePath(root: string, relative: string): string {
    const clean = relative.replace(/^[/\\]+/, '');
    if (!clean || clean.split(/[\\/]/).includes('..') || path.isAbsolute(relative)) {
        throw new Error(`不安全的存储路径: ${relative}`);
    }
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, clean);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`存储路径越界: ${relative}`);
    }
    return resolved;
}

async function readStorageBytes(meta: any, root?: string): Promise<Buffer | null> {
    const candidates: string[] = [];
    if (meta.filePath) candidates.push(meta.filePath);
    if (meta.fsPath) candidates.push(meta.fsPath);
    if (root) {
        for (const candidate of [meta._id, meta.link, meta.path]) {
            if (candidate && typeof candidate === 'string') candidates.push(safeRelativePath(root, candidate));
        }
    }
    for (const candidate of candidates) {
        try {
            const stat = await fsp.stat(candidate);
            if (stat.isFile()) return await fsp.readFile(candidate);
        } catch { /* try the next storage layout */ }
    }
    return null;
}

async function ensurePrivateDirectory(directory: string) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    try { await fsp.chmod(directory, 0o700); } catch { /* Windows and read-only mounts */ }
}

async function writePrivateFile(file: string, content: string | Buffer) {
    await ensurePrivateDirectory(path.dirname(file));
    await fsp.writeFile(file, content, { mode: 0o600 });
    try { await fsp.chmod(file, 0o600); } catch { /* Windows and read-only mounts */ }
}

async function writeJson(file: string, value: any) {
    await writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T = any>(file: string): Promise<T> {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
}

async function writeAudit(runDir: string, event: string, data: any = {}) {
    const line = JSON.stringify({
        at: new Date().toISOString(), event, ...redactForLog(data),
    });
    await fsp.appendFile(path.join(runDir, 'audit.jsonl'), `${line}\n`, { mode: 0o600 });
}

async function readJsonLines(file: string): Promise<any[]> {
    let content: string;
    try { content = await fsp.readFile(file, 'utf8'); } catch { return []; }
    return content.split('\n').filter(Boolean).map((line) => EJSON.parse(line));
}

async function writeJsonLines(file: string, docs: any[]): Promise<{ sha256: string; bytes: number }> {
    const content = docs.map((doc) => EJSON.stringify(canonicalize(doc), { relaxed: false })).join('\n') + (docs.length ? '\n' : '');
    await writePrivateFile(file, content);
    return { sha256: sha256(content), bytes: Buffer.byteLength(content) };
}

async function hashPackageDirectory(directory: string): Promise<string> {
    const files: string[] = [];
    async function visit(current: string) {
        for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            const relative = path.relative(directory, full).split(path.sep).join('/');
            if (relative === 'backup' || relative.startsWith('backup/')) continue;
            if (relative === 'manifest.json' || relative === 'plan.json' || relative === 'apply.json'
                || relative === 'verify-report.json' || relative === 'rollback.json'
                || relative === 'verify-summary.txt' || relative === 'package.sha256'
                || relative === 'merge-report.json' || relative === 'merge-report.sha256'
                || relative === 'merge-summary.md'
                || relative === 'browser-regression.json'
                || relative === 'audit.jsonl' || relative === 'commands.jsonl') continue;
            if (entry.isDirectory()) await visit(full);
            else files.push(relative);
        }
    }
    await visit(directory);
    files.sort();
    const hash = crypto.createHash('sha256');
    for (const file of files) {
        hash.update(file);
        hash.update('\0');
        hash.update(await fsp.readFile(path.join(directory, file)));
        hash.update('\0');
    }
    // The manifest is part of the immutable package, but packageHash itself
    // must be omitted to avoid a self-referential digest.
    try {
        const manifest = await readJson<any>(path.join(directory, 'manifest.json'));
        delete manifest.packageHash;
        hash.update('manifest.json');
        hash.update('\0');
        hash.update(JSON.stringify(canonicalize(manifest)));
        hash.update('\0');
    } catch { /* export computes the payload hash before the first manifest */ }
    return hash.digest('hex');
}

async function getAll(db: Db, name: MigrationCollection, filter: any): Promise<any[]> {
    return db.collection(name).find(filter).toArray();
}

function submissionPathFromReference(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const pathPart = value.split('#', 1)[0];
    if (!pathPart) return null;
    if (pathPart.startsWith('submission/')) return pathPart;
    if (/^-?\d+\/[^/]+(?:\/.*)?$/.test(pathPart)) return `submission/${pathPart}`;
    if (/^[^/]+$/.test(pathPart)) return `submission/${pathPart}`;
    return null;
}

function collectSubmissionPaths(value: any, output = new Set<string>()): Set<string> {
    if (typeof value === 'string') {
        const pathValue = submissionPathFromReference(value);
        if (pathValue) output.add(pathValue);
    } else if (Array.isArray(value)) {
        for (const item of value) collectSubmissionPaths(item, output);
    } else if (value && typeof value === 'object' && !(value instanceof Date) && !isBsonValue(value)) {
        for (const child of Object.values(value)) collectSubmissionPaths(child, output);
    }
    return output;
}

async function collectionFilterForDatabase(db: Db, name: MigrationCollection, domainId: string): Promise<any> {
    if (name === 'storage') {
        const records = await db.collection<any>('record').find({ domainId }).project({ files: 1 }).toArray();
        const submissionPaths = [...collectSubmissionPaths(records.map((record) => record.files))];
        const scoped = { path: { $regex: `^(?:problem|contest)/${escapeRegex(domainId)}(?:/|$)` } };
        return {
            autoDelete: null,
            $or: [scoped, ...(submissionPaths.length ? [{ path: { $in: submissionPaths } }] : [])],
        };
    }
    if (name !== 'record.history') return collectionFilter(name, domainId);
    const records = await db.collection<any>('record').find({ domainId }).project({ _id: 1 }).toArray();
    return { rid: { $in: records.map((record) => record._id) } };
}

async function sourceFingerprint(db: Db, domainId: string, docs: Record<string, any[]>): Promise<string> {
    const summary: any = { domainId, collections: {} };
    for (const name of COLLECTIONS) {
        const values = docs[name] || [];
        summary.collections[name] = {
            count: values.length,
            ids: values.map((value) => EJSON.stringify(value._id ?? value.docId ?? value.path, { relaxed: false })).sort(),
        };
    }
    const server: any = await db.command({ hello: 1 }).catch(() => ({}));
    return hashObject({ summary, server: { version: server.version, setName: server.setName } });
}

function materializedProblemPath(sourceDocId: number | string, kind: MaterializedProblemFileKind, name: string): string {
    return `problem/${EXAM_DOMAIN}/${String(sourceDocId)}/${kind === 'data' ? 'testdata' : kind}/${name}`;
}

function materializedStorageId(runId: string, sourceDocId: number | string, originPath: string, name: string): string {
    const suffix = path.extname(name).replace(/[^a-z0-9.]/gi, '').toLowerCase();
    return `migration/${runId}/materialized/${String(sourceDocId)}/${sha256(originPath).slice(0, 24)}${suffix}`;
}

function materializedStorageEtag(storageId: string): string {
    // Match Hydro's local storage etag shape so normal storage-reference
    // rewriting can map sidecar file descriptors through plan.storage.
    return Buffer.from(`/data/file/hydro/${storageId}`).toString('base64');
}

function materializedFileName(file: any, sourceDocId: number | string, kind: MaterializedProblemFileKind): string {
    const name = String(file?.name || file?._id || '').trim();
    assert(name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'),
        `题目 ${String(sourceDocId)} 的 ${kind} 文件名不安全: ${name}`);
    return name;
}

async function findReferencedProblem(db: Db, reference: ProblemReference & Record<string, any>, sourceDocId: number | string): Promise<any> {
    const domainId = String(reference.domainId || '').trim();
    const pid = reference.pid;
    assert(domainId && pid !== undefined && pid !== null,
        `题目 ${String(sourceDocId)} 的引用缺少 domainId/pid`);
    const candidates = await db.collection<any>('document').find({
        docType: 10,
        domainId,
        $or: [{ docId: pid }, { pid: String(pid) }, { pid }],
    }).limit(2).toArray();
    assert(candidates.length === 1,
        `题目 ${String(sourceDocId)} 的引用 ${domainId}/${String(pid)} ${candidates.length ? '不唯一' : '不存在'}`);
    return candidates[0];
}

/**
 * Resolve an exam wrapper's reference chain. Only chains which ultimately
 * resolve to the prepare domain are materialized; other references continue
 * to be handled by the existing decision logic.
 */
export async function resolveMaterializedProblem(db: Db, wrapper: any): Promise<{
    sourceReference: ProblemReference & Record<string, any>;
    effectiveSource: MaterializedProblemSnapshot['effectiveSource'];
    problem: any;
} | null> {
    if (!wrapper?.reference) return null;
    const sourceDocId = wrapper.docId;
    const sourceReference = wrapper.reference as ProblemReference & Record<string, any>;
    if (sourceReference.domainId !== 'prepare') return null;
    const referenceChain: Array<ProblemReference & Record<string, any>> = [];
    const visited = new Set<string>();
    let current = wrapper;
    while (current?.reference) {
        const reference = current.reference as ProblemReference & Record<string, any>;
        const key = `${String(reference.domainId)}:${String(reference.pid)}`;
        assert(!visited.has(key), `题目 ${String(sourceDocId)} 的题目引用形成循环: ${key}`);
        visited.add(key);
        referenceChain.push(reference);
        current = await findReferencedProblem(db, reference, sourceDocId);
    }
    const effectiveDomainId = String(current?.domainId || '');
    if (!referenceChain.some((reference) => String(reference.domainId) === 'prepare')
        && effectiveDomainId !== 'prepare') return null;
    assert(effectiveDomainId === 'prepare',
        `题目 ${String(sourceDocId)} 的引用链未以 prepare 题目结束: ${effectiveDomainId}`);
    const effectiveDocId = current.docId;
    assert(effectiveDocId !== undefined && effectiveDocId !== null,
        `题目 ${String(sourceDocId)} 的 prepare 引用缺少 docId`);
    return {
        sourceReference,
        effectiveSource: {
            domainId: effectiveDomainId,
            docId: effectiveDocId,
            pid: current.pid ?? effectiveDocId,
            path: `problem/${effectiveDomainId}/${String(effectiveDocId)}`,
            referenceChain,
        },
        problem: current,
    };
}

export async function targetFingerprint(db: Db, domainId = EXAM_DOMAIN): Promise<TargetFingerprint> {
    const collections: Record<string, { count: number; idsHash: string }> = {};
    for (const name of COLLECTIONS) {
        const filter = name === 'user' ? {} : await collectionFilterForDatabase(db, name, domainId);
        const docs = await db.collection<any>(name).find(filter).toArray();
        const ids = docs.map((doc) => stableStringify(doc)).sort();
        collections[name] = { count: docs.length, idsHash: sha256(ids.join('\n')) };
    }
    const users = await db.collection('user').find({}).project({ _id: 1 }).toArray();
    const domain = await db.collection<any>('domain').findOne({ _id: domainId }, { projection: { _id: 1 } });
    const defaultPrivDoc = await db.collection<any>('system').findOne({ _id: 'default.priv' }, { projection: { value: 1 } });
    const defaultUserPriv = Number(defaultPrivDoc?.value ?? DEFAULT_USER_PRIV);
    const referenceProblemsHash = hashObject(await db.collection<any>('document').find({ docType: 10 }).toArray());
    const referenceDomainsHash = hashObject(await db.collection<any>('domain').find({}).toArray());
    return {
        hash: hashObject({
            collections,
            maxUid: Math.max(0, ...users.map((user) => Number(user._id) || 0)),
            defaultUserPriv,
            referenceProblemsHash,
            referenceDomainsHash,
            examDomainExists: !!domain,
        }),
        collections,
        maxUid: Math.max(0, ...users.map((user) => Number(user._id) || 0)),
        defaultUserPriv,
        referenceProblemsHash,
        referenceDomainsHash,
        examDomainExists: !!domain,
    };
}

export async function exportExamPackage(options: CommandOptions = {}): Promise<MigrationManifest> {
    assert(options.sourceUri, 'export 需要 --source-uri 或 HYDRO_EXAM_SOURCE_URI');
    const domainId = (options.domainId || EXAM_DOMAIN).toLowerCase();
    const runDir = path.resolve(options.runDir || path.join(RUNS_DIRECTORY, createRunId()));
    try {
        const existing = await fsp.readdir(runDir);
        if (existing.length) throw new Error(`迁移运行目录已存在且非空: ${runDir}`);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    await ensurePrivateDirectory(runDir);
    await ensurePrivateDirectory(path.join(runDir, 'collections'));
    await ensurePrivateDirectory(path.join(runDir, 'files'));
    const sourceDatabase = databaseName(options.sourceUri, options.sourceDatabase) || 'hydro';
    await writeAudit(runDir, 'export.start', { domainId, sourceDatabase });

    const client = await MongoClient.connect(options.sourceUri);
    try {
        const db = client.db(sourceDatabase);
        const domain = await db.collection<any>('domain').findOne({ _id: domainId });
        assert(domain, `源数据库没有 ${domainId} 域`);
        const selected: Record<string, any[]> = {};
        for (const name of COLLECTIONS) {
            selected[name] = await getAll(db, name, await collectionFilterForDatabase(db, name, domainId));
        }

        const uidSet = new Set<number>();
        for (const collectionName of COLLECTIONS.filter((item) => item !== 'user' && item !== 'storage')) {
            for (const doc of selected[collectionName]) collectUidValues(doc).forEach((uid) => uidSet.add(uid));
        }
        for (const sourcePath of collectSubmissionPaths(selected.record?.map((record) => record.files))) {
            const match = sourcePath.match(/^submission\/(-?\d+)(?:\/|$)/);
            if (match) uidSet.add(Number(match[1]));
        }
        uidSet.add(Number(domain.owner));
        const allUsers = await db.collection<any>('user').find({ _id: { $in: [...uidSet] } }).toArray();
        selected.user = allUsers.map((user) => scrubExportDocument('user', user));

        const allStorage = await db.collection('storage').find({}).toArray();
        const files: FileEntry[] = [];
        const excludedFiles: MigrationManifest['excludedFiles'] = [];
        const excludedPaths = new Set<string>();
        const addExcludedFile = (entry: MigrationManifest['excludedFiles'][number]) => {
            if (excludedPaths.has(entry.sourcePath)) return;
            excludedPaths.add(entry.sourcePath);
            excludedFiles.push(entry);
        };
        const storageByPath = new Map<string, any>();
        const selectedStoragePaths = new Set((selected.storage || []).map((storage) => String(storage.path || '')));
        const fileHashes = new Map<string, string>();
        for (const storage of allStorage) {
            if (storage.autoDelete) continue;
            const sourcePath = String(storage.path || '');
            storageByPath.set(sourcePath, storage);
            const inDomainScope = sourceStoragePathIsScoped(sourcePath, domainId)
                || selectedStoragePaths.has(sourcePath);
            if (!inDomainScope) {
                if (sourceStoragePathIsPersonal(sourcePath, domainId)) {
                    const bytes = await readStorageBytes(storage, options.sourceStorageRoot);
                    addExcludedFile({
                        sourcePath,
                        reason: bytes ? 'personal-user-file-excluded' : 'personal-user-file-missing',
                        ...(bytes ? {} : { missing: true }),
                    });
                }
                continue;
            }
            const required = /^(?:problem|contest|submission)\//.test(sourcePath);
            const bytes = await readStorageBytes(storage, options.sourceStorageRoot);
            const base: FileEntry = {
                sourceStorageId: String(storage._id),
                sourcePath,
                targetPath: sourcePath,
                size: bytes?.length ?? storage.size,
                required,
                included: !!bytes,
                missing: !bytes,
            };
            if (!bytes) {
                if (required) addExcludedFile({ sourcePath, reason: 'required-file-missing', missing: true });
                else addExcludedFile({ sourcePath, reason: 'file-missing', missing: true });
                files.push(base);
                continue;
            }
            const digest = sha256(bytes);
            base.sha256 = digest;
            if (!fileHashes.has(digest)) {
                const packagePath = `files/${digest}`;
                await writePrivateFile(path.join(runDir, packagePath), bytes);
                fileHashes.set(digest, packagePath);
            }
            base.packagePath = fileHashes.get(digest);
            files.push(base);
        }

        // User file declarations live on the user document, while their
        // storage metadata may be absent. Record both present-but-excluded and
        // missing declarations, then clear them when creating new users.
        for (const user of selected.user) {
            for (const file of Array.isArray(user._files) ? user._files : []) {
                const name = String(file?.name || file?._id || '');
                if (!name || name.includes('/') || name.includes('\\')) continue;
                const sourcePath = `user/${user._id}/${name}`;
                if (excludedPaths.has(sourcePath)) continue;
                const storage = storageByPath.get(sourcePath);
                const bytes = storage && await readStorageBytes(storage, options.sourceStorageRoot);
                addExcludedFile({
                    sourcePath,
                    reason: bytes ? 'personal-user-file-excluded' : 'personal-user-file-missing',
                    ...(bytes ? {} : { missing: true }),
                });
            }
        }
        const storageEntryPaths = new Set(files.map((file) => file.sourcePath));
        for (const sourcePath of collectSubmissionPaths(selected.record?.map((record) => record.files))) {
            if (!storageEntryPaths.has(sourcePath)) {
                addExcludedFile({ sourcePath, reason: 'required-file-missing', missing: true });
            }
        }

        // Exam problem documents frequently only contain a reference to a
        // prepare problem. Keep the exam document snapshot unchanged, but
        // materialize the ultimate prepare config/files in a separate,
        // immutable sidecar. Every wrapper receives its own logical storage
        // path and synthetic storage identity so the apply phase can safely
        // turn it into an exam-owned entity.
        const materializedProblems: MaterializedProblemSnapshot[] = [];
        const materializedStorageIds = new Set<string>();
        const materializedEtags = new Set<string>();
        const examProblems = (selected.document || []).filter((doc) => doc.docType === 10 && doc.domainId === domainId);
        for (const wrapper of examProblems) {
            const resolved = await resolveMaterializedProblem(db, wrapper);
            if (!resolved) continue;
            const sourceDocId = wrapper.docId as number | string;
            const effective = resolved.effectiveSource;
            assert(wrapper.owner !== undefined && wrapper.owner !== null,
                `题目 ${String(sourceDocId)} 缺少 owner，无法克隆存储元数据`);
            const clonedFiles: MaterializedProblemClonedFile[] = [];
            const clonedData: any[] = [];
            const clonedAdditionalFiles: any[] = [];
            const fileKinds: Array<[MaterializedProblemFileKind, any[]]> = [
                ['data', clonedData], ['additional_file', clonedAdditionalFiles],
            ];
            for (const [kind, output] of fileKinds) {
                const sourceFiles = Array.isArray(resolved.problem[kind]) ? resolved.problem[kind] : [];
                for (const sourceFile of sourceFiles) {
                    const name = materializedFileName(sourceFile, sourceDocId, kind);
                    const folder = kind === 'data' ? 'testdata' : kind;
                    const originCandidates = [
                        `problem/${effective.domainId}/${String(effective.docId)}/${folder}/${name}`,
                        ...(String(effective.pid) !== String(effective.docId)
                            ? [`problem/${effective.domainId}/${String(effective.pid)}/${folder}/${name}`] : []),
                    ];
                    const originPath = originCandidates.find((candidate) => storageByPath.has(candidate));
                    assert(originPath, `题目 ${String(sourceDocId)} 的 prepare 文件元数据不存在: ${originCandidates[0]}`);
                    const originStorage = storageByPath.get(originPath)!;
                    const originStorageId = String(originStorage._id || '');
                    assert(originStorageId, `题目 ${String(sourceDocId)} 的 prepare 文件缺少 storage._id: ${originPath}`);
                    const bytes = await readStorageBytes(originStorage, options.sourceStorageRoot);
                    assert(bytes, `题目 ${String(sourceDocId)} 的 prepare 文件实体不存在: ${originPath}`);
                    if (originStorage.size !== undefined && originStorage.size !== null
                        && Number(originStorage.size) !== bytes.length) {
                        throw new Error(`题目 ${String(sourceDocId)} 的 prepare 文件大小不一致: ${originPath}`);
                    }
                    if (sourceFile.size !== undefined && sourceFile.size !== null
                        && Number(sourceFile.size) !== bytes.length) {
                        throw new Error(`题目 ${String(sourceDocId)} 的 prepare 文件描述大小不一致: ${originPath}`);
                    }
                    const logicalPath = materializedProblemPath(sourceDocId, kind, name);
                    assert(!files.some((file) => file.sourcePath === logicalPath),
                        `迁移包存储路径重复: ${logicalPath}`);
                    const syntheticId = materializedStorageId(path.basename(runDir), sourceDocId, originPath, name);
                    const syntheticEtag = materializedStorageEtag(syntheticId);
                    assert(!materializedStorageIds.has(syntheticId), `合成 storage ID 重复: ${syntheticId}`);
                    assert(!materializedEtags.has(syntheticEtag), `合成 etag 重复: ${logicalPath}`);
                    materializedStorageIds.add(syntheticId);
                    materializedEtags.add(syntheticEtag);
                    const digest = sha256(bytes);
                    if (!fileHashes.has(digest)) {
                        const packagePath = `files/${digest}`;
                        await writePrivateFile(path.join(runDir, packagePath), bytes);
                        fileHashes.set(digest, packagePath);
                    }
                    const file: FileEntry = {
                        sourceStorageId: syntheticId,
                        sourcePath: logicalPath,
                        targetPath: logicalPath,
                        packagePath: fileHashes.get(digest),
                        size: bytes.length,
                        sha256: digest,
                        required: true,
                        included: true,
                    };
                    const storage = {
                        ...originStorage,
                        _id: syntheticId,
                        path: logicalPath,
                        size: bytes.length,
                        etag: syntheticEtag,
                        owner: wrapper.owner,
                    };
                    if (originStorage.meta && typeof originStorage.meta === 'object') storage.meta = { ...originStorage.meta };
                    delete storage.link;
                    delete storage.autoDelete;
                    delete storage.lastUsage;
                    delete storage.operator;
                    clonedFiles.push({
                        kind,
                        name,
                        originPath,
                        originStorageId,
                        storage,
                        file,
                    });
                    output.push({
                        ...sourceFile,
                        _id: name,
                        name,
                        size: bytes.length,
                        etag: syntheticEtag,
                        ...(storage.lastModified ? { lastModified: storage.lastModified } : {}),
                    });
                    files.push(file);
                }
            }
            materializedProblems.push({
                sourceDocId,
                ...(wrapper.pid !== undefined ? { sourcePid: wrapper.pid } : {}),
                sourceReference: resolved.sourceReference,
                effectiveSource: effective,
                config: resolved.problem.config ?? null,
                data: clonedData,
                additional_file: clonedAdditionalFiles,
                clonedFiles,
            });
        }
        const materializedProblemsFile = materializedProblems.length
            ? 'collections/materialized-problems.jsonl' : undefined;
        const materializedProblemsManifest = materializedProblemsFile
            ? { file: materializedProblemsFile, count: materializedProblems.length,
                ...(await writeJsonLines(path.join(runDir, materializedProblemsFile), materializedProblems)) }
            : undefined;
        const selectedFingerprint = await sourceFingerprint(db, domainId, selected);
        const sourceFingerprintValue = hashObject({
            selected: selectedFingerprint,
            materializedProblems: materializedProblems.map((problem) => ({
                sourceDocId: problem.sourceDocId,
                sourceReference: problem.sourceReference,
                effectiveSource: problem.effectiveSource,
                config: problem.config,
                data: problem.data,
                additional_file: problem.additional_file,
                clonedFiles: problem.clonedFiles.map((file) => ({
                    kind: file.kind,
                    name: file.name,
                    originPath: file.originPath,
                    originStorageId: file.originStorageId,
                    storage: file.storage,
                    file: file.file,
                })),
            })),
        });

        const collections: CollectionManifest[] = [];
        for (const name of COLLECTIONS) {
            const docs = (selected[name] || []).map((doc) => scrubExportDocument(name, doc));
            docs.sort((a, b) => stableStringify(a._id ?? a.docId ?? a.path).localeCompare(stableStringify(b._id ?? b.docId ?? b.path)));
            const file = `collections/${COLLECTION_FILE_NAMES[name]}`;
            const digest = await writeJsonLines(path.join(runDir, file), docs);
            collections.push({ name, file, count: docs.length, ...digest });
        }
        const manifest: MigrationManifest = {
            schemaVersion: MIGRATION_SCHEMA_VERSION,
            kind: 'hydro.exam-migration',
            runId: path.basename(runDir),
            domainId,
            createdAt: new Date().toISOString(),
            sourceFingerprint: sourceFingerprintValue,
            sourceDatabase,
            collections,
            files,
            ...(materializedProblemsManifest ? { materializedProblems: materializedProblemsManifest } : {}),
            excludedFiles,
            counts: Object.fromEntries(collections.map((item) => [item.name, item.count])),
        };
        await writeJson(path.join(runDir, 'manifest.json'), manifest);
        manifest.packageHash = await hashPackageDirectory(runDir);
        await writeJson(path.join(runDir, 'manifest.json'), manifest);
        await writePrivateFile(path.join(runDir, 'package.sha256'), `${manifest.packageHash}\n`);
        await writeAudit(runDir, 'export.complete', {
            runId: manifest.runId,
            packageHash: manifest.packageHash,
            counts: manifest.counts,
            includedFiles: files.filter((file) => file.included).length,
            excludedFiles: excludedFiles.length,
            materializedProblems: materializedProblems.map((problem) => ({
                sourceDocId: problem.sourceDocId,
                originPath: problem.effectiveSource.path,
                originFiles: problem.clonedFiles.map((file) => file.originPath),
                fileCount: problem.clonedFiles.length,
            })),
        });
        return manifest;
    } finally {
        await client.close();
    }
}

export async function loadManifest(runDir: string): Promise<MigrationManifest> {
    const manifest = await readJson<MigrationManifest>(path.join(runDir, 'manifest.json'));
    assert(manifest.schemaVersion === MIGRATION_SCHEMA_VERSION, `不支持的迁移包版本: ${manifest.schemaVersion}`);
    assert(manifest.kind === 'hydro.exam-migration', '不是 exam 迁移包');
    const safePackageRelative = (value: string, prefix: string) => value.startsWith(prefix)
        && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');
    for (const collection of manifest.collections) {
        assert(safePackageRelative(collection.file, 'collections/'), `不安全的集合文件路径: ${collection.file}`);
    }
    for (const file of manifest.files) {
        if (file.packagePath) assert(safePackageRelative(file.packagePath, 'files/'), `不安全的文件包路径: ${file.packagePath}`);
    }
    if (manifest.materializedProblems) {
        assert(safePackageRelative(manifest.materializedProblems.file, 'collections/'),
            `不安全的题源快照路径: ${manifest.materializedProblems.file}`);
    }
    const packageHash = await hashPackageDirectory(runDir);
    assert(packageHash === manifest.packageHash, `迁移包哈希不匹配: ${packageHash} != ${manifest.packageHash}`);
    for (const collection of manifest.collections) {
        const file = path.join(runDir, collection.file);
        const content = await fsp.readFile(file);
        assert(sha256(content) === collection.sha256, `集合文件哈希不匹配: ${collection.name}`);
    }
    if (manifest.materializedProblems) {
        const content = await fsp.readFile(path.join(runDir, manifest.materializedProblems.file));
        assert(sha256(content) === manifest.materializedProblems.sha256, '题源快照哈希不匹配');
    }
    return manifest;
}

export async function loadPackageCollections(runDir: string, manifest: MigrationManifest) {
    const result: Record<string, any[]> = {};
    for (const collection of manifest.collections) {
        const docs = await readJsonLines(path.join(runDir, collection.file));
        assert(docs.length === collection.count, `集合数量不匹配: ${collection.name}`);
        result[collection.name] = docs;
    }
    return result;
}

export async function loadMaterializedProblems(runDir: string, manifest: MigrationManifest): Promise<MaterializedProblemSnapshot[]> {
    if (!manifest.materializedProblems) return [];
    const snapshots = await readJsonLines(path.join(runDir, manifest.materializedProblems.file)) as MaterializedProblemSnapshot[];
    assert(snapshots.length === manifest.materializedProblems.count, '题源快照数量不匹配');
    const manifestFiles = new Map(manifest.files.map((file) => [file.sourcePath, file]));
    const sourceDocIds = new Set<string>();
    for (const snapshot of snapshots) {
        const sourceDocId = String(snapshot.sourceDocId);
        assert(!sourceDocIds.has(sourceDocId), `题源快照重复: ${sourceDocId}`);
        sourceDocIds.add(sourceDocId);
        for (const cloned of snapshot.clonedFiles) {
            const file = manifestFiles.get(cloned.file.sourcePath);
            assert(file && file.sha256 === cloned.file.sha256
                && file.sourceStorageId === cloned.file.sourceStorageId,
            `题源快照文件清单不一致: ${cloned.file.sourcePath}`);
        }
    }
    return snapshots;
}

function getPlanHashInput(plan: MigrationPlan): Omit<MigrationPlan, 'planHash'> {
    const { planHash: _, ...input } = plan;
    return input;
}

export function computePlanHash(plan: MigrationPlan): string {
    const omitUndefined = (value: any): any => {
        if (Array.isArray(value)) return value.map((item) => item === undefined ? null : omitUndefined(item));
        if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value) || isBsonValue(value)) return value;
        const result: Record<string, any> = {};
        for (const [key, child] of Object.entries(value)) {
            if (child !== undefined) result[key] = omitUndefined(child);
        }
        return result;
    };
    return hashObject(omitUndefined(getPlanHashInput(plan)));
}

function sourceObjectIds(docs: Record<string, any[]>): string[] {
    const ids = new Set<string>();
    const collectNested = (value: any) => {
        if (value instanceof ObjectId || (isBsonValue(value) && value._bsontype === 'ObjectId')) {
            ids.add(value.toHexString());
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) collectNested(item);
        } else if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value) && !isBsonValue(value)) {
            for (const child of Object.values(value)) collectNested(child);
        }
    };
    for (const values of Object.values(docs)) {
        for (const doc of values) {
            // Nested reply, scoreboard, status and history references can all
            // carry ObjectIds. Include them so collision rewrites reach every
            // occurrence, not only the common top-level fields below.
            collectNested(doc);
            const id = getObjectId(doc._id);
            if (id) ids.add(id.toHexString());
            const docId = getObjectId(doc.docId);
            if (docId) ids.add(docId.toHexString());
            if (doc.rid) {
                const rid = getObjectId(doc.rid);
                if (rid) ids.add(rid.toHexString());
            }
            if (doc.hackTarget) {
                const hackTarget = getObjectId(doc.hackTarget);
                if (hackTarget) ids.add(hackTarget.toHexString());
            }
        }
    }
    return [...ids].sort();
}

async function buildObjectIdMap(
    db: Db, docs: Record<string, any[]>, runId: string,
): Promise<ObjectIdMaps> {
    const sourceIds = sourceObjectIds(docs);
    if (!sourceIds.length) return { values: {} };
    const values: Record<string, string> = {};
    const occupied = new Set<string>();
    for (const collection of COLLECTIONS) {
        const existing = await db.collection<any>(collection).find({ _id: { $in: sourceIds.map((id) => new ObjectId(id)) } })
            .project({ _id: 1 }).toArray();
        for (const item of existing) occupied.add(item._id.toHexString());
    }
    // Also reserve untouched source IDs. A generated replacement must not
    // collide with a different source object that will be inserted unchanged.
    const used = new Set([...sourceIds, ...occupied]);
    for (const id of sourceIds) {
        if (id === '0'.repeat(24) || id === '0'.repeat(23) + '1') continue;
        if (!occupied.has(id)) continue;
        let target = deterministicObjectId(`${runId}:objectid:${id}`);
        while (used.has(target.toHexString())) target = deterministicObjectId(`${runId}:objectid:${id}:${target.toHexString()}`);
        values[id] = target.toHexString();
        used.add(target.toHexString());
    }
    // A contest's docId is the identifier used by records and statuses.  It
    // may collide even when the document _id itself does not.
    for (const document of docs.document || []) {
        const docId = getObjectId(document.docId);
        if (!docId || ['0'.repeat(24), '0'.repeat(23) + '1'].includes(docId.toHexString())
            || values[docId.toHexString()]) continue;
        const collision = await db.collection<any>('document').findOne({ docId: docId });
        if (!collision) continue;
        let target = deterministicObjectId(`${runId}:docid:${docId.toHexString()}`);
        while (used.has(target.toHexString())) target = deterministicObjectId(`${runId}:docid:${docId.toHexString()}:${target.toHexString()}`);
        values[docId.toHexString()] = target.toHexString();
        used.add(target.toHexString());
    }
    return { values };
}

function expectedCounts(
    target: TargetFingerprint, inserted: Record<string, number>, identities: IdentityDecision[],
): Record<string, number> {
    const result: Record<string, number> = {};
    for (const name of COLLECTIONS) result[name] = (target.collections[name]?.count || 0) + (inserted[name] || 0);
    result.user = (target.collections.user?.count || 0) + identities.filter((decision) => decision.created).length;
    result['domain.user.system'] = identities.filter((decision) => decision.created).length;
    return result;
}

function normalizeStorageTargetPath(
    sourcePath: string, users: Map<number, number>, objectIds: Map<string, ObjectId>,
): string {
    let result = sourcePath;
    const domainSubmission = result.match(/^(submission\/[^/]+\/)(-?\d+\/)([^/]+)(\/.*)?$/i);
    if (domainSubmission) {
        const uid = Number(domainSubmission[2].slice(0, -1));
        const rid = objectIds.get(domainSubmission[3].toLowerCase());
        result = `${domainSubmission[1]}${users.get(uid) ?? uid}/${rid?.toHexString() || domainSubmission[3]}${domainSubmission[4] || ''}`;
    } else {
        // Hydro's current binary submission layout is submission/<uid>/<id>;
        // the path itself carries no domain, so the UID is the only rewrite.
        const userSubmission = result.match(/^(submission\/)(-?\d+)(\/.*)$/i);
        if (userSubmission) {
            const uid = Number(userSubmission[2]);
            result = `${userSubmission[1]}${users.get(uid) ?? uid}${userSubmission[3]}`;
        }
    }
    const contest = result.match(/^(contest\/exam\/)([\da-f]{24})(\/.*)$/i);
    if (contest) {
        const tid = objectIds.get(contest[2].toLowerCase());
        result = `${contest[1]}${tid?.toHexString() || contest[2]}${contest[3]}`;
    }
    return result;
}

function rewriteSubmissionReferences(
    value: any, users: Map<number, number>, objectIds: Map<string, ObjectId>,
): any {
    if (typeof value === 'string') {
        const hashIndex = value.indexOf('#');
        const pathPart = hashIndex < 0 ? value : value.slice(0, hashIndex);
        const suffix = hashIndex < 0 ? '' : value.slice(hashIndex);
        const sourcePath = pathPart.startsWith('submission/') ? pathPart : `submission/${pathPart}`;
        const targetPath = normalizeStorageTargetPath(sourcePath, users, objectIds);
        return `${targetPath.replace(/^submission\//, '')}${suffix}`;
    }
    if (Array.isArray(value)) return value.map((item) => rewriteSubmissionReferences(item, users, objectIds));
    if (!value || typeof value !== 'object' || value instanceof Date || isBsonValue(value)) return value;
    const output: Record<string, any> = {};
    for (const [key, child] of Object.entries(value)) {
        output[key] = rewriteSubmissionReferences(child, users, objectIds);
    }
    return output;
}

export function planStorage(
    files: FileEntry[], problems: ProblemDecision[], contests: ContestDecision[],
    users: Map<number, number>, objectIds: ObjectIdMaps, runId: string,
): FileEntry[] {
    const referenced = new Map<number, ProblemDecision>(problems.map((problem) => [problem.sourceDocId, problem]));
    const reusedContests = new Set(contests.filter((contest) => contest.action === 'reuse').map((contest) => contest.sourceDocId));
    const objectIdMap = new Map(Object.entries(objectIds.values).map(([source, target]) => [source, new ObjectId(target)]));
    const storageIds = new Set<string>();
    return files.map((source) => {
        const item: FileEntry = {
            ...source,
            targetPath: normalizeStorageTargetPath(source.sourcePath, users, objectIdMap),
        };
        const problemMatch = source.sourcePath.match(/^problem\/exam\/(\d+)\//);
        if (problemMatch) {
            const decision = referenced.get(Number(problemMatch[1]));
            if (decision?.action === 'reuse' || decision?.action === 'reference') {
                item.included = false;
                item.excludedReason = decision.action === 'reuse'
                    ? 'problem-reuse-does-not-copy-testdata' : 'problem-reference-does-not-copy-testdata';
                return item;
            }
            if (decision?.targetDocId !== undefined) {
                item.targetPath = item.targetPath.replace(
                    /^problem\/exam\/\d+(\/)/,
                    `problem/exam/${String(decision.targetDocId)}$1`,
                );
            }
        }
        const contestMatch = source.sourcePath.match(/^contest\/exam\/([\da-f]{24})\//i);
        if (contestMatch && reusedContests.has(contestMatch[1].toLowerCase())) {
            item.included = false;
            item.excludedReason = 'contest-reuse-does-not-copy-files';
            return item;
        }
        let targetStorageId = source.sourceStorageId;
        if (storageIds.has(targetStorageId)) targetStorageId = `migration/${runId}/${sha256(source.sourcePath).slice(0, 24)}`;
        storageIds.add(targetStorageId);
        return { ...item, targetStorageId };
    });
}

export async function analyzeExamPackage(options: CommandOptions = {}): Promise<MigrationPlan> {
    const runDir = path.resolve(options.runDir || options.packageDir || '');
    assert(runDir, 'analyze 需要 --package 或 --run-dir');
    assert(options.targetUri, 'analyze 需要 --target-uri 或 HYDRO_EXAM_TARGET_URI');
    const manifest = await loadManifest(runDir);
    const domainId = (options.domainId || manifest.domainId || EXAM_DOMAIN).toLowerCase();
    assert(domainId === manifest.domainId, `分析域与迁移包不一致: ${domainId} != ${manifest.domainId}`);
    const docs = await loadPackageCollections(runDir, manifest);
    const materializedProblems = await loadMaterializedProblems(runDir, manifest);
    const materializedById = new Map(materializedProblems.map((problem) => [Number(problem.sourceDocId), problem]));
    const client = await MongoClient.connect(options.targetUri);
    try {
        const db = client.db(options.targetDatabase || undefined);
        const target = await targetFingerprint(db, domainId);
        if (options.mergeExisting) assert(target.examDomainExists, `合并模式要求目标已有 ${domainId} 域`);
        else assert(!target.examDomainExists, `目标已存在 ${domainId} 域，拒绝生成应用计划`);
        const defaultUserPriv = target.defaultUserPriv;
        const targetUsers = await db.collection<any>('user').find({}).toArray();
        const sourceUsers = docs.user || [];
        const identities = resolveIdentities(sourceUsers, targetUsers);
        const users = identityMap(identities);
        const targetProblems = await db.collection<any>('document').find({ docType: 10 }).toArray();
        const targetDomains = await db.collection<any>('domain').find({}).toArray();
        const sourceProblems = (docs.document || []).filter((doc) => doc.docType === 10);
        const problems = buildProblemDecisions(sourceProblems, targetProblems, targetDomains, {
            mergeExisting: !!options.mergeExisting, domainId,
        });
        for (const decision of problems.filter((item) => item.action === 'copy')) {
            const source = sourceProblems.find((item) => Number(item.docId) === decision.sourceDocId);
            if (!source?.reference || source.data?.length || source.additional_file?.length) continue;
            const materialized = materializedById.get(decision.sourceDocId);
            assert(materialized && materialized.sourceReference.domainId === source.reference.domainId
                && String(materialized.sourceReference.pid) === String(source.reference.pid)
                && materialized.data.length + materialized.additional_file.length > 0,
            `题目 ${decision.sourcePid} 的引用题源测试数据未打包，拒绝实体化复制`);
        }
        const problemIds = Object.fromEntries(problems.map((decision) => [
            String(decision.sourceDocId), decision.targetDocId ?? decision.sourceDocId,
        ]));
        const targetContests = await db.collection<any>('document').find({ domainId, docType: 30 }).toArray();
        const sourceContests = (docs.document || []).filter((doc) => doc.docType === 30);
        const contests = buildContestDecisions(sourceContests, targetContests, problems, !!options.mergeExisting);
        const sourceDocumentIds = new Set((docs.document || []).map((doc) => `${doc.docType}:${ejsonKey(doc.docId)}`));
        const targetDocumentIds = new Set((await db.collection<any>('document').find({})
            .project({ docType: 1, docId: 1 }).toArray())
            .map((doc) => `${doc.docType}:${ejsonKey(doc.docId)}`));
        const excludedDocuments: ExcludedDocument[] = (docs.document || [])
            .filter((doc) => doc.parentType !== undefined && doc.parentId !== undefined)
            .filter((doc) => !sourceDocumentIds.has(`${doc.parentType}:${ejsonKey(doc.parentId)}`)
                && !targetDocumentIds.has(`${doc.parentType}:${ejsonKey(doc.parentId)}`))
            .map((doc) => ({
                collection: 'document' as const,
                docType: Number(doc.docType),
                docId: ejsonKey(doc.docId),
                reason: 'missing-parent' as const,
            }));
        const excludedDocumentKeys = new Set(excludedDocuments.map((item) => `${item.docType}:${item.docId}`));
        const problemFileDifferences: ProblemFileDifference[] = [];
        for (const decision of problems.filter((item) => item.action === 'reference' || item.action === 'reuse')) {
            const source = sourceProblems.find((item) => Number(item.docId) === decision.sourceDocId);
            const targetProblem = targetProblems.find((item) => item.domainId === decision.targetDomainId
                && String(item.docId) === String(decision.targetDocId ?? decision.targetPid))
            || targetProblems.find((item) => item.domainId === decision.targetDomainId
                && String(item.pid || item.docId) === String(decision.targetPid));
            const sourceFiles = problemFileNames(source);
            const targetFiles = problemFileNames(targetProblem);
            problemFileDifferences.push({
                sourceDocId: decision.sourceDocId,
                targetDomainId: decision.targetDomainId,
                targetPid: decision.targetPid,
                sourceFiles,
                targetFiles,
                missingInTarget: sourceFiles.filter((file) => !targetFiles.includes(file)),
                extraInTarget: targetFiles.filter((file) => !sourceFiles.includes(file)),
            });
        }
        const objectIds = await buildObjectIdMap(db, docs, manifest.runId);
        for (const contest of contests.filter((item) => item.action === 'reuse')) {
            objectIds.values[contest.sourceDocId] = contest.targetObjectId;
        }
        const storage = planStorage(manifest.files, problems, contests, users, objectIds, manifest.runId);
        const storageCandidates = storage.filter((item) => item.included);
        const plannedPaths = new Set<string>();
        for (const item of storageCandidates) {
            if (plannedPaths.has(item.targetPath)) throw new Error(`迁移包内部存储路径重复: ${item.targetPath}`);
            plannedPaths.add(item.targetPath);
        }
        const existingStorage = await db.collection<any>('storage').find({
            $or: [
                { _id: { $in: storageCandidates.map((item) => item.targetStorageId || item.sourceStorageId) } },
                { path: { $in: storageCandidates.map((item) => item.targetPath) } },
            ],
        }).project({ _id: 1, path: 1 }).toArray();
        const existingIds = new Set(existingStorage.map((item) => String(item._id)));
        const existingPaths = new Set(existingStorage.map((item) => String(item.path)));
        const reservedIds = new Set(storageCandidates.map((item) => item.targetStorageId || item.sourceStorageId));
        for (const item of storageCandidates) {
            if (existingPaths.has(item.targetPath)) {
                throw new Error(`目标存储路径已存在，拒绝覆盖: ${item.targetPath}`);
            }
            const currentId = item.targetStorageId || item.sourceStorageId;
            if (!existingIds.has(currentId)) continue;
            let targetId = `migration/${manifest.runId}/${sha256(`${item.sourceStorageId}:${item.sourcePath}`).slice(0, 24)}`;
            while (reservedIds.has(targetId) || existingIds.has(targetId)) targetId = `${targetId}0`;
            item.targetStorageId = targetId;
            reservedIds.add(targetId);
        }

        const targetMembers = await db.collection<any>('domain.user').find({ domainId }).toArray();
        const domainMemberKeys = new Set(targetMembers.map((member) => `${domainId}:${Number(member.uid)}`));
        const plannedDomainMemberKeys = new Set<string>();
        for (const member of docs['domain.user'] || []) {
            const uid = users.get(Number(member.uid)) ?? Number(member.uid);
            const key = `${domainId}:${uid}`;
            if (!domainMemberKeys.has(key)) plannedDomainMemberKeys.add(key);
        }
        const targetGroups = await db.collection<any>('user.group').find({ domainId }).toArray();
        const groupKeys = new Set(targetGroups.map((group) => `${domainId}:${String(group.name || '')}`));
        const plannedGroupKeys = new Set<string>();
        for (const group of docs['user.group'] || []) {
            const key = `${domainId}:${String(group.name || '')}`;
            if (!groupKeys.has(key)) plannedGroupKeys.add(key);
        }

        const statusKey = (status: any) => `${status.docType}:${ejsonKey(status.docId)}:${status.uid}`;
        const targetStatuses = await db.collection<any>('document.status').find({ domainId }).toArray();
        const existingStatusKeys = new Set(targetStatuses.map(statusKey));
        const provisionalPlan = {
            problemIds,
            problems,
            objectIds,
            storage,
            identities,
        } as MigrationPlan;
        const mappedStatuses = (docs['document.status'] || []).map((status) => mapDocumentForApply(
            status, provisionalPlan, domainId, users, objectIdMapFromPlan(provisionalPlan), storageMapFromPlan(provisionalPlan), problemMapFromPlan(provisionalPlan),
        ));
        const plannedStatusKeys = new Set<string>();
        for (const status of mappedStatuses) {
            const key = statusKey(status);
            if (!existingStatusKeys.has(key)) plannedStatusKeys.add(key);
        }

        const materializedStorage = materializedProblems.flatMap((problem) => problem.clonedFiles.map((file) => file.storage));
        const sourceStorage = [...(docs.storage || []), ...materializedStorage].map((doc) => mapStorageDocument(
            doc, provisionalPlan, domainId, users, objectIdMapFromPlan(provisionalPlan), storageMapFromPlan(provisionalPlan),
        )).filter(Boolean);
        const relatedDocuments = (docs.document || []).filter((doc) => doc.docType !== 10)
            .filter((doc) => !excludedDocumentKeys.has(`${doc.docType}:${ejsonKey(doc.docId)}`)).filter((doc) => {
                if (doc.docType !== 30) return true;
                const sourceId = getObjectId(doc._id || doc.docId)?.toHexString();
                return !contests.some((contest) => contest.sourceDocId === sourceId && contest.action === 'reuse');
            });
        const inserted: Record<string, number> = {
            domain: options.mergeExisting ? 0 : (docs.domain || []).length,
            'domain.user': plannedDomainMemberKeys.size,
            'user.group': plannedGroupKeys.size,
            document: problems.filter((problem) => problem.action !== 'reuse').length + relatedDocuments.length,
            storage: sourceStorage.length,
            'discussion.history': (docs['discussion.history'] || []).length,
            'contest.balloon': (docs['contest.balloon'] || []).length,
            record: (docs.record || []).length,
            'record.stat': (docs['record.stat'] || []).length,
            'record.history': (docs['record.history'] || []).length,
            'document.status': plannedStatusKeys.size,
        };
        const plan: MigrationPlan = {
            schemaVersion: MIGRATION_SCHEMA_VERSION,
            kind: 'hydro.exam-migration-plan',
            runId: manifest.runId,
            domainId,
            packageHash: manifest.packageHash,
            sourceFingerprint: manifest.sourceFingerprint,
            targetBefore: target,
            mergeExisting: !!options.mergeExisting,
            identities,
            problems,
            problemIds,
            contests,
            problemFileDifferences,
            objectIds,
            storage,
            defaultUserPriv,
            expectedCounts: expectedCounts(target, {
                ...inserted,
                user: identities.filter((decision) => decision.created).length,
            }, identities),
            excludedFiles: manifest.excludedFiles,
            confirmedDecisions: CONFIRMED_DECISIONS,
            phases: PHASES,
            excludedDocuments,
            mergeKeys: {
                domainMembers: [...plannedDomainMemberKeys].sort(),
                groups: [...plannedGroupKeys].sort(),
                statuses: [...plannedStatusKeys].sort(),
            },
        };
        plan.planHash = computePlanHash(plan);
        await writeJson(path.join(runDir, 'plan.json'), plan);
        await writeAudit(runDir, 'analyze.complete', {
            planHash: plan.planHash,
            packageHash: plan.packageHash,
            targetFingerprint: plan.targetBefore.hash,
            identityMethods: identities.reduce((result, item) => {
                result[item.method] = (result[item.method] || 0) + 1;
                return result;
            }, {} as Record<string, number>),
            problemActions: problems.reduce((result, item) => {
                result[item.action] = (result[item.action] || 0) + 1;
                return result;
            }, {} as Record<string, number>),
            excludedDocuments,
            problemFileDifferences: problemFileDifferences.filter((item) => item.missingInTarget.length || item.extraInTarget.length),
        });
        return plan;
    } finally {
        await client.close();
    }
}

interface AppliedItem {
    collection: string;
    id: string;
    domainId?: string;
    uid?: number;
    path?: string;
}

interface ApplyState {
    schemaVersion: number;
    runId: string;
    packageHash: string;
    planHash: string;
    startedAt: string;
    completedAt?: string;
    dryRun?: boolean;
    phases: Array<{ phase: MigrationPhase; startedAt: string; completedAt?: string; count: number; ok: boolean; error?: string }>;
    inserted: AppliedItem[];
    files: Array<{ path: string; storageId: string; sha256: string }>;
}

function objectIdMapFromPlan(plan: MigrationPlan): Map<string, ObjectId> {
    return new Map(Object.entries(plan.objectIds.values).map(([source, target]) => [source, new ObjectId(target)]));
}

function userMapFromPlan(plan: MigrationPlan): Map<number, number> {
    return identityMap(plan.identities);
}

function problemMapFromPlan(plan: MigrationPlan): Map<string, number | string> {
    return new Map(Object.entries(plan.problemIds || {}));
}

function storageMapFromPlan(plan: MigrationPlan): Map<string, string> {
    return new Map(plan.storage.map((item) => [item.sourceStorageId, item.targetStorageId || item.sourceStorageId]));
}

export function rewriteStorageReference(value: any, storageIds: Map<string, string>): any {
    if (typeof value === 'string') {
        let decoded = value;
        let encoded = false;
        try {
            const candidate = Buffer.from(value, 'base64').toString('utf8');
            if (candidate.startsWith('/data/file/hydro/')) {
                decoded = candidate;
                encoded = true;
            }
        } catch { /* not a base64 etag */ }
        if (decoded.startsWith('/data/file/hydro/')) {
            const sourceId = decoded.slice('/data/file/hydro/'.length);
            const targetId = storageIds.get(sourceId);
            if (targetId) {
                const result = `/data/file/hydro/${targetId}`;
                return encoded ? Buffer.from(result).toString('base64') : result;
            }
        }
        return storageIds.get(value) || value;
    }
    if (Array.isArray(value)) return value.map((item) => rewriteStorageReference(item, storageIds));
    if (!value || typeof value !== 'object' || value instanceof Date || isBsonValue(value)) return value;
    const output: Record<string, any> = {};
    for (const [key, child] of Object.entries(value)) output[key] = rewriteStorageReference(child, storageIds);
    return output;
}

export function rewriteProblemReferences(value: any, problems: Map<string, number | string>, key = ''): any {
    if (Array.isArray(value)) {
        return value.map((item) => key === 'pids' || key === 'pid' ? problems.get(String(item)) ?? item
            : rewriteProblemReferences(item, problems, key));
    }
    if ((key === 'pid' || key === 'pids' || key === 'subject') && (typeof value === 'number' || typeof value === 'string')) {
        return problems.get(String(value)) ?? value;
    }
    if (!value || typeof value !== 'object' || value instanceof Date || isBsonValue(value)) return value;
    const output: Record<string, any> = {};
    for (const [childKey, child] of Object.entries(value)) {
        // Contest status detail/display dictionaries are keyed by PID in
        // addition to carrying the PID again in each value.  Rewrite both
        // representations so the scoreboard can find every migrated result.
        const outputKey = key === 'detail' || key === 'display'
            ? String(problems.get(childKey) ?? childKey) : childKey;
        output[outputKey] = rewriteProblemReferences(child, problems, childKey);
    }
    return output;
}

export function mapDocumentForApply(
    original: any, plan: MigrationPlan, domainId: string,
    users = userMapFromPlan(plan), objectIds = objectIdMapFromPlan(plan),
    storageIds = storageMapFromPlan(plan), problems = problemMapFromPlan(plan), isProblemDocument = false,
): any {
    if (isProblemDocument && original.docType === 10) {
        const decision = plan.problems.find((item) => Number(item.sourceDocId) === Number(original.docId));
        if (decision?.action === 'reuse') return null;
    }
    const doc = rewriteStorageReference(
        rewriteProblemReferences(rewriteObjectIds(rewriteUserIds(original, users), objectIds), problems), storageIds,
    );
    doc.domainId &&= domainId;
    if (doc.docType === 10) {
        const problem = plan.problems.find((item) => Number(item.sourceDocId) === Number(original.docId));
        if (problem?.targetDocId !== undefined) {
            doc.docId = problem.targetDocId;
            if (typeof doc.sort === 'string' && /^P\d+$/i.test(doc.sort)) {
                doc.sort = `P${String(problem.targetDocId).padStart(6, '0')}`;
            }
        }
    }
    if (doc.files && doc.pid !== undefined && doc.uid !== undefined) {
        doc.files = rewriteSubmissionReferences(doc.files, users, objectIds);
    }
    if (isProblemDocument && doc.docType === 10) {
        const problem = plan.problems.find((item) => Number(item.sourceDocId) === Number(original.docId));
        if (problem?.action === 'reference') {
            doc.reference = {
                domainId: problem.targetDomainId,
                pid: problem.targetPid,
                sourceUpdateAt: original.updateAt,
                lastSyncAt: new Date(),
            };
            // A lightweight reference must never carry a second testdata set.
            doc.data = [];
            doc.additional_file = [];
        } else {
            // Entity materialisation must not retain a source-domain alias,
            // including the forbidden prepare/test references.
            delete doc.reference;
        }
    }
    if (doc.parentType === 10) {
        doc.parentId = problems.get(String(original.parentId)) ?? doc.parentId;
    }
    return doc;
}

function mapStorageDocument(
    original: any, plan: MigrationPlan, domainId: string,
    users = userMapFromPlan(plan), objectIds = objectIdMapFromPlan(plan),
    storageIds = storageMapFromPlan(plan),
): any {
    const entry = plan.storage.find((item) => item.sourceStorageId === String(original._id)
        && item.sourcePath === String(original.path));
    if (!entry || !entry.included) return null;
    const result = rewriteStorageReference(rewriteObjectIds(rewriteUserIds(original, users), objectIds), storageIds);
    if (typeof result.link === 'string') result.link = storageIds.get(result.link) || result.link;
    result.domainId = domainId;
    result.path = entry.targetPath;
    result._id = entry.targetStorageId || result._id;
    delete result.autoDelete;
    return result;
}

function mapNewUser(original: any, decision: IdentityDecision, defaultUserPriv: number): any {
    const user = {
        ...original,
        _id: decision.targetUid,
        uname: decision.targetUname || `${original.uname || `user_${decision.sourceUid}`}_exam`,
        mail: decision.targetMail,
        mailLower: decision.targetMail,
    };
    delete user.domains;
    delete user.pinnedDomains;
    delete user.perm;
    delete user.role;
    // Private user files are outside this migration scope. Do not leave
    // declarations pointing at source UID paths that were not copied.
    user._files = [];
    user.unameLower = normalizeUsername(user.uname);
    if (typeof user.avatar === 'string' && user.avatar.startsWith(`url:/file/${original._id}/`)) {
        user.avatar = `gravatar:${user.mail}`;
    }
    user.priv = defaultUserPriv;
    return user;
}

async function insertDocuments(
    db: Db, collectionName: string, docs: any[], state: ApplyState, _domainId?: string,
): Promise<number> {
    docs = docs.filter(Boolean);
    if (!docs.length) return 0;
    const collection = db.collection<any>(collectionName);
    let inserted = 0;
    // Record each successful insert before attempting the next one. A bulk
    // insert can partially succeed before throwing, which would otherwise
    // leave those documents absent from the rollback manifest.
    for (const doc of docs) {
        await collection.insertOne(doc);
        inserted++;
        state.inserted.push({
            collection: collectionName,
            id: EJSON.stringify(doc._id, { relaxed: false }),
            domainId: doc.domainId,
            uid: doc.uid,
            path: doc.path,
        });
    }
    return inserted;
}

function statusNaturalKey(status: any): string {
    return `${status.docType}:${ejsonKey(status.docId)}:${status.uid}`;
}

async function runPhase(
    runDir: string, state: ApplyState, phase: MigrationPhase, callback: () => Promise<number>,
) {
    const phaseState = { phase, startedAt: new Date().toISOString(), count: 0, ok: false } as ApplyState['phases'][number];
    state.phases.push(phaseState);
    await writeJson(path.join(runDir, 'apply.json'), state);
    try {
        phaseState.count = await callback();
        phaseState.ok = true;
        phaseState.completedAt = new Date().toISOString();
        await writeAudit(runDir, `apply.${phase}.complete`, { count: phaseState.count });
        await writeJson(path.join(runDir, 'apply.json'), state);
    } catch (error) {
        phaseState.error = error instanceof Error ? error.message : String(error);
        await writeAudit(runDir, `apply.${phase}.failed`, { error: phaseState.error });
        await writeJson(path.join(runDir, 'apply.json'), state);
        throw error;
    }
}

async function runCommand(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = childProcess.spawn(command, args, { stdio: 'inherit' });
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

export async function checkConfirmedP105Files(
    db: Db, storageRoot: string | undefined, plan: MigrationPlan,
    materializedProblems: MaterializedProblemSnapshot[],
): Promise<{ checked: number; errors: string[] }> {
    const decision = plan.problems.find((item) => item.sourceDocId === 105 && item.reason === 'confirmed-reuse');
    if (!decision) return { checked: 0, errors: [] };
    const errors: string[] = [];
    const snapshot = materializedProblems.find((item) => Number(item.sourceDocId) === 105);
    if (!snapshot || !storageRoot) return { checked: 0, errors: ['P105 复用缺少源题文件快照或目标存储根目录'] };
    if (snapshot.effectiveSource.domainId !== 'prepare' || String(snapshot.effectiveSource.docId) !== '88') {
        return { checked: 0, errors: ['P105 源题不再指向 prepare/88'] };
    }
    const reference = CONFIRMED_DECISIONS.problemReuses.P105.reference;
    const entity = await db.collection<any>('document').findOne({
        domainId: reference.domainId, docType: 10, docId: reference.pid,
    });
    const expected = snapshot.clonedFiles.filter((item) => item.kind === 'data');
    const expectedNames = expected.map((item) => item.name).sort();
    const actualNames = (entity?.data || []).map((item) => String(item.name)).sort();
    const expectedAdditionalNames = snapshot.clonedFiles.filter((item) => item.kind === 'additional_file')
        .map((item) => item.name).sort();
    const actualAdditionalNames = (entity?.additional_file || []).map((item) => String(item.name)).sort();
    if (!entity || entity.reference || expected.length !== 40
        || stableStringify(expectedNames) !== stableStringify(actualNames)
        || stableStringify(expectedAdditionalNames) !== stableStringify(actualAdditionalNames)) {
        return { checked: 0, errors: ['P105 源 prepare/88 与目标 contests/3230 测试文件清单不一致'] };
    }
    let checked = 0;
    for (const file of snapshot.clonedFiles) {
        const folder = file.kind === 'data' ? 'testdata' : 'additional_file';
        const targetPath = `problem/${reference.domainId}/${reference.pid}/${folder}/${file.name}`;
        const metadata = await db.collection<any>('storage').findOne({ path: targetPath, autoDelete: null });
        if (!metadata) {
            errors.push(`P105 目标存储元数据不存在: ${targetPath}`);
            continue;
        }
        try {
            const bytes = await fsp.readFile(safeRelativePath(storageRoot, String(metadata._id)));
            checked++;
            if (sha256(bytes) !== file.file.sha256) errors.push(`P105 文件 SHA-256 不一致: ${targetPath}`);
        } catch {
            errors.push(`P105 目标物理文件不存在: ${targetPath}`);
        }
    }
    return { checked, errors };
}

async function verifyApplyPreconditions(
    db: Db, runDir: string, plan: MigrationPlan, options: ApplyOptions,
): Promise<MigrationManifest> {
    const manifest = await loadManifest(runDir);
    const materializedProblems = await loadMaterializedProblems(runDir, manifest);
    assert(manifest.domainId === plan.domainId, '计划和迁移包域不一致');
    assert(manifest.packageHash === plan.packageHash, '计划和迁移包哈希不一致');
    assert(computePlanHash(plan) === plan.planHash, 'plan.json 自身哈希不一致');
    const current = await targetFingerprint(db, plan.domainId);
    assert(current.hash === plan.targetBefore.hash, '目标状态已变化，拒绝应用计划');
    if (plan.mergeExisting) assert(current.examDomainExists, `合并计划要求目标已有 ${plan.domainId} 域`);
    else assert(!current.examDomainExists, `目标已存在 ${plan.domainId} 域，拒绝覆盖`);
    const marker = await db.collection<any>('exam.migration').findOne({ _id: plan.runId });
    assert(!marker, `迁移 ${plan.runId} 已经执行或正在执行`);
    const required = plan.storage.filter((file) => file.included && file.required);
    const missingRequired = plan.storage.filter((file) => !file.included && file.required
        && !['problem-reference-does-not-copy-testdata', 'problem-reuse-does-not-copy-testdata', 'contest-reuse-does-not-copy-files'].includes(file.excludedReason || ''));
    const missingRequiredExcluded = manifest.excludedFiles.filter((file) => file.reason === 'required-file-missing' && file.missing);
    if (missingRequired.length || missingRequiredExcluded.length) {
        throw new Error(`迁移包缺少必需文件: ${[...missingRequired.map((file) => file.sourcePath), ...missingRequiredExcluded.map((file) => file.sourcePath)].join(', ')}`);
    }
    if (required.length && !options.targetStorageRoot) {
        throw new Error('迁移包含文件，apply 必须提供 --target-storage-root');
    }
    if (options.targetStorageRoot) {
        for (const file of plan.storage.filter((item) => item.included)) {
            const target = safeRelativePath(options.targetStorageRoot, file.targetStorageId || file.sourceStorageId);
            if (fs.existsSync(target)) throw new Error(`禁止覆盖既有物理文件: ${target}`);
            if (file.packagePath) {
                const bytes = await fsp.readFile(path.join(runDir, file.packagePath));
                assert(sha256(bytes) === file.sha256, `文件包哈希不匹配: ${file.sourcePath}`);
            }
        }
    }
    const p105Files = await checkConfirmedP105Files(db, options.targetStorageRoot, plan, materializedProblems);
    assert(!p105Files.errors.length, p105Files.errors.join('; '));
    return manifest;
}

export async function applyExamPackage(options: ApplyOptions = {}): Promise<ApplyState> {
    const runDir = path.resolve(options.runDir || options.packageDir || '');
    assert(runDir, 'apply 需要 --package 或 --run-dir');
    assert(options.targetUri, 'apply 需要 --target-uri 或 HYDRO_EXAM_TARGET_URI');
    assert(options.planHash, 'apply 必须携带经确认的 --plan-hash');
    const plan = await readJson<MigrationPlan>(path.join(runDir, 'plan.json'));
    assert(plan.schemaVersion === MIGRATION_SCHEMA_VERSION && plan.kind === 'hydro.exam-migration-plan', '不是有效的 exam 迁移计划');
    assert(plan.planHash === options.planHash, `计划哈希不匹配: ${options.planHash}`);
    const manifest = await loadManifest(runDir);
    const docs = await loadPackageCollections(runDir, manifest);
    const materializedProblems = await loadMaterializedProblems(runDir, manifest);
    const materializedById = new Map(materializedProblems.map((problem) => [Number(problem.sourceDocId), problem]));
    const client = await MongoClient.connect(options.targetUri);
    let stopped = false;
    let completed = false;
    const state: ApplyState = {
        schemaVersion: MIGRATION_SCHEMA_VERSION,
        runId: plan.runId,
        packageHash: plan.packageHash,
        planHash: plan.planHash,
        startedAt: new Date().toISOString(),
        phases: [],
        inserted: [],
        files: [],
    };
    try {
        const db = client.db(options.targetDatabase || undefined);
        await verifyApplyPreconditions(db, runDir, plan, options);
        if (options.dryRun) {
            state.dryRun = true;
            state.completedAt = new Date().toISOString();
            await writeJson(path.join(runDir, 'apply.json'), state);
            await writeAudit(runDir, 'apply.dry-run', { planHash: plan.planHash });
            return state;
        }
        await writeJson(path.join(runDir, 'apply.json'), state);
        const stop = options.stopService || (options.serviceControl === 'none' || options.noStop ? null : defaultStopService);
        if (stop) {
            await stop();
            stopped = true;
            await writeAudit(runDir, 'apply.service.stopped', { service: 'hydrooj' });
        }
        const backupDir = path.join(runDir, 'backup');
        if (options.backup !== false && !options.noBackup) {
            await ensurePrivateDirectory(backupDir);
            const dump = options.mongoDump || ((args: string[]) => defaultMongoDump(
                options.targetUri!, databaseName(options.targetUri, options.targetDatabase) || 'hydro', args[0],
            ));
            await dump([backupDir]);
            await writeAudit(runDir, 'apply.backup.complete', { backupDir });
        }

        await db.collection<any>('exam.migration').insertOne({
            _id: plan.runId,
            runId: plan.runId,
            packageHash: plan.packageHash,
            planHash: plan.planHash,
            startedAt: new Date(),
            status: 'running',
        });
        const users = userMapFromPlan(plan);
        const objectIds = objectIdMapFromPlan(plan);
        const storageIds = new Map(plan.storage.map((item) => [
            item.sourceStorageId, item.targetStorageId || item.sourceStorageId,
        ]));

        const newUserDocs = (docs.user || []).flatMap((user) => {
            const decision = plan.identities.find((item) => item.sourceUid === Number(user._id));
            return decision?.created ? [mapNewUser(user, decision, plan.defaultUserPriv)] : [];
        });
        const systemMembers = [];
        for (const decision of plan.identities.filter((item) => item.created)) {
            const existing = await db.collection<any>('domain.user').findOne({ domainId: 'system', uid: decision.targetUid });
            if (!existing) systemMembers.push({ domainId: 'system', uid: decision.targetUid, join: true, role: 'default' });
        }
        await runPhase(runDir, state, 'users', async () => {
            return await insertDocuments(db, 'user', newUserDocs, state)
                + await insertDocuments(db, 'domain.user', systemMembers, state, 'system');
        });

        const domainDoc = plan.mergeExisting ? [] : (docs.domain || []).map((doc) => mapDocumentForApply(doc, plan, plan.domainId, users, objectIds));
        const domainMemberKeys = new Set(plan.mergeKeys?.domainMembers || []);
        const seenDomainMemberKeys = new Set<string>();
        const domainUsers = (docs['domain.user'] || []).map((doc) => mapDocumentForApply(doc, plan, plan.domainId, users, objectIds))
            .filter((doc) => {
                const key = `${plan.domainId}:${doc.uid}`;
                if (seenDomainMemberKeys.has(key)) return false;
                seenDomainMemberKeys.add(key);
                return domainMemberKeys.has(key);
            });
        const groupKeys = new Set(plan.mergeKeys?.groups || []);
        const seenGroupKeys = new Set<string>();
        const groups = (docs['user.group'] || []).map((doc) => mapDocumentForApply(doc, plan, plan.domainId, users, objectIds))
            .filter((doc) => {
                const key = `${plan.domainId}:${doc.name || ''}`;
                if (seenGroupKeys.has(key)) return false;
                seenGroupKeys.add(key);
                return groupKeys.has(key);
            });
        await runPhase(runDir, state, 'domain', async () => {
            return await insertDocuments(db, 'domain', domainDoc, state)
                + await insertDocuments(db, 'domain.user', domainUsers, state, plan.domainId)
                + await insertDocuments(db, 'user.group', groups, state, plan.domainId);
        });

        const problemDocuments = (docs.document || []).filter((doc) => doc.docType === 10)
            .map((doc) => {
                const decision = plan.problems.find((item) => item.sourceDocId === Number(doc.docId));
                const materialized = decision?.action === 'copy' ? materializedById.get(Number(doc.docId)) : undefined;
                const source = materialized ? {
                    ...doc,
                    config: materialized.config,
                    data: materialized.data,
                    additional_file: materialized.additional_file,
                } : doc;
                return mapDocumentForApply(source, plan, plan.domainId, users, objectIds, storageIds, problemMapFromPlan(plan), true);
            });
        await runPhase(runDir, state, 'problems', async () => insertDocuments(db, 'document', problemDocuments, state, plan.domainId));

        const materializedStorage = materializedProblems.flatMap((problem) => problem.clonedFiles.map((file) => file.storage));
        const sourceStorage = [...(docs.storage || []), ...materializedStorage]
            .map((doc) => mapStorageDocument(doc, plan, plan.domainId, users, objectIds, storageIds)).filter(Boolean);
        await runPhase(runDir, state, 'storage', async () => {
            let count = 0;
            for (const file of plan.storage.filter((item) => item.included && item.packagePath)) {
                const targetId = file.targetStorageId || file.sourceStorageId;
                const destination = safeRelativePath(options.targetStorageRoot!, targetId);
                await ensurePrivateDirectory(path.dirname(destination));
                await fsp.copyFile(path.join(runDir, file.packagePath!), destination, fs.constants.COPYFILE_EXCL);
                state.files.push({ path: file.targetPath, storageId: targetId, sha256: file.sha256! });
            }
            count += await insertDocuments(db, 'storage', sourceStorage, state, plan.domainId);
            return count;
        });

        const reusedContestIds = new Set(plan.contests.filter((contest) => contest.action === 'reuse').map((contest) => contest.sourceDocId));
        const excludedDocumentKeys = new Set((plan.excludedDocuments || [])
            .map((item) => `${item.docType}:${item.docId}`));
        const relatedDocuments = (docs.document || []).filter((doc) => doc.docType !== 10)
            .filter((doc) => !excludedDocumentKeys.has(`${doc.docType}:${ejsonKey(doc.docId)}`))
            .filter((doc) => doc.docType !== 30 || !reusedContestIds.has(getObjectId(doc._id || doc.docId)?.toHexString() || ''))
            .map((doc) => mapDocumentForApply(doc, plan, plan.domainId, users, objectIds, storageIds, problemMapFromPlan(plan)));
        const discussions = (docs['discussion.history'] || []).map((doc) => mapDocumentForApply(doc, plan, plan.domainId, users, objectIds));
        const balloons = (docs['contest.balloon'] || []).map((doc) => mapDocumentForApply(doc, plan, plan.domainId, users, objectIds));
        await runPhase(runDir, state, 'related-documents', async () => {
            return await insertDocuments(db, 'document', relatedDocuments, state, plan.domainId)
                + await insertDocuments(db, 'discussion.history', discussions, state, plan.domainId)
                + await insertDocuments(db, 'contest.balloon', balloons, state, plan.domainId);
        });

        const records = (docs.record || []).map((doc) => mapDocumentForApply(doc, plan, plan.domainId, users, objectIds));
        const recordStats = (docs['record.stat'] || []).map((doc) => mapDocumentForApply(doc, plan, plan.domainId, users, objectIds));
        const recordHistory = (docs['record.history'] || []).map((doc) => mapDocumentForApply(doc, plan, plan.domainId, users, objectIds));
        await runPhase(runDir, state, 'records', async () => {
            return await insertDocuments(db, 'record', records, state, plan.domainId)
                + await insertDocuments(db, 'record.stat', recordStats, state, plan.domainId)
                + await insertDocuments(db, 'record.history', recordHistory, state, plan.domainId);
        });

        const plannedStatusKeys = new Set(plan.mergeKeys?.statuses || []);
        const seenStatusKeys = new Set<string>();
        const statuses = (docs['document.status'] || []).map((doc) => mapDocumentForApply(
            doc, plan, plan.domainId, users, objectIds, storageIds, problemMapFromPlan(plan), false,
        )).filter((doc) => {
            const key = statusNaturalKey(doc);
            if (seenStatusKeys.has(key)) return false;
            seenStatusKeys.add(key);
            return !plan.mergeExisting || plannedStatusKeys.has(key);
        });
        await runPhase(runDir, state, 'statuses', async () => insertDocuments(db, 'document.status', statuses, state, plan.domainId));

        await db.collection<any>('exam.migration').updateOne(
            { _id: plan.runId },
            { $set: { status: 'complete', completedAt: new Date(), inserted: state.inserted.length, files: state.files.length } },
        );
        state.completedAt = new Date().toISOString();
        await writeJson(path.join(runDir, 'apply.json'), state);
        await writeAudit(runDir, 'apply.complete', { inserted: state.inserted.length, files: state.files.length });
        completed = true;
        return state;
    } catch (error) {
        await writeAudit(runDir, 'apply.failed', { error: error instanceof Error ? error.message : String(error) });
        throw error;
    } finally {
        await client.close();
        if (stopped && completed && options.startService) await options.startService();
    }
}

function addError(errors: string[], message: string) {
    if (!errors.includes(message)) errors.push(message);
}

function redactEmailForReport(value: unknown): string {
    const email = String(value ?? '').trim();
    const at = email.lastIndexOf('@');
    if (at <= 0 || at === email.length - 1) return '';
    return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}

function containsExactValue(value: any, candidates: Set<string>): boolean {
    if (value instanceof ObjectId || (isBsonValue(value) && value._bsontype === 'ObjectId')) {
        return candidates.has(value.toHexString());
    }
    if (typeof value === 'string') return candidates.has(value);
    if (Array.isArray(value)) return value.some((item) => containsExactValue(item, candidates));
    if (value && typeof value === 'object' && !(value instanceof Date) && !isBsonValue(value)) {
        return Object.values(value).some((child) => containsExactValue(child, candidates));
    }
    return false;
}

function markdownCell(value: unknown): string {
    return String(value ?? '').replace(/[|\r\n]/g, ' ');
}

/**
 * Write an auditable account/contest/problem merge report after verification.
 * The report is deliberately separate from the immutable package payload and
 * is excluded from packageHash calculation.
 */
export async function generateMergeReport(options: CommandOptions = {}): Promise<MergeReport> {
    const runDir = path.resolve(options.runDir || options.packageDir || '');
    assert(runDir, 'report 需要 --package 或 --run-dir');
    assert(options.targetUri, 'report 需要 --target-uri 或 HYDRO_EXAM_TARGET_URI');
    const plan = await readJson<MigrationPlan>(path.join(runDir, 'plan.json'));
    assert(plan.schemaVersion === MIGRATION_SCHEMA_VERSION && plan.kind === 'hydro.exam-migration-plan', '不是有效的 exam 迁移计划');
    assert(computePlanHash(plan) === plan.planHash, 'plan.json 自身哈希不一致');
    const manifest = await loadManifest(runDir);
    assert(manifest.packageHash === plan.packageHash, '计划和迁移包哈希不一致');
    const docs = await loadPackageCollections(runDir, manifest);
    const materializedProblems = await loadMaterializedProblems(runDir, manifest);
    const materializedById = new Map(materializedProblems.map((problem) => [Number(problem.sourceDocId), problem]));
    const verification = await readJson<VerifyReport>(path.join(runDir, 'verify-report.json'));
    assert(verification.runId === plan.runId, '验证报告和计划 run-id 不一致');
    assert(verification.applied, '尚未完成正式 apply，不能生成合并报告');
    const client = await MongoClient.connect(options.targetUri);
    try {
        const db = client.db(options.targetDatabase || undefined);
        const targetDomain = plan.domainId;
        const targetUsers = await db.collection<any>('user').find({}).project({ _id: 1, uname: 1, mail: 1 }).toArray();
        const targetUserById = new Map(targetUsers.map((user) => [Number(user._id), user]));
        const sourceRecords = docs.record || [];
        const sourceStatuses = docs['document.status'] || [];
        const sourceStats = docs['record.stat'] || [];
        const countByUid = (items: any[]) => {
            const result = new Map<number, number>();
            for (const item of items) {
                const uid = Number(item.uid);
                if (Number.isFinite(uid)) result.set(uid, (result.get(uid) || 0) + 1);
            }
            return result;
        };
        const sourceRecordCounts = countByUid(sourceRecords);
        const sourceStatusCounts = countByUid(sourceStatuses);
        const sourceStatCounts = countByUid(sourceStats);
        const mappedUsers = identityMap(plan.identities);
        const statusCollisionMap = new Map<string, { docType: number; docId: string; targetUid: number; sourceUids: Set<number> }>();
        for (const status of sourceStatuses) {
            const sourceUid = Number(status.uid);
            const targetUid = mappedUsers.get(sourceUid) ?? sourceUid;
            if (!Number.isFinite(sourceUid) || !Number.isFinite(targetUid)) continue;
            const docType = Number(status.docType);
            const docId = ejsonKey(status.docId);
            const key = `${docType}:${docId}:${targetUid}`;
            const entry = statusCollisionMap.get(key) || { docType, docId, targetUid, sourceUids: new Set<number>() };
            entry.sourceUids.add(sourceUid);
            statusCollisionMap.set(key, entry);
        }
        const statusCollisions = [...statusCollisionMap.values()]
            .filter((item) => item.sourceUids.size > 1)
            .map((item) => ({ ...item, sourceUids: [...item.sourceUids].sort((a, b) => a - b) }))
            .sort((a, b) => `${a.docType}:${a.docId}:${a.targetUid}`.localeCompare(`${b.docType}:${b.docId}:${b.targetUid}`));
        const identities: MergeReport['identities'] = [];
        for (const decision of plan.identities) {
            const target = targetUserById.get(decision.targetUid);
            identities.push({
                sourceUid: decision.sourceUid,
                targetUid: decision.targetUid,
                username: decision.sourceUname,
                targetUsername: target?.uname || decision.targetUname || '',
                method: decision.method,
                result: decision.created ? 'created' as const : 'reused' as const,
                alias: decision.alias,
                examMember: !!(await db.collection<any>('domain.user').findOne({ domainId: targetDomain, uid: decision.targetUid })),
                systemMember: !!(await db.collection<any>('domain.user').findOne({ domainId: 'system', uid: decision.targetUid })),
                email: redactEmailForReport(decision.sourceMail),
                targetEmail: redactEmailForReport(target?.mail || decision.targetMail),
                records: sourceRecordCounts.get(decision.sourceUid) || 0,
                statuses: sourceStatusCounts.get(decision.sourceUid) || 0,
                statistics: sourceStatCounts.get(decision.sourceUid) || 0,
            });
        }

        const contests: MergeReport['contests'] = [];
        for (const source of (docs.document || []).filter((doc) => doc.docType === 30)) {
            const sourceObject = getObjectId(source._id || source.docId);
            if (!sourceObject) continue;
            const sourceObjectId = sourceObject.toHexString();
            const decision = plan.contests.find((item) => item.sourceDocId === sourceObjectId);
            if (!decision) continue;
            const targetObject = getObjectId(decision.targetObjectId);
            const target = targetObject ? await db.collection<any>('document').findOne({
                domainId: targetDomain, docType: 30, _id: targetObject,
            }) : null;
            const sourceStatusCount = sourceStatuses.filter((status) => status.docType === 30
                && ejsonKey(status.docId) === ejsonKey(source.docId)).length;
            const targetStatusCount = target ? await db.collection<any>('document.status').countDocuments({
                domainId: targetDomain, docType: 30, docId: target.docId,
            }) : 0;
            const sourceRecordCount = sourceRecords.filter((record) => containsExactValue(record, new Set([sourceObjectId]))).length;
            const targetRecords = await db.collection<any>('record').find({ domainId: targetDomain }).toArray();
            const targetRecordCount = targetRecords.filter((record) => target && containsExactValue(record, new Set([decision.targetObjectId]))).length;
            const targetStatuses = target ? await db.collection<any>('document.status').find({
                domainId: targetDomain, docType: 30, docId: target.docId,
            }).toArray() : [];
            const referencesRewritten = !!target
                && !targetRecords.some((record) => containsExactValue(record, new Set([sourceObjectId])))
                && !targetStatuses.some((status) => containsExactValue(status, new Set([sourceObjectId])));
            contests.push({
                sourceObjectId,
                targetObjectId: decision.targetObjectId,
                title: String(source.title || target?.title || ''),
                action: decision.action,
                sourcePids: [...(source.pids || [])],
                targetPids: [...(target?.pids || source.pids || [])],
                sourceStatusCount,
                targetStatusCount,
                sourceRecordCount,
                targetRecordCount,
                attachmentCount: manifest.files.filter((file) => file.included
                    && file.sourcePath.startsWith(`contest/${targetDomain}/${sourceObjectId}/`)).length,
                referencesRewritten,
            });
        }

        const problems: MergeReport['problems'] = [];
        for (const source of (docs.document || []).filter((doc) => doc.docType === 10)) {
            const decision = plan.problems.find((item) => item.sourceDocId === Number(source.docId));
            if (!decision) continue;
            const materialized = decision.action === 'copy' ? materializedById.get(Number(source.docId)) : undefined;
            const target = await db.collection<any>('document').findOne({
                domainId: decision.action === 'reference' ? targetDomain : decision.targetDomainId,
                docType: 10,
                ...(decision.targetDocId !== undefined
                    ? { docId: decision.targetDocId }
                    : { pid: decision.targetPid }),
            });
            const comparableSource = materialized ? { ...source, config: materialized.config } : source;
            const comparison = target ? (problemEquivalent(comparableSource, target) ? 'equivalent' : 'different') : 'unavailable';
            const sourceFiles = problemFileNames(materialized || source);
            const targetFiles = problemFileNames(target);
            let effectiveTarget = target;
            const visited = new Set<string>();
            while (effectiveTarget?.reference) {
                const key = `${effectiveTarget.domainId}/${String(effectiveTarget.docId)}`;
                if (visited.has(key)) {
                    effectiveTarget = null;
                    break;
                }
                visited.add(key);
                effectiveTarget = await db.collection<any>('document').findOne({
                    domainId: effectiveTarget.reference.domainId,
                    docType: 10,
                    $or: [{ docId: effectiveTarget.reference.pid }, { pid: effectiveTarget.reference.pid }],
                });
            }
            const effectiveTestData = effectiveTarget ? {
                source: `${effectiveTarget.domainId}/${String(effectiveTarget.pid || effectiveTarget.docId)}`,
                files: (effectiveTarget.data || []).length,
            } : null;
            const prefix = `problem/${targetDomain}/${source.docId}/`;
            const alternatePrefix = `problem/${targetDomain}/${source.pid}/`;
            const attachments = manifest.files.filter((file) => file.included
                && (file.sourcePath.startsWith(prefix) || file.sourcePath.startsWith(alternatePrefix)));
            problems.push({
                sourcePid: decision.sourcePid,
                sourceTitle: String(source.title || ''),
                targetDomainId: decision.targetDomainId,
                targetPid: decision.targetPid,
                targetDocId: decision.targetDocId,
                action: decision.action,
                reason: decision.reason,
                comparison,
                sourceFiles,
                targetFiles,
                effectiveTestData,
                attachmentCount: attachments.length,
                filesIncluded: decision.action !== 'copy' || attachments.length === sourceFiles.length,
                excluded: false,
            });
        }

        const actualCounts = Object.fromEntries(Object.entries(verification.counts).map(([key, value]) => [key, value.actual]));
        const identityMethods = identities.reduce((result, item) => {
            result[item.method] = (result[item.method] || 0) + 1;
            return result;
        }, {} as Record<string, number>);
        const problemActions = problems.reduce((result, item) => {
            result[item.action] = (result[item.action] || 0) + 1;
            return result;
        }, {} as Record<string, number>);
        const contestActions = contests.reduce((result, item) => {
            result[item.action] = (result[item.action] || 0) + 1;
            return result;
        }, {} as Record<string, number>);
        const report: MergeReport = {
            schemaVersion: MIGRATION_SCHEMA_VERSION,
            runId: plan.runId,
            generatedAt: new Date().toISOString(),
            packageHash: plan.packageHash,
            planHash: plan.planHash!,
            targetBeforeHash: plan.targetBefore.hash,
            verification: { ok: verification.ok, errors: verification.errors },
            identities,
            contests,
            problems,
            statusCollisions,
            summary: {
                identityMethods,
                problemActions,
                contestActions,
                excludedDocuments: plan.excludedDocuments.length,
                excludedFiles: plan.excludedFiles.length,
                statusCollisionCount: statusCollisions.length,
                sourceCounts: manifest.counts,
                expectedCounts: plan.expectedCounts,
                actualCounts,
            },
        };
        const reportJson = `${JSON.stringify(report, null, 2)}\n`;
        await writePrivateFile(path.join(runDir, 'merge-report.json'), reportJson);
        await writePrivateFile(path.join(runDir, 'merge-report.sha256'), `${sha256(reportJson)}\n`);
        const lines = [
            '# exam 合并结果报告', '',
            `- run-id: ${report.runId}`,
            `- packageHash: ${report.packageHash}`,
            `- planHash: ${report.planHash}`,
            `- targetBeforeHash: ${report.targetBeforeHash}`,
            `- verify: ${report.verification.ok ? 'ok' : 'failed'}`,
            '', '## 账户合并', '',
            '| 源 UID | 目标 UID | 用户名 | 方法 | 结果 | exam | system | 提交 | 状态 | 统计 |',
            '| ---: | ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: |',
            ...identities.map((item) => `| ${item.sourceUid} | ${item.targetUid} | ${markdownCell(item.username)} | ${item.method} | ${item.result} | ${item.examMember ? '是' : '否'} | ${item.systemMember ? '是' : '否'} | ${item.records} | ${item.statuses} | ${item.statistics} |`),
            '', '## 比赛合并', '',
            '| 源 ObjectId | 目标 ObjectId | 标题 | 方式 | 源题目 | 目标题目 | 源状态 | 目标状态 | 附件 | 引用重写 |',
            '| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |',
            ...contests.map((item) => `| ${item.sourceObjectId} | ${item.targetObjectId} | ${markdownCell(item.title)} | ${item.action} | ${item.sourcePids.join(', ')} | ${item.targetPids.join(', ')} | ${item.sourceStatusCount} | ${item.targetStatusCount} | ${item.attachmentCount} | ${item.referencesRewritten ? '是' : '否'} |`),
            '', '## 题目合并', '',
            '| 源 PID | 标题 | 目标域 | 目标 PID | 方式 | 原因 | 配置比较 | 附件 | 目标有效测试文件（元数据） | 文件完整 |',
            '| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- |',
            ...problems.map((item) => `| ${markdownCell(item.sourcePid)} | ${markdownCell(item.sourceTitle)} | ${item.targetDomainId} | ${item.targetPid} | ${item.action} | ${item.reason} | ${item.comparison} | ${item.attachmentCount} | ${item.effectiveTestData ? `${item.effectiveTestData.source} (${item.effectiveTestData.files})` : '缺失'} | ${item.filesIncluded ? '是' : '否'} |`),
            '', '## 汇总', '',
            `- 账户映射：${JSON.stringify(identityMethods)}`,
            `- 题目处理：${JSON.stringify(problemActions)}`,
            `- 比赛处理：${JSON.stringify(contestActions)}`,
            `- 排除文档：${plan.excludedDocuments.length}`,
            `- 排除文件：${plan.excludedFiles.length}`,
            '', '## 成绩自然键碰撞', '',
            '| docType | docId | 目标 UID | 源 UID |',
            '| ---: | --- | ---: | --- |',
            ...statusCollisions.map((item) => `| ${item.docType} | ${item.docId} | ${item.targetUid} | ${item.sourceUids.join(', ')} |`),
            `- 成绩自然键碰撞数：${statusCollisions.length}`,
            `- 源集合计数：${JSON.stringify(manifest.counts)}`,
            `- 计划计数：${JSON.stringify(plan.expectedCounts)}`,
            `- 实际计数：${JSON.stringify(actualCounts)}`,
            '', '排除文档和文件的详细原因见 `plan.json`、`manifest.json` 与 `audit.jsonl`。', '',
        ];
        await writePrivateFile(path.join(runDir, 'merge-summary.md'), `${lines.join('\n')}\n`);
        await writeAudit(runDir, 'merge-report.complete', {
            identities: identities.length,
            contests: contests.length,
            problems: problems.length,
            packageHash: report.packageHash,
            planHash: report.planHash,
        });
        return report;
    } finally {
        await client.close();
    }
}

function isSpecialContestId(value: any): boolean {
    const id = value instanceof ObjectId || (isBsonValue(value) && value._bsontype === 'ObjectId')
        ? value.toHexString() : String(value || '');
    return id === '0'.repeat(24) || id === '0'.repeat(23) + '1';
}

async function verifyReferences(
    db: Db, domainId: string, expectedSystemUids: number[] = [], defaultUserPriv?: number,
): Promise<{ checked: number; errors: string[] }> {
    const errors: string[] = [];
    let checked = 0;
    const users = new Set((await db.collection<any>('user').find({}).project({ _id: 1 }).toArray()).map((doc) => Number(doc._id)));
    const docs = await db.collection<any>('document').find({ domainId }).toArray();
    const statuses = await db.collection<any>('document.status').find({ domainId }).toArray();
    const records = await db.collection<any>('record').find({ domainId }).toArray();
    const recordStats = await db.collection<any>('record.stat').find({ domainId }).toArray();
    const recordHistory = await db.collection<any>('record.history').find({
        rid: { $in: records.map((record) => record._id) },
    }).toArray();
    const discussionHistory = await db.collection<any>('discussion.history').find({ domainId }).toArray();
    const balloons = await db.collection<any>('contest.balloon').find({ domainId }).toArray();
    const submissionPaths = [...collectSubmissionPaths(records.map((record) => record.files))];
    const existingSubmissionPaths = new Set((submissionPaths.length
        ? await db.collection<any>('storage').find({ path: { $in: submissionPaths }, autoDelete: null }).project({ path: 1 }).toArray()
        : []).map((storage) => String(storage.path)));
    const domain = await db.collection<any>('domain').findOne({ _id: domainId });
    const problems = docs.filter((doc) => doc.docType === 10);
    const contests = docs.filter((doc) => doc.docType === 30);
    const byProblem = new Set(problems.map((doc) => String(doc.docId)));
    const byDocumentId = new Set(docs.map((doc) => `${doc.docType}:${String(doc.docId)}`));
    const byRecord = new Set(records.map((doc) => String(doc._id)));
    const checkUid = (value: any, where: string) => {
        if (typeof value !== 'number') return;
        checked++;
        if (!users.has(value)) addError(errors, `${where} uid ${value} 不存在`);
    };
    const checkDoc = (docType: number, docId: any, where: string) => {
        checked++;
        if (!byDocumentId.has(`${docType}:${String(docId)}`)) addError(errors, `${where} 文档 ${docType}/${String(docId)} 不存在`);
    };
    if (!domain) addError(errors, `域 ${domainId} 不存在`);
    else checkUid(domain.owner, `domain/${domainId}`);

    const walkUids = (value: any, key = '', where = '') => {
        if (typeof value === 'number' && UID_KEYS.has(key)) checkUid(value, where || key);
        else if (Array.isArray(value)) value.forEach((child, index) => walkUids(child, key, `${where}[${index}]`));
        else if (value && typeof value === 'object' && !(value instanceof Date) && !isBsonValue(value)) {
            for (const [childKey, child] of Object.entries(value)) walkUids(child, childKey, where ? `${where}.${childKey}` : childKey);
        }
    };

    for (const doc of docs) {
        checkUid(doc.owner, `document/${doc.docType}/${String(doc.docId)}`);
        checkUid(doc.editor, `document/${doc.docType}/${String(doc.docId)}`);
        walkUids(doc, '', `document/${doc.docType}/${String(doc.docId)}`);
        if (doc.docType === 10) {
            if (doc.reference) {
                checked++;
                if (doc.reference.domainId === 'prepare' || doc.reference.domainId === 'test') {
                    addError(errors, `problem/${doc.docId} 保留了禁止的 ${doc.reference.domainId} 引用`);
                }
                // References outside the migrated domain must point to an
                // existing problem.  The target source domain is read-only.
                const target = await db.collection<any>('document').findOne({
                    domainId: doc.reference.domainId,
                    docType: 10,
                    $or: [{ docId: doc.reference.pid }, { pid: String(doc.reference.pid) }, { pid: doc.reference.pid }],
                });
                if (!target) addError(errors, `problem/${doc.docId} 的引用目标不存在`);
            }
        } else if (doc.parentType !== undefined && doc.parentId !== undefined) {
            checkDoc(Number(doc.parentType), doc.parentId, `document/${doc.docType}/${String(doc.docId)} parent`);
        }
        if (doc.docType === 30) {
            for (const pid of doc.pids || []) {
                checked++;
                if (!byProblem.has(String(pid))) addError(errors, `contest/${String(doc.docId)} pid ${pid} 不存在`);
            }
        }
    }
    for (const status of statuses) {
        checkUid(status.uid, `status/${status.docType}/${String(status.docId)}`);
        checkDoc(Number(status.docType), status.docId, 'status');
        walkUids(status, '', `status/${status.docType}/${String(status.docId)}`);
        for (const value of [status.rid, ...(status.journal || []).map((item: any) => item.rid),
            ...Object.values(status.detail || {}).map((item: any) => item?.rid)]) {
            if (value === undefined || value === null) continue;
            checked++;
            if (!byRecord.has(String(value))) addError(errors, `status/${String(status.docId)} rid ${String(value)} 不存在`);
        }
    }
    for (const record of records) {
        checkUid(record.uid, `record/${String(record._id)}`);
        checked++;
        if (!byProblem.has(String(record.pid))) addError(errors, `record/${String(record._id)} pid ${record.pid} 不存在`);
        if (record.contest && !isSpecialContestId(record.contest)) {
            checked++;
            if (!contests.some((contest) => String(contest.docId) === String(record.contest))) {
                addError(errors, `record/${String(record._id)} contest ${String(record.contest)} 不存在`);
            }
        }
        if (record.hackTarget) {
            checked++;
            if (!byRecord.has(String(record.hackTarget))) addError(errors, `record/${String(record._id)} hackTarget 不存在`);
        }
        for (const submissionPath of collectSubmissionPaths(record.files)) {
            checked++;
            if (!existingSubmissionPaths.has(submissionPath)) {
                addError(errors, `record/${String(record._id)} 附件 ${submissionPath} 不存在`);
            }
        }
    }
    for (const stat of recordStats) {
        checked++;
        if (!byRecord.has(String(stat._id))) addError(errors, `record.stat/${String(stat._id)} 没有对应提交`);
        checkUid(stat.uid, `record.stat/${String(stat._id)}`);
        if (!byProblem.has(String(stat.pid))) addError(errors, `record.stat/${String(stat._id)} pid ${stat.pid} 不存在`);
        if (stat.contest && !isSpecialContestId(stat.contest)) {
            checked++;
            if (!contests.some((contest) => String(contest.docId) === String(stat.contest))) {
                addError(errors, `record.stat/${String(stat._id)} contest ${String(stat.contest)} 不存在`);
            }
        }
    }
    for (const history of recordHistory) {
        checked++;
        if (!byRecord.has(String(history.rid))) addError(errors, `record.history/${String(history._id)} rid 不存在`);
    }
    for (const history of discussionHistory) {
        checked++;
        const parent = await db.collection<any>('document').findOne({ domainId, docId: history.docId });
        if (!parent) addError(errors, `discussion.history/${String(history.docId)} 父文档不存在`);
        checkUid(history.uid, `discussion.history/${String(history.docId)}`);
    }
    for (const balloon of balloons) {
        checkUid(balloon.uid, `contest.balloon/${String(balloon._id)}`);
        checkUid(balloon.sent, `contest.balloon/${String(balloon._id)} sent`);
        checked++;
        if (!contests.some((contest) => String(contest.docId) === String(balloon.tid))) {
            addError(errors, `contest.balloon/${String(balloon._id)} tid ${String(balloon.tid)} 不存在`);
        }
        checked++;
        if (!byProblem.has(String(balloon.pid))) {
            addError(errors, `contest.balloon/${String(balloon._id)} pid ${balloon.pid} 不存在`);
        }
    }
    const members = await db.collection<any>('domain.user').find({ domainId }).toArray();
    for (const member of members) {
        checkUid(member.uid, `domain.user/${domainId}`);
        checked++;
    }
    const systemMembers = new Set((expectedSystemUids.length
        ? await db.collection<any>('domain.user').find({ domainId: 'system', uid: { $in: expectedSystemUids } })
            .project({ uid: 1 }).toArray()
        : []).map((member) => Number(member.uid)));
    for (const uid of expectedSystemUids) {
        checked++;
        if (!systemMembers.has(uid)) addError(errors, `domain.user/system uid ${uid} 不存在`);
    }
    if (expectedSystemUids.length && defaultUserPriv !== undefined) {
        const newUsers = await db.collection<any>('user').find({ _id: { $in: expectedSystemUids } })
            .project({ _id: 1, priv: 1 }).toArray();
        const byUid = new Map(newUsers.map((user) => [Number(user._id), Number(user.priv)]));
        for (const uid of expectedSystemUids) {
            checked++;
            if (byUid.get(uid) !== defaultUserPriv) addError(errors, `user/${uid} 全局权限不是目标默认值`);
        }
    }
    const groups = await db.collection<any>('user.group').find({ domainId }).toArray();
    for (const group of groups) {
        walkUids(group, '', `group/${group.name}`);
        checked++;
    }
    return { checked, errors };
}

async function verifyFiles(
    db: Db, runDir: string, plan: MigrationPlan, storageRoot?: string,
): Promise<{ checked: number; errors: string[] }> {
    const errors: string[] = [];
    let checked = 0;
    for (const file of plan.storage.filter((item) => item.included)) {
        checked++;
        const metadata = await db.collection<any>('storage').findOne({ path: file.targetPath, autoDelete: null });
        if (!metadata) {
            addError(errors, `storage 元数据不存在: ${file.targetPath}`);
            continue;
        }
        if (!storageRoot || !file.targetStorageId) {
            addError(errors, `storage 物理根目录或 ID 缺失: ${file.targetPath}`);
            continue;
        }
        try {
            const bytes = await fsp.readFile(safeRelativePath(storageRoot, file.targetStorageId));
            if (sha256(bytes) !== file.sha256) addError(errors, `storage SHA-256 不一致: ${file.targetPath}`);
        } catch {
            addError(errors, `storage 物理文件不存在: ${file.targetPath}`);
        }
    }
    return { checked, errors };
}

async function verifyContestProblemReferences(
    db: Db, domainId: string, sourceDocuments: any[], plan: MigrationPlan,
): Promise<{ checked: number; errors: string[] }> {
    const errors: string[] = [];
    let checked = 0;
    for (const source of sourceDocuments.filter((doc) => doc.docType === 30)) {
        const sourceObjectId = getObjectId(source._id || source.docId);
        if (!sourceObjectId) {
            addError(errors, `contest/${String(source.docId)} 缺少 ObjectId`);
            continue;
        }
        const sourceId = sourceObjectId.toHexString();
        const decision = plan.contests.find((item) => item.sourceDocId === sourceId);
        if (!decision) {
            addError(errors, `contest/${sourceId} 没有迁移决策`);
            continue;
        }
        const targetId = plan.objectIds.values[sourceId] || decision.targetObjectId;
        const target = await db.collection<any>('document').findOne({
            domainId, docType: 30, _id: new ObjectId(targetId),
        });
        checked++;
        if (!target) {
            addError(errors, `contest/${sourceId} 目标文档不存在`);
            continue;
        }
        const expectedPids = (source.pids || []).map((pid: any) => String(
            plan.problemIds[String(pid)] ?? pid,
        ));
        const actualPids = (target.pids || []).map((pid: any) => String(pid));
        if (stableStringify(actualPids) !== stableStringify(expectedPids)) {
            addError(errors, `contest/${sourceId} 题目列表映射不一致`);
            continue;
        }
        const expectedPidSet = new Set(expectedPids);
        const statuses = await db.collection<any>('document.status').find({
            domainId, docType: 30, docId: target.docId,
        }).project({ uid: 1, detail: 1, display: 1 }).toArray();
        for (const status of statuses) {
            for (const field of ['detail', 'display']) {
                for (const key of Object.keys(status[field] || {})) {
                    checked++;
                    if (!expectedPidSet.has(String(key))) {
                        addError(errors, `status/${String(status.uid)} ${field} 题目 ${key} 不属于比赛`);
                    }
                }
            }
        }
    }
    return { checked, errors };
}

export async function verifyExamMigration(options: CommandOptions = {}): Promise<VerifyReport> {
    const runDir = path.resolve(options.runDir || options.packageDir || '');
    assert(runDir, 'verify 需要 --package 或 --run-dir');
    assert(options.targetUri, 'verify 需要 --target-uri 或 HYDRO_EXAM_TARGET_URI');
    const plan = await readJson<MigrationPlan>(path.join(runDir, 'plan.json'));
    assert(plan.schemaVersion === MIGRATION_SCHEMA_VERSION && plan.kind === 'hydro.exam-migration-plan', '不是有效的 exam 迁移计划');
    assert(computePlanHash(plan) === plan.planHash, 'plan.json 自身哈希不一致');
    const manifest = await loadManifest(runDir);
    assert(manifest.domainId === plan.domainId, '计划和迁移包域不一致');
    assert(plan.packageHash === manifest.packageHash, '验证计划和迁移包哈希不一致');
    const docs = await loadPackageCollections(runDir, manifest);
    const materializedProblems = await loadMaterializedProblems(runDir, manifest);
    const client = await MongoClient.connect(options.targetUri);
    try {
        const db = client.db(options.targetDatabase || undefined);
        const marker = await db.collection<any>('exam.migration').findOne({ _id: plan.runId });
        const counts: VerifyReport['counts'] = {};
        for (const name of COLLECTIONS) {
            const actual = await db.collection<any>(name).countDocuments(
                await collectionFilterForDatabase(db, name, plan.domainId),
            );
            const value = plan.expectedCounts[name] ?? 0;
            counts[name] = { expected: value, actual, ok: actual === value };
        }
        const createdUids = plan.identities.filter((identity) => identity.created).map((identity) => identity.targetUid);
        const references = await verifyReferences(db, plan.domainId, createdUids, plan.defaultUserPriv);
        const materializedById = new Map(materializedProblems.map((problem) => [Number(problem.sourceDocId), problem]));
        const storageIds = storageMapFromPlan(plan);
        for (const decision of plan.problems.filter((item) => item.action === 'copy')) {
            const materialized = materializedById.get(decision.sourceDocId);
            if (!materialized) continue;
            const target = await db.collection<any>('document').findOne({
                domainId: plan.domainId, docType: 10, docId: decision.targetDocId,
            });
            const expectedData = rewriteStorageReference(materialized.data, storageIds);
            const expectedAdditionalFiles = rewriteStorageReference(materialized.additional_file, storageIds);
            references.checked++;
            if (!target || target.reference
                || stableStringify(target.data || []) !== stableStringify(expectedData)
                || stableStringify(target.additional_file || []) !== stableStringify(expectedAdditionalFiles)
                || stableStringify(target.config ?? null) !== stableStringify(materialized.config ?? null)) {
                references.errors.push(`problem/${String(decision.targetDocId)} 题源测试数据物化不一致`);
            }
        }
        const contestReferences = await verifyContestProblemReferences(db, plan.domainId, docs.document || [], plan);
        references.checked += contestReferences.checked;
        references.errors.push(...contestReferences.errors);
        const files = await verifyFiles(db, runDir, plan, options.targetStorageRoot);
        const p105Files = await checkConfirmedP105Files(db, options.targetStorageRoot, plan, materializedProblems);
        files.checked += p105Files.checked;
        files.errors.push(...p105Files.errors);
        const users = await db.collection<any>('user').find({}).project({ unameLower: 1, uname: 1, mailLower: 1, mail: 1 }).toArray();
        const usernames = new Map<string, number>();
        const emails = new Map<string, number>();
        const duplicateUsernames: string[] = [];
        const duplicateEmails: string[] = [];
        for (const user of users) {
            const uname = normalizeUsername(user.unameLower || user.uname);
            if (uname) usernames.set(uname, (usernames.get(uname) || 0) + 1);
            const mail = normalizeIdentityEmail(user.mailLower || user.mail);
            if (mail) emails.set(mail, (emails.get(mail) || 0) + 1);
        }
        for (const [key, count] of usernames) if (count > 1) duplicateUsernames.push(key);
        for (const [key, count] of emails) if (count > 1) duplicateEmails.push(key);
        const errors: string[] = [];
        for (const value of Object.values(counts)) if (!value.ok) errors.push('集合数量不一致');
        errors.push(...references.errors, ...files.errors);
        errors.push(...duplicateUsernames.map((value) => `用户名唯一索引冲突: ${value}`));
        errors.push(...duplicateEmails.map((value) => `邮箱唯一索引冲突: ${value}`));
        const report: VerifyReport = {
            schemaVersion: MIGRATION_SCHEMA_VERSION,
            runId: plan.runId,
            verifiedAt: new Date().toISOString(),
            ok: errors.length === 0 && !!marker && marker.status === 'complete',
            applied: !!marker && marker.status === 'complete',
            counts,
            references,
            files,
            identities: { duplicateUsernames, duplicateEmails },
            errors,
        };
        await writeJson(path.join(runDir, 'verify-report.json'), report);
        await writePrivateFile(path.join(runDir, 'verify-summary.txt'), [
            `run: ${report.runId}`,
            `verifiedAt: ${report.verifiedAt}`,
            `applied: ${report.applied}`,
            `ok: ${report.ok}`,
            `errors: ${report.errors.length}`,
            ...report.errors.map((error) => `- ${error}`),
            '',
        ].join('\n'));
        await writeAudit(runDir, 'verify.complete', { ok: report.ok, errors: report.errors.length });
        return report;
    } finally {
        await client.close();
    }
}

export async function rollbackExamMigration(options: ApplyOptions = {}): Promise<{ runId: string; deleted: number; files: number }> {
    const runDir = path.resolve(options.runDir || options.packageDir || '');
    assert(runDir, 'rollback 需要 --package 或 --run-dir');
    assert(options.targetUri, 'rollback 需要 --target-uri 或 HYDRO_EXAM_TARGET_URI');
    const state = await readJson<ApplyState>(path.join(runDir, 'apply.json'));
    assert(!state.dryRun, 'dry-run 没有可回滚的写入');
    assert(state.startedAt, '没有可回滚的应用记录');
    const plan = await readJson<MigrationPlan>(path.join(runDir, 'plan.json'));
    assert(plan.schemaVersion === MIGRATION_SCHEMA_VERSION && plan.kind === 'hydro.exam-migration-plan', '不是有效的 exam 迁移计划');
    assert(computePlanHash(plan) === plan.planHash, 'plan.json 自身哈希不一致');
    assert(plan.planHash === state.planHash, '应用记录和计划哈希不一致');
    const manifest = await loadManifest(runDir);
    assert(manifest.domainId === plan.domainId, '计划和迁移包域不一致');
    assert(manifest.packageHash === state.packageHash, '应用记录和迁移包哈希不一致');
    const client = await MongoClient.connect(options.targetUri);
    let stopped = false;
    let completed = false;
    try {
        const db = client.db(options.targetDatabase || undefined);
        const marker = await db.collection<any>('exam.migration').findOne({ _id: state.runId });
        assert(marker, `找不到迁移标记: ${state.runId}`);
        assert(marker.packageHash === state.packageHash && marker.planHash === state.planHash, '迁移标记哈希不一致');
        const stop = options.stopService || (options.serviceControl === 'none' || options.noStop ? null : defaultStopService);
        if (stop) {
            await stop();
            stopped = true;
            await writeAudit(runDir, 'rollback.service.stopped', { service: 'hydrooj' });
        }
        let deleted = 0;
        for (const item of [...state.inserted].reverse()) {
            const collection = db.collection<any>(item.collection);
            let id: any = item.id;
            try { id = EJSON.parse(item.id); } catch { /* legacy apply state */ }
            if (typeof id === 'string' && ObjectId.isValid(id) && /^[\da-f]{24}$/i.test(item.id)
                && !['domain', 'user', 'user.group'].includes(item.collection)) id = new ObjectId(id);
            const filter: any = { _id: id };
            if (item.domainId) filter.domainId = item.domainId;
            if (item.path) filter.path = item.path;
            const result = await collection.deleteOne(filter);
            deleted += result.deletedCount;
        }
        let files = 0;
        for (const file of state.files) {
            const metadata = await db.collection<any>('storage').findOne({ path: file.path });
            if (metadata) {
                await db.collection<any>('storage').deleteOne({ _id: metadata._id, path: file.path });
            }
            if (options.targetStorageRoot) {
                try {
                    await fsp.unlink(safeRelativePath(options.targetStorageRoot, file.storageId));
                    files++;
                } catch { /* already removed */ }
            }
        }
        await db.collection<any>('exam.migration').deleteOne({ _id: state.runId });
        await writeJson(path.join(runDir, 'rollback.json'), {
            schemaVersion: MIGRATION_SCHEMA_VERSION,
            runId: state.runId,
            rolledBackAt: new Date().toISOString(),
            deleted,
            files,
        });
        await writeAudit(runDir, 'rollback.complete', { deleted, files });
        completed = true;
        return { runId: state.runId, deleted, files };
    } finally {
        await client.close();
        if (stopped && completed && options.startService) await options.startService();
    }
}
