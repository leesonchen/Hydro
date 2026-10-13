/* eslint-disable no-await-in-loop */
import { randomUUID } from 'node:crypto';
import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import { Context } from '../context';
import {
    RatingJob, RatingPointer, RatingPublicationStore, RatingRow, RATING_COLLECTIONS,
} from '../lib/rating-publication-store';
import { TIERS } from '../lib/rating-v2/composite';
import { runShadowReplay } from '../lib/rating-v2/shadow-replay';
import { Logger } from '../logger';
import db from '../service/db';
import { PRIV } from './builtin';
import * as ContestModel from './contest';
import * as oplog from './oplog';
import ProblemModel from './problem';
import UserModel, { deleteUserCache } from './user';

export const ratingStore = new RatingPublicationStore(db);
const logger = new Logger('rating-publication');
const dateText = (value?: number) => (value ? moment(value).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss') : '—');

export async function configureRating(options: { algorithm: any, domains: string[] }, operator: number) {
    const config = await ratingStore.configure(options.algorithm, options.domains);
    await oplog.add({ type: 'rating.configure', operator, time: new Date(), config });
    return config;
}

export async function queueRatingApply(domainId: string, operator: number) {
    const job = await ratingStore.begin(domainId, true, operator);
    try {
        await db.collection('schedule').insertOne({ _id: new ObjectId(), type: 'schedule', subType: 'task.rating-publication',
            executeAfter: new Date(), runId: job._id });
        await oplog.add({ type: 'rating.applyQueued', operator, time: new Date(), domainId, runId: job._id });
        return { runId: job._id };
    } catch (error) {
        const result = await ratingStore.fail(job, error);
        if (result?.outcome === 'committed') return { runId: job._id };
        throw error;
    }
}

export async function rollbackRating(domainId: string, operator: number) {
    const active = await ratingStore.rollback(domainId);
    deleteUserCache(domainId);
    try {
        await oplog.add({ type: 'rating.rollback', operator, time: new Date(), domainId, runId: active.runId });
    } catch (error) { logger.error('Rollback succeeded but audit write failed for %s: %s', domainId, error.message); }
    return active;
}

async function members(domainId: string, uids: number[]) {
    const documents = await db.collection('domain.user').find({ domainId }).toArray();
    const byUid = new Map(documents.map((doc) => [doc.uid, doc]));
    const all = [...new Set([...documents.map((doc) => doc.uid), ...uids])].filter((uid) => Number.isSafeInteger(uid) && uid > 1);
    const users = await UserModel.coll.find({ _id: { $in: all } }, { projection: { _id: 1, priv: 1 } }).toArray();
    return users.map((user) => ({ uid: user._id, join: byUid.get(user._id)?.join === true,
        visible: !!(user.priv & PRIV.PRIV_USER_PROFILE) }));
}

export function rankRatingRows(rows: RatingRow[]) {
    const eligible = rows.filter((row) => row.visible && row.rp > 0).sort((a, b) => b.rp - a.rp || a.uid - b.uid);
    let lastRp = -1;
    let rank = 0;
    for (let i = 0; i < eligible.length; i++) {
        const row = eligible[i];
        if (row.rp !== lastRp) rank = i + 1;
        row.rank = rank;
        lastRp = row.rp;
    }
    return rows;
}

async function buildV2(job: RatingJob, report: (data: any) => void) {
    let docs: any[] = [];
    const options = { domainId: job.domainId, refDomain: job.domainId, asOf: job.asOf,
        eligibilityMode: 'trial' as const, poolId: job._id, write: false };
    // Public scoring follows the same result visibility policy as legacy RP.
    // A hidden cached best result may need a visible earlier record instead.
    const statuses = await db.collection('document.status').find({ domainId: job.domainId, docType: 10,
        rid: { $ne: null }, uid: { $gt: 0 } }, { projection: { uid: 1, docId: 1 } }).toArray();
    const visibleStatuses = await ProblemModel.resolveVisibleStatuses(job.domainId,
        [...new Set(statuses.map((status) => status.uid))], [...new Set(statuses.map((status) => status.docId as number))],
        (contest, uid) => ContestModel.canShowProblemStatus(null, uid, contest, false));
    const publicInputs = { collection(name: string) {
        const coll = db.collection(name as any);
        return new Proxy(coll, { get(target, key) {
            if (key === 'find') return (filter: any, ...args: any[]) => {
                if (name === 'document.status' && filter.docType === 10) return (async function* visible() {
                    for (const status of visibleStatuses) if (status.rid) yield status;
                }());
                if (name === 'document' && filter.docType === 30) return target.find({ $and: [filter, {
                    keepScoreboardHidden: { $ne: true }, $or: [{ lockAt: { $exists: false } }, { lockAt: null }, { unlocked: true }],
                }] }, ...args);
                return target.find(filter, ...args);
            };
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    } };
    const summary = await runShadowReplay(publicInputs, options, (data) => report(typeof data === 'string' ? { message: data } : data), (result) => { docs = result; });
    if (summary.contests.failed) throw new Error('V2 比赛计算失败，本批次未发布');
    const projections = new Map(docs.filter((doc) => doc.kind === 'projection').map((doc) => [doc.uid, doc]));
    const population = await members(job.domainId, [...projections.keys()]);
    const rows: RatingRow[] = population.map((member) => {
        const projection = member.visible ? projections.get(member.uid) : null;
        return { ...member, rp: (projection?.rpCents || 0) / 100,
            rpInfo: { problem: (projection?.problemCents || 0) / 100, contest: (projection?.contestCents || 0) / 100 },
            rank: null, level: 0, rating: projection?.rating ?? null, ratedEvents: projection?.ratedEvents || 0,
            achievement: projection?.a || 0, tier: projection?.tier || null,
            tierName: TIERS.find((tier) => tier.id === projection?.tier)?.name || null };
    });
    return { rows: rankRatingRows(rows), summary, parameters: options };
}

/** Both manual and daily work use the same fenced snapshot publisher. */
export async function executeRatingJob(job: RatingJob, report: (data: any) => void = () => {}) {
    await ratingStore.claim(job);
    let heartbeatError: Error;
    const heartbeat = setInterval(() => { ratingStore.renew(job).catch((error) => { heartbeatError = error; }); }, 30000);
    heartbeat.unref();
    try {
        await ratingStore.renew(job);
        // Import on execution to keep script registration and user models free of initialization cycles.
        const { calculateLegacyInDomain } = require('../script/rating') as typeof import('../script/rating');
        const legacy = await calculateLegacyInDomain(job.domainId, report);
        let previous: RatingPointer = job.previous;
        let legacyRunId: string;
        if (job.algorithm === 'v2_trial') {
            const reference: RatingJob = { ...job, _id: randomUUID(), algorithm: 'legacy', status: 'running', referenceOnly: true };
            await db.collection(RATING_COLLECTIONS.runs).insertOne(reference);
            try {
                await ratingStore.writeRows(reference, legacy.rows, legacy.summary);
            } catch (error) {
                await db.collection(RATING_COLLECTIONS.runs).updateOne({ _id: reference._id }, {
                    $set: { status: 'failed', completedAt: Date.now(), error: error.message },
                });
                throw error;
            }
            legacyRunId = reference._id;
            previous ||= { domainId: job.domainId, algorithm: 'legacy', runId: reference._id,
                updatedAt: job.asOf, version: randomUUID() };
        }
        const result = job.algorithm === 'legacy' ? legacy : await buildV2(job, report);
        if (heartbeatError) throw heartbeatError;
        await ratingStore.writeRows(job, result.rows, result.summary, {
            parameters: result.parameters || {}, modelVersion: job.algorithm === 'v2_trial' ? 'hydro-local-cf-v1/rp-policy-v2' : 'legacy-rp',
            ...(legacyRunId ? { legacyRunId } : {}),
        });
        if (heartbeatError) throw heartbeatError;
        const active = await ratingStore.publish(job, previous);
        deleteUserCache(job.domainId);
        await ratingStore.prune(job.domainId);
        await oplog.add({ type: 'rating.published', time: new Date(), operator: job.operator,
            domainId: job.domainId, algorithm: job.algorithm, runId: job._id });
        report({ message: `${job.domainId} 已应用 ${job.algorithm === 'legacy' ? '旧版' : 'V2 试用版'}：${result.rows.length} 名用户` });
        return active;
    } catch (error) {
        // The receipt survives later publications and proves this operation's commit, rather than today's head.
        const result = await ratingStore.receipt(job) || await ratingStore.fail(job, error);
        if (result?.outcome === 'committed') {
            await ratingStore.reconcile(job).catch((e) => logger.error('Deferred publication metadata: %s', e.message));
            deleteUserCache(job.domainId);
            return result.pointer;
        }
        throw error;
    } finally {
        clearInterval(heartbeat);
    }
}

export async function refreshRating(domainId: string, report: (data: any) => void = () => {}) {
    const job = await ratingStore.begin(domainId, false);
    return executeRatingJob(job, report);
}

export async function ratingDashboard() {
    const config = await ratingStore.config();
    const domains = await db.collection('domain').find({}, { projection: { _id: 1, name: 1 } }).sort({ _id: 1 }).toArray();
    const result = [];
    for (const domain of domains) {
        const domainId = domain._id;
        const active = await ratingStore.active(domainId);
        const savedRuns = await db.collection(RATING_COLLECTIONS.runs).find({ domainId, referenceOnly: { $ne: true } }).sort({ asOf: -1 }).limit(5).toArray();
        const runs = await Promise.all(savedRuns.map(async (run) => {
            const receipt = await ratingStore.receipt(run);
            if (!receipt) return run;
            return { ...run, status: receipt.outcome === 'committed'
                ? (receipt.operation === 'rollback' ? 'superseded' : 'complete') : receipt.outcome,
            completedAt: receipt.at, error: receipt.error };
        }));
        const latest = runs[0] || null;
        const comparisonRun = active?.algorithm === 'v2_trial'
            ? await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: active.runId })
            : await db.collection(RATING_COLLECTIONS.runs).findOne({ domainId, algorithm: 'v2_trial', status: 'complete' }, { sort: { asOf: -1 } });
        let comparison: any[] = [];
        if (comparisonRun) {
            const rows = await db.collection(RATING_COLLECTIONS.users).find({ domainId, runId: comparisonRun._id, visible: true })
                .sort({ rp: -1, uid: 1 }).limit(20).toArray();
            const old = comparisonRun.legacyRunId ? await db.collection(RATING_COLLECTIONS.users).find({
                domainId, runId: comparisonRun.legacyRunId, uid: { $in: rows.map((row) => row.uid) },
            }).toArray() : [];
            const oldMap = new Map(old.map((row) => [row.uid, row.rp]));
            comparison = rows.map((row) => ({ uid: row.uid, legacyRp: oldMap.get(row.uid) || 0,
                rp: row.rp, rating: row.rating, ratedEvents: row.ratedEvents, achievement: row.achievement, rank: row.rank, tier: row.tierName }));
        }
        result.push({ domainId, name: domain.name || domainId,
            active: active ? { ...active, updatedAtText: dateText(active.updatedAt) } : null,
            pending: ratingStore.desired(config, domainId) !== (active?.algorithm || 'legacy'),
            job: latest ? { status: latest.status, operation: latest.operation, error: latest.error, runId: latest._id } : null,
            runs: runs.map((run) => ({ ...run, asOfText: dateText(run.asOf), completedAtText: dateText(run.completedAt) })), comparison });
    }
    return { config, domains: result };
}

export async function recoverRatingJobs() {
    const jobs = [...await db.collection(RATING_COLLECTIONS.runs).find({ status: { $in: ['queued', 'running', 'ready'] }, referenceOnly: { $ne: true } }).toArray(),
        ...await ratingStore.legacyPendingJobs()];
    for (const job of jobs) {
        try {
            if (await ratingStore.reconcile(job)) continue;
            if (job.status === 'complete' && !await ratingStore.normalizeLegacyLease(job)) continue;
            if (!await ratingStore.leaseAlive(job)) {
                await ratingStore.fail(job, new Error('重算已中断或锁已过期，请重新重算'), 'failed', true);
                continue;
            }
            if (job.status === 'queued' && job.operation !== 'rollback' && await ratingStore.queueLeaseAlive(job)
                && !await db.collection('schedule').findOne({ subType: 'task.rating-publication', runId: job._id })) {
                await db.collection('schedule').insertOne({ _id: new ObjectId(), type: 'schedule', subType: 'task.rating-publication', executeAfter: new Date(), runId: job._id });
            }
        } catch (error) {
            logger.error('Deferred rating recovery for %s: %s', job.domainId, error.message);
        }
    }
}

export async function apply(ctx: Context) {
    await ratingStore.ensureIndexes();
    ctx.on('domain/delete', async (domainId) => {
        await ratingStore.deleteDomain(domainId);
        deleteUserCache(domainId);
    });
    await ctx.inject(['worker'], (c) => {
        c.on('app/started', () => c.worker.addHandler('task.rating-publication', async (task) => {
            const job = await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: task.runId, status: 'queued', operation: { $ne: 'rollback' } });
            if (!job) return;
            try {
                await executeRatingJob(job, (data) => logger.info('%o', data));
            } catch (error) {
                logger.error('Rating publication failed for %s: %s', job.domainId, error.message);
            }
        }));
    });
    ctx.on('app/started', () => {
        if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') return;
        recoverRatingJobs().catch((error) => logger.error('%s', error.message));
        ctx.interval(() => recoverRatingJobs().catch((error) => logger.error('%s', error.message)), 15000);
    });
}
