import { pick, sum } from 'lodash';
import moment from 'moment-timezone';
import {
    Filter, FindOptions, MatchKeysAndValues,
    ObjectId, OnlyFieldsOfType, PushOperator, UpdateFilter,
} from 'mongodb';
import { ProblemConfigFile, STATUS_TEXTS } from '@hydrooj/common';
import { Context } from '../context';
import { ProblemNotFoundError, ValidationError } from '../error';
import { JudgeMeta, RecordDoc, RecordStatDoc } from '../interface';
import {
    ProblemEvidence, resolveProblemEvidence,
    SUBMISSION_INGRESS_VERSION } from '../lib/submission-provenance';
import db from '../service/db';
import { MaybeArray, NumberKeys } from '../typeutils';
import { ArgMethod, buildProjection, Time } from '../utils';
import { STATUS } from './builtin';
import DomainModel from './domain';
import MessageModel from './message';
import problem from './problem';
import SystemModel from './system';
import task from './task';

const IMMUTABLE_RECORD_FIELDS = [
    'submittedAt', 'submissionKind', 'participationMode', 'problemRevisionId',
    'ingressVersion', 'canonicalProblemKey', 'problemOwner', 'problemReleased',
    'problemFullScore', 'originalRid', 'submissionContext', 'classroomSession',
];

function isImmutableRecordField(key: string) {
    return IMMUTABLE_RECORD_FIELDS.some((field) => key === field || key.startsWith(`${field}.`));
}

function filterRecordUpdate<T extends Record<string, any>>(fields?: T) {
    if (!fields) return fields;
    return Object.fromEntries(Object.entries(fields).filter(([key]) => !isImmutableRecordField(key))) as T;
}

export default class RecordModel {
    static coll = db.collection('record');
    static collStat = db.collection('record.stat');
    static collHistory = db.collection('record.history');
    static PROJECTION_LIST: (keyof RecordDoc)[] = [
        '_id', 'score', 'time', 'memory', 'lang',
        'uid', 'pid', 'rejudged', 'progress', 'domainId',
        'contest', 'judger', 'judgeAt', 'status', 'source',
        'files', 'hackTarget', 'practiceContest',
    ];

    static STAT_QUERY = {
        time: [{ time: -1 }, { time: 1 }],
        memory: [{ memory: -1 }, { memory: 1 }],
        length: [{ length: -1 }, { length: 1 }],
        date: [{ _id: -1 }, { _id: 1 }],
    };

    static RECORD_PRETEST = new ObjectId('000000000000000000000000');
    static RECORD_GENERATE = new ObjectId('000000000000000000000001');

    static async submissionPriority(uid: number, base: number = 0) {
        const timeRecent = await RecordModel.coll
            .find({ _id: { $gte: Time.getObjectID(moment().add(-30, 'minutes')) }, uid, rejudged: { $ne: true } })
            .project({ time: 1, status: 1 }).toArray();
        const pending = timeRecent.filter((i) => [
            STATUS.STATUS_WAITING, STATUS.STATUS_FETCHED, STATUS.STATUS_COMPILING, STATUS.STATUS_JUDGING,
        ].includes(i.status)).length;
        return Math.max(base - 10000, base - (pending * 1000 + 1) * (sum(timeRecent.map((i) => i.time || 0)) / 10000 + 1));
    }

    static async get(_id: ObjectId): Promise<RecordDoc | null>;
    static async get(domainId: string, _id: ObjectId): Promise<RecordDoc | null>;
    static async get(arg0: string | ObjectId, arg1?: any) {
        const _id = arg1 || arg0;
        const domainId = arg1 ? arg0 : null;
        const res = await RecordModel.coll.findOne({ _id });
        if (!res) return null;
        if (res.domainId === (domainId || res.domainId)) return res;
        return null;
    }

    @ArgMethod
    static async stat(domainId?: string) {
        const [d5min, d1h, day, week, month, year, total] = await Promise.all([
            RecordModel.coll.countDocuments({ _id: { $gte: Time.getObjectID(moment().add(-5, 'minutes')) }, ...domainId ? { domainId } : {} }),
            RecordModel.coll.countDocuments({ _id: { $gte: Time.getObjectID(moment().add(-1, 'hour')) }, ...domainId ? { domainId } : {} }),
            RecordModel.coll.countDocuments({ _id: { $gte: Time.getObjectID(moment().add(-1, 'day')) }, ...domainId ? { domainId } : {} }),
            RecordModel.coll.countDocuments({ _id: { $gte: Time.getObjectID(moment().add(-1, 'week')) }, ...domainId ? { domainId } : {} }),
            RecordModel.coll.countDocuments({ _id: { $gte: Time.getObjectID(moment().add(-1, 'month')) }, ...domainId ? { domainId } : {} }),
            RecordModel.coll.countDocuments({ _id: { $gte: Time.getObjectID(moment().add(-1, 'year')) }, ...domainId ? { domainId } : {} }),
            domainId ? RecordModel.coll.countDocuments({ domainId }) : RecordModel.coll.estimatedDocumentCount(),
        ]);
        return {
            d5min, d1h, day, week, month, year, total,
        };
    }

    static async judge(
        domainId: string, rids: MaybeArray<ObjectId> | RecordDoc, priority = 0,
        config: ProblemConfigFile = {}, meta: Partial<JudgeMeta> = {},
    ) {
        let rdocs: RecordDoc[];
        const _rids = rids instanceof Array ? rids
            : (rids instanceof ObjectId) ? [rids]
                : [rids._id];
        if (!_rids.length) return null;
        if (rids instanceof Array || rids instanceof ObjectId || ObjectId.isValid(rids.toString())) {
            rdocs = await RecordModel.getMulti(domainId, { _id: { $in: _rids } }, { readPreference: 'primary' }).toArray();
        } else rdocs = [rids];
        if (!rdocs.length) return null;
        let source = `${domainId}/${rdocs[0].pid}`;
        let [pdoc] = await Promise.all([
            problem.get(domainId, rdocs[0].pid),
            task.deleteMany({ rid: { $in: _rids } }),
        ]);
        if (!pdoc) throw new ProblemNotFoundError(domainId, rdocs[0].pid);
        if (pdoc.reference) {
            pdoc = await problem.get(pdoc.reference.domainId, pdoc.reference.pid);
            if (!pdoc) throw new ProblemNotFoundError(domainId, rdocs[0].pid);
            source = `${pdoc.domainId}/${pdoc.docId}`;
        }
        meta = { ...meta, problemOwner: pdoc.owner };
        const ddoc = await DomainModel.get(pdoc.domainId);
        return await task.addMany(rdocs.map((rdoc) => {
            let type = 'judge';
            if (typeof pdoc.config === 'string') throw new Error(pdoc.config);
            if (pdoc.config.type === 'remote_judge' && rdoc.contest?.toHexString() !== '0'.repeat(24)) type = 'remotejudge';
            else if (meta?.type === 'generate') type = 'generate';
            return ({
                ...rdoc,
                ...(pdoc.config as any), // TODO deprecate this
                priority,
                type,
                rid: rdoc._id,
                domainId,
                config: {
                    ...(pdoc.config as any),
                    ...config,
                },
                data: pdoc.data,
                source,
                trusted: ddoc.isTrusted,
                meta,
            } as any);
        }));
    }

    static async add(
        domainId: string, pid: number, uid: number,
        lang: string, code: string, addTask: boolean,
        args: {
            contest?: ObjectId;
            practiceContest?: ObjectId;
            input?: string[];
            files?: Record<string, string>;
            hackTarget?: ObjectId;
            originalRid?: ObjectId;
            participationMode?: RecordDoc['participationMode'];
            classroomSession?: RecordDoc['classroomSession'];
            type: 'judge' | 'rejudge' | 'pretest' | 'hack' | 'generate';
            notify?: boolean;
        } = { type: 'judge' },
    ) {
        const submittedAt = new Date();
        if (args.practiceContest && (args.contest || !['judge', 'rejudge'].includes(args.type))) {
            throw new ValidationError('practiceContest');
        }
        const originalType = args.type;
        const candidateOriginal = originalType === 'rejudge' && args.originalRid
            ? await RecordModel.coll.findOne({ _id: args.originalRid, domainId })
            : null;
        const original = candidateOriginal && candidateOriginal.uid === uid
            && candidateOriginal.pid === pid && candidateOriginal.domainId === domainId
            ? candidateOriginal : null;
        const evidence: ProblemEvidence = original ? pick(original, [
            'problemRevisionId', 'canonicalProblemKey', 'problemOwner', 'problemReleased', 'problemFullScore',
        ]) : await resolveProblemEvidence(db, domainId, pid);
        const participationMode = original
            ? original.participationMode || 'unknown'
            : (args.practiceContest || originalType === 'pretest' ? 'practice' : args.participationMode || 'unknown');
        const data: RecordDoc = {
            status: STATUS.STATUS_WAITING,
            _id: new ObjectId(),
            uid,
            code,
            lang,
            pid,
            domainId,
            score: 0,
            time: 0,
            memory: 0,
            judgeTexts: [],
            compilerTexts: [],
            testCases: [],
            judger: null,
            judgeAt: null,
            rejudged: false,
            ...(original ? original.submittedAt ? { submittedAt: original.submittedAt } : {} : { submittedAt }),
            submissionKind: originalType === 'judge' ? 'normal' : originalType,
            participationMode,
            ...(original
                ? original.ingressVersion ? { ingressVersion: original.ingressVersion } : {}
                : { ingressVersion: SUBMISSION_INGRESS_VERSION }),
            ...(original ? original.submissionContext ? { submissionContext: original.submissionContext } : {} : {
                submissionContext: {
                    domainId,
                    uid,
                    pid,
                    ...(args.contest ? { contestId: args.contest.toHexString() } : {}),
                    ...(args.practiceContest ? { practiceContestId: args.practiceContest.toHexString() } : {}),
                },
            }),
            ...evidence,
            ...((original ? original.classroomSession : args.classroomSession)
                ? { classroomSession: structuredClone(original ? original.classroomSession : args.classroomSession) } : {}),
        };
        let isContest = !!args.contest;
        if (args.contest) data.contest = args.contest;
        if (args.practiceContest) data.practiceContest = args.practiceContest;
        if (args.files) data.files = args.files;
        if (args.hackTarget) data.hackTarget = args.hackTarget;
        if (args.notify) data.notify = true;
        if (args.type === 'rejudge') {
            args.type = 'judge';
            data.rejudged = true;
            if (original) data.originalRid = original._id;
        } else if (args.type === 'pretest') {
            data.input = args.input || [];
            isContest = false;
            data.contest = RecordModel.RECORD_PRETEST;
        } else if (args.type === 'generate') {
            data.contest = RecordModel.RECORD_GENERATE;
        }
        const res = await RecordModel.coll.insertOne(data);
        bus.broadcast('record/change', data);
        if (addTask) {
            const priority = await RecordModel.submissionPriority(uid, args.type === 'pretest' ? -20 : (isContest ? 50 : 0));
            await RecordModel.judge(domainId, data, priority, isContest ? { detail: false } : {}, {
                type: args.type,
                rejudge: data.rejudged,
            });
        }
        return res.insertedId;
    }

    static getMulti(domainId: string, query: any, options?: FindOptions) {
        if (domainId) query = { domainId, ...query };
        return RecordModel.coll.find(query, options);
    }

    static getMultiStat(domainId: string, query: any, sortBy: any = { _id: -1 }) {
        return RecordModel.collStat.find({ domainId, ...query }).sort(sortBy);
    }

    static async listStat(
        domainId: string, query: any, sortBy: any,
        page: number, pageSize: number, unique: boolean,
    ): Promise<[RecordStatDoc[], number, number]> {
        const pipeline: any[] = [
            { $match: { domainId, ...query } },
            { $sort: sortBy },
        ];
        if (unique) {
            pipeline.push(
                { $group: { _id: '$uid', doc: { $first: '$$ROOT' } } },
                { $replaceWith: '$doc' },
                { $sort: sortBy },
            );
        }
        pipeline.push({
            $facet: {
                docs: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }],
                count: [{ $count: 'value' }],
            },
        });
        const [result] = await RecordModel.collStat.aggregate(pipeline).toArray() as any[];
        const count = result?.count?.[0]?.value || 0;
        return [result?.docs || [], Math.floor((count + pageSize - 1) / pageSize), count];
    }

    static async update(
        domainId: string, _id: MaybeArray<ObjectId>,
        $set?: MatchKeysAndValues<RecordDoc>,
        $push?: PushOperator<RecordDoc>,
        $unset?: OnlyFieldsOfType<RecordDoc, any, true | '' | 1>,
        $inc?: Partial<Record<NumberKeys<RecordDoc>, number>>,
    ): Promise<RecordDoc | null> {
        const $update: UpdateFilter<RecordDoc> = {};
        const set = filterRecordUpdate($set as any);
        const push = filterRecordUpdate($push as any);
        const unset = filterRecordUpdate($unset as any);
        const inc = filterRecordUpdate($inc as any);
        if (set && Object.keys(set).length) $update.$set = set;
        if (push && Object.keys(push).length) $update.$push = push;
        if (unset && Object.keys(unset).length) $update.$unset = unset;
        if (inc && Object.keys(inc).length) $update.$inc = inc;
        if (_id instanceof Array) {
            if (!Object.keys($update).length) return null;
            await RecordModel.coll.updateMany({ _id: { $in: _id }, domainId }, $update);
            return null;
        }
        if (Object.keys($update).length) {
            return await RecordModel.coll.findOneAndUpdate(
                { _id, domainId },
                $update,
                { returnDocument: 'after' },
            );
        }
        return await RecordModel.coll.findOne({ _id }, { readPreference: 'primary' });
    }

    static async updateMulti(
        domainId: string, $match: Filter<RecordDoc>,
        $set?: MatchKeysAndValues<RecordDoc>,
        $push?: PushOperator<RecordDoc>,
        $unset?: OnlyFieldsOfType<RecordDoc, any, true | '' | 1>,
    ) {
        const $update: UpdateFilter<RecordDoc> = {};
        const set = filterRecordUpdate($set as any);
        const push = filterRecordUpdate($push as any);
        const unset = filterRecordUpdate($unset as any);
        if (set && Object.keys(set).length) $update.$set = set;
        if (push && Object.keys(push).length) $update.$push = push;
        if (unset && Object.keys(unset).length) $update.$unset = unset;
        if (!Object.keys($update).length) return 0;
        const res = await RecordModel.coll.updateMany({ domainId, ...$match }, $update);
        return res.modifiedCount;
    }

    static async reset(domainId: string, rid: MaybeArray<ObjectId>, isRejudge: boolean) {
        const rids = Array.isArray(rid) ? rid : [rid];
        const upd: any = {
            score: 0,
            status: STATUS.STATUS_WAITING,
            time: 0,
            memory: 0,
            testCases: [],
            subtasks: {},
            judgeTexts: [],
            compilerTexts: [],
            judgeAt: null,
            judger: null,
        };
        if (isRejudge) upd.rejudged = true;
        const [rdocs] = await Promise.all([
            RecordModel.coll.find({ _id: { $in: rids }, judgeAt: { $exists: true, $ne: null } }).toArray(),
            RecordModel.collStat.deleteMany({ _id: { $in: rids } }),
            task.deleteMany({ rid: { $in: rids } }),
        ]);
        if (rdocs.length) {
            await RecordModel.collHistory.insertMany(rdocs.map((rdoc) => ({
                ...pick(rdoc, [
                    'compilerTexts', 'judgeTexts', 'testCases', 'subtasks',
                    'score', 'time', 'memory', 'status', 'judgeAt', 'judger',
                ]),
                rid: rdoc._id,
                _id: new ObjectId(),
            })));
        }
        return RecordModel.update(domainId, rid, upd);
    }

    static count(domainId: string, query: any) {
        return RecordModel.coll.countDocuments({ domainId, ...query });
    }

    static async getList(
        domainId: string, rids: ObjectId[], fields?: (keyof RecordDoc)[],
    ): Promise<Record<string, Partial<RecordDoc>>> {
        const r: Record<string, RecordDoc> = {};
        rids = Array.from(new Set(rids));
        let cursor = RecordModel.coll.find({ domainId, _id: { $in: rids } });
        if (fields) cursor = cursor.project(buildProjection(fields));
        const rdocs = await cursor.toArray();
        for (const rdoc of rdocs) r[rdoc._id.toHexString()] = rdoc;
        return r;
    }
}

export async function apply(ctx: Context) {
    // Mark problem as deleted
    ctx.on('problem/delete', (domainId, docId) => Promise.all([
        RecordModel.coll.deleteMany({ domainId, pid: docId }),
        RecordModel.collStat.deleteMany({ domainId, pid: docId }),
    ]));
    ctx.on('domain/delete', (domainId) => Promise.all([
        RecordModel.coll.deleteMany({ domainId }),
        db.collection('contest.practiceAccess').deleteMany({ domainId }),
    ]));
    ctx.on('record/judge', async (rdoc, updated) => {
        if (rdoc.practiceContest) return;
        if (rdoc.contest?.toHexString().startsWith('0'.repeat(23))) return;
        if (rdoc.notify) {
            const pdoc = await Hydro.model.problem.get(rdoc.domainId, rdoc.pid);
            await MessageModel.send(1, rdoc.uid, JSON.stringify({
                message: 'Judge Result\n{0}: {1}',
                params: [pdoc.title, STATUS_TEXTS[rdoc.status]],
            }), MessageModel.FLAG_I18N);
        }
        if (rdoc.status === STATUS.STATUS_ACCEPTED && updated) {
            if (SystemModel.get('record.statMode') === 'unique') {
                await RecordModel.collStat.deleteMany({
                    _id: { $ne: rdoc._id },
                    uid: rdoc.uid,
                    pid: rdoc.pid,
                    domainId: rdoc.domainId,
                    ...rdoc.contest ? { contest: rdoc.contest } : { contest: { $exists: false } },
                });
            }
            await RecordModel.collStat.updateOne({
                _id: rdoc._id,
            }, {
                $set: {
                    domainId: rdoc.domainId,
                    pid: rdoc.pid,
                    uid: rdoc.uid,
                    time: rdoc.time,
                    memory: rdoc.memory,
                    length: rdoc.code?.length || 0,
                    lang: rdoc.lang,
                    ...rdoc.contest ? { contest: rdoc.contest } : {},
                },
            }, { upsert: true });
        }
    });
    await Promise.all([
        db.ensureIndexes(db.collection('contest.practiceAccess'), {
            key: { domainId: 1, tid: 1, uid: 1 }, name: 'practiceAccess', unique: true,
        }),
        db.ensureIndexes(
            RecordModel.coll,
            { key: { domainId: 1, practiceContest: 1, uid: 1, pid: 1, _id: -1 }, name: 'practice' },
            { key: { domainId: 1, pid: 1 }, name: 'delete' },
            { key: { domainId: 1, contest: 1, _id: -1 }, name: 'basic' },
            { key: { domainId: 1, contest: 1, uid: 1, _id: -1 }, name: 'withUser' },
            { key: { domainId: 1, contest: 1, pid: 1, _id: -1 }, name: 'withProblem' },
            { key: { domainId: 1, contest: 1, pid: 1, uid: 1, _id: -1 }, name: 'withUserAndProblem' },
            { key: { domainId: 1, contest: 1, status: 1, _id: -1 }, name: 'withStatus' },
        ),
        db.ensureIndexes(
            RecordModel.collStat,
            { key: { domainId: 1, pid: 1, uid: 1, _id: -1 }, name: 'basic' },
            { key: { domainId: 1, pid: 1, uid: 1, time: 1 }, name: 'time' },
            { key: { domainId: 1, pid: 1, uid: 1, memory: 1 }, name: 'memory' },
            { key: { domainId: 1, pid: 1, uid: 1, length: 1 }, name: 'length' },
        ),
        db.ensureIndexes(
            RecordModel.collHistory,
            { key: { rid: 1, _id: -1 }, name: 'basic' },
        ),
    ]);
}
global.Hydro.model.record = RecordModel;
