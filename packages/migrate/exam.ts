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

/** Confirmed source -> target user mappings supplied with the migration plan. */
export const CONFIRMED_USER_MAP: Record<number, number> = Object.freeze({
    1558: 2047,
    1605: 2381,
    1632: 3859,
    1682: 1514,
    1716: 2553,
    1888: 2927,
    1996: 595,
    2013: 3781,
    2106: 3494,
    2110: 3520,
    2121: 3480,
    2124: 3510,
    2142: 3529,
    2144: 3492,
    2146: 3507,
    2147: 3500,
    2151: 3503,
    2156: 3464,
    2159: 3482,
    2160: 3479,
    2170: 3513,
    2172: 3486,
    2177: 3616,
    2208: 3676,
    2242: 1970,
    2257: 3564,
    2310: 2992,
});

/**
 * Twelve known username/e-mail disagreements.  The username side is the
 * confirmed identity decision, so these are kept separate from the ordinary
 * username pass to make the decision auditable.
 */
export const USERNAME_CONFLICT_MAP: Record<number, number> = Object.freeze({
    1383: 3919,
    1450: 2363,
    1582: 3525,
    1583: 3398,
    1623: 3117,
    1649: 2837,
    1665: 4020,
    1765: 2574,
    1810: 2544,
    1933: 2972,
    2100: 3040,
    2236: 2862,
});

export const CONFIRMED_DECISIONS = Object.freeze({
    manualUserMappings: CONFIRMED_USER_MAP,
    usernameConflictMappings: USERNAME_CONFLICT_MAP,
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

export type IdentityMethod = 'manual' | 'username-conflict' | 'username' | 'email' | 'new';

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
    note?: string;
}

export interface IdentityOptions {
    manualMap?: Record<number, number>;
    conflictMap?: Record<number, number>;
    /** Allow a source identity that exactly aliases a confirmed target. */
    allowAliases?: boolean;
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
    reason: 'confirmed-reference' | 'matching-reference' | 'matching-existing' | 'entity';
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
 * Match Hydro's mail lookup normalization, while explicitly rejecting the
 * synthetic @test.com addresses that were not approved as identity evidence.
 */
export function normalizeIdentityEmail(value: unknown): string | null {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw || /\s/.test(raw)) return null;
    const at = raw.lastIndexOf('@');
    if (at <= 0 || at === raw.length - 1 || raw.indexOf('@') !== at) return null;
    const local = raw.slice(0, at);
    const domain = raw.slice(at + 1);
    if (!/^[^@.]+(?:\.[^@.]+)*$/.test(domain)) return null;
    if (domain === 'test.com') return null;
    const withoutPlus = local.split('+', 1)[0];
    if (!withoutPlus) return null;
    const canonicalDomain = domain === 'googlemail.com' ? 'gmail.com' : domain;
    const canonicalLocal = withoutPlus.replace(/\./g, '');
    if (!canonicalLocal) return null;
    return `${canonicalLocal}@${canonicalDomain}`;
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

/** Resolve the confirmed identity precedence without touching a database. */
export function resolveIdentities(
    sourceUsers: SourceUser[], targetUsers: TargetUser[], options: IdentityOptions = {},
): IdentityDecision[] {
    const manualMap = options.manualMap || CONFIRMED_USER_MAP;
    const conflictMap = options.conflictMap || USERNAME_CONFLICT_MAP;
    const byUid = new Map(targetUsers.map((user) => [Number(user._id), user]));
    const byName = indexBy(targetUsers, (user) => normalizeUsername(user.unameLower || user.uname));
    const byMail = indexBy(targetUsers, (user) => normalizeIdentityEmail(user.mailLower || user.mail) || '');
    // Reserve explicitly confirmed targets before resolving ordinary
    // username/e-mail matches, so an earlier source UID cannot claim a
    // target that a later manual decision must use.
    const reservedTarget = new Set<number>();
    const confirmedSourcesByTarget = new Map<number, number[]>();
    const sourceIds = new Set(sourceUsers.map((user) => Number(user._id)));
    for (const mapping of [manualMap, conflictMap]) {
        for (const [source, target] of Object.entries(mapping)) {
            if (!sourceIds.has(Number(source))) continue;
            const targetUid = Number(target);
            if (!byUid.has(targetUid)) {
                throw new Error(`确认的用户映射不存在目标用户: ${source} -> ${target}`);
            }
            reservedTarget.add(targetUid);
            const sources = confirmedSourcesByTarget.get(targetUid) || [];
            sources.push(Number(source));
            confirmedSourcesByTarget.set(targetUid, sources);
        }
    }
    const usedTarget = new Set<number>();
    const existingMax = targetUsers.reduce((max, user) => Math.max(max, Number(user._id) || 0), 0);
    let nextUid = existingMax + 1;
    const decisions: IdentityDecision[] = [];
    const plannedNames = new Set<string>();
    const plannedEmails = new Set<string>();
    const sorted = [...sourceUsers].sort((a, b) => Number(a._id) - Number(b._id));

    const chooseOne = (candidates: TargetUser[], source: SourceUser, method: IdentityMethod) => {
        const sourceUid = Number(source._id);
        const sourceName = normalizeUsername(source.unameLower || source.uname);
        const sourceMail = normalizeIdentityEmail(source.mailLower || source.mail);
        const available = candidates.filter((candidate) => {
            const candidateUid = Number(candidate._id);
            const candidateName = normalizeUsername(candidate.unameLower || candidate.uname);
            const candidateMail = normalizeIdentityEmail(candidate.mailLower || candidate.mail);
            const exact = (sourceName && sourceName === candidateName) || (sourceMail && sourceMail === candidateMail);
            if (usedTarget.has(candidateUid)) return !!options.allowAliases && !!exact;
            if (!reservedTarget.has(candidateUid)) return true;
            if (!options.allowAliases || !confirmedSourcesByTarget.has(candidateUid)) return false;
            return !!exact;
        });
        if (available.length > 1) {
            throw new Error(`身份判定不唯一: source uid ${sourceUid} has ${available.length} ${method} candidates`);
        }
        return available[0];
    };

    for (const source of sorted) {
        const sourceUid = Number(source._id);
        let target: TargetUser | undefined;
        let method: IdentityMethod;
        let note = '';
        let alias = false;

        if (Object.hasOwn(manualMap, sourceUid)) {
            target = byUid.get(Number(manualMap[sourceUid]));
            if (!target) throw new Error(`确认的用户映射不存在目标用户: ${sourceUid} -> ${manualMap[sourceUid]}`);
            method = 'manual';
        } else if (Object.hasOwn(conflictMap, sourceUid)) {
            target = byUid.get(Number(conflictMap[sourceUid]));
            if (!target) throw new Error(`确认的用户名冲突映射不存在目标用户: ${sourceUid} -> ${conflictMap[sourceUid]}`);
            method = 'username-conflict';
            note = 'username wins over normalized email';
        } else {
            const sourceName = normalizeUsername(source.unameLower || source.uname);
            target = chooseOne(byName.get(sourceName) || [], source, 'username');
            if (target) {
                method = 'username';
                alias = reservedTarget.has(Number(target._id)) || usedTarget.has(Number(target._id));
            } else {
                const sourceMail = normalizeIdentityEmail(source.mailLower || source.mail);
                target = sourceMail ? chooseOne(byMail.get(sourceMail) || [], source, 'email') : undefined;
                if (target) {
                    method = 'email';
                    alias = reservedTarget.has(Number(target._id)) || usedTarget.has(Number(target._id));
                } else {
                    method = 'new';
                    if (sourceName && ((byName.get(sourceName) || []).length || plannedNames.has(sourceName))) {
                        throw new Error(`新用户用户名会发生唯一性冲突: ${source.uname}`);
                    }
                    const sourceStoredMail = String(source.mailLower || source.mail || '').trim().toLowerCase();
                    const sourceMailKey = sourceMail || sourceStoredMail;
                    if (sourceMailKey && (plannedEmails.has(sourceMailKey)
                        || (sourceMail && (byMail.get(sourceMail) || []).length)
                        || targetUsers.some((user) => String(user.mailLower || user.mail || '').trim().toLowerCase() === sourceStoredMail))) {
                        throw new Error(`新用户邮箱会发生唯一性冲突: ${source.mail || source.mailLower}`);
                    }
                    if (sourceName) plannedNames.add(sourceName);
                    if (sourceMailKey) plannedEmails.add(sourceMailKey);
                    while (byUid.has(nextUid) || usedTarget.has(nextUid)) nextUid++;
                    target = undefined;
                }
            }
        }

        const targetUid = target ? Number(target._id) : nextUid++;
        if (usedTarget.has(targetUid) && !alias) {
            throw new Error(`多个源用户映射到同一目标用户: target uid ${targetUid}`);
        }
        if (!alias) usedTarget.add(targetUid);
        decisions.push({
            sourceUid,
            targetUid,
            method,
            created: method === 'new',
            sourceUname: source.uname,
            targetUname: target?.uname,
            sourceMail: source.mail,
            targetMail: target?.mail,
            ...(alias ? { alias: true } : {}),
            ...(alias ? { note: 'exact identity alias of a confirmed target mapping' } : note ? { note } : {}),
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
): boolean {
    if (!problem) return false;
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
    return !!domain || target.domainId === 'system' || target.domainId === 'oler' || target.domainId === 'yizhong';
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

function safeRelativePath(root: string, relative: string): string {
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
            sourceFingerprint: await sourceFingerprint(db, domainId, selected),
            sourceDatabase,
            collections,
            files,
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
        });
        return manifest;
    } finally {
        await client.close();
    }
}

async function loadManifest(runDir: string): Promise<MigrationManifest> {
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
    const packageHash = await hashPackageDirectory(runDir);
    assert(packageHash === manifest.packageHash, `迁移包哈希不匹配: ${packageHash} != ${manifest.packageHash}`);
    for (const collection of manifest.collections) {
        const file = path.join(runDir, collection.file);
        const content = await fsp.readFile(file);
        assert(sha256(content) === collection.sha256, `集合文件哈希不匹配: ${collection.name}`);
    }
    return manifest;
}

async function loadPackageCollections(runDir: string, manifest: MigrationManifest) {
    const result: Record<string, any[]> = {};
    for (const collection of manifest.collections) {
        const docs = await readJsonLines(path.join(runDir, collection.file));
        assert(docs.length === collection.count, `集合数量不匹配: ${collection.name}`);
        result[collection.name] = docs;
    }
    return result;
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

function planStorage(
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
    const client = await MongoClient.connect(options.targetUri);
    try {
        const db = client.db(options.targetDatabase || undefined);
        const target = await targetFingerprint(db, domainId);
        if (options.mergeExisting) assert(target.examDomainExists, `合并模式要求目标已有 ${domainId} 域`);
        else assert(!target.examDomainExists, `目标已存在 ${domainId} 域，拒绝生成应用计划`);
        const defaultUserPriv = target.defaultUserPriv;
        const targetUsers = await db.collection<any>('user').find({}).toArray();
        const sourceUsers = docs.user || [];
        const identities = resolveIdentities(sourceUsers, targetUsers, { allowAliases: !!options.mergeExisting });
        const users = identityMap(identities);
        const targetProblems = await db.collection<any>('document').find({ docType: 10 }).toArray();
        const targetDomains = await db.collection<any>('domain').find({}).toArray();
        const sourceProblems = (docs.document || []).filter((doc) => doc.docType === 10);
        const problems = buildProblemDecisions(sourceProblems, targetProblems, targetDomains, {
            mergeExisting: !!options.mergeExisting, domainId,
        });
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

        const sourceStorage = (docs.storage || []).map((doc) => mapStorageDocument(
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

function rewriteStorageReference(value: any, storageIds: Map<string, string>): any {
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

function rewriteProblemReferences(value: any, problems: Map<string, number | string>, key = ''): any {
    if (Array.isArray(value)) {
        return value.map((item) => key === 'pids' || key === 'pid' ? problems.get(String(item)) ?? item
            : rewriteProblemReferences(item, problems, key));
    }
    if ((key === 'pid' || key === 'pids' || key === 'subject') && (typeof value === 'number' || typeof value === 'string')) {
        return problems.get(String(value)) ?? value;
    }
    if (!value || typeof value !== 'object' || value instanceof Date || isBsonValue(value)) return value;
    const output: Record<string, any> = {};
    for (const [childKey, child] of Object.entries(value)) output[childKey] = rewriteProblemReferences(child, problems, childKey);
    return output;
}

function mapDocumentForApply(
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
    if (doc.docType === 30 && Array.isArray(doc.pids)) doc.pids = doc.pids.map((pid: any) => problems.get(String(pid)) ?? Number(pid));
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
    const user = { ...original, _id: decision.targetUid };
    delete user.domains;
    delete user.pinnedDomains;
    delete user.perm;
    delete user.role;
    // Private user files are outside this migration scope. Do not leave
    // declarations pointing at source UID paths that were not copied.
    user._files = [];
    user.unameLower = normalizeUsername(user.uname);
    user.mailLower = normalizeIdentityEmail(user.mailLower || user.mail)
        || String(user.mailLower || user.mail || '').trim().toLowerCase();
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

async function verifyApplyPreconditions(
    db: Db, runDir: string, plan: MigrationPlan, options: ApplyOptions,
): Promise<MigrationManifest> {
    const manifest = await loadManifest(runDir);
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
            .map((doc) => mapDocumentForApply(doc, plan, plan.domainId, users, objectIds, storageIds, problemMapFromPlan(plan), true));
        await runPhase(runDir, state, 'problems', async () => insertDocuments(db, 'document', problemDocuments, state, plan.domainId));

        const sourceStorage = (docs.storage || []).map((doc) => mapStorageDocument(doc, plan, plan.domainId, users, objectIds, storageIds)).filter(Boolean);
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
        const files = await verifyFiles(db, runDir, plan, options.targetStorageRoot);
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
