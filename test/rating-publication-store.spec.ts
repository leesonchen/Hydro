import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { after, before, beforeEach, test } from 'node:test';
import { PRIV } from '@hydrooj/common/permission';
import { RatingPublicationStore, RATING_COLLECTIONS } from '../packages/hydrooj/src/lib/rating-publication-store';

let server: MongoMemoryServer;
let client: MongoClient;
let db: any;
let store: RatingPublicationStore;
before(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    db = client.db('rating-publication-store');
});
after(async () => {
    await client?.close();
    await server?.stop();
});
beforeEach(async () => {
    for (const name of ['system', 'domain', RATING_COLLECTIONS.runs, RATING_COLLECTIONS.users, RATING_COLLECTIONS.problems]) await db.collection(name).deleteMany({});
    store = new RatingPublicationStore(db);
});

async function addDomain(domainId = 'exam') { await db.collection('domain').insertOne({ _id: domainId }); }
const row = (uid = 2, extra: any = {}) => ({ uid, rp: 1200, rpInfo: { accepted: 3 }, rank: 1, level: 2, join: true, visible: true, ...extra });
async function complete(domainId = 'exam', manual = true, rows = [row()]) {
    const job = await store.begin(domainId, manual, 7);
    await store.writeRows(job, rows, { source: job.algorithm });
    const pointer = await store.publish(job);
    return { job, pointer };
}

test('configuration saves desired settings without changing the active publication', async () => {
    await addDomain();
    assert.equal(await store.active('exam'), null);
    const config = await store.configure('v2_trial', ['exam']);
    assert.deepEqual(config, { algorithm: 'v2_trial', domains: ['exam'], revision: 1 });
    assert.equal(await store.active('exam'), null);
    assert.deepEqual(await store.config(), config);
});

test('manual publication applies a matching revision and rejects changed configuration', async () => {
    await addDomain();
    await store.configure('v2_trial', ['exam']);
    const matching = await store.begin('exam', true, 7);
    await store.writeRows(matching, [row()], {});
    const published = await store.publish(matching);
    assert.equal(published.algorithm, 'v2_trial');
    const stale = await store.begin('exam', true, 7);
    await store.writeRows(stale, [row(3)], {});
    await store.configure('legacy', []);
    await assert.rejects(store.publish(stale), /配置或活动批次已变化/);
    assert.equal((await store.active('exam'))?.runId, matching._id);
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: stale._id })).status, 'superseded');
});

test('daily publication retains the active algorithm while desired configuration is pending', async () => {
    await addDomain();
    const first = await complete('exam', true, [row()]);
    await store.configure('v2_trial', ['exam']);
    const daily = await store.begin('exam', false);
    assert.equal(daily.algorithm, first.pointer.algorithm);
    assert.equal(daily.configRevision, 1);
    await store.writeRows(daily, [row(3)], {});
    const next = await store.publish(daily);
    assert.equal(next.algorithm, 'legacy');
});

test('completed generations remain immutable and can be read through their pointer', async () => {
    await addDomain();
    const first = await complete('exam', true, [row(2)]);
    const second = await complete('exam', true, [row(3)]);
    assert.equal(await db.collection(RATING_COLLECTIONS.runs).countDocuments({ domainId: 'exam', status: 'complete' }), 2);
    assert.deepEqual((await store.rows('exam', [2], first.pointer)).rows.map((r) => r.uid), [2]);
    assert.deepEqual((await store.rows('exam', [3], second.pointer)).rows.map((r) => r.uid), [3]);
});

test('concurrent begin calls are fenced to one active job', async () => {
    await addDomain();
    const attempts = await Promise.allSettled([store.begin('exam', true), store.begin('exam', true)]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
    const first = attempts.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof store.begin>>> => result.status === 'fulfilled')!.value;
    await store.release(first);
});

test('expired leases cannot renew or publish', async () => {
    await addDomain();
    const job = await store.begin('exam', true);
    await store.writeRows(job, [], {});
    const lockKey = Buffer.from('exam').toString('base64url');
    await db.collection('system').updateOne({ _id: 'rating.publication' }, {
        $set: { [`value.locks.${lockKey}.expiresAt`]: Date.now() - 1 },
    });
    await assert.rejects(store.renew(job), /锁已失效/);
    await assert.rejects(store.publish(job), /锁已失效/);
    assert.equal(await store.active('exam'), null);
});

test('failing a replacement job keeps the active pointer unchanged', async () => {
    await addDomain();
    const first = await complete();
    const failing = await store.begin('exam', true);
    await store.fail(failing, new Error('fixture failure'));
    assert.equal((await store.active('exam'))?.runId, first.job._id);
    const failed = await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: failing._id });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'fixture failure');
});

test('rollback restores the previous run and its algorithm', async () => {
    await addDomain();
    const legacy = await complete('exam', true, [row(2)]);
    await store.configure('v2_trial', ['exam']);
    const v2 = await complete('exam', true, [row(3)]);
    assert.equal(v2.pointer.algorithm, 'v2_trial');
    const restored = await store.rollback('exam');
    assert.equal(restored.algorithm, legacy.pointer.algorithm);
    assert.equal(restored.runId, legacy.pointer.runId);
    assert.deepEqual((await store.rows('exam', [2], restored)).rows.map((r) => r.uid), [2]);
});

test('rollback acknowledges success when pointer commit succeeds but the response is lost', async () => {
    await addDomain();
    const first = await complete('exam', true, [row(2)]);
    await store.configure('v2_trial', ['exam']);
    await complete('exam', true, [row(3)]);
    const key = Buffer.from('exam').toString('base64url');
    let loseAck = true;
    const database = { collection(name: string) {
        const coll = db.collection(name);
        if (name !== 'system') return coll;
        return new Proxy(coll, { get(target, prop) {
            if (prop !== 'updateOne') return target[prop].bind(target);
            return async (...args: any[]) => {
                const result = await target.updateOne(...args);
                if (loseAck && Object.keys(args[1]?.$set || {}).includes(`value.active.${key}`)) {
                    loseAck = false;
                    throw new Error('acknowledgment lost after commit');
                }
                return result;
            };
        } });
    } };
    const uncertain = new RatingPublicationStore(database);
    const restored = await uncertain.rollback('exam');
    assert.equal(restored.runId, first.job._id);
    assert.equal(restored.algorithm, first.pointer.algorithm);
    assert.equal((await store.active('exam'))?.version, restored.version);
});

test('domain keys with dots and Unicode publish and read independently', async () => {
    const ids = ['exam.with.dot', '课程-例'];
    for (const domainId of ids) await addDomain(domainId);
    const results = await Promise.all(ids.map((domainId, i) => complete(domainId, true, [row(i + 2)])));
    for (let i = 0; i < ids.length; i++) {
        assert.equal((await store.active(ids[i]))?.runId, results[i].job._id);
        assert.equal((await store.rows(ids[i], [i + 2])).rows.length, 1);
    }
});

test('empty result generations complete and publish', async () => {
    await addDomain();
    const { job, pointer } = await complete('exam', true, []);
    const run = await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id });
    assert.equal(run.status, 'complete');
    assert.equal(run.count, 0);
    assert.equal((await store.rows('exam', [2], pointer)).rows.length, 0);
});

test('V2 difficulty snapshots follow the active publication pointer', async () => {
    await addDomain();
    await store.configure('v2_trial', ['exam']);
    const job = await store.begin('exam', true);
    await store.writeProblemDifficulties(job, [{ pid: 7, d: 1680.5, se: 42.1, students: 24, pos: 8, neg: 16,
        status: 'ok', provisionalLike: true }]);
    await store.writeRows(job, [row()], {});
    const pointer = await store.publish(job);
    assert.deepEqual(await store.problemDifficulties('exam', [7], pointer), [{
        _id: (await db.collection(RATING_COLLECTIONS.problems).findOne({ domainId: 'exam', runId: job._id }))._id,
        domainId: 'exam', runId: job._id, pid: 7, d: 1680.5, se: 42.1, students: 24, pos: 8, neg: 16,
        status: 'ok', provisionalLike: true,
    }]);
    const next = await store.begin('exam', true);
    await store.writeProblemDifficulties(next, [{ pid: 7, d: 1800, se: null, students: 24, pos: 24, neg: 0,
        status: 'degenerate', provisionalLike: false }]);
    // Unpublished snapshots never replace the active difficulty.
    assert.equal((await store.problemDifficulties('exam', [7]))[0].d, 1680.5);
    await store.writeRows(next, [row()], {});
    await store.publish(next);
    assert.equal((await store.problemDifficulties('exam', [7]))[0].d, 1800);
    await store.rollback('exam');
    assert.equal((await store.problemDifficulties('exam', [7]))[0].d, 1680.5);
    await store.deleteDomain('exam');
    assert.equal(await db.collection(RATING_COLLECTIONS.problems).countDocuments({ domainId: 'exam' }), 0);
});

test('write readback corruption is rejected before completion', async () => {
    await addDomain();
    const job = await store.begin('exam', true);
    let corrupt = true;
    const proxied = new RatingPublicationStore({ collection(name: string) {
        const coll = db.collection(name);
        if (name !== RATING_COLLECTIONS.users) return coll;
        return new Proxy(coll, { get(target, property) {
            if (property !== 'find') return target[property].bind(target);
            return (...args: any[]) => {
                const cursor = target.find(...args);
                return {
                    sort(spec: any) { cursor.sort(spec); return this; },
                    async toArray() {
                        const values = await cursor.toArray();
                        if (corrupt && values.length) { values[0].rp += 1; corrupt = false; }
                        return values;
                    },
                };
            };
        } });
    } });
    await assert.rejects(proxied.writeRows(job, [row()], {}), /写入校验失败/);
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id })).status, 'queued');
    assert.equal(await store.active('exam'), null);
    await store.release(job);
});

test('ranking uses current profile privacy and current domain membership', async () => {
    await addDomain();
    const { job } = await complete('exam', true, [row(2, { rp: 1600 }), row(3, { rp: 1400 }), row(4, { rp: 1400 })]);
    await db.collection('user').insertMany([
        { _id: 2, priv: PRIV.PRIV_USER_PROFILE },
        { _id: 3, priv: PRIV.PRIV_USER_PROFILE },
        { _id: 4, priv: PRIV.PRIV_USER_PROFILE },
    ]);
    await db.collection('domain.user').insertMany([
        { domainId: 'exam', uid: 2, join: true },
        { domainId: 'exam', uid: 3, join: true },
        { domainId: 'exam', uid: 4, join: true },
    ]);
    const initially = await store.ranking('exam');
    assert.deepEqual((await initially.cursor.toArray()).map((r) => r.uid), [2, 3, 4]);
    assert.deepEqual([...initially.liveRanks], [[2, 1], [3, 2], [4, 2]]); // ties share rank
    await db.collection('user').updateOne({ _id: 2 }, { $set: { priv: 0 } });
    await db.collection('domain.user').updateOne({ domainId: 'exam', uid: 3 }, { $set: { join: false } });
    const current = await store.ranking('exam');
    assert.deepEqual((await current.cursor.toArray()).map((r) => r.uid), [4]);
    assert.deepEqual([...current.liveRanks], [[4, 1]]); // no gaps after live membership change
    const withFormerMembers = await store.ranking('exam', false);
    assert.deepEqual((await withFormerMembers.cursor.toArray()).map((r) => r.uid), [3, 4]);
    assert.deepEqual([...withFormerMembers.liveRanks], [[3, 1], [4, 1]]);
    assert.equal((await store.active('exam'))?.runId, job._id);
});

test('domain deletion removes publication data and reused ids start without stale state', async () => {
    await addDomain('reused.domain');
    await store.configure('v2_trial', ['reused.domain']);
    const { job, pointer } = await complete('reused.domain', true, [row()]);
    assert.equal((await store.rows('reused.domain', [2], pointer)).rows.length, 1);
    await store.deleteDomain('reused.domain');
    assert.equal(await store.active('reused.domain'), null);
    assert.equal(await db.collection(RATING_COLLECTIONS.runs).countDocuments({ domainId: 'reused.domain' }), 0);
    assert.equal(await db.collection(RATING_COLLECTIONS.users).countDocuments({ domainId: 'reused.domain' }), 0);
    await db.collection('domain').deleteOne({ _id: 'reused.domain' });
    await addDomain('reused.domain');
    assert.equal(await store.active('reused.domain'), null);
    const fresh = await store.begin('reused.domain', false);
    assert.equal(fresh.previous, null);
    assert.notEqual(fresh._id, job._id);
});

test('pruning keeps active and previous generations, recent algorithm history, and referenced legacy input', async () => {
    await addDomain();
    const previous = await complete('exam', true, [row(2)]);
    const active = await complete('exam', true, [row(3)]);
    const old = Array.from({ length: 11 }, (_, i) => ({
        _id: `old-${i}`, domainId: 'exam', algorithm: 'legacy', configRevision: 0, manual: false,
        operator: 0, asOf: Date.now() - (31 + i) * 86400000, status: 'complete', token: `t-${i}`,
        expectedVersion: null, count: 1,
    }));
    await db.collection(RATING_COLLECTIONS.runs).insertMany(old);
    const referenced = old[10];
    const recentV2 = { _id: 'recent-v2', domainId: 'exam', algorithm: 'v2_trial', configRevision: 0, manual: false,
        operator: 0, asOf: Date.now(), status: 'complete', token: 'recent', expectedVersion: null, count: 1,
        legacyRunId: referenced._id };
    await db.collection(RATING_COLLECTIONS.runs).insertOne(recentV2);
    await db.collection(RATING_COLLECTIONS.users).insertMany(old.map((run) => ({
        domainId: 'exam', runId: run._id, ...row(10 + Number(run._id.slice(4))),
    })));
    await store.prune('exam');
    const retainedIds = (await db.collection(RATING_COLLECTIONS.runs).find({ domainId: 'exam' }, { projection: { _id: 1 } }).toArray()).map((r) => r._id);
    assert(retainedIds.includes(active.job._id));
    assert(retainedIds.includes(previous.job._id));
    assert(retainedIds.includes(referenced._id));
    assert(retainedIds.includes('recent-v2'));
    assert(old.slice(0, 8).every((run) => retainedIds.includes(run._id)));
    assert.equal(retainedIds.includes(old[8]._id), false);
    assert.equal(retainedIds.includes(old[9]._id), false);
    assert.equal(await db.collection(RATING_COLLECTIONS.users).countDocuments({ runId: { $in: [old[8]._id, old[9]._id] } }), 0);
});

test('leaseAlive is read-only and expired nonrenewing leases can be acquired again', async () => {
    await addDomain();
    const first = await store.begin('exam', true);
    const lockKey = Buffer.from('exam').toString('base64url');
    const readLock = async () => (await db.collection('system').findOne({ _id: 'rating.publication' })).value.locks[lockKey];
    const expiresAt = (await readLock()).expiresAt;
    assert.equal(await store.leaseAlive(first), true);
    assert.equal((await readLock()).expiresAt, expiresAt);
    await db.collection('system').updateOne({ _id: 'rating.publication' }, { $set: { [`value.locks.${lockKey}.expiresAt`]: Date.now() - 1 } });
    assert.equal(await store.leaseAlive(first), false);
    const second = await store.begin('exam', true);
    assert.notEqual(second.token, first.token);
    await store.release(second);
});

test('verified main snapshots stay ready until the pointer and receipt commit', async () => {
    await addDomain();
    const job = await store.begin('exam', true);
    await store.writeRows(job, [row()], {});
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id })).status, 'ready');
    assert.equal(await store.active('exam'), null);
    assert.equal(await store.receipt(job), null);
    const pointer = await store.publish(job);
    assert.equal((await store.receipt(job))?.pointer?.version, pointer.version);
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id })).status, 'complete');
    assert.equal((await store.publish(job)).version, pointer.version); // idempotent acknowledgement
});

test('a lost publication response remains confirmed after later publications move the head', async () => {
    await addDomain();
    const first = await store.begin('exam', true);
    await store.writeRows(first, [row(2)], {});
    const key = Buffer.from('exam').toString('base64url');
    let loseAck = true;
    let second: any;
    const uncertain = new RatingPublicationStore({ collection(name: string) {
        const coll = db.collection(name);
        return new Proxy(coll, { get(target, property) {
            if (name === 'system' && property === 'updateOne') return async (...args: any[]) => {
                const result = await target.updateOne(...args);
                if (loseAck && args[1]?.$set?.[`value.active.${key}`]) {
                    loseAck = false;
                    second = await complete('exam', true, [row(3)]);
                    throw new Error('lost acknowledgment after the next publication');
                }
                return result;
            };
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    } });
    const acknowledged = await uncertain.publish(first);
    assert.equal(acknowledged.runId, first._id);
    assert.equal((await store.active('exam'))?.runId, second.job._id);
    await store.fail(first, new Error('late publisher error'));
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: first._id })).status, 'complete');
    const rollback = await store.rollback('exam');
    assert.equal(rollback.runId, first._id);
    await complete('exam', true, [row(4)]);
    await complete('exam', true, [row(5)]);
    assert.equal((await store.receipt(first))?.pointer?.version, acknowledged.version);
    assert.equal((await store.fail(first, new Error('error after several replacements')))?.outcome, 'committed');
});

test('rollback acknowledgment survives a following publication', async () => {
    await addDomain();
    const original = await complete();
    await complete('exam', true, [row(3)]);
    const key = Buffer.from('exam').toString('base64url');
    let loseAck = true;
    let replacement: any;
    const uncertain = new RatingPublicationStore({ collection(name: string) {
        const coll = db.collection(name);
        return new Proxy(coll, { get(target, property) {
            if (name === 'system' && property === 'updateOne') return async (...args: any[]) => {
                const result = await target.updateOne(...args);
                if (loseAck && args[1]?.$set?.[`value.active.${key}`]) {
                    loseAck = false;
                    replacement = await complete('exam', true, [row(4)]);
                    throw new Error('lost rollback acknowledgment after replacement');
                }
                return result;
            };
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    } });
    const restored = await uncertain.rollback('exam');
    assert.equal(restored.runId, original.job._id);
    assert.equal((await store.active('exam'))?.runId, replacement.job._id);
    const operation = await db.collection(RATING_COLLECTIONS.runs).findOne({ operation: 'rollback' });
    assert.equal(operation.status, 'superseded');
    assert.equal((await store.receipt(operation))?.pointer?.version, restored.version);
});

test('cancellation winning the pointer race fences the publisher without touching the previous snapshot', async () => {
    await addDomain();
    const original = await complete();
    const job = await store.begin('exam', true);
    await store.writeRows(job, [row(3)], {});
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const key = Buffer.from('exam').toString('base64url');
    const publisher = new RatingPublicationStore({ collection(name: string) {
        const coll = db.collection(name);
        return new Proxy(coll, { get(target, property) {
            if (name === 'system' && property === 'updateOne') return async (...args: any[]) => {
                if (args[1]?.$set?.[`value.active.${key}`]) { enter(); await paused; }
                return target.updateOne(...args);
            };
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    } });
    const publishing = assert.rejects(publisher.publish(job), /配置或活动批次已变化/);
    await entered;
    assert.equal((await store.fail(job, new Error('cancelled during commit')))?.outcome, 'failed');
    resume();
    await publishing;
    assert.equal((await store.active('exam'))?.runId, original.job._id);
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id })).status, 'failed');
});

test('execution and ready leases expire in 90 seconds while queued work retains its queue lease', async () => {
    await addDomain();
    let now = Date.now();
    const timed = new RatingPublicationStore(db, () => now);
    const job = await timed.begin('exam', true);
    const key = Buffer.from('exam').toString('base64url');
    const lock = async () => (await db.collection('system').findOne({ _id: 'rating.publication' })).value.locks[key];
    assert.equal((await lock()).expiresAt, now + 30 * 60000);
    await timed.claim(job);
    assert.equal((await lock()).expiresAt, now + 90000);
    now += 30000;
    await timed.renew(job);
    assert.equal((await lock()).expiresAt, now + 90000);
    await timed.writeRows(job, [row()], {});
    assert.equal(await timed.queueLeaseAlive(job), false);
    assert.equal(await timed.fail(job, new Error('not expired'), 'failed', true), null);
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id })).status, 'ready');
    now += 90001;
    assert.equal((await timed.fail(job, new Error('interrupted'), 'failed', true))?.outcome, 'failed');
    const fresh = await timed.begin('exam', true);
    await assert.rejects(timed.publish(job), /interrupted/);
    await assert.rejects(timed.writeRows(job, [row()], {}), /锁已失效/);
    assert.equal((await lock()).token, fresh.token);
});

test('committed ready metadata can be repaired and its verified snapshot is already eligible for rollback', async () => {
    await addDomain();
    const job = await store.begin('exam', true);
    await store.writeRows(job, [row()], {});
    const metadataUnavailable = new RatingPublicationStore({ collection(name: string) {
        const coll = db.collection(name);
        return new Proxy(coll, { get(target, property) {
            if (name === RATING_COLLECTIONS.runs && property === 'updateOne') return async (...args: any[]) => {
                if (args[0]._id === job._id && args[1]?.$set?.status === 'complete') throw new Error('metadata unavailable');
                return target.updateOne(...args);
            };
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    } });
    const applied = await metadataUnavailable.publish(job);
    assert.equal(applied.runId, job._id);
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id })).status, 'ready');
    await complete('exam', true, [row(3)]);
    assert.equal((await metadataUnavailable.rollback('exam')).runId, job._id);
    await store.reconcile(job);
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id })).status, 'complete');
});

test('delayed older heartbeats cannot shorten a newer execution lease', async () => {
    await addDomain();
    let now = Date.now();
    const timed = new RatingPublicationStore(db, () => now);
    const job = await timed.begin('exam', true);
    await timed.claim(job);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const delayed = new RatingPublicationStore({ collection(name: string) {
        const coll = db.collection(name);
        return new Proxy(coll, { get(target, property) {
            if (name === 'system' && property === 'updateOne') return async (...args: any[]) => {
                if (Array.isArray(args[1])) { enter(); await paused; }
                return target.updateOne(...args);
            };
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    } }, () => now);
    const older = delayed.renew(job);
    await entered;
    now += 30000;
    await timed.renew(job);
    const expected = now + 90000;
    resume();
    await older;
    const key = Buffer.from('exam').toString('base64url');
    assert.equal((await db.collection('system').findOne({ _id: 'rating.publication' })).value.locks[key].expiresAt, expected);
});

test('pruning retains active and previous receipts and their comparison input but removes expired cancelled receipts', async () => {
    await addDomain();
    const previous = await complete();
    await store.configure('v2_trial', ['exam']);
    const active = await complete('exam', true, [row(3)]);
    const comparison = await db.collection(RATING_COLLECTIONS.runs).insertOne({ _id: 'protected-comparison',
        domainId: 'exam', algorithm: 'legacy', status: 'complete', asOf: Date.now() - 40 * 86400000 });
    await db.collection(RATING_COLLECTIONS.runs).updateOne({ _id: active.job._id }, {
        $set: { legacyRunId: comparison.insertedId, asOf: Date.now() - 40 * 86400000 },
    });
    await db.collection(RATING_COLLECTIONS.runs).insertMany(Array.from({ length: 11 }, (_, i) => ({
        _id: `new-v2-${i}`, domainId: 'exam', algorithm: 'v2_trial', status: 'complete', asOf: Date.now() + i,
    })));
    const cancelled = await store.begin('exam', true);
    await store.fail(cancelled, new Error('abandoned fixture'));
    await db.collection(RATING_COLLECTIONS.runs).updateOne({ _id: cancelled._id }, { $set: { asOf: Date.now() - 31 * 86400000 } });
    assert.equal((await store.receipt(cancelled))?.outcome, 'failed');
    await store.prune('exam');
    assert.equal((await store.receipt(active.job))?.outcome, 'committed');
    assert.equal((await store.receipt(previous.job))?.outcome, 'committed');
    assert(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: comparison.insertedId }));
    assert.equal(await store.receipt(cancelled), null);
    assert.equal(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: cancelled._id }), null);
});
