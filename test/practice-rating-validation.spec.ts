import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { STATUS } from '@hydrooj/common/status';
import { runPracticeRating } from '../packages/hydrooj/src/lib/practice-rating/runner';
import { ActiveScope, COLLECTIONS } from '../packages/hydrooj/src/lib/practice-rating/store';
import {
    evaluatePracticePredictions, freezePracticePredictions, PREDICTION_COLLECTION, summarizePredictions,
} from '../packages/hydrooj/src/lib/practice-rating/validation';

const DAY = 86400000;
const scope = 'prospective';
const record = (n: number, time: number, uid: number, pid: number, status = STATUS.STATUS_ACCEPTED) => ({
    _id: new ObjectId(ObjectId.createFromTime(Math.floor(time / 1000)).toHexString().slice(0, 8) + n.toString(16).padStart(16, '0')),
    domainId: scope, uid, pid, status, judgeAt: new Date(time + 1),
});

it('fixed bins and all three Brier metrics use identical evaluated observations', () => {
    const rows = [0, 1].map((y) => ({ y: y as 0 | 1,
        prediction: { uid: 2, pid: y + 1, probability: y ? 0.8 : 0.2, overallBaseline: 0.5, problemBaseline: y ? 0.6 : 0.4 } }));
    const result = summarizePredictions(rows);
    assert.ok(Math.abs(result.brier - 0.04) < 1e-12);
    assert.equal(result.overallBaselineBrier, 0.25);
    assert.ok(Math.abs(result.problemBaselineBrier - 0.16) < 1e-12);
    assert.equal(result.bins[2].samples, 1);
    assert.equal(result.bins[8].actual, 1);
    assert.equal(summarizePredictions([]).brier, null);
    assert.equal(summarizePredictions([]).conclusion, '尚无结论');
});

describe('prospective practice predictions with real Mongo adapters', () => {
    let mongo: MongoMemoryServer;
    let client: MongoClient;
    let database: ReturnType<MongoClient['db']>;
    before(async () => {
        mongo = await MongoMemoryServer.create();
        client = await MongoClient.connect(mongo.getUri());
        database = client.db('prospective-test');
    });
    after(async () => {
        mock.restoreAll();
        await client?.close();
        await mongo?.stop();
    });
    beforeEach(async () => {
        mock.restoreAll();
        await database.dropDatabase();
        await database.collection<any>('domain').insertOne({ _id: scope });
        const old = Date.now() - 8 * DAY;
        await database.collection('record').insertMany([
            record(1, old, 2, 10), record(2, old, 3, 10), record(3, old, 3, 20, STATUS.STATUS_WRONG_ANSWER),
        ]);
        await runPracticeRating(database, { domainId: scope, write: true });
    });

    it('freezes only unattempted connected pairs, including baselines, before outcomes exist', async () => {
        const result = await freezePracticePredictions(database, scope, [{ uid: 2, pid: 20 }, { uid: 2, pid: 10 }, { uid: 99, pid: 20 }]);
        assert.equal(result.predictions, 1);
        assert.deepEqual(result.skipped, { attempted: 1, excluded: 0, unavailable: 1 });
        const frozen = await database.collection(PREDICTION_COLLECTION).findOne({ _id: result.predictionId as any });
        assert.equal(frozen.rows[0].overallBaseline, 2 / 3);
        assert.equal(frozen.rows[0].problemBaseline, 0);
        const report = await evaluatePracticePredictions(database, scope, result.predictionId);
        assert.equal(report.counts.notAttempted, 1);
        assert.equal(report.samples, 0);
        assert.equal(report.brier, null);
        assert.equal(report.conclusion, '尚无结论');
        await assert.rejects(evaluatePracticePredictions(database, 'other', result.predictionId), /Unknown/);
        await assert.rejects(freezePracticePredictions(database, scope, [{ uid: 2, pid: 10 }]), /No eligible/);
    });

    it('later outcomes/configuration/active runs cannot rewrite frozen predictions or their eligibility', async () => {
        const frozen = await freezePracticePredictions(database, scope, [{ uid: 2, pid: 20 }]);
        const beforeDoc = await database.collection(PREDICTION_COLLECTION).findOne({ _id: frozen.predictionId as any });
        const t0 = Math.ceil((frozen.frozenAt + 1000) / 1000) * 1000;
        await database.collection('record').insertMany([
            record(10, t0, 2, 20, STATUS.STATUS_WRONG_ANSWER), record(11, t0 + DAY, 2, 20),
        ]);
        await database.collection<ActiveScope>(COLLECTIONS.active).updateOne({ _id: scope }, {
            $set: { excludedUids: [2], runId: 'later-run' },
        });
        await database.collection<any>('vuser').insertOne({ _id: 2 });
        mock.method(Date, 'now', () => t0 + 8 * DAY);
        const open = await evaluatePracticePredictions(database, scope, frozen.predictionId, t0 + 6 * DAY);
        assert.equal(open.samples, 0);
        assert.equal(open.counts.open, 1);
        const mature = await evaluatePracticePredictions(database, scope, frozen.predictionId, t0 + 7 * DAY);
        assert.equal(mature.samples, 1);
        assert.equal(mature.problemBaselineBrier, 1);
        assert.equal(mature.runId, frozen.runId);
        await database.collection('record').updateOne({ _id: record(11, t0 + DAY, 2, 20)._id }, {
            $set: { status: STATUS.STATUS_WRONG_ANSWER, judgeAt: new Date(t0 + 7 * DAY + 1000) },
        });
        const rejudged = await evaluatePracticePredictions(database, scope, frozen.predictionId);
        assert.equal(rejudged.samples, 1);
        assert.equal(rejudged.problemBaselineBrier, 0);
        assert.deepEqual(await database.collection(PREDICTION_COLLECTION).findOne({ _id: frozen.predictionId as any }), beforeDoc);
        await assert.rejects(evaluatePracticePredictions(database, scope, frozen.predictionId, frozen.frozenAt - 1), /precedes/);
    });

    it('pending results and attempts at or before the freeze are not future failures', async () => {
        const frozen = await freezePracticePredictions(database, scope, [{ uid: 2, pid: 20 }]);
        const t0 = Math.ceil((frozen.frozenAt + 1000) / 1000) * 1000;
        await database.collection('record').insertOne({ ...record(10, t0, 2, 20, STATUS.STATUS_WAITING), judgeAt: null });
        mock.method(Date, 'now', () => t0 + 8 * DAY);
        const pending = await evaluatePracticePredictions(database, scope, frozen.predictionId);
        assert.equal(pending.samples, 0);
        assert.equal(pending.counts.pending, 1);
        await database.collection('record').insertOne(record(11, frozen.frozenAt - 1000, 2, 20));
        const prior = await evaluatePracticePredictions(database, scope, frozen.predictionId);
        assert.equal(prior.samples, 0);
        assert.equal(prior.counts.beforeFreeze, 1);
    });

    it('a failed freeze acknowledgement leaves an unusable candidate rather than an evaluable prediction', async () => {
        const failing = {
            collection(name: string) {
                const coll = database.collection(name);
                if (name !== PREDICTION_COLLECTION) return coll;
                return new Proxy(coll, { get(target, prop) {
                    if (prop === 'updateOne') return async () => { throw new Error('Injected freeze failure'); };
                    const value = Reflect.get(target, prop);
                    return typeof value === 'function' ? value.bind(target) : value;
                } });
            },
        } as typeof database;
        await assert.rejects(freezePracticePredictions(failing, scope, [{ uid: 2, pid: 20 }]), /Injected freeze failure/);
        const candidate = await database.collection<any>(PREDICTION_COLLECTION).findOne({ scope });
        assert.equal(candidate.status, 'writing');
        await assert.rejects(evaluatePracticePredictions(database, scope, candidate._id), /Unknown/);
    });

    it('detects changes to the frozen timestamp/prediction and refuses incomplete cohorts', async () => {
        const frozen = await freezePracticePredictions(database, scope, [{ uid: 2, pid: 20 }]);
        await database.collection(PREDICTION_COLLECTION).updateOne({ _id: frozen.predictionId as any }, { $inc: { frozenAt: -1000 } });
        await assert.rejects(evaluatePracticePredictions(database, scope, frozen.predictionId), /checksum/);
        await database.collection(PREDICTION_COLLECTION).updateOne({ _id: frozen.predictionId as any }, { $set: { status: 'writing' } });
        await assert.rejects(evaluatePracticePredictions(database, scope, frozen.predictionId), /Unknown/);
        await assert.rejects(freezePracticePredictions(database, scope, [{ uid: 2, pid: 20 }, { uid: 2, pid: 20 }]), /Invalid/);
    });
});
