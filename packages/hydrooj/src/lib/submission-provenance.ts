import { createHash } from 'crypto';
import { load } from 'js-yaml';
import type { ProblemConfigFile } from '@hydrooj/common';

/** The version of the server-side submission ingress which writes these facts. */
export const SUBMISSION_INGRESS_VERSION = 'record-v1';

export interface ProblemEvidence {
    canonicalProblemKey?: string;
    problemRevisionId?: string;
    problemOwner?: number;
    problemReleased?: boolean;
    problemFullScore?: number;
}

interface RawProblem {
    domainId: string;
    docId: number;
    owner?: number;
    hidden?: boolean;
    content?: unknown;
    config?: unknown;
    data?: unknown;
    additional_file?: unknown;
    reference?: { domainId?: string, pid?: number };
    [key: string]: unknown;
}
interface ProblemCollection {
    collection(name: string): {
        findOne(query: Record<string, unknown>, options?: unknown): Promise<RawProblem | null>;
    };
}
function stable(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, stable((value as any)[key])]));
    }
    return value;
}
function hash(value: unknown) {
    return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

function number(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function scoreOfAnswer(value: unknown) {
    if (Array.isArray(value)) return number(value[1]) || 0;
    if (value && typeof value === 'object') {
        return Math.max(0, ...Object.values(value).map((item) => number(item) || 0));
    }
    return 0;
}

function parseConfig(config: unknown): ProblemConfigFile | undefined {
    let cfg: ProblemConfigFile;
    try {
        cfg = (typeof config === 'string' ? load(config || '{}') : config) as ProblemConfigFile;
    } catch {
        return undefined;
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return undefined;
    return cfg;
}

function fullScore(cfg: ProblemConfigFile | undefined): number | undefined {
    if (!cfg) return undefined;
    if (cfg.answers && typeof cfg.answers === 'object') {
        const score = Object.values(cfg.answers).reduce((sum, answer) => sum + scoreOfAnswer(answer), 0);
        return Number.isFinite(score) && score > 0 ? score : undefined;
    }
    if (cfg.cases !== undefined && !Array.isArray(cfg.cases)) return undefined;
    if (cfg.subtasks !== undefined && !Array.isArray(cfg.subtasks)) return undefined;
    // readYamlCases gives top-level cases precedence over any subtasks field.
    const subtasks: any[] = cfg.cases?.length ? [{ cases: cfg.cases, type: 'sum' as const }] : cfg.subtasks;
    if (!subtasks?.length) return undefined;
    if (subtasks.some((subtask) => !subtask || typeof subtask !== 'object'
        || (subtask.score !== undefined && (number(subtask.score) === undefined || subtask.score < 0)))) return undefined;
    const explicit = subtasks.reduce((sum, subtask) => sum + (number(subtask.score) || 0), 0);
    const missing = subtasks.filter((subtask) => !number(subtask.score)).length;
    const remainder = Math.max(100 - explicit, 0);
    if (!missing) return explicit > 0 ? explicit : undefined;
    return explicit + remainder;
}

function hasValidFileFingerprints(doc: RawProblem, cfg: ProblemConfigFile | undefined) {
    if (!Array.isArray(doc.data) || !doc.data.length) {
        return !!doc.reference || (!!cfg?.answers && typeof cfg.answers === 'object');
    }
    if (doc.data.some((item: any) => !item || typeof item.etag !== 'string' || !item.etag)) return false;
    if (Array.isArray(doc.additional_file)
        && doc.additional_file.some((item: any) => !item || typeof item.etag !== 'string' || !item.etag)) return false;
    return true;
}

function observedProblem(doc: RawProblem) {
    return {
        domainId: doc.domainId,
        docId: doc.docId,
        content: doc.content,
        config: doc.config,
        data: Array.isArray(doc.data) ? doc.data.map((item: any) => ({
            name: item?.name,
            etag: item?.etag,
            size: item?.size,
            lastModified: item?.lastModified,
        })) : doc.data,
        additional_file: Array.isArray(doc.additional_file) ? doc.additional_file.map((item: any) => ({
            name: item?.name,
            etag: item?.etag,
            size: item?.size,
            lastModified: item?.lastModified,
        })) : doc.additional_file,
    };
}

/**
 * Resolve a problem and its explicit copy/reference chain without loading a
 * Hydro model. The raw document collection is injectable for replay and tests.
 */
export async function resolveProblemEvidence(
    dbh: ProblemCollection, domainId: string, pid: number,
): Promise<ProblemEvidence> {
    const docs: RawProblem[] = [];
    const seen = new Set<string>();
    let next = { domainId, pid };
    let broken = false;
    while (true) {
        const key = `${next.domainId}/${next.pid}`;
        if (seen.has(key)) {
            broken = true;
            break;
        }
        seen.add(key);
        // The next reference depends on the current document, so this lookup is deliberately serial.
        // eslint-disable-next-line no-await-in-loop
        const doc = await dbh.collection('document').findOne({
            docType: 10, domainId: next.domainId, docId: next.pid,
        });
        if (!doc) {
            broken = true;
            break;
        }
        docs.push(doc);
        if (doc.reference === undefined) break;
        if (!doc.reference || typeof doc.reference.domainId !== 'string' || !doc.reference.domainId
            || !Number.isSafeInteger(doc.reference.pid)) {
            broken = true;
            break;
        }
        next = { domainId: doc.reference.domainId, pid: doc.reference.pid };
    }
    if (!docs.length || broken) return {};
    const canonical = docs.at(-1)!;
    const canonicalConfig = parseConfig(canonical.config);
    const evidence = {
        canonicalProblemKey: `${canonical.domainId}/${canonical.docId}`,
        problemOwner: typeof canonical.owner === 'number' ? canonical.owner : undefined,
        problemReleased: docs.every((doc) => doc.hidden === false),
        problemFullScore: fullScore(canonicalConfig),
    };
    const revision = canonicalConfig && hasValidFileFingerprints(canonical, canonicalConfig)
        && docs.every((doc) => doc.data === undefined || hasValidFileFingerprints(doc, parseConfig(doc.config)))
        ? hash(docs.map(observedProblem)) : undefined;
    return {
        ...evidence,
        ...(revision ? { problemRevisionId: revision } : {}),
    };
}
