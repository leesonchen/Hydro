import type { Collection, Filter } from 'mongodb';
import {
    appendFeedbackEvent, createLocalFeedbackWriter, FeedbackActor, FeedbackChange, FeedbackEvent, feedbackEventId, feedbackHash,
    FeedbackRecord, FeedbackValidationError,
    normalizeActor, normalizeFeedbackChange,
} from '../lib/classroomFeedback';
import db from '../service/db';

declare module '../service/db' {
    interface Collections {
        'classroom.feedback.events': FeedbackEvent;
    }
}

export const coll = db.collection('classroom.feedback.events');

export interface FeedbackScope {
    domainId: string;
    activityType: 'course' | 'homework';
    activityId: string;
}

export interface FeedbackQuery {
    studentUid?: number;
    pid?: number;
    pending?: boolean;
    before?: string;
}

export function createFeedbackRepository(collection: Collection<FeedbackEvent>) {
    const store = {
        findOne: (filter: { _id: string }) => collection.findOne(filter),
        insertOne: (event: FeedbackEvent) => collection.insertOne(event, { writeConcern: { w: 'majority' } }),
    };
    const writer = createLocalFeedbackWriter({
        findOne: async (filter) => await store.findOne(filter) as FeedbackRecord | null,
        insertOne: store.insertOne,
    });
    return {
        record: writer.record,
        async ensureIndexes() {
            await collection.createIndexes([
                { name: 'feedback_activity', key: { domainId: 1, activityType: 1, activityId: 1, eventType: 1, recordedAt: -1, _id: -1 } },
                { name: 'feedback_student', key: { domainId: 1, studentUid: 1, pid: 1, recordedAt: -1, _id: -1 } },
                { name: 'feedback_target', key: { domainId: 1, targetId: 1, eventType: 1, recordedAt: -1, _id: -1 } },
            ]);
        },
        async get(scope: FeedbackScope, eventId: string) {
            if (!/^feedback:[a-f0-9]{64}$/.test(eventId)) throw new FeedbackValidationError('eventId');
            return await collection.findOne({ ...scope, _id: eventId, eventType: 'OBSERVATION_RECORDED' }) as FeedbackRecord | null;
        },
        async change(
            actorValue: FeedbackActor, target: FeedbackRecord, eventType: FeedbackChange['eventType'], value: unknown,
            authorize: (actor: FeedbackActor, target: FeedbackRecord, rid?: string) => Promise<void>,
        ) {
            const actor = normalizeActor(actorValue);
            const input = normalizeFeedbackChange(value);
            if (actor.domainId !== target.domainId) throw new FeedbackValidationError('domainId');
            if (eventType === 'RETEST_RESOLVED' && target.kind !== 'NEEDS_RETEST') throw new FeedbackValidationError('kind');
            await authorize(actor, target, input.rid);
            return await appendFeedbackEvent(store, {
                ...actor, ...input, _id: feedbackEventId(actor, input.requestId), schemaVersion: 1, source: 'hydro',
                eventType, targetId: target._id, activityType: target.activityType, activityId: target.activityId,
                studentUid: target.studentUid, pid: target.pid, recordedAt: new Date(),
                requestHash: feedbackHash({ ...input, eventType, targetId: target._id }),
            });
        },
        async list(scope: FeedbackScope, query: FeedbackQuery = {}) {
            const match: Filter<FeedbackEvent> = { ...scope, eventType: 'OBSERVATION_RECORDED' };
            for (const field of ['studentUid', 'pid'] as const) {
                if (query[field] !== undefined) {
                    if (!Number.isSafeInteger(query[field]) || query[field] <= 0) throw new FeedbackValidationError(field);
                    match[field] = query[field];
                }
            }
            if (query.pending) match.kind = 'NEEDS_RETEST';
            if (query.before) {
                try {
                    if (query.before.length > 256) throw new Error();
                    const [at, id] = JSON.parse(Buffer.from(query.before, 'base64url').toString());
                    const date = new Date(at);
                    if (!Number.isFinite(date.getTime()) || !/^feedback:[a-f0-9]{64}$/.test(id)) throw new Error();
                    match.$or = [{ recordedAt: { $lt: date } }, { recordedAt: date, _id: { $lt: id } }];
                } catch {
                    throw new FeedbackValidationError('before');
                }
            }
            // Limit after resolving state: a page of closed retests must not hide older pending work.
            const rows = await collection.aggregate<FeedbackRecord & { changes: FeedbackChange[] }>([
                { $match: match },
                { $sort: { recordedAt: -1, _id: -1 } },
                ...(!query.pending ? [{ $limit: 51 }] : []),
                { $lookup: {
                    from: collection.collectionName, let: { id: '$_id', domain: '$domainId' },
                    pipeline: [
                        { $match: { $expr: { $and: [{ $eq: ['$targetId', '$$id'] }, { $eq: ['$domainId', '$$domain'] }] } } },
                        { $sort: { recordedAt: -1, _id: -1 } },
                        { $group: { _id: '$eventType', event: { $first: '$$ROOT' } } },
                        { $replaceRoot: { newRoot: '$event' } },
                        { $project: { requestHash: 0, requestId: 0 } },
                    ], as: 'changes',
                } },
                ...(query.pending ? [{ $match: { changes: { $size: 0 } } }, { $limit: 51 }] : []),
                { $project: { requestHash: 0, requestId: 0 } },
            ]).toArray();
            const hasMore = rows.length > 50;
            const items = rows.slice(0, 50).map((row) => ({
                ...row,
                retracted: row.changes.some((e) => e.eventType === 'OBSERVATION_RETRACTED'),
                resolved: row.changes.some((e) => e.eventType === 'RETEST_RESOLVED'),
            }));
            const last = items.at(-1);
            return {
                items,
                next: hasMore ? Buffer.from(JSON.stringify([last.recordedAt.toISOString(), last._id])).toString('base64url') : null,
            };
        },
    };
}

export const feedbackRepository = createFeedbackRepository(coll);

export const inject = ['db'];
export async function apply() {
    await feedbackRepository.ensureIndexes();
}
