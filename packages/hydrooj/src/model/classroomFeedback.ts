import type { Collection, Filter } from 'mongodb';
import {
    appendFeedbackEvent, createLocalFeedbackWriter, FeedbackActor, FeedbackChange, FeedbackEvent, feedbackEventId, feedbackHash,
    FeedbackRecord, FeedbackValidationError, normalizeActor, normalizeFeedbackChange,
} from '../lib/classroomFeedback';
import db from '../service/db';

declare module '../service/db' {
    interface Collections { 'classroom.feedback.events': FeedbackEvent }
}

export const coll = db.collection('classroom.feedback.events');
export interface FeedbackScope { domainId: string, activityType: 'course' | 'homework', activityId: string }
export interface FeedbackQuery {
    studentUid?: number;
    pid?: number;
    nodeId?: number;
    pending?: boolean;
    before?: string;
}

export class FeedbackStateConflictError extends Error {
    constructor(public currentState: { state: string, version: number, resolutionId?: string, operatorUid?: number }) {
        super(currentState.state === 'resolved' ? '这条观察已由其他操作完成跟进，请刷新查看。' : '观察状态已变化，请刷新后再操作。');
    }
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
    const match = (scope: FeedbackScope, query: FeedbackQuery, cursor = false): Filter<FeedbackEvent> => {
        const filter: Filter<FeedbackEvent> = { ...scope, eventType: 'OBSERVATION_RECORDED' };
        for (const field of ['studentUid', 'pid', 'nodeId'] as const) {
            if (query[field] === undefined) continue;
            if (!Number.isSafeInteger(query[field]) || query[field] < (field === 'nodeId' ? 0 : 1)) throw new FeedbackValidationError(field);
            // A legacy number alone cannot prove which lesson the observation belonged to.
            filter[field === 'nodeId' ? 'context.nodeId' : field] = query[field];
        }
        if (query.pending) filter.kind = 'NEEDS_RETEST';
        if (cursor && query.before) {
            try {
                if (query.before.length > 256) throw new Error();
                const [at, id, hash] = JSON.parse(Buffer.from(query.before, 'base64url').toString());
                const date = new Date(at);
                if (!Number.isFinite(date.getTime()) || !/^feedback:[a-f0-9]{64}$/.test(id)
                    || hash !== feedbackHash(filter)) throw new Error();
                filter.$or = [{ recordedAt: { $lt: date } }, { recordedAt: date, _id: { $lt: id } }];
            } catch { throw new FeedbackValidationError('before'); }
        }
        return filter;
    };
    const stateStages = [
        { $lookup: {
            from: collection.collectionName, let: { id: '$_id', domain: '$domainId' },
            pipeline: [
                { $match: { $expr: { $and: [{ $eq: ['$targetId', '$$id'] }, { $eq: ['$domainId', '$$domain'] }] } } },
                { $sort: { version: -1, recordedAt: -1, _id: -1 } },
                { $project: { requestHash: 0, requestId: 0 } },
            ], as: 'changes',
        } },
        { $set: {
            state: { $ifNull: [{ $arrayElemAt: ['$changes.stateAfter', 0] },
                { $cond: [{ $in: ['OBSERVATION_RETRACTED', '$changes.eventType'] }, 'retracted',
                    { $cond: [{ $in: ['RETEST_RESOLVED', '$changes.eventType'] }, 'resolved',
                        { $cond: [{ $eq: ['$kind', 'NEEDS_RETEST'] }, 'pending', 'active'] }] }] }] },
            version: { $ifNull: [{ $arrayElemAt: ['$changes.version', 0] }, 0] },
        } },
    ];
    const decorate = (row: any) => ({
        ...row, retracted: row.state === 'retracted', resolved: row.state === 'resolved',
        resolution: row.state === 'resolved' ? row.changes.find((c) => c.eventType === 'RETEST_RESOLVED') : null,
        changes: [...row.changes].reverse(),
    });
    const count = async (scope: FeedbackScope, query: FeedbackQuery = {}) => {
        const result = await collection.aggregate([
            { $match: match(scope, { ...query, pending: true }) }, ...stateStages,
            { $match: { state: 'pending' } }, { $count: 'total' },
        ]).toArray();
        return result[0]?.total || 0;
    };
    const state = async (target: FeedbackRecord) => {
        const rows = await collection.aggregate([
            { $match: { _id: target._id, domainId: target.domainId } }, ...stateStages,
            { $project: { requestHash: 0, requestId: 0 } },
        ]).toArray();
        return decorate(rows[0]);
    };
    return {
        record: writer.record,
        count,
        async maxNodeId(scope: FeedbackScope) {
            const row = await collection.find({ ...scope, eventType: 'OBSERVATION_RECORDED', nodeId: { $gte: 0 } })
                .sort({ nodeId: -1 }).limit(1).next() as FeedbackRecord | null;
            return row?.nodeId || 0;
        },
        async ensureIndexes() {
            await collection.createIndexes([
                { name: 'feedback_activity', key: { domainId: 1, activityType: 1, activityId: 1, eventType: 1, recordedAt: -1, _id: -1 } },
                { name: 'feedback_student', key: { domainId: 1, studentUid: 1, pid: 1, recordedAt: -1, _id: -1 } },
                { name: 'feedback_target', key: { domainId: 1, targetId: 1, eventType: 1, recordedAt: -1, _id: -1 } },
                { name: 'feedback_version', key: { domainId: 1, targetId: 1, version: -1 }, unique: true,
                    partialFilterExpression: { version: { $exists: true } } },
                { name: 'feedback_lesson', key: { domainId: 1, activityType: 1, activityId: 1, 'context.nodeId': 1, pid: 1, recordedAt: -1 } },
            ]);
        },
        async get(scope: FeedbackScope, eventId: string) {
            if (!/^feedback:[a-f0-9]{64}$/.test(eventId)) throw new FeedbackValidationError('eventId');
            return await collection.findOne({ ...scope, _id: eventId, eventType: 'OBSERVATION_RECORDED' }) as FeedbackRecord | null;
        },
        detail: state,
        async change(
            actorValue: FeedbackActor, target: FeedbackRecord, eventType: FeedbackChange['eventType'], value: unknown,
            authorize: (actor: FeedbackActor, target: FeedbackRecord, rid?: string, resolution?: FeedbackChange) => Promise<void>,
        ) {
            const actor = normalizeActor(actorValue);
            const input = normalizeFeedbackChange(value);
            if (actor.domainId !== target.domainId) throw new FeedbackValidationError('domainId');
            if (eventType !== 'OBSERVATION_RETRACTED' && target.kind !== 'NEEDS_RETEST') throw new FeedbackValidationError('kind');
            const resolution = input.resolutionId ? await collection.findOne({
                _id: input.resolutionId, domainId: actor.domainId, targetId: target._id, eventType: 'RETEST_RESOLVED',
            }) as FeedbackChange | null : null;
            if (eventType === 'RETEST_RESOLUTION_RETRACTED' && !resolution) throw new FeedbackValidationError('resolutionId');
            await authorize(actor, target, input.rid, resolution);
            const _id = feedbackEventId(actor, input.requestId);
            const requestHash = feedbackHash({ ...input, eventType, targetId: target._id });
            const replay = await store.findOne({ _id });
            if (replay) return appendFeedbackEvent(store, { ...replay, requestHash });
            const current = await state(target);
            if ((input.expectedVersion !== undefined && input.expectedVersion !== current.version)
                || current.retracted || (eventType === 'RETEST_RESOLVED' && current.state !== 'pending')
                || (eventType === 'RETEST_RESOLUTION_RETRACTED'
                    && (current.state !== 'resolved' || current.resolution?._id !== input.resolutionId))) {
                throw new FeedbackStateConflictError({ state: current.state, version: current.version,
                    ...(current.resolution ? { resolutionId: current.resolution._id, operatorUid: current.resolution.operatorUid } : {}) });
            }
            const stateAfter = eventType === 'OBSERVATION_RETRACTED' ? 'retracted'
                : eventType === 'RETEST_RESOLVED' ? 'resolved' : 'pending';
            try {
                return await appendFeedbackEvent(store, {
                    ...actor, ...input, _id, schemaVersion: 2, source: 'hydro', eventType, targetId: target._id,
                    activityType: target.activityType, activityId: target.activityId, studentUid: target.studentUid, pid: target.pid,
                    recordedAt: new Date(), requestHash, version: current.version + 1, stateAfter,
                });
            } catch (error) {
                if (error.code !== 11000) throw error;
                const latest = await state(target);
                throw new FeedbackStateConflictError({ state: latest.state, version: latest.version,
                    ...(latest.resolution ? { resolutionId: latest.resolution._id, operatorUid: latest.resolution.operatorUid } : {}) });
            }
        },
        async summary(scope: FeedbackScope, query: FeedbackQuery = {}) {
            return await collection.aggregate([
                { $match: match(scope, { ...query, pending: false }) }, { $sort: { recordedAt: -1, _id: -1 } },
                ...stateStages, { $match: { state: { $ne: 'retracted' } } },
                { $group: { _id: '$studentUid', latest: { $first: '$$ROOT' } } },
                { $replaceRoot: { newRoot: '$latest' } }, { $project: { requestHash: 0, requestId: 0 } },
            ]).toArray().then((rows) => rows.map(decorate));
        },
        async list(scope: FeedbackScope, query: FeedbackQuery = {}) {
            const rows = await collection.aggregate([
                { $match: match(scope, query, true) }, { $sort: { recordedAt: -1, _id: -1 } },
                ...(!query.pending ? [{ $limit: 51 }] : []), ...stateStages,
                ...(query.pending ? [{ $match: { state: 'pending' } }, { $limit: 51 }] : []),
                { $project: { requestHash: 0, requestId: 0 } },
            ]).toArray();
            const items = rows.slice(0, 50).map(decorate);
            const last = items.at(-1);
            return { items, next: rows.length > 50 ? Buffer.from(JSON.stringify([
                last.recordedAt.toISOString(), last._id, feedbackHash(match(scope, query)),
            ])).toString('base64url') : null };
        },
    };
}

export const feedbackRepository = createFeedbackRepository(coll);
export const inject = ['db'];
export async function apply() { await feedbackRepository.ensureIndexes(); }
