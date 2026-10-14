/* eslint-disable no-await-in-loop */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { after, before, beforeEach, test } from 'node:test';
import { transformSync } from 'esbuild';
import { Context } from 'cordis';
import TimerService from '@cordisjs/plugin-timer';
import { runShadowReplay } from '../packages/hydrooj/src/lib/rating-v2/shadow-replay';
import { RatingPublicationStore, RATING_COLLECTIONS } from '../packages/hydrooj/src/lib/rating-publication-store';

let server: MongoMemoryServer;
let client: MongoClient;
let db: any;
let runtime: any;
let store: RatingPublicationStore;
let calculateLegacy: (domainId: string) => Promise<any>;
let beforeLegacy: (() => Promise<void>) | null;
let counters: { renew: number, publish: number };
let recoveryErrorDomain: string | null;
let visibilityCalls: { uid: number, strict: boolean, contestId: any }[];
let clock: number | null;
let ensureIndexes: (() => Promise<void>) | null;

before(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    db = client.db('rating-publication-runtime');
});
after(async () => {
    await client?.close();
    await server?.stop();
});

function loadRuntime() {
    const source = readFileSync('packages/hydrooj/src/model/rating-publication.ts', 'utf8');
    const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22.16' }).code;
    const module = { exports: {} as any };
    const realStoreModule = require('../packages/hydrooj/src/lib/rating-publication-store');
    const realComposite = require('../packages/hydrooj/src/lib/rating-v2/composite');
    store = new RatingPublicationStore(db, () => clock ?? Date.now());
    // Execute with the same Mongo store used by the runtime while counting renew/publish calls.
    const countedStore = new Proxy(store, { get(target, prop) {
        if (prop === 'ensureIndexes' && ensureIndexes) return ensureIndexes;
        if (prop === 'renew') return async (...args: any[]) => { counters.renew++; return target.renew(...args); };
        if (prop === 'publish') return async (...args: any[]) => { counters.publish++; return target.publish(...args); };
        if (prop === 'leaseAlive') return async (...args: any[]) => {
            if (recoveryErrorDomain === args[0].domainId) throw new Error('temporary recovery read failure');
            return target.leaseAlive(...args);
        };
        return target[prop].bind(target);
    } });
    const mocks: Record<string, any> = {
        '../context': {},
        '../lib/rating-publication-store': { ...realStoreModule, RatingPublicationStore: class extends RatingPublicationStore {
            constructor(_database: any) { super(_database); return countedStore as any; }
        } },
        '../lib/rating-v2/composite': realComposite,
        '../lib/rating-v2/shadow-replay': { runShadowReplay },
        '../logger': { Logger: class { info() {} error() {} } },
        '../service/db': db,
        './builtin': { PRIV: { PRIV_USER_PROFILE: 1 } },
        './contest': { canShowProblemStatus: (_ctx: any, uid: number, contest: any, strict: boolean) => {
            visibilityCalls.push({ uid, strict, contestId: contest.docId });
            return contest.keepScoreboardHidden !== true && (!contest.lockAt || contest.unlocked === true);
        } },
        './oplog': { add: async () => {} },
        './problem': { resolveVisibleStatuses: async (domainId: string, uids: number[], pids: number[], canShow: any) => {
            const latest = await db.collection('document.status').find({ domainId, docType: 10, uid: { $in: uids }, docId: { $in: pids }, rid: { $ne: null } }).toArray();
            const visible: any[] = [];
            for (const status of latest) {
                const records = await db.collection('record').find({ domainId, uid: status.uid, pid: status.docId }).sort({ _id: -1 }).toArray();
                for (const record of records) {
                    const contest = await db.collection('document').findOne({ domainId, docType: 30, docId: record.contest });
                    if (contest && canShow(contest, status.uid)) {
                        visible.push({ ...status, rid: record._id, status: record.status, score: record.score });
                        break;
                    }
                }
            }
            return visible;
        } },
        './user': { coll: db.collection('user'), deleteUserCache: () => {} },
    };
    const mockRequire = (name: string) => {
        if (name === '../script/rating') return { calculateLegacyInDomain: async (domainId: string, report: any) => {
            if (beforeLegacy) await beforeLegacy();
            return calculateLegacy(domainId, report);
        } };
        return mocks[name] || require(name);
    };
    vm.runInNewContext(code, { module, exports: module.exports, require: mockRequire, process, console, setInterval, clearInterval, Date, Buffer });
    return module.exports;
}

function loadWorkerService() {
    const source = readFileSync('packages/hydrooj/src/service/worker.ts', 'utf8');
    const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22.16' }).code;
    const module = { exports: {} as any };
    const env = { ...process.env };
    delete env.CI;
    const mocks: Record<string, any> = {
        '../context': require('cordis'),
        './db': { __esModule: true, default: db },
        cac: () => ({ parse: () => ({ options: { disableWorker: true } }) }),
    };
    vm.runInNewContext(code, {
        module,
        exports: module.exports,
        require: (name) => mocks[name] || require(name),
        process: { env },
    });
    return module.exports.default;
}

async function loadCordisRuntime() {
    const ctx = new Context();
    const timer = ctx.plugin(TimerService);
    await timer;
    const worker = ctx.plugin(loadWorkerService());
    await worker;
    return { ctx, timer, worker, service: ctx.worker };
}

const legacyRows = () => ({ rows: [
    { uid: 2, rp: 1500, rpInfo: { accepted: 3 }, rank: 1, level: 3, join: true, visible: true },
    { uid: 3, rp: 1200, rpInfo: { accepted: 1 }, rank: 2, level: 2, join: true, visible: true },
], summary: { source: 'fixture-legacy' } });
const recordId = (ms: number, n: number) => new ObjectId(`${ObjectId.createFromTime(Math.floor(ms / 1000)).toHexString().slice(0, 8)}0000000000${n.toString(16).padStart(6, '0')}`);

async function seedDomain(domainId = 'd') {
    await db.collection('domain').insertOne({ _id: domainId, name: `Domain ${domainId}` });
    await db.collection('user').insertMany([
        { _id: 2, priv: 1, email: 'private-2@example.test' },
        { _id: 3, priv: 1, email: 'private-3@example.test' },
        { _id: 4, priv: 0, email: 'hidden@example.test' },
    ]);
    await db.collection('domain.user').insertMany([
        { domainId, uid: 2, join: true }, { domainId, uid: 3, join: true }, { domainId, uid: 4, join: true },
    ]);
}

async function seedContest(domainId = 'd') {
    const now = Date.now();
    const beginAt = new Date(now - 7200000);
    const endAt = new Date(now - 3600000);
    const tid = new ObjectId();
    await db.collection('document').insertOne({ _id: tid, docId: tid, docType: 30, domainId,
        rule: 'oi', rated: true, beginAt, endAt, duration: 0, pids: [1], assign: [] });
    await db.collection('record').insertMany([
        { _id: recordId(beginAt.getTime() + 60000, 1), domainId, uid: 2, pid: 1, contest: tid, status: 1, score: 100 },
        { _id: recordId(beginAt.getTime() + 120000, 2), domainId, uid: 3, pid: 1, contest: tid, status: 2, score: 0 },
    ]);
}

beforeEach(async () => {
    for (const name of ['system', 'domain', 'domain.user', 'user', 'document', 'document.status', 'record', 'schedule',
        'ratingv2_shadow', 'rating.publication.runs', 'rating.publication.users', RATING_COLLECTIONS.runs, RATING_COLLECTIONS.users, RATING_COLLECTIONS.problems]) {
        await db.collection(name).deleteMany({});
    }
    counters = { renew: 0, publish: 0 };
    recoveryErrorDomain = null;
    visibilityCalls = [];
    clock = null;
    ensureIndexes = null;
    beforeLegacy = null;
    calculateLegacy = async () => legacyRows();
    runtime = loadRuntime();
    await seedDomain();
});

test('configuration is pending until queued legacy work successfully publishes', async () => {
    await runtime.configureRating({ algorithm: 'legacy', domains: [] }, 99);
    assert.equal(await store.active('d'), null);
    const queued = await runtime.queueRatingApply('d', 99);
    const job = await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: queued.runId });
    assert.equal(job.status, 'queued');
    assert.equal((await db.collection('schedule').findOne({ runId: queued.runId })).domainId, 'd');
    assert.equal(await store.active('d'), null);
    const pointer = await runtime.executeRatingJob(job);
    assert.equal(pointer.algorithm, 'legacy');
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id })).status, 'complete');
});

test('V2 execution uses real replay, retains a legacy comparison run, and stores no private profile fields', async () => {
    await seedContest();
    const contests = await db.collection('document').find({ domainId: 'd', docType: 30 }).toArray();
    const visibleContest = contests[0];
    const hiddenTid = new ObjectId();
    const hiddenBegin = new Date(visibleContest.endAt.getTime() + 60000);
    const hiddenEnd = new Date(hiddenBegin.getTime() + 1800000);
    await db.collection('document').insertOne({ _id: hiddenTid, docId: hiddenTid, docType: 30, domainId: 'd',
        rule: 'oi', rated: true, beginAt: hiddenBegin, endAt: hiddenEnd, duration: 0, pids: [1], assign: [], keepScoreboardHidden: true });
    const hiddenRecords = [
        { _id: recordId(hiddenBegin.getTime() + 60000, 3), domainId: 'd', uid: 2, pid: 1, contest: hiddenTid, status: 2, score: 0 },
        { _id: recordId(hiddenBegin.getTime() + 120000, 4), domainId: 'd', uid: 3, pid: 1, contest: hiddenTid, status: 1, score: 100 },
    ];
    await db.collection('record').insertMany(hiddenRecords);
    for (const [uid, sourceRecord] of [[2, hiddenRecords[0]], [3, hiddenRecords[1]]] as const) {
        await db.collection('document.status').insertOne({ docType: 10, domainId: 'd', uid, docId: 1,
            rid: sourceRecord._id, status: sourceRecord.status, score: sourceRecord.score });
    }
    await runtime.configureRating({ algorithm: 'v2_trial', domains: ['d'] }, 99);
    const queued = await runtime.queueRatingApply('d', 99);
    const job = await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: queued.runId });
    const pointer = await runtime.executeRatingJob(job);
    assert.equal(pointer.algorithm, 'v2_trial');
    const activeRows = await db.collection(RATING_COLLECTIONS.users).find({ domainId: 'd', runId: job._id }).toArray();
    assert.equal(activeRows.length, 3); // domain population includes the unrated private-profile user
    assert(activeRows.every((row) => !('email' in row) && !('password' in row) && !('priv' in row)));
    assert.equal(activeRows.find((row) => row.uid === 4).visible, false);
    assert.equal(activeRows.find((row) => row.uid === 2).ratedEvents, 1);
    assert.equal(activeRows.find((row) => row.uid === 3).ratedEvents, 1);
    assert.equal(activeRows.find((row) => row.uid === 2).achievement, 1); // hidden latest record falls back to visible AC
    assert.equal(activeRows.find((row) => row.uid === 3).achievement, 0); // hidden best result is excluded
    assert(visibilityCalls.length >= 2);
    assert(visibilityCalls.every((call) => call.strict === false));
    assert(visibilityCalls.some((call) => String(call.contestId) === String(hiddenTid)));
    const completed = await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id });
    assert(completed.legacyRunId);
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: completed.legacyRunId })).status, 'complete');
    const dashboard = await runtime.ratingDashboard();
    const domain = dashboard.domains.find((entry: any) => entry.domainId === 'd');
    assert.equal(domain.active.runId, job._id);
    assert.equal(domain.active.algorithm, 'v2_trial');
    assert.equal(domain.pending, false);
    assert.equal(domain.job.status, 'complete');
    assert(domain.runs[0].asOfText);
    assert(domain.comparison.some((entry: any) => entry.legacyRp > 0 && Number.isFinite(entry.rp)));
});

test('public status resolver always receives the strict visibility argument as false', async () => {
    await seedContest();
    const record = await db.collection('record').findOne({ domainId: 'd', uid: 2 });
    await db.collection('document.status').insertOne({ docType: 10, domainId: 'd', uid: 2, docId: 1,
        rid: record._id, status: record.status, score: record.score });
    await runtime.configureRating({ algorithm: 'v2_trial', domains: ['d'] }, 99);
    const runId = (await runtime.queueRatingApply('d', 99)).runId;
    await runtime.executeRatingJob(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: runId }));
    assert.equal(visibilityCalls.length, 1);
    assert.equal(visibilityCalls[0].strict, false);
});

test('compute failure leaves the previous publication active', async () => {
    const firstJobId = (await runtime.queueRatingApply('d', 99)).runId;
    await runtime.executeRatingJob(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: firstJobId }));
    const active = await store.active('d');
    const secondJobId = (await runtime.queueRatingApply('d', 99)).runId;
    calculateLegacy = async () => { throw new Error('synthetic calculation failure'); };
    await assert.rejects(runtime.executeRatingJob(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: secondJobId })), /synthetic calculation failure/);
    assert.equal((await store.active('d')).runId, active.runId);
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: secondJobId })).status, 'failed');
});

test('configuration edited during computation fences the queued V2 job from publication', async () => {
    await seedContest();
    await runtime.configureRating({ algorithm: 'v2_trial', domains: ['d'] }, 99);
    const queuedId = (await runtime.queueRatingApply('d', 99)).runId;
    beforeLegacy = async () => runtime.configureRating({ algorithm: 'legacy', domains: [] }, 101);
    await assert.rejects(runtime.executeRatingJob(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: queuedId })), /配置或活动批次已变化/);
    assert.equal(await store.active('d'), null);
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: queuedId })).status, 'superseded');
});

test('repeated execution of the same completed queue item is rejected', async () => {
    const queuedId = (await runtime.queueRatingApply('d', 99)).runId;
    const job = await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: queuedId });
    await runtime.executeRatingJob(job);
    await assert.rejects(runtime.executeRatingJob(job), /已执行或失效/);
    assert.equal(await db.collection(RATING_COLLECTIONS.runs).countDocuments({ _id: queuedId, status: 'complete' }), 1);
});

test('worker recovery fails expired jobs without renewing or publishing and schedules live queued work', async () => {
    const queuedId = (await runtime.queueRatingApply('d', 99)).runId;
    const liveJob = await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: queuedId });
    await db.collection('domain').insertOne({ _id: 'expired' });
    await db.collection('domain').insertOne({ _id: 'deferred' });
    const expired = await store.begin('expired', true);
    await db.collection(RATING_COLLECTIONS.runs).updateOne({ _id: expired._id }, { $set: { status: 'running' } });
    const expiredKey = Buffer.from('expired').toString('base64url');
    await db.collection('system').updateOne({ _id: 'rating.publication' }, { $set: { [`value.locks.${expiredKey}.expiresAt`]: Date.now() - 1 } });
    const deferred = await store.begin('deferred', true);
    await db.collection(RATING_COLLECTIONS.runs).updateOne({ _id: deferred._id }, { $set: { status: 'running' } });
    const deferredKey = Buffer.from('deferred').toString('base64url');
    const deferredExpiry = (await db.collection('system').findOne({ _id: 'rating.publication' })).value.locks[deferredKey].expiresAt;
    recoveryErrorDomain = 'deferred';
    const liveKey = Buffer.from('d').toString('base64url');
    const expiry = (await db.collection('system').findOne({ _id: 'rating.publication' })).value.locks[liveKey].expiresAt;
    const handlers: any = {};
    let intervals = 0;
    const ctx: any = {
        on: () => {},
        inject: async (_deps: any, callback: any) => callback({
            worker: { addHandler: (type: string, handler: any) => { handlers[type] = handler; } },
            interval: () => { intervals++; },
        }),
    };
    const oldInstance = process.env.NODE_APP_INSTANCE;
    const oldCli = process.env.HYDRO_CLI;
    process.env.NODE_APP_INSTANCE = '0';
    delete process.env.HYDRO_CLI;
    try {
        await runtime.apply(ctx);
    } finally {
        if (oldInstance === undefined) delete process.env.NODE_APP_INSTANCE;
        else process.env.NODE_APP_INSTANCE = oldInstance;
        if (oldCli === undefined) delete process.env.HYDRO_CLI;
        else process.env.HYDRO_CLI = oldCli;
    }
    for (let i = 0; i < 50 && (await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: expired._id })).status !== 'failed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: expired._id })).status, 'failed');
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: deferred._id })).status, 'running');
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: liveJob._id })).status, 'queued');
    assert.equal(await db.collection('schedule').countDocuments({ runId: liveJob._id }), 1);
    assert.equal((await db.collection('schedule').findOne({ runId: liveJob._id })).domainId, liveJob.domainId);
    assert.equal((await db.collection('system').findOne({ _id: 'rating.publication' })).value.locks[liveKey].expiresAt, expiry);
    assert.equal((await db.collection('system').findOne({ _id: 'rating.publication' })).value.locks[deferredKey].expiresAt, deferredExpiry);
    assert.equal(await store.active('d'), null);
    assert.equal(counters.publish, 0);
    assert.equal(counters.renew, 0);
    assert.equal(typeof handlers['task.rating-publication'], 'function');
    assert.equal(intervals, 1);
});

test('rating worker registration survives app/started during delayed initialization and cleans up on reload', async () => {
    let resolveIndexes!: () => void;
    ensureIndexes = () => new Promise<void>((resolve) => { resolveIndexes = resolve; });
    runtime = loadRuntime();
    const { ctx, timer, worker, service } = await loadCordisRuntime();
    const oldInstance = process.env.NODE_APP_INSTANCE;
    const oldCli = process.env.HYDRO_CLI;
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    const activeIntervals = new Set<any>();
    global.setInterval = ((callback: any, delay?: number, ...args: any[]) => {
        const handle = realSetInterval(callback, delay, ...args);
        activeIntervals.add(handle);
        return handle;
    }) as any;
    global.clearInterval = ((handle: any) => {
        activeIntervals.delete(handle);
        return realClearInterval(handle);
    }) as any;
    process.env.NODE_APP_INSTANCE = '0';
    delete process.env.HYDRO_CLI;
    let plugin: any;
    try {
        const queued = await runtime.queueRatingApply('d', 99);
        await db.collection('domain').insertOne({ _id: 'expired-primary' });
        const expired = await store.begin('expired-primary', true);
        await db.collection(RATING_COLLECTIONS.runs).updateOne({ _id: expired._id }, { $set: { status: 'running' } });
        const expiredKey = Buffer.from('expired-primary').toString('base64url');
        await db.collection('system').updateOne({ _id: 'rating.publication' }, {
            $set: { [`value.locks.${expiredKey}.expiresAt`]: Date.now() - 1 },
        });
        plugin = ctx.plugin({ apply: runtime.apply });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(typeof resolveIndexes, 'function');

        // Hydro emits this once while the model's index barrier is still pending.
        await ctx.parallel('app/started');
        assert.equal(await service.getFirst(), null);

        resolveIndexes();
        await plugin;
        assert.equal(typeof service.handlers['task.rating-publication'], 'function');
        assert.equal(activeIntervals.size, 1);
        const task = await service.getFirst();
        assert.equal(task.runId.toString(), queued.runId.toString());
        await service.handlers['task.rating-publication'](task);
        assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: queued.runId })).status, 'complete');
        assert.equal((await store.active('d'))?.runId.toString(), queued.runId.toString());
        for (let i = 0; i < 50 && (await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: expired._id })).status !== 'failed'; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: expired._id })).status, 'failed');

        await plugin.dispose();
        assert.equal(service.handlers['task.rating-publication'], undefined);
        assert.equal(activeIntervals.size, 0);

        ensureIndexes = null;
        plugin = ctx.plugin({ apply: runtime.apply });
        await plugin;
        assert.equal(typeof service.handlers['task.rating-publication'], 'function');
        assert.equal(activeIntervals.size, 1);
        await plugin.dispose();
        assert.equal(service.handlers['task.rating-publication'], undefined);
        assert.equal(activeIntervals.size, 0);
    } finally {
        resolveIndexes?.();
        await plugin?.dispose();
        await worker.dispose();
        await timer.dispose();
        global.setInterval = realSetInterval;
        global.clearInterval = realClearInterval;
        if (oldInstance === undefined) delete process.env.NODE_APP_INSTANCE;
        else process.env.NODE_APP_INSTANCE = oldInstance;
        if (oldCli === undefined) delete process.env.HYDRO_CLI;
        else process.env.HYDRO_CLI = oldCli;
        ensureIndexes = null;
    }
});

test('rating worker and recovery remain disabled in Hydro CLI mode', async () => {
    runtime = loadRuntime();
    const { ctx, timer, worker, service } = await loadCordisRuntime();
    const oldInstance = process.env.NODE_APP_INSTANCE;
    const oldCli = process.env.HYDRO_CLI;
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    const activeIntervals = new Set<any>();
    global.setInterval = ((callback: any, delay?: number, ...args: any[]) => {
        const handle = realSetInterval(callback, delay, ...args);
        activeIntervals.add(handle);
        return handle;
    }) as any;
    global.clearInterval = ((handle: any) => {
        activeIntervals.delete(handle);
        return realClearInterval(handle);
    }) as any;
    const queued = await runtime.queueRatingApply('d', 99);
    await db.collection('domain').insertOne({ _id: 'expired-cli' });
    const expired = await store.begin('expired-cli', true);
    await db.collection(RATING_COLLECTIONS.runs).updateOne({ _id: expired._id }, { $set: { status: 'running' } });
    const expiredKey = Buffer.from('expired-cli').toString('base64url');
    await db.collection('system').updateOne({ _id: 'rating.publication' }, {
        $set: { [`value.locks.${expiredKey}.expiresAt`]: Date.now() - 1 },
    });
    process.env.NODE_APP_INSTANCE = '0';
    process.env.HYDRO_CLI = 'true';
    let plugin: any;
    try {
        plugin = ctx.plugin({ apply: runtime.apply });
        await plugin;
        assert.equal(service.handlers['task.rating-publication'], undefined);
        assert.equal(await service.getFirst(), null);
        assert.equal(await db.collection('schedule').countDocuments({ runId: queued.runId }), 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: expired._id })).status, 'running');
        assert.equal(activeIntervals.size, 0);
    } finally {
        await plugin?.dispose();
        await worker.dispose();
        await timer.dispose();
        global.setInterval = realSetInterval;
        global.clearInterval = realClearInterval;
        if (oldInstance === undefined) delete process.env.NODE_APP_INSTANCE;
        else process.env.NODE_APP_INSTANCE = oldInstance;
        if (oldCli === undefined) delete process.env.HYDRO_CLI;
        else process.env.HYDRO_CLI = oldCli;
    }
});

test('non-primary instances register the worker but do not run rating recovery', async () => {
    runtime = loadRuntime();
    const { ctx, timer, worker, service } = await loadCordisRuntime();
    const oldInstance = process.env.NODE_APP_INSTANCE;
    const oldCli = process.env.HYDRO_CLI;
    process.env.NODE_APP_INSTANCE = '1';
    delete process.env.HYDRO_CLI;
    await db.collection('domain').insertOne({ _id: 'expired-non-primary' });
    const expired = await store.begin('expired-non-primary', true);
    await db.collection(RATING_COLLECTIONS.runs).updateOne({ _id: expired._id }, { $set: { status: 'running' } });
    const expiredKey = Buffer.from('expired-non-primary').toString('base64url');
    await db.collection('system').updateOne({ _id: 'rating.publication' }, {
        $set: { [`value.locks.${expiredKey}.expiresAt`]: Date.now() - 1 },
    });
    let plugin: any;
    try {
        plugin = ctx.plugin({ apply: runtime.apply });
        await plugin;
        assert.equal(typeof service.handlers['task.rating-publication'], 'function');
        assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: expired._id })).status, 'running');
    } finally {
        await plugin?.dispose();
        await worker.dispose();
        await timer.dispose();
        if (oldInstance === undefined) delete process.env.NODE_APP_INSTANCE;
        else process.env.NODE_APP_INSTANCE = oldInstance;
        if (oldCli === undefined) delete process.env.HYDRO_CLI;
        else process.env.HYDRO_CLI = oldCli;
    }
});

test('domain deletion removes owned rating schedules and keeps unrelated tasks intact in CLI mode', async () => {
    runtime = loadRuntime();
    const { ctx, timer, worker } = await loadCordisRuntime();
    const oldInstance = process.env.NODE_APP_INSTANCE;
    const oldCli = process.env.HYDRO_CLI;
    process.env.NODE_APP_INSTANCE = '0';
    process.env.HYDRO_CLI = 'true';
    await db.collection('domain').insertMany([
        { _id: 'domain-to-delete' }, { _id: 'domain-to-keep' },
    ]);
    const deleted = await runtime.queueRatingApply('domain-to-delete', 99);
    const kept = await runtime.queueRatingApply('domain-to-keep', 99);
    const legacySchedule = await db.collection('schedule').findOne({ runId: deleted.runId, subType: 'task.rating-publication' });
    await db.collection('schedule').updateOne({ _id: legacySchedule._id }, { $unset: { domainId: '' } });
    await db.collection('schedule').insertOne({ _id: new ObjectId(), type: 'schedule', subType: 'task.rating-publication',
        executeAfter: new Date(), domainId: 'domain-to-delete', runId: deleted.runId });
    await db.collection('schedule').insertOne({ _id: new ObjectId(), type: 'schedule', subType: 'task.daily',
        executeAfter: new Date(), domainId: 'domain-to-delete', runId: deleted.runId });
    let plugin: any;
    try {
        plugin = ctx.plugin({ apply: runtime.apply });
        await plugin;
        // The domain listener is installed before the CLI early return.
        await ctx.parallel('domain/delete', 'domain-to-delete');

        assert.equal(await db.collection(RATING_COLLECTIONS.runs).countDocuments({ domainId: 'domain-to-delete' }), 0);
        assert.equal(await db.collection(RATING_COLLECTIONS.runs).countDocuments({ _id: kept.runId }), 1);
        assert.equal(await db.collection('schedule').countDocuments({
            subType: 'task.rating-publication', runId: deleted.runId,
        }), 0);
        const keptSchedule = await db.collection('schedule').findOne({ runId: kept.runId, subType: 'task.rating-publication' });
        assert.equal(keptSchedule.domainId, 'domain-to-keep');
        assert.equal(await db.collection('schedule').countDocuments({
            subType: 'task.daily', domainId: 'domain-to-delete', runId: deleted.runId,
        }), 1);
    } finally {
        await plugin?.dispose();
        await worker.dispose();
        await timer.dispose();
        if (oldInstance === undefined) delete process.env.NODE_APP_INSTANCE;
        else process.env.NODE_APP_INSTANCE = oldInstance;
        if (oldCli === undefined) delete process.env.HYDRO_CLI;
        else process.env.HYDRO_CLI = oldCli;
    }
});

test('interrupted ready snapshots are cancelled on expiry and require a new manual calculation', async () => {
    const first = await runtime.queueRatingApply('d', 99);
    await runtime.executeRatingJob(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: first.runId }));
    const active = await store.active('d');
    clock = Date.now();
    const next = await runtime.queueRatingApply('d', 99);
    const job = await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: next.runId });
    await store.claim(job);
    await db.collection('schedule').deleteMany({ runId: job._id });
    await store.writeRows(job, legacyRows().rows, {});
    const initialCounts = { ...counters };
    await runtime.recoverRatingJobs();
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id })).status, 'ready');
    assert.equal(await db.collection('schedule').countDocuments({ runId: job._id }), 0);
    clock += 90001;
    await runtime.recoverRatingJobs();
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id })).status, 'failed');
    assert.equal((await store.active('d'))?.version, active.version);
    assert.deepEqual(counters, initialCounts); // recovery neither renews nor publishes ready results
    const retried = await runtime.queueRatingApply('d', 99);
    assert.notEqual(retried.runId, job._id);
    await runtime.executeRatingJob(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: retried.runId }));
    assert.equal((await store.active('d'))?.runId, retried.runId);
});

test('recovery repairs committed metadata even when another snapshot is already active', async () => {
    const first = await runtime.queueRatingApply('d', 99);
    await runtime.executeRatingJob(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: first.runId }));
    const second = await runtime.queueRatingApply('d', 99);
    await runtime.executeRatingJob(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: second.runId }));
    await db.collection(RATING_COLLECTIONS.runs).updateOne({ _id: first.runId }, { $set: { status: 'ready' }, $unset: { publishedAt: '' } });
    const dashboard = await runtime.ratingDashboard();
    assert.equal(dashboard.domains[0].runs.find((run: any) => run._id === first.runId).status, 'complete');
    const beforeRecovery = { ...counters };
    await runtime.recoverRatingJobs();
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: first.runId })).status, 'complete');
    assert.equal((await store.active('d'))?.runId, second.runId);
    assert.deepEqual(counters, beforeRecovery);
    assert.equal((await store.rollback('d')).runId, first.runId);
});

test('temporary recovery failures do not cancel or extend a live ready task', async () => {
    const job = await store.begin('d', true);
    await store.claim(job);
    await store.writeRows(job, legacyRows().rows, {});
    const key = Buffer.from('d').toString('base64url');
    const expiry = (await db.collection('system').findOne({ _id: 'rating.publication' })).value.locks[key].expiresAt;
    recoveryErrorDomain = 'd';
    await runtime.recoverRatingJobs();
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: job._id })).status, 'ready');
    assert.equal((await db.collection('system').findOne({ _id: 'rating.publication' })).value.locks[key].expiresAt, expiry);
    assert.equal(await store.receipt(job), null);
});

test('a claimed queued job and a rollback operation never enter the calculation queue during recovery', async () => {
    clock = Date.now();
    const job = await store.begin('d', true);
    await store.claim(job);
    // Simulate an interruption between the control-document claim and the run's status write.
    await db.collection(RATING_COLLECTIONS.runs).updateOne({ _id: job._id }, { $set: { status: 'queued' } });
    await db.collection('domain').insertOne({ _id: 'rollback-domain' });
    const rollback = await store.begin('rollback-domain', false, 99, 'rollback');
    await runtime.recoverRatingJobs();
    assert.equal(await db.collection('schedule').countDocuments({ runId: { $in: [job._id, rollback._id] } }), 0);
    assert.equal(counters.publish, 0);
    clock += 90001;
    await runtime.recoverRatingJobs();
    for (const id of [job._id, rollback._id]) {
        assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: id })).status, 'failed');
    }
});

test('pre-upgrade complete-but-unpublished snapshots are cancelled without changing previously published history', async () => {
    const first = await runtime.queueRatingApply('d', 99);
    await runtime.executeRatingJob(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: first.runId }));
    const active = await store.active('d');
    clock = Date.now();
    const old = await store.begin('d', true);
    await store.writeRows(old, legacyRows().rows, {});
    await db.collection(RATING_COLLECTIONS.runs).updateOne({ _id: old._id }, { $set: { status: 'complete' } });
    const key = Buffer.from('d').toString('base64url');
    await db.collection('system').updateOne({ _id: 'rating.publication' }, {
        $set: { [`value.locks.${key}.expiresAt`]: clock + 30 * 60000 },
        $unset: { [`value.locks.${key}.phase`]: '' },
    });
    await runtime.recoverRatingJobs();
    const legacyExpiry = (await db.collection('system').findOne({ _id: 'rating.publication' })).value.locks[key].expiresAt;
    assert.equal(legacyExpiry, clock + 90000);
    clock += 15000;
    await runtime.recoverRatingJobs();
    assert.equal((await db.collection('system').findOne({ _id: 'rating.publication' })).value.locks[key].expiresAt, legacyExpiry);
    clock += 75001;
    await runtime.recoverRatingJobs();
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: old._id })).status, 'failed');
    assert.equal((await store.receipt(old))?.unpublishedLegacy, true);
    assert.equal((await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: first.runId })).status, 'complete');
    assert.equal((await store.active('d'))?.version, active.version);
    const retry = await runtime.queueRatingApply('d', 99);
    assert.notEqual(retry.runId, old._id);
});

test('a limited-domain V2 trial includes a valid unrated course assessment alongside rated contests', async () => {
    await seedContest();
    const now = Date.now();
    const begin = new Date(now - 45 * 60000);
    const end = new Date(now - 30 * 60000);
    const courseTid = new ObjectId();
    const examTid = new ObjectId();
    await db.collection('document').insertMany([
        { _id: courseTid, docId: courseTid, docType: 30, domainId: 'd', rule: 'course',
            owner: 99, beginAt: begin, endAt: end, assign: [], dag: [{
                _id: 1, kind: 'assessment', pids: [1],
                assessment: { contestTid: examTid.toString(), rule: 'oi', beginAt: begin, endAt: end },
            }] },
        { _id: examTid, docId: examTid, docType: 30, domainId: 'd', rule: 'oi', rated: false,
            sourceType: 'course_assessment', sourceCourseTid: courseTid, sourceNodeId: 1,
            beginAt: begin, endAt: end, pids: [1], duration: 0, assign: [] },
    ]);
    await db.collection('document.status').insertMany([
        { domainId: 'd', docType: 30, docId: examTid, uid: 2, attend: true },
        { domainId: 'd', docType: 30, docId: examTid, uid: 3, attend: true },
    ]);
    await db.collection('record').insertMany([
        { _id: recordId(begin.getTime() + 1000, 61), domainId: 'd', uid: 2, pid: 1,
            contest: examTid, score: 100, status: 1 },
        { _id: recordId(begin.getTime() + 2000, 62), domainId: 'd', uid: 3, pid: 1,
            contest: examTid, score: 0, status: 2 },
    ]);
    await runtime.configureRating({ algorithm: 'v2_trial', domains: ['d'] }, 99);
    const runId = (await runtime.queueRatingApply('d', 99)).runId;
    await runtime.executeRatingJob(await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: runId }));
    const rows = await db.collection(RATING_COLLECTIONS.users).find({ domainId: 'd', runId }).toArray();
    assert.equal(rows.find((row) => row.uid === 2).ratedEvents, 2);
    assert.equal(rows.find((row) => row.uid === 3).ratedEvents, 2);
    const snapshot = await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: runId });
    assert.equal(snapshot.diagnostics.contests.ratedProcessed, 1);
    assert.equal(snapshot.diagnostics.contests.classroomProcessed, 1);
    assert.equal(snapshot.parameters.includeClassroomAssessments, true);
});

test('V2 publication saves replayed difficulty from mature contest participants', async () => {
    const firstStart = Date.now() - 8 * 86400000;
    for (let i = 0; i < 6; i++) {
        const tid = new ObjectId();
        const beginAt = new Date(firstStart + i * 86400000);
        const endAt = new Date(beginAt.getTime() + 3600000);
        await db.collection('document').insertOne({ _id: tid, docId: tid, docType: 30, domainId: 'd',
            rule: 'oi', rated: true, beginAt, endAt, duration: 0, pids: [1], assign: [] });
        await db.collection('record').insertMany([
            { _id: recordId(beginAt.getTime() + 60000, i * 2 + 1), domainId: 'd', uid: 2, pid: 1, contest: tid, status: 1, score: 100 },
            { _id: recordId(beginAt.getTime() + 120000, i * 2 + 2), domainId: 'd', uid: 3, pid: 1, contest: tid, status: 2, score: 0 },
        ]);
    }
    await runtime.configureRating({ algorithm: 'v2_trial', domains: ['d'] }, 99);
    const queued = await runtime.queueRatingApply('d', 99);
    const job = await db.collection(RATING_COLLECTIONS.runs).findOne({ _id: queued.runId });
    await runtime.executeRatingJob(job);
    const [difficulty] = await store.problemDifficulties('d', [1]);
    assert.equal(difficulty.runId, job._id);
    assert.equal(difficulty.students, 2);
    assert.equal(difficulty.pos, 1);
    assert.equal(difficulty.neg, 1);
    assert.equal(difficulty.status, 'ok');
    assert.equal(difficulty.provisionalLike, false);
    assert(Number.isFinite(difficulty.d));
});
