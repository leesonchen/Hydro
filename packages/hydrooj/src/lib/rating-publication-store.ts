/* eslint-disable no-await-in-loop */
import { createHash, randomUUID } from 'node:crypto';
import { PRIV } from '@hydrooj/common/permission';

export type RatingAlgorithm = 'legacy' | 'v2_trial';
export interface RatingConfig { algorithm: RatingAlgorithm; domains: string[]; revision: number }
export interface RatingPointer {
    domainId: string;
    algorithm: RatingAlgorithm;
    runId: string;
    version: string;
    updatedAt: number;
    previous?: Omit<RatingPointer, 'previous'>;
}
export interface RatingRow {
    uid: number;
    rp: number;
    rpInfo: Record<string, number>;
    rank: number | null;
    level: number;
    join: boolean;
    visible: boolean;
    rating?: number | null;
    ratedEvents?: number;
    achievement?: number;
    tier?: string | null;
    tierName?: string | null;
}
export interface RatingProblemDifficulty {
    domainId: string;
    runId: string;
    pid: number | string;
    d: number;
    se: number | null;
    students: number;
    pos: number;
    neg: number;
    status: 'ok' | 'degenerate' | 'nonconverged';
    provisionalLike: boolean;
}
export interface RatingJob {
    _id: string;
    domainId: string;
    algorithm: RatingAlgorithm;
    configRevision: number;
    manual: boolean;
    operator: number;
    asOf: number;
    status: 'queued' | 'running' | 'ready' | 'complete' | 'failed' | 'superseded';
    operation?: 'publish' | 'rollback';
    token: string;
    expectedVersion: string | null;
    previous?: RatingPointer;
    error?: string;
    completedAt?: number;
    [key: string]: any;
}
export interface RatingReceipt {
    outcome: 'committed' | 'failed' | 'superseded';
    operation: 'publish' | 'rollback';
    at: number;
    pointer?: RatingPointer;
    error?: string;
    unpublishedLegacy?: boolean;
}
export interface PublicationDatabase { collection(name: string): any }
declare module '../service/db' {
    interface Collections {
        rating_publication_runs: RatingJob;
        rating_publication_users: RatingRow & { domainId: string, runId: string };
        rating_publication_problems: RatingProblemDifficulty;
    }
}
export const RATING_COLLECTIONS = { runs: 'rating_publication_runs', users: 'rating_publication_users', problems: 'rating_publication_problems' } as const;
const CONTROL_ID = 'rating.publication';
const QUEUE_LEASE_MS = 30 * 60 * 1000;
const EXECUTION_LEASE_MS = 90 * 1000;
const scopeKey = (domainId: string) => Buffer.from(domainId).toString('base64url');
const hash = (rows: unknown) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

/** Configuration and publication pointers share one document, so stale jobs cannot apply new settings. */
export class RatingPublicationStore {
    constructor(public database: PublicationDatabase, private now = () => Date.now()) { }

    private async control() {
        const coll = this.database.collection('system');
        await coll.updateOne({ _id: CONTROL_ID }, { $setOnInsert: { value: {
            algorithm: 'legacy', domains: ['exam'], revision: 0, active: {}, locks: {}, receipts: {},
        } } }, { upsert: true });
        return (await coll.findOne({ _id: CONTROL_ID })).value;
    }

    async ensureIndexes() {
        await this.database.collection(RATING_COLLECTIONS.users).createIndex({ domainId: 1, runId: 1, uid: 1 }, { unique: true });
        await this.database.collection(RATING_COLLECTIONS.users).createIndex({ domainId: 1, runId: 1, join: 1, visible: 1, rp: -1, uid: 1 });
        await this.database.collection(RATING_COLLECTIONS.problems).createIndex({ domainId: 1, runId: 1, pid: 1 }, { unique: true });
        await this.database.collection(RATING_COLLECTIONS.runs).createIndex({ domainId: 1, asOf: -1 });
    }

    async config(): Promise<RatingConfig> {
        // Reading an installation before its first publication does not create configuration.
        const doc = await this.database.collection('system').findOne({ _id: CONTROL_ID });
        return doc ? { algorithm: doc.value.algorithm, domains: doc.value.domains, revision: doc.value.revision }
            : { algorithm: 'legacy', domains: ['exam'], revision: 0 };
    }

    async configure(algorithm: RatingAlgorithm, domains: string[]): Promise<RatingConfig> {
        if (!['legacy', 'v2_trial'].includes(algorithm)) throw new Error('请选择旧版或 V2 试用版');
        if (!Array.isArray(domains) || domains.some((id) => typeof id !== 'string' || !id.trim())) throw new Error('试用域列表无效');
        const selected = [...new Set(domains.map((id) => id.trim()))].sort();
        if (algorithm === 'v2_trial' && !selected.length) throw new Error('请选择至少一个 V2 试用域');
        const found = await this.database.collection('domain').find({ _id: { $in: selected } }, { projection: { _id: 1 } }).toArray();
        if (found.length !== selected.length) throw new Error('试用域不存在，请检查域 ID');
        await this.control();
        const updated = await this.database.collection('system').findOneAndUpdate({ _id: CONTROL_ID }, {
            $set: { 'value.algorithm': algorithm, 'value.domains': selected }, $inc: { 'value.revision': 1 },
        }, { returnDocument: 'after' });
        return { algorithm, domains: selected, revision: updated.value.revision };
    }

    desired(config: RatingConfig, domainId: string): RatingAlgorithm {
        return config.algorithm === 'v2_trial' && config.domains.includes(domainId) ? 'v2_trial' : 'legacy';
    }

    async active(domainId: string): Promise<RatingPointer | null> {
        const doc = await this.database.collection('system').findOne({ _id: CONTROL_ID }, {
            projection: { [`value.active.${scopeKey(domainId)}`]: 1 },
        });
        return doc?.value?.active?.[scopeKey(domainId)] || null;
    }

    async begin(domainId: string, manual: boolean, operator = 0, operation: 'publish' | 'rollback' = 'publish'): Promise<RatingJob> {
        if (!await this.database.collection('domain').findOne({ _id: domainId })) throw new Error('域不存在');
        const ctl = await this.control();
        const key = scopeKey(domainId);
        const previous: RatingPointer = ctl.active[key] || null;
        const algorithm = manual ? this.desired(ctl, domainId) : previous?.algorithm || 'legacy';
        const token = randomUUID();
        const job: RatingJob = { _id: randomUUID(), domainId, algorithm, configRevision: ctl.revision,
            manual, operator, operation, asOf: this.now(), status: 'queued', token, expectedVersion: previous?.version || null, previous };
        const acquired = await this.database.collection('system').updateOne({ _id: CONTROL_ID,
            'value.revision': ctl.revision,
            ...(previous ? { [`value.active.${key}.version`]: previous.version } : { [`value.active.${key}`]: { $exists: false } }),
            $or: [{ [`value.locks.${key}`]: { $exists: false } }, { [`value.locks.${key}.expiresAt`]: { $lte: this.now() } }],
        }, { $set: { [`value.locks.${key}`]: { token, runId: job._id,
            phase: operation === 'rollback' ? 'executing' : 'queued',
            expiresAt: this.now() + (operation === 'rollback' ? EXECUTION_LEASE_MS : QUEUE_LEASE_MS) } } });
        if (!acquired.matchedCount) throw new Error('该域正在重算或配置已变化，请稍后重试');
        try {
            await this.database.collection(RATING_COLLECTIONS.runs).insertOne(job);
        } catch (error) {
            await this.release(job);
            throw error;
        }
        return job;
    }

    /** Claim the execution lease before changing the run, so a crash in either step expires promptly. */
    async claim(job: RatingJob) {
        const lock = `value.locks.${scopeKey(job.domainId)}`;
        const claimed = await this.database.collection('system').updateOne({ _id: CONTROL_ID,
            [`${lock}.token`]: job.token, [`${lock}.expiresAt`]: { $gt: this.now() },
            $or: [{ [`${lock}.phase`]: 'queued' }, { [`${lock}.phase`]: { $exists: false } }],
        }, { $set: { [`${lock}.phase`]: 'executing', [`${lock}.expiresAt`]: this.now() + EXECUTION_LEASE_MS } });
        if (!claimed.matchedCount) throw new Error('该重算任务已执行或失效');
        const running = await this.database.collection(RATING_COLLECTIONS.runs).updateOne({ _id: job._id,
            status: 'queued', operation: { $ne: 'rollback' },
        }, { $set: { status: 'running' } });
        if (!running.matchedCount) throw new Error('该重算任务已执行或失效');
    }

    async renew(job: RatingJob) {
        const lock = `value.locks.${scopeKey(job.domainId)}`;
        const renewed = await this.database.collection('system').updateOne({ _id: CONTROL_ID,
            [`${lock}.token`]: job.token, [`${lock}.expiresAt`]: { $gt: this.now() },
        }, [{ $set: { [`${lock}.phase`]: 'executing', [`${lock}.expiresAt`]: {
            $cond: [{ $eq: [`$${lock}.phase`, 'executing'] },
                { $max: [`$${lock}.expiresAt`, this.now() + EXECUTION_LEASE_MS] }, this.now() + EXECUTION_LEASE_MS],
        } } }]);
        if (!renewed.matchedCount) throw new Error('重算锁已失效，本批次不能发布');
    }

    async leaseAlive(job: RatingJob) {
        const lock = `value.locks.${scopeKey(job.domainId)}`;
        return !!await this.database.collection('system').findOne({ _id: CONTROL_ID,
            [`${lock}.token`]: job.token, [`${lock}.expiresAt`]: { $gt: this.now() },
        }, { projection: { _id: 1 } });
    }

    async queueLeaseAlive(job: RatingJob) {
        const lock = `value.locks.${scopeKey(job.domainId)}`;
        return !!await this.database.collection('system').findOne({ _id: CONTROL_ID,
            [`${lock}.token`]: job.token, [`${lock}.expiresAt`]: { $gt: this.now() },
            $or: [{ [`${lock}.phase`]: 'queued' }, { [`${lock}.phase`]: { $exists: false } }],
        }, { projection: { _id: 1 } });
    }

    async release(job: RatingJob) {
        const lock = `value.locks.${scopeKey(job.domainId)}`;
        await this.database.collection('system').updateOne({ _id: CONTROL_ID, [`${lock}.token`]: job.token }, { $unset: { [lock]: '' } });
    }

    private receiptPath(job: Pick<RatingJob, '_id' | 'domainId'>) {
        return `value.receipts.${scopeKey(job.domainId)}.${scopeKey(job._id)}`;
    }

    async receipt(job: Pick<RatingJob, '_id' | 'domainId'>): Promise<RatingReceipt | null> {
        const path = this.receiptPath(job);
        const doc = await this.database.collection('system').findOne({ _id: CONTROL_ID }, { projection: { [path]: 1 } });
        return doc?.value?.receipts?.[scopeKey(job.domainId)]?.[scopeKey(job._id)] || null;
    }

    /** Metadata is repairable; the receipt co-committed with the pointer is authoritative. */
    async reconcile(job: Pick<RatingJob, '_id' | 'domainId'>): Promise<RatingReceipt | null> {
        const receipt = await this.receipt(job);
        if (!receipt) return null;
        const committed = receipt.outcome === 'committed';
        const rollback = receipt.operation === 'rollback';
        await this.database.collection(RATING_COLLECTIONS.runs).updateOne({ _id: job._id, domainId: job.domainId,
            ...(!committed ? { status: { $nin: receipt.unpublishedLegacy ? ['superseded'] : ['complete', 'superseded'] } } : {}),
        }, { $set: {
            status: committed ? (rollback ? 'superseded' : 'complete') : receipt.outcome,
            completedAt: receipt.at,
            ...(committed ? { publishedAt: receipt.at, ...(rollback ? { restoredRunId: receipt.pointer.runId } : {}) }
                : { error: receipt.error }),
        }, ...(committed ? { $unset: { error: '' } } : {}) });
        return receipt;
    }

    async fail(job: RatingJob, error: Error, outcome: 'failed' | 'superseded' = 'failed', expiredOnly = false): Promise<RatingReceipt | null> {
        const lock = `value.locks.${scopeKey(job.domainId)}`;
        const path = this.receiptPath(job);
        const receipt: RatingReceipt = { outcome, operation: job.operation || 'publish', at: this.now(), error: error.message };
        const unpublishedLegacy = job.status === 'complete' && !job.referenceOnly;
        // Cancellation and publication contend on the same lock and receipt in one document.
        const result = await this.database.collection('system').updateOne({ _id: CONTROL_ID,
            [`${lock}.token`]: job.token, [`${lock}.runId`]: job._id, [path]: { $exists: false },
            [`value.active.${scopeKey(job.domainId)}.runId`]: { $ne: job._id },
            [`value.active.${scopeKey(job.domainId)}.previous.runId`]: { $ne: job._id },
            ...(expiredOnly ? { [`${lock}.expiresAt`]: { $lte: this.now() } } : {}),
        }, { $set: { [path]: { ...receipt, ...(unpublishedLegacy ? { unpublishedLegacy: true } : {}) } }, $unset: { [lock]: '' } });
        if (!result.matchedCount && !unpublishedLegacy && !await this.receipt(job)) {
            // If another job owns the lock, this old token can never publish. Never clear its replacement's lock.
            await this.database.collection('system').updateOne({ _id: CONTROL_ID,
                [`${lock}.token`]: { $ne: job.token }, [path]: { $exists: false },
                [`value.active.${scopeKey(job.domainId)}.runId`]: { $ne: job._id },
                [`value.active.${scopeKey(job.domainId)}.previous.runId`]: { $ne: job._id },
            }, { $set: { [path]: receipt } });
        }
        return this.reconcile(job);
    }

    /** Pre-upgrade writers called verified-but-unpublished snapshots complete. Only their matching lock proves they are pending. */
    async legacyPendingJobs(): Promise<RatingJob[]> {
        const doc = await this.database.collection('system').findOne({ _id: CONTROL_ID }, { projection: { 'value.locks': 1 } });
        const locks: any[] = Object.values(doc?.value?.locks || {});
        const ids = locks.filter((lock) => !lock.phase || lock.legacyReady).map((lock) => lock.runId);
        if (!ids.length) return [];
        return this.database.collection(RATING_COLLECTIONS.runs).find({ _id: { $in: ids },
            status: 'complete', referenceOnly: { $ne: true }, publishedAt: { $exists: false },
        }).toArray();
    }

    async normalizeLegacyLease(job: RatingJob) {
        const lock = `value.locks.${scopeKey(job.domainId)}`;
        const key = scopeKey(job.domainId);
        const result = await this.database.collection('system').updateOne({ _id: CONTROL_ID,
            [`${lock}.token`]: job.token, [`${lock}.runId`]: job._id,
            [this.receiptPath(job)]: { $exists: false },
            [`value.active.${key}.runId`]: { $ne: job._id }, [`value.active.${key}.previous.runId`]: { $ne: job._id },
        }, { $set: { [`${lock}.phase`]: 'executing', [`${lock}.legacyReady`]: true },
        $min: { [`${lock}.expiresAt`]: this.now() + EXECUTION_LEASE_MS } });
        return !!result.matchedCount;
    }

    async writeRows(job: RatingJob, rows: RatingRow[], diagnostics: any, extra: Record<string, any> = {}) {
        await this.renew(job);
        if (new Set(rows.map((row) => row.uid)).size !== rows.length
            || rows.some((row) => !Number.isSafeInteger(row.uid) || row.uid <= 1 || !Number.isFinite(row.rp) || row.rp < 0)) {
            throw new Error('评分结果包含重复用户或无效数值');
        }
        const sorted = [...rows].sort((a, b) => a.uid - b.uid);
        for (let i = 0; i < sorted.length; i += 500) {
            await this.renew(job);
            await this.database.collection(RATING_COLLECTIONS.users).insertMany(sorted.slice(i, i + 500).map((row) => ({
                domainId: job.domainId, runId: job._id, ...row,
            })));
        }
        const saved = await this.database.collection(RATING_COLLECTIONS.users).find({ domainId: job.domainId, runId: job._id },
            { projection: { _id: 0, domainId: 0, runId: 0 } }).sort({ uid: 1 }).toArray();
        if (hash(saved) !== hash(sorted)) throw new Error('评分写入校验失败');
        const completed = await this.database.collection(RATING_COLLECTIONS.runs).updateOne({ _id: job._id,
            status: { $in: ['queued', 'running'] },
        }, {
            $set: { ...extra, status: job.referenceOnly ? 'complete' : 'ready', calculatedAt: this.now(),
                ...(job.referenceOnly ? { completedAt: this.now() } : {}),
                count: rows.length, outputHash: hash(sorted), diagnostics },
        });
        if (!completed.matchedCount) throw new Error('评分任务已失效，不能完成快照');
    }

    async writeProblemDifficulties(job: RatingJob, difficulties: Omit<RatingProblemDifficulty, 'domainId' | 'runId'>[]) {
        await this.renew(job);
        if (new Set(difficulties.map((row) => row.pid)).size !== difficulties.length
            || difficulties.some((row) => !Number.isFinite(row.d)
                || !['ok', 'degenerate', 'nonconverged'].includes(row.status))) {
            throw new Error('题目难度结果包含重复题目或无效数值');
        }
        const coll = this.database.collection(RATING_COLLECTIONS.problems);
        if (difficulties.length) {
            await coll.insertMany(difficulties.map((difficulty) => ({
                domainId: job.domainId, runId: job._id, ...difficulty,
            })));
        }
        const saved = await coll.find({ domainId: job.domainId, runId: job._id }, {
            projection: { _id: 0, domainId: 0, runId: 0 },
        }).toArray();
        const sort = (rows: typeof difficulties) => [...rows].sort((a, b) => String(a.pid).localeCompare(String(b.pid)));
        if (hash(sort(saved)) !== hash(sort(difficulties))) throw new Error('题目难度写入校验失败');
    }

    async problemDifficulties(domainId: string, pids: (number | string)[], pointer?: RatingPointer | null): Promise<RatingProblemDifficulty[]> {
        const active = pointer === undefined ? await this.active(domainId) : pointer;
        if (!active || active.algorithm !== 'v2_trial' || !pids.length) return [] as RatingProblemDifficulty[];
        return this.database.collection(RATING_COLLECTIONS.problems).find({
            domainId, runId: active.runId, pid: { $in: pids },
        }).toArray();
    }

    async publish(job: RatingJob, fallbackPrevious?: RatingPointer) {
        const prior = await this.receipt(job);
        if (prior?.outcome === 'committed') return prior.pointer;
        if (prior) throw new Error(prior.error || '本批次已失效');
        await this.renew(job);
        const run = await this.database.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id, domainId: job.domainId,
            status: 'ready', referenceOnly: { $ne: true },
        });
        if (!run) throw new Error('评分批次尚未完成');
        const key = scopeKey(job.domainId);
        const previous = job.previous || fallbackPrevious;
        const pointer: RatingPointer = { domainId: job.domainId, algorithm: job.algorithm, runId: job._id,
            version: randomUUID(), updatedAt: this.now(), ...(previous ? { previous: {
                domainId: previous.domainId, algorithm: previous.algorithm, runId: previous.runId,
                version: previous.version, updatedAt: previous.updatedAt,
            } } : {}) };
        const filter: any = { _id: CONTROL_ID, [`value.locks.${key}.token`]: job.token,
            [`value.locks.${key}.expiresAt`]: { $gt: this.now() }, [this.receiptPath(job)]: { $exists: false },
            ...(job.expectedVersion ? { [`value.active.${key}.version`]: job.expectedVersion }
                : { [`value.active.${key}`]: { $exists: false } }),
            ...(job.manual ? { 'value.revision': job.configRevision } : {}),
        };
        try {
            const result = await this.database.collection('system').updateOne(filter, {
                $set: { [`value.active.${key}`]: pointer,
                    [this.receiptPath(job)]: { outcome: 'committed', operation: 'publish', at: pointer.updatedAt, pointer } },
                $unset: { [`value.locks.${key}`]: '' },
            });
            if (!result.matchedCount) {
                await this.fail(job, new Error('配置或活动批次已变化，未应用本批次'), 'superseded');
                throw new Error('配置或活动批次已变化，请重新手工重算');
            }
            await this.reconcile(job);
            return pointer;
        } catch (error) {
            const confirmed = await this.receipt(job);
            if (confirmed?.outcome === 'committed') {
                // Recovery will retry metadata if its write, rather than the pointer commit, failed.
                await this.reconcile(job).catch(() => {});
                return confirmed.pointer;
            }
            throw error;
        }
    }

    async rollback(domainId: string): Promise<RatingPointer> {
        const job = await this.begin(domainId, false, 0, 'rollback');
        try {
            await this.renew(job);
            const active = job.previous;
            const previous = active?.previous;
            const snapshot = previous ? await this.database.collection(RATING_COLLECTIONS.runs).findOne({
                _id: previous.runId, domainId,
            }) : null;
            const verified = snapshot?.status === 'complete' || (snapshot?.status === 'ready'
                && (await this.receipt({ _id: previous.runId, domainId }))?.outcome === 'committed');
            if (!verified) throw new Error('没有可回退的完整批次');
            const key = scopeKey(domainId);
            const pointer: RatingPointer = { ...previous, version: randomUUID(), updatedAt: this.now(), previous: {
                domainId: active.domainId, algorithm: active.algorithm, runId: active.runId,
                version: active.version, updatedAt: active.updatedAt,
            } };
            const changed = await this.database.collection('system').updateOne({ _id: CONTROL_ID,
                [`value.active.${key}.version`]: active.version, [`value.locks.${key}.token`]: job.token,
                [`value.locks.${key}.expiresAt`]: { $gt: this.now() }, [this.receiptPath(job)]: { $exists: false },
            }, { $set: { [`value.active.${key}`]: pointer,
                [this.receiptPath(job)]: { outcome: 'committed', operation: 'rollback', at: pointer.updatedAt, pointer } },
            $unset: { [`value.locks.${key}`]: '' } });
            if (!changed.matchedCount) throw new Error('活动批次已变化，回退未生效');
            await this.reconcile(job);
            return pointer;
        } catch (error) {
            const confirmed = await this.receipt(job);
            if (confirmed?.outcome === 'committed') {
                await this.reconcile(job).catch(() => {});
                return confirmed.pointer;
            }
            const receipt = await this.fail(job, error);
            if (receipt?.outcome === 'committed') return receipt.pointer;
            throw error;
        }
    }

    async rows(domainId: string, uids: number[], pointer?: RatingPointer): Promise<{ active: RatingPointer | null, rows: RatingRow[] }> {
        const active = pointer === undefined ? await this.active(domainId) : pointer;
        if (!active) return { active, rows: [] as RatingRow[] };
        const rows = await this.database.collection(RATING_COLLECTIONS.users).find({ domainId, runId: active.runId, uid: { $in: uids } }).toArray();
        return { active, rows };
    }

    async ranking(domainId: string, joinedOnly = true) {
        const active = await this.active(domainId);
        let liveUids: number[];
        let liveRanks: Map<number, number> | null = null;
        if (active) {
            const scored = await this.database.collection(RATING_COLLECTIONS.users).distinct('uid', { domainId, runId: active.runId, visible: true, rp: { $gt: 0 } });
            const live = await this.database.collection('user').find({ _id: { $in: scored },
                priv: { $bitsAllSet: PRIV.PRIV_USER_PROFILE } }, { projection: { _id: 1 } }).toArray();
            liveUids = live.map((user) => user._id);
            liveUids = (await this.database.collection('domain.user').find({ domainId,
                uid: { $in: liveUids }, ...(joinedOnly ? { join: true } : {}),
            }, { projection: { uid: 1 } }).toArray()).map((member) => member.uid);
            // A snapshot's stored ranks cannot track users leaving/rejoining the domain.
            // Resolve the current public rank (with ties) from the same visible population
            // used by the cursor. Snapshot rows and scores remain immutable.
            const eligible = await this.database.collection(RATING_COLLECTIONS.users).find({
                domainId, runId: active.runId, uid: { $in: liveUids }, visible: true, rp: { $gt: 0 },
            }, { projection: { uid: 1, rp: 1 } }).sort({ rp: -1, uid: 1 }).toArray();
            liveRanks = new Map();
            let rank = 0;
            let lastRp = -1;
            for (let i = 0; i < eligible.length; i++) {
                if (eligible[i].rp !== lastRp) rank = i + 1;
                liveRanks.set(eligible[i].uid, rank);
                lastRp = eligible[i].rp;
            }
        }
        const cursor = active ? this.database.collection(RATING_COLLECTIONS.users).find({
            domainId, runId: active.runId, uid: { $gt: 1, $in: liveUids }, visible: true, rp: { $gt: 0 },
        }).sort({ rp: -1, uid: 1 }) : this.database.collection('domain.user').find({
            domainId, uid: { $gt: 1 }, rp: { $gt: 0 }, ...(joinedOnly ? { join: true } : {}),
        }).sort({ rp: -1, uid: 1 });
        return { active, cursor, liveRanks };
    }

    async deleteDomain(domainId: string) {
        const key = scopeKey(domainId);
        await this.database.collection('system').updateOne({ _id: CONTROL_ID }, {
            $unset: { [`value.active.${key}`]: '', [`value.locks.${key}`]: '', [`value.receipts.${key}`]: '' },
            $pull: { 'value.domains': domainId }, $inc: { 'value.revision': 1 },
        });
        await this.database.collection(RATING_COLLECTIONS.users).deleteMany({ domainId });
        await this.database.collection(RATING_COLLECTIONS.problems).deleteMany({ domainId });
        await this.database.collection(RATING_COLLECTIONS.runs).deleteMany({ domainId });
    }

    async prune(domainId: string) {
        const active = await this.active(domainId);
        const keep = new Set([active?.runId, active?.previous?.runId].filter(Boolean));
        for (const algorithm of ['legacy', 'v2_trial']) {
            const recent = await this.database.collection(RATING_COLLECTIONS.runs).find({ domainId, algorithm, status: 'complete' })
                .sort({ asOf: -1 }).limit(10).toArray();
            for (const run of recent) { keep.add(run._id); if (run.legacyRunId) keep.add(run.legacyRunId); }
        }
        const linked = await this.database.collection(RATING_COLLECTIONS.runs).find({ domainId, _id: { $in: [...keep] } },
            { projection: { legacyRunId: 1 } }).toArray();
        for (const run of linked) if (run.legacyRunId) keep.add(run.legacyRunId);
        const expired = await this.database.collection(RATING_COLLECTIONS.runs).find({ domainId,
            _id: { $nin: [...keep] }, status: { $in: ['complete', 'failed', 'superseded'] },
            asOf: { $lt: this.now() - 30 * 86400000 },
        }, { projection: { _id: 1 } }).toArray();
        const ids = expired.map((run) => run._id);
        if (!ids.length) return;
        await this.database.collection(RATING_COLLECTIONS.users).deleteMany({ domainId, runId: { $in: ids } });
        await this.database.collection(RATING_COLLECTIONS.problems).deleteMany({ domainId, runId: { $in: ids } });
        await this.database.collection(RATING_COLLECTIONS.runs).deleteMany({ domainId, _id: { $in: ids } });
        await this.database.collection('system').updateOne({ _id: CONTROL_ID }, {
            $unset: Object.fromEntries(ids.map((_id) => [this.receiptPath({ _id, domainId }), ''])),
        });
    }
}

export function ratingOverlay(pointer: RatingPointer, row?: RatingRow) {
    const v2 = pointer.algorithm === 'v2_trial';
    return {
        rp: row?.rp || 0, rpInfo: row?.rpInfo || {}, rank: row?.rank ?? null, level: v2 ? 0 : row?.level || 0,
        ratingAlgorithm: pointer.algorithm, ratingUpdatedAt: pointer.updatedAt,
        rating: v2 ? row?.rating ?? null : null, ratedEvents: v2 ? row?.ratedEvents || 0 : 0,
        ratingAchievement: v2 ? row?.achievement || 0 : 0,
        ratingTier: v2 ? row?.tier || null : null, ratingTierName: v2 ? row?.tierName || null : null,
    };
}
