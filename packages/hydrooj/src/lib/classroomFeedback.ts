import { createHash } from 'node:crypto';

/** Local-only observation contract. This module does not register HTTP routes. */
export const FEEDBACK_KINDS = ['GUIDED', 'CHECKED', 'NEEDS_RETEST'] as const;
export type FeedbackKind = typeof FEEDBACK_KINDS[number];

const DETAILS: Record<FeedbackKind, readonly string[]> = {
    GUIDED: ['IDEA', 'DEBUGGING'],
    CHECKED: ['REASONING', 'BOUNDARY', 'CODE_EXPLANATION'],
    NEEDS_RETEST: ['UNDERSTANDING', 'BOUNDARY', 'TRANSFER'],
};
const INPUT_KEYS = new Set([
    'requestId', 'studentUid', 'activityType', 'activityId', 'pid', 'nodeId', 'rid', 'kind', 'detail', 'note',
]);

export interface FeedbackInput {
    requestId: string;
    studentUid: number;
    activityType: 'course' | 'homework';
    activityId: string;
    pid: number;
    nodeId?: number;
    rid?: string;
    kind: FeedbackKind;
    detail?: string;
    note: string;
}

/** Must come from Hydro's authenticated server-side session, never the request body. */
export interface FeedbackActor {
    domainId: string;
    operatorUid: number;
}

export interface FeedbackRecord extends FeedbackInput, FeedbackActor {
    _id: string;
    schemaVersion: 1;
    source: 'hydro';
    eventType: 'OBSERVATION_RECORDED';
    requestHash: string;
    recordedAt: Date;
}

export interface FeedbackStore {
    findOne(filter: { _id: string }): Promise<FeedbackRecord | null>;
    insertOne(record: FeedbackRecord): Promise<{ acknowledged: boolean }>;
}

export interface FeedbackReceipt {
    eventId: string;
    recordedAt: string;
    replayed: boolean;
}

/**
 * Required for EVERY request, including idempotent retries. The Hydro adapter
 * must verify activity access, the student roster, pid/node ownership and any
 * optional rid against Hydro data. No external identity/AI service is allowed.
 */
export type FeedbackAuthorizer = (
    actor: Readonly<FeedbackActor>, input: Readonly<FeedbackInput>,
) => Promise<void>;

export class FeedbackValidationError extends Error {
    constructor(field: string) {
        super(`Invalid classroom feedback field: ${field}`);
        this.name = 'FeedbackValidationError';
    }
}

export class FeedbackConflictError extends Error {
    constructor() {
        super('The requestId was already used for different classroom feedback.');
        this.name = 'FeedbackConflictError';
    }
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FeedbackValidationError('body');
    return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new FeedbackValidationError(field);
    return value;
}

function objectId(value: unknown, field: string): string {
    if (typeof value !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value)) throw new FeedbackValidationError(field);
    return value.toLowerCase();
}

export function normalizeFeedbackInput(value: unknown): FeedbackInput {
    const input = object(value);
    for (const key of Object.keys(input)) {
        if (!INPUT_KEYS.has(key)) throw new FeedbackValidationError(key);
    }
    if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(input.requestId)) {
        throw new FeedbackValidationError('requestId');
    }
    if (input.activityType !== 'course' && input.activityType !== 'homework') throw new FeedbackValidationError('activityType');
    if (typeof input.kind !== 'string' || !FEEDBACK_KINDS.includes(input.kind as FeedbackKind)) {
        throw new FeedbackValidationError('kind');
    }
    const kind = input.kind as FeedbackKind;
    if (input.detail !== undefined && (typeof input.detail !== 'string' || !DETAILS[kind].includes(input.detail))) {
        throw new FeedbackValidationError('detail');
    }
    if (input.nodeId !== undefined && (input.activityType !== 'course'
        || typeof input.nodeId !== 'number' || !Number.isSafeInteger(input.nodeId) || input.nodeId < 0)) {
        throw new FeedbackValidationError('nodeId');
    }
    if (input.note !== undefined && typeof input.note !== 'string') throw new FeedbackValidationError('note');
    const note = (input.note as string | undefined || '').replace(/\r\n?/g, '\n').trim();
    if ([...note].length > 500) throw new FeedbackValidationError('note');
    return {
        requestId: input.requestId,
        studentUid: positiveInteger(input.studentUid, 'studentUid'),
        activityType: input.activityType,
        activityId: objectId(input.activityId, 'activityId'),
        pid: positiveInteger(input.pid, 'pid'),
        ...(input.nodeId !== undefined ? { nodeId: input.nodeId as number } : {}),
        ...(input.rid !== undefined ? { rid: objectId(input.rid, 'rid') } : {}),
        kind,
        ...(input.detail !== undefined ? { detail: input.detail as string } : {}),
        note,
    };
}

function normalizeActor(actor: FeedbackActor): FeedbackActor {
    if (!actor || typeof actor.domainId !== 'string' || !actor.domainId
        || actor.domainId !== actor.domainId.trim() || actor.domainId.length > 128) {
        throw new FeedbackValidationError('domainId');
    }
    return { domainId: actor.domainId, operatorUid: positiveInteger(actor.operatorUid, 'operatorUid') };
}

function hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function receipt(record: FeedbackRecord, replayed: boolean): FeedbackReceipt {
    return { eventId: record._id, recordedAt: record.recordedAt.toISOString(), replayed };
}

function replay(record: FeedbackRecord, requestHash: string): FeedbackReceipt {
    if (record.requestHash !== requestHash) throw new FeedbackConflictError();
    return receipt(record, true);
}

function duplicateKey(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 11000;
}

/**
 * A single acknowledged local insert is the save boundary. `_id` is derived
 * from the domain, operator and requestId, so MongoDB's built-in unique `_id`
 * index provides idempotency even when requests reach different Hydro workers.
 * There is deliberately no remote call, secondary write or bus dispatch here.
 * Fact fields are append-only; future corrections must be separate events.
 */
export function createLocalFeedbackWriter(store: FeedbackStore, clock: () => Date = () => new Date()) {
    return {
        async record(actorValue: FeedbackActor, value: unknown, authorize: FeedbackAuthorizer): Promise<FeedbackReceipt> {
            const actor = Object.freeze(normalizeActor(actorValue));
            const input = Object.freeze(normalizeFeedbackInput(value));
            if (typeof authorize !== 'function') throw new TypeError('A Hydro-local authorizer is required.');
            await authorize(actor, input);

            const _id = `feedback:${hash(['hydro-feedback-v1', actor.domainId, actor.operatorUid, input.requestId])}`;
            const requestHash = hash(input);
            const existing = await store.findOne({ _id });
            if (existing) return replay(existing, requestHash);

            const recordedAt = clock();
            if (!(recordedAt instanceof Date) || !Number.isFinite(recordedAt.getTime())) {
                throw new FeedbackValidationError('recordedAt');
            }
            const record: FeedbackRecord = {
                ...input, ...actor, _id, schemaVersion: 1, source: 'hydro',
                eventType: 'OBSERVATION_RECORDED', requestHash, recordedAt,
            };
            try {
                const result = await store.insertOne(record);
                if (!result.acknowledged) throw new Error('Hydro did not acknowledge the feedback write.');
                return receipt(record, false);
            } catch (error) {
                if (!duplicateKey(error)) throw error;
                const winner = await store.findOne({ _id });
                if (!winner) throw error; // Do not hide a collision on an unrelated index.
                return replay(winner, requestHash);
            }
        },
    };
}
