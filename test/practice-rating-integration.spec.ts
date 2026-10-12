import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { after, before, beforeEach, describe, it } from 'node:test';
import ts from 'typescript';
import { STATUS } from '@hydrooj/common/status';
import { capturePracticeInput, RatingDatabase, RECORD_PROJECTION } from '../packages/hydrooj/src/lib/practice-rating/adapter';
import { completionProbability, fitPracticeRating } from '../packages/hydrooj/src/lib/practice-rating/model';
import { runPracticeRating } from '../packages/hydrooj/src/lib/practice-rating/runner';
import { ActiveScope, COLLECTIONS, PracticeRatingStore, probabilityForRun } from '../packages/hydrooj/src/lib/practice-rating/store';

const scope = 'rating-fixture';
const DAY = 86400000;
const t0 = Math.floor((Date.now() - 8 * DAY) / 1000) * 1000;
const rid = (n: number, time = t0) => new ObjectId(ObjectId.createFromTime(Math.floor(time / 1000)).toHexString().slice(0, 8)
    + n.toString(16).padStart(16, '0'));
const record = (n: number, uid: number, pid: number, status = STATUS.STATUS_WRONG_ANSWER) => ({
    _id: rid(n), domainId: scope, uid, pid, status, judgeAt: new Date(t0 + 1000),
    code: 'private source should never be read', compilerTexts: ['large private output'],
});

describe('practice rating isolated MongoDB integration', () => {
    let mongo: MongoMemoryServer;
    let client: MongoClient;
    let database: ReturnType<MongoClient['db']>;
    let store: PracticeRatingStore;
    before(async () => {
        mongo = await MongoMemoryServer.create();
        client = await MongoClient.connect(mongo.getUri());
        database = client.db('practice-rating-test');
        store = new PracticeRatingStore(database);
    });
    after(async () => {
        await client?.close();
        await mongo?.stop();
    });
    beforeEach(async () => {
        await database.dropDatabase();
        await database.collection<any>('domain').insertMany([{ _id: scope }, { _id: 'other-domain' }]);
        await database.collection('record').insertMany([
            record(1, 2, 10, STATUS.STATUS_ACCEPTED), record(2, 2, 100),
            record(3, 3, 10, STATUS.STATUS_ACCEPTED), record(4, 3, 100, STATUS.STATUS_ACCEPTED),
        ]);
        await database.collection('domain.user').insertOne({ domainId: scope, uid: 2, rp: 123, rpInfo: { problem: 123 }, level: 4, rank: 1 });
        await database.collection('document').insertOne({ domainId: scope, docType: 10, docId: 10, difficulty: 5, nAccept: 2 });
    });

    it('projects only minimal raw fields, scopes records, excludes virtual and configured accounts', async () => {
        const contest = new ObjectId();
        await database.collection('record').insertMany([
            { ...record(5, 99, 10), contest }, record(6, 4, 10), record(7, 1, 10),
            { ...record(8, 2, 10), domainId: 'other-domain' },
            { ...record(9, 2, 200), contest: new ObjectId('000000000000000000000000') },
        ]);
        await database.collection<any>('vuser').insertOne({ _id: 99, members: [2, 3] });
        await database.collection('document').insertOne({ domainId: scope, docType: 30, docId: contest, rule: 'oi' });
        const input = await capturePracticeInput(database, scope, [4]);
        assert.equal(input.records.length, 8);
        assert.ok(input.records.every((r) => r.domainId === scope && !('code' in r) && !('compilerTexts' in r)));
        assert.deepEqual(Object.keys(RECORD_PROJECTION).sort(), ['_id', 'contest', 'domainId', 'judgeAt', 'pid', 'practiceContest', 'status', 'uid']);
        assert.equal(input.records.find((r) => r.uid === 99).policyExclusion, 'team_aggregate');
        assert.equal(input.records.find((r) => r.uid === 4).policyExclusion, 'test_account');
        const summary = await runPracticeRating(database, { domainId: scope, excludedUids: [4] });
        assert.equal(summary.users, 2);
        assert.equal(summary.diagnostics.excludedByReason.team_aggregate, 1);
        assert.equal(summary.diagnostics.excludedByReason.service_account, 1);
        assert.equal(summary.diagnostics.excludedByReason.special_record, 1);
        assert.equal(await database.collection(COLLECTIONS.active).countDocuments(), 0);
    });

    it('applies explicit and built-in exclusions at a historical cutoff and records the effective policy', async () => {
        await database.collection('record').insertMany([record(5, 4, 10), record(6, 1, 10), record(7, 99, 10)]);
        await database.collection<any>('vuser').insertOne({ _id: 99 });
        await database.collection<ActiveScope>(COLLECTIONS.active).insertOne({ _id: scope, excludedUids: [3] });
        const result = await runPracticeRating(database, { domainId: scope, asOf: t0 + 7 * DAY, excludedUids: [4], write: true });
        assert.equal(result.users, 1);
        assert.equal(result.diagnostics.excludedByReason.test_account, 3);
        assert.equal(result.diagnostics.excludedByReason.service_account, 1);
        assert.equal(result.diagnostics.excludedByReason.team_aggregate, 1);
        const run = await store.activeRun(scope);
        assert.deepEqual(run.exclusionPolicy.excludedUids, [3, 4]);
        assert.deepEqual(run.exclusionPolicy.virtualUids, [99]);
        assert.equal(typeof run.exclusionPolicyVersion, 'string');
        assert.equal(run.diagnostics.unknownRevisionTrainingRatio, 1);
        await database.collection<ActiveScope>(COLLECTIONS.active).updateOne({ _id: scope }, { $set: { excludedUids: [] } });
        assert.deepEqual((await store.activeRun(scope)).exclusionPolicy.excludedUids, [3, 4]);
    });

    it('empty automatic fits keep the previous estimate; an initially empty scope remains unactivated', async () => {
        const empty = await runPracticeRating(database, { domainId: 'other-domain', write: true });
        assert.equal(empty.status, 'insufficient');
        assert.equal(empty.activated, false);
        assert.equal(await store.activeRun('other-domain'), null);
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        const next = await runPracticeRating(database, { domainId: scope, excludedUids: [2, 3], write: true });
        assert.equal(next.status, 'insufficient');
        assert.equal(next.activated, false);
        assert.equal((await store.activeRun(scope))._id, first.runId);
        assert.equal((await database.collection(COLLECTIONS.runs).findOne({ _id: next.runId as any })).status, 'insufficient');
        assert.equal((await store.read(scope, 2, 10)).latestAttempt.status, 'insufficient');
    });

    it('reuses immutable training chunks and never copies expired history into a daily snapshot', async () => {
        await database.collection('record').insertOne({ ...record(55, 5, 10), _id: rid(55, t0 - 200 * DAY), judgeAt: new Date(t0 - 199 * DAY) });
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        const count = await database.collection(COLLECTIONS.episodes).countDocuments();
        await runPracticeRating(database, { domainId: scope, write: true });
        assert.equal(await database.collection(COLLECTIONS.episodes).countDocuments(), count);
        const rows = await store.trainingInput(first.runId, scope);
        assert.equal(rows.length, 4);
        assert.ok(rows.every((s) => s.observation && s.episode.uid !== 5));
    });

    it('T12/T17: dry run is read-only and repeated writes do not accumulate or alter legacy data', async () => {
        const beforeUsers = await database.collection('domain.user').find({}).toArray();
        const beforeProblems = await database.collection('document').find({}).toArray();
        const beforeRecords = await database.collection('record').find({}).toArray();
        const dry = await runPracticeRating(database, { domainId: scope });
        assert.equal(dry.runId, null);
        const shadowCollections: readonly string[] = Object.values(COLLECTIONS);
        assert.ok((await database.listCollections().toArray()).every((c) => !shadowCollections.includes(c.name)));
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        const old = await store.activeRun(scope);
        const second = await runPracticeRating(database, { domainId: scope, write: true });
        const current = await store.activeRun(scope);
        assert.notEqual(first.runId, second.runId);
        assert.equal(current.outputHash, old.outputHash);
        assert.deepEqual(await database.collection('domain.user').find({}).toArray(), beforeUsers);
        assert.deepEqual(await database.collection('document').find({}).toArray(), beforeProblems);
        assert.deepEqual(await database.collection('record').find({}).toArray(), beforeRecords);
        assert.equal(current.status, 'complete');
        assert.equal(current.counts.episodes, 4);
        const report = await store.read(scope, 2, 10);
        assert.equal(report.runId, second.runId);
        assert.equal(report.probability, completionProbability(report.user.value, report.problem.value));
        assert.ok(!JSON.stringify(report).includes('evidence'));
        assert.ok(!JSON.stringify(report).includes('recordIds'));
        assert.equal((await store.read('unrated-domain', 2, 10)).runId, null);
    });

    it('T10: freezes actual input and labels across a later rejudge', async () => {
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        const frozen = await store.trainingInput(first.runId, scope);
        assert.equal(frozen.find((s) => s.episode.uid === 2 && s.episode.pid === 10).observation.y, 1);
        await database.collection('record').updateOne({ _id: rid(1) }, { $set: { status: STATUS.STATUS_WRONG_ANSWER, judgeAt: new Date() } });
        const next = await runPracticeRating(database, { domainId: scope, write: true });
        const changed = (await store.trainingInput(next.runId, scope)).find((s) => s.episode.uid === 2 && s.episode.pid === 10);
        assert.equal(changed.observation.y, 0);
        assert.deepEqual(await store.trainingInput(first.runId, scope), frozen);
    });

    it('T13: half-write failure keeps the previous complete run and releases its lease', async () => {
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        const failing = {
            collection(name: string) {
                const coll = database.collection(name);
                if (name !== COLLECTIONS.users) return coll;
                return new Proxy(coll, { get(target, prop) {
                    if (prop === 'insertMany') return async () => { throw new Error('Injected user write failure'); };
                    const value = Reflect.get(target, prop);
                    return typeof value === 'function' ? value.bind(target) : value;
                } });
            },
        } as RatingDatabase;
        await assert.rejects(runPracticeRating(failing, { domainId: scope, write: true }), /Injected user write failure/);
        assert.equal((await store.activeRun(scope))._id, first.runId);
        assert.equal(await database.collection(COLLECTIONS.runs).countDocuments({ status: 'failed' }), 1);
        assert.equal((await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope })).lock, undefined);
        await runPracticeRating(database, { domainId: scope, write: true });
    });

    it('T14: rejects mixed runs/scopes and cross-component probability requests', () => {
        const fit = fitPracticeRating([
            { domainId: scope, uid: 2, pid: 10, revision: null, y: 1, windowEnd: 1000, episodeKey: 'a' },
            { domainId: scope, uid: 3, pid: 100, revision: null, y: 0, windowEnd: 1000, episodeKey: 'b' },
        ], scope);
        const user = { ...fit.users[0], runId: 'run-a', scope };
        const problem = { ...fit.problems[0], runId: 'run-a', scope };
        assert.throws(() => probabilityForRun('run-a', scope, user, { ...problem, runId: 'run-b' }), /Mixed run/);
        assert.throws(() => probabilityForRun('run-a', 'other', user, problem), /Mixed run/);
        assert.equal(probabilityForRun('run-a', scope, user, { ...fit.problems[1], runId: 'run-a', scope }), null);
    });

    it('checksum mismatch after successful inserts cannot switch the active pointer', async () => {
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        const corrupting = {
            collection(name: string) {
                const coll = database.collection(name);
                if (name !== COLLECTIONS.users) return coll;
                return new Proxy(coll, { get(target, prop) {
                    if (prop === 'insertMany') {
                        return async (docs: any[]) => {
                            const result = await target.insertMany(docs);
                            await target.updateOne({ _id: docs[0]._id }, { $set: { value: 99999 } });
                            return result;
                        };
                    }
                    const value = Reflect.get(target, prop);
                    return typeof value === 'function' ? value.bind(target) : value;
                } });
            },
        } as RatingDatabase;
        await assert.rejects(runPracticeRating(corrupting, { domainId: scope, write: true }), /checksum/);
        assert.equal((await store.activeRun(scope))._id, first.runId);
    });

    it('rejects a damaged reused input chunk and preserves the current estimates', async () => {
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        const run = await store.activeRun(scope);
        await database.collection<any>(COLLECTIONS.episodes).updateOne({ _id: run.inputChunks[0] }, {
            $set: { 'rows.0.observation.y': 99 },
        });
        await assert.rejects(runPracticeRating(database, { domainId: scope, write: true }), /checksum/);
        assert.equal((await store.activeRun(scope))._id, first.runId);
        await assert.rejects(store.trainingInput(first.runId, scope), /checksum/);
    });

    it('reads legacy v1 training snapshots without rewriting them', async () => {
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        const rows = await store.trainingInput(first.runId, scope);
        await database.collection<any>(COLLECTIONS.runs).insertOne({ _id: 'legacy-run', scope, status: 'complete' });
        await database.collection<any>(COLLECTIONS.episodes).insertMany(rows.map((r, i) => ({
            _id: `legacy-${i}`, scope, runId: 'legacy-run', ...r, evidence: [],
        })));
        assert.deepEqual(await store.trainingInput('legacy-run', scope), rows);
    });

    it('keeps a validated active run complete if the pointer write succeeds but its response is lost', async () => {
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        const losingResponse = {
            collection(name: string) {
                const coll = database.collection(name);
                if (name !== COLLECTIONS.active) return coll;
                return new Proxy(coll, { get(target, prop) {
                    if (prop === 'updateOne') {
                        return async (query: any, update: any) => {
                            const result = await target.updateOne(query, update);
                            if (update.$set?.runId) throw new Error('Injected lost pointer response');
                            return result;
                        };
                    }
                    const value = Reflect.get(target, prop);
                    return typeof value === 'function' ? value.bind(target) : value;
                } });
            },
        } as RatingDatabase;
        const recovered = await runPracticeRating(losingResponse, { domainId: scope, write: true });
        const current = await store.activeRun(scope);
        assert.notEqual(current._id, first.runId);
        assert.equal(recovered.runId, current._id);
        assert.equal(current.status, 'complete');
        assert.ok((await store.read(scope, 2, 10)).probability !== null);
    });

    it('one report retains the captured run even if the active pointer changes during its reads', async () => {
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        const moving = {
            collection(name: string) {
                const coll = database.collection(name);
                if (name !== COLLECTIONS.users) return coll;
                return new Proxy(coll, { get(target, prop) {
                    if (prop === 'findOne') {
                        return async (query: any) => {
                            await database.collection<ActiveScope>(COLLECTIONS.active).updateOne({ _id: scope }, { $set: { runId: 'successor' } });
                            return target.findOne(query);
                        };
                    }
                    const value = Reflect.get(target, prop);
                    return typeof value === 'function' ? value.bind(target) : value;
                } });
            },
        } as RatingDatabase;
        const report = await new PracticeRatingStore(moving).read(scope, 2, 10);
        assert.equal(report.runId, first.runId);
        assert.ok(report.probability !== null);
    });

    it('allows only one domain writer and prevents stale owners from publishing or unlocking a successor', async () => {
        const lease = await store.acquire(scope);
        await assert.rejects(new PracticeRatingStore(database).acquire(scope), /already running/);
        await database.collection<ActiveScope>(COLLECTIONS.active).updateOne({ _id: scope }, { $set: { 'lock.expiresAt': 0 } });
        const next = await store.acquire(scope);
        await assert.rejects(store.save({ runId: 'expired-owner', scope, asOf: Date.now(), capturedAt: Date.now(),
            fit: fitPracticeRating([], scope), episodes: [], diagnostics: {} }, lease), /expired or was replaced/);
        await store.release(scope, lease.token);
        assert.equal((await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope })).lock.token, next.token);
        await store.release(scope, next.token);
    });

    it('rejects an older cutoff and corrupt snapshots without replacing the active run', async () => {
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        const lease = await store.acquire(scope);
        try {
            await assert.rejects(store.save({ runId: 'bad-fit', scope, asOf: Date.now(), capturedAt: Date.now(),
                fit: fitPracticeRating([], 'other-domain'), episodes: [], diagnostics: {} }, lease), /Invalid fit/);
            await assert.rejects(store.save({ runId: 'old-cutoff', scope, asOf: t0, capturedAt: Date.now(),
                fit: { ...fitPracticeRating([], scope), status: 'ok' }, episodes: [], diagnostics: {} }, lease), /older/);
            assert.equal((await store.activeRun(scope))._id, first.runId);
        } finally {
            await store.release(scope, lease.token);
        }
        await assert.rejects(capturePracticeInput(database, 'missing'), /Unknown domain/);
        await assert.rejects(capturePracticeInput(database, scope, [], Date.now() + DAY), /Invalid/);
    });

    it('T16: script registration defaults to read-only and daily fits only enabled scopes', async () => {
        const scripts: Record<string, any> = {};
        const hooks: Record<string, Function> = {};
        const errors: string[] = [];
        const filename = path.resolve('packages/hydrooj/src/script/practice-rating.ts');
        const exported: any = {};
        const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText;
        vm.runInNewContext(code, { exports: exported, require(name: string) {
            if (name === '../context') return {};
            if (name === '../service/db') return { default: database, __esModule: true };
            if (name === '../logger') return { Logger: class { info() {} error(...args: any[]) { errors.push(args.join(' ')); } } };
            if (name.startsWith('../lib/')) return require(path.resolve('packages/hydrooj/src', name.slice(3)));
            return require(name);
        } }, { filename });
        await exported.apply({
            addScript(name: string, _description: string, validate: any, run: Function) { scripts[name] = { validate, run }; },
            on(event: string, callback: Function) { hooks[event] = callback; },
        });
        assert.equal(scripts['practice-rating-run'].validate({ domainId: scope }).write, false);
        await hooks['task/daily']();
        assert.equal(await database.collection(COLLECTIONS.runs).countDocuments(), 0);
        await scripts['practice-rating-configure'].run({ domainId: scope, enabled: true, excludedUids: [] }, () => {});
        await database.collection<any>(COLLECTIONS.active).insertOne({ _id: 'absent-domain', enabled: true });
        await hooks['task/daily']();
        assert.equal(await database.collection(COLLECTIONS.runs).countDocuments({ scope, status: 'complete' }), 1);
        assert.ok(errors.some((e) => e.includes('absent-domain')));
        await scripts['practice-rating-configure'].run({ domainId: scope, enabled: false, excludedUids: [] }, () => {});
        await hooks['task/daily']();
        assert.equal(await database.collection(COLLECTIONS.runs).countDocuments({ scope }), 1);
    });
    it('reports valid writes separately from interrupted snapshots without changing the active rating', async () => {
        const first = await runPracticeRating(database, { domainId: scope, write: true });
        assert.equal(first.activated, true);
        const previous = await store.activeRun(scope);
        await database.collection<any>(COLLECTIONS.runs).insertOne({
            _id: 'interrupted-snapshot', scope, asOf: previous.asOf,
            capturedAt: previous.capturedAt + 1, status: 'writing', leaseToken: 'expired-owner',
        });
        let current = await store.read(scope, 2, 10);
        assert.equal(current.runId, first.runId);
        assert.equal(current.latestAttempt.status, 'interrupted');
        await database.collection<ActiveScope>(COLLECTIONS.active).updateOne({ _id: scope }, {
            $set: { lock: { token: 'live-owner', expiresAt: Date.now() + 60000 } },
        });
        await database.collection<any>(COLLECTIONS.runs).updateOne({ _id: 'interrupted-snapshot' }, {
            $set: { leaseToken: 'live-owner' },
        });
        current = await store.read(scope, 2, 10);
        assert.equal(current.latestAttempt.status, 'writing');
        await database.collection<ActiveScope>(COLLECTIONS.active).updateOne({ _id: scope }, {
            $set: { 'lock.expiresAt': 0 },
        });
        current = await store.read(scope, 2, 10);
        assert.equal(current.latestAttempt.status, 'interrupted');
        assert.equal((await store.activeRun(scope))._id, first.runId);
    });

    it('administrator trial configuration changes only explicit fields and never revives teacherTrial', async () => {
        const scripts: Record<string, any> = {};
        const filename = path.resolve('packages/hydrooj/src/script/practice-rating.ts');
        const exported: any = {};
        const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText;
        vm.runInNewContext(code, { exports: exported, require(name: string) {
            if (name === '../context') return {};
            if (name === '../service/db') return { default: database, __esModule: true };
            if (name === '../logger') return { Logger: class { info() {} error() {} } };
            if (name.startsWith('../lib/')) return require(path.resolve('packages/hydrooj/src', name.slice(3)));
            return require(name);
        } }, { filename });
        await exported.apply({
            addScript(name: string, _description: string, validate: any, run: Function) { scripts[name] = { validate, run }; },
            on() {},
        });
        const { validate, run } = scripts['practice-rating-configure'];
        const configure = async (fields: Record<string, unknown>) => run(validate({ domainId: scope, ...fields }), () => {});
        const omitted = validate({ domainId: scope, enabled: false });
        assert.equal(omitted.excludedUids, undefined, 'Schemastery must not inject [] for an omitted list');
        await configure({ enabled: true, adminTrial: true, excludedUids: [3, 4, 3] });
        let saved = await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope });
        assert.equal(saved.enabled, true);
        assert.equal(saved.adminTrial, true);
        assert.deepEqual(saved.excludedUids, [3, 4]);
        const hash = saved.exclusionConfigVersion;
        await configure({ enabled: false });
        saved = await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope });
        assert.equal(saved.enabled, false);
        assert.equal(saved.adminTrial, true);
        assert.deepEqual(saved.excludedUids, [3, 4]);
        assert.equal(saved.exclusionConfigVersion, hash);
        await configure({ adminTrial: false });
        saved = await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope });
        assert.equal(saved.enabled, false);
        assert.equal(saved.adminTrial, false);
        assert.deepEqual(saved.excludedUids, [3, 4]);
        await configure({ excludedUids: [] });
        saved = await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope });
        assert.deepEqual(saved.excludedUids, []);
        assert.notEqual(saved.exclusionConfigVersion, hash);
        await Promise.all([null, '3', [0], [1.5], ['3'], [Number.MAX_SAFE_INTEGER + 1]].map((invalid) => assert.rejects(
            configure({ enabled: true, adminTrial: true, excludedUids: invalid }), /excludedUids must be an array of positive integer UIDs/,
        )));
        assert.deepEqual(await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope }), saved);
        await assert.rejects(configure({}), /Provide enabled, adminTrial or excludedUids/);
    });
});
