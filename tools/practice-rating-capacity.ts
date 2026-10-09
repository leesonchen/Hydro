/* eslint-disable no-await-in-loop */
// Isolated synthetic capacity gate; never connects to an installation database.
import assert from 'node:assert/strict';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { STATUS } from '@hydrooj/common/status';
import { capturePracticeInput, MAX_RECORDS, RECORD_PROJECTION } from '../packages/hydrooj/src/lib/practice-rating/adapter';
import { runPracticeRating } from '../packages/hydrooj/src/lib/practice-rating/runner';
import { COLLECTIONS, PracticeRatingStore } from '../packages/hydrooj/src/lib/practice-rating/store';

async function main() {
    const mongo = await MongoMemoryServer.create();
    const client = await MongoClient.connect(mongo.getUri());
    try {
        const database = client.db('practice-capacity');
        const scope = 'capacity';
        const t0 = Date.now() - 8 * 86400000;
        await database.collection<any>('domain').insertOne({ _id: scope });
        for (let start = 0; start < MAX_RECORDS; start += 1000) {
            await database.collection('record').insertMany(Array.from({ length: 1000 }, (_, j) => {
                const i = start + j;
                return { _id: new ObjectId(ObjectId.createFromTime(Math.floor(t0 / 1000)).toHexString().slice(0, 8)
                    + i.toString(16).padStart(16, '0')), domainId: scope, uid: 2 + Math.floor(i / 200), pid: 1 + i % 200,
                status: i % 3 ? STATUS.STATUS_ACCEPTED : STATUS.STATUS_WRONG_ANSWER, judgeAt: new Date(t0 + 1000) };
            }));
        }
        const store = new PracticeRatingStore(database);
        await store.ensureIndexes();
        const explain = await database.collection('record').find({ domainId: scope, _id: { $lt: new ObjectId() } }, {
            projection: RECORD_PROJECTION,
        }).sort({ _id: 1 }).limit(MAX_RECORDS + 1).explain('executionStats');
        assert.ok(JSON.stringify(explain.queryPlanner.winningPlan).includes('practiceRatingScan'));
        assert.ok(!JSON.stringify(explain.queryPlanner.winningPlan).includes('"SORT"'));
        const measure = async () => {
            const delay = monitorEventLoopDelay({ resolution: 10 });
            let peakRss = process.memoryUsage().rss;
            const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
            delay.enable();
            const start = performance.now();
            try {
                const result = await runPracticeRating(database, { domainId: scope, write: true });
                return { ms: performance.now() - start, peakRss, maxEventLoopMs: delay.max / 1e6, p99EventLoopMs: delay.percentile(99) / 1e6,
                    result, bytes: (await database.command({ collStats: COLLECTIONS.episodes })).size,
                    chunks: await database.collection(COLLECTIONS.episodes).countDocuments() };
            } finally {
                delay.disable();
                clearInterval(sampler);
            }
        };
        const first = await measure();
        const second = await measure();
        assert.equal(second.chunks, first.chunks);
        assert.equal(second.bytes, first.bytes);
        assert.equal(second.result.diagnostics.trainingObservations, MAX_RECORDS);
        await database.collection('record').insertOne({ _id: new ObjectId(), domainId: scope, uid: 2, pid: 1,
            status: STATUS.STATUS_WAITING, judgeAt: null });
        await assert.rejects(capturePracticeInput(database, scope), /record limit exceeded/);
        assert.equal((await store.activeRun(scope))._id, second.result.runId);
        console.log(JSON.stringify({ at: new Date().toISOString(), records: MAX_RECORDS, first, second,
            limitPlusOneRejected: true, stats: explain.executionStats, plan: explain.queryPlanner.winningPlan }, null, 2));
    } finally {
        await client.close();
        await mongo.stop();
    }
}
main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
