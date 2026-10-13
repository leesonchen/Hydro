import assert from 'node:assert/strict';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { after, before, beforeEach, test } from 'node:test';
import { runShadowReplay } from '../packages/hydrooj/src/lib/rating-v2/shadow-replay';

let server: MongoMemoryServer;
let client: MongoClient;
let db: any;
const beginAt = new Date('2020-01-01T10:00:00.000Z');
const endAt = new Date('2020-01-01T11:00:00.000Z');
const cutoff = new Date('2020-01-01T12:00:00.000Z').getTime();

before(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    db = client.db('rating-v2-public-replay');
});
after(async () => {
    await client?.close();
    await server?.stop();
});
beforeEach(async () => {
    for (const name of ['document', 'document.status', 'record', 'domain.user']) await db.collection(name).deleteMany({});
});

let recordCounter = 1;
function oid(ms: number) {
    const prefix = ObjectId.createFromTime(Math.floor(ms / 1000)).toHexString().slice(0, 8);
    return new ObjectId(`${prefix}0000000000${(recordCounter++).toString(16).padStart(6, '0')}`);
}
async function addContest(domainId: string, begin: Date, end: Date, options: any = {}) {
    const _id = new ObjectId();
    await db.collection('document').insertOne({ _id, docId: _id, docType: 30, domainId, rule: 'oi', rated: true,
        beginAt: begin, endAt: end, duration: 0, pids: [1], assign: [], ...options });
    return _id;
}
async function addRecord(contest: ObjectId, domainId: string, uid: number, time: number, extra: any = {}) {
    await db.collection('record').insertOne({ _id: oid(time), contest, domainId, uid, pid: 1, status: 1, score: 100, ...extra });
}
async function replay(options: any = {}) {
    let docs: any[] = [];
    const summary = await runShadowReplay(db, { asOf: cutoff, minParticipants: 1, difficultyMinPriorEvents: 0, ...options }, () => {}, (result) => { docs = result; });
    return { summary, docs };
}

test('trial replay is deterministic for unordered records and obeys exact contest windows and cutoff', async () => {
    const contest = await addContest('d', beginAt, endAt);
    await addRecord(contest, 'd', 2, beginAt.getTime() + 1000);
    await addRecord(contest, 'd', 1, beginAt.getTime() + 1000);
    await addRecord(contest, 'd', 3, endAt.getTime()); // exclusive end
    await addRecord(contest, 'd', 4, cutoff + 1000);
    await addRecord(contest, 'other', 6, beginAt.getTime() + 1000); // same contest pid, different domain
    await addRecord(contest, 'd', 7, beginAt.getTime() + 1000, { pid: 999 });
    await addRecord(contest, 'd', 8, beginAt.getTime() + 1000, { status: 0 });
    await addRecord(contest, 'd', 9, beginAt.getTime() + 1000, { score: Number.NaN });
    const future = await addContest('d', new Date(cutoff + 1000), new Date(cutoff + 3601000));
    await addRecord(future, 'd', 5, cutoff + 2000);
    const first = await replay({ domainId: 'd' });
    const second = await replay({ domainId: 'd' });
    assert.equal(first.summary.contests.total, 1);
    assert.equal(first.summary.contests.processed, 1);
    assert.deepEqual(first.docs, second.docs);
    assert.deepEqual(first.docs.filter((d) => d.kind === 'rating_state').map((d) => d.uid).sort(), [1, 2]);
    assert(first.docs.filter((d) => d.kind === 'observation').every((d) => d.contestId.toString() === contest.toString()));
});

test('trial replay prefers submittedAt milliseconds and applies inclusive begin, exclusive end, inclusive cutoff', async () => {
    const contest = await addContest('d', beginAt, endAt);
    // The ObjectId second is outside the contest; the precise submittedAt brings this record in.
    await addRecord(contest, 'd', 1, beginAt.getTime() - 1000, { submittedAt: new Date(beginAt.getTime()) });
    await addRecord(contest, 'd', 2, beginAt.getTime() - 1000, { submittedAt: new Date(beginAt.getTime() + 1) });
    await addRecord(contest, 'd', 3, endAt.getTime(), { submittedAt: new Date(endAt.getTime()) });
    await addRecord(contest, 'd', 4, cutoff + 1000, { submittedAt: new Date(cutoff) });
    await addRecord(contest, 'd', 5, cutoff, { submittedAt: new Date(cutoff + 1) });
    const { summary, docs } = await replay({ domainId: 'd' });
    assert.deepEqual(docs.filter((d) => d.kind === 'rating_state').map((d) => d.uid).sort(), [1, 2]);
    assert.equal(summary.contests.precisionFallbacks, 0);
});

test('trial fallback uses floored-second boundaries and reports fallback records', async () => {
    const fractionalBegin = new Date(beginAt.getTime() + 500);
    const fractionalEnd = new Date(endAt.getTime() + 500);
    const fractionalCutoff = cutoff + 500;
    const contest = await addContest('d', fractionalBegin, fractionalEnd);
    await addRecord(contest, 'd', 1, beginAt.getTime()); // begins in retained start second
    await addRecord(contest, 'd', 2, fractionalEnd.getTime() - 1000, { submittedAt: 'invalid-date' });
    const { summary, docs } = await replay({ domainId: 'd', asOf: fractionalCutoff });
    assert.deepEqual(docs.filter((d) => d.kind === 'rating_state').map((d) => d.uid).sort(), [1, 2]);
    assert.equal(summary.contests.precisionFallbacks, 2);
});

test('trial replay sorts precise submissions before ObjectId ties and deterministically keeps the last OI score', async () => {
    const contest = await addContest('d', beginAt, endAt);
    const sameSecond = beginAt.getTime() + 1000;
    // Insert in reverse effective-time order. The later precise submission scores 40.
    await addRecord(contest, 'd', 1, sameSecond, { submittedAt: new Date(sameSecond + 300), score: 40 });
    await addRecord(contest, 'd', 1, sameSecond, { submittedAt: new Date(sameSecond + 100), score: 10 });
    await addRecord(contest, 'd', 2, sameSecond, { submittedAt: new Date(sameSecond + 200), score: 100 });
    const first = await replay({ domainId: 'd' });
    const second = await replay({ domainId: 'd' });
    assert.deepEqual(first.docs, second.docs);
    assert.equal(first.summary.contests.processed, 1);
});

test('ACM CE status 7 does not add a wrong-answer penalty', async () => {
    const contest = await addContest('d', beginAt, endAt, { rule: 'acm' });
    await addRecord(contest, 'd', 1, beginAt.getTime() + 1000, { status: 1, score: 100 });
    await addRecord(contest, 'd', 1, beginAt.getTime() + 2000, { status: 7, score: 0 });
    await addRecord(contest, 'd', 2, beginAt.getTime() + 1000, { status: 1, score: 100 });
    await addRecord(contest, 'd', 3, beginAt.getTime() + 1000, { status: 2, score: 0 });
    const { summary, docs } = await replay({ domainId: 'd' });
    assert.equal(summary.contests.processed, 1);
    const states = docs.filter((d) => d.kind === 'rating_state');
    assert.equal(states.find((d) => d.uid === 1).mu, states.find((d) => d.uid === 2).mu);
});

test('personal duration requires attendance startAt and clamps each record to the personal window', async () => {
    const contest = await addContest('d', beginAt, endAt, { duration: 1 });
    await db.collection('document.status').insertMany([
        { docType: 30, domainId: 'd', docId: contest, uid: 1, attend: 1, startAt: new Date(beginAt.getTime() + 10 * 60000) },
        { docType: 30, domainId: 'd', docId: contest, uid: 2, attend: 1 },
        { docType: 30, domainId: 'd', docId: contest, uid: 3, attend: 1, startAt: new Date(beginAt.getTime() + 1) },
        { docType: 30, domainId: 'd', docId: contest, uid: 4, attend: 1, startAt: 'invalid-date' },
        { docType: 30, domainId: 'd', docId: contest, uid: 5, attend: 1, startAt: new Date(beginAt.getTime() + 5 * 60000), endAt: new Date(beginAt.getTime() + 10 * 60000) },
    ]);
    await addRecord(contest, 'd', 1, beginAt.getTime() + 10 * 60000);
    await addRecord(contest, 'd', 1, beginAt.getTime() + 70 * 60000); // after duration
    await addRecord(contest, 'd', 2, beginAt.getTime() + 20 * 60000); // missing start
    await addRecord(contest, 'd', 3, beginAt.getTime(), { submittedAt: new Date(beginAt.getTime()) }); // precise time before start
    await addRecord(contest, 'd', 4, beginAt.getTime() + 6 * 60000);
    await addRecord(contest, 'd', 5, beginAt.getTime() + 11 * 60000); // effective attendance endAt
    const { summary, docs } = await replay({ domainId: 'd' });
    assert.equal(summary.contests.processed, 0); // only one eligible participant remains
    assert(summary.contests.personalDurationExcluded.missingStart > 0);
    assert(summary.contests.personalDurationExcluded.invalidStart > 0);
    assert(summary.contests.personalDurationExcluded.outsideWindow > 0);
    assert.equal(docs.filter((d) => d.kind === 'rating_state').length, 0);
});

test('fallback records in the attendance start second are included in a personal duration window', async () => {
    const contest = await addContest('d', beginAt, endAt, { duration: 1 });
    const startAt = new Date(beginAt.getTime() + 500);
    await db.collection('document.status').insertOne({
        docType: 30, domainId: 'd', docId: contest, uid: 1, attend: 1, startAt,
    });
    await db.collection('document.status').insertOne({
        docType: 30, domainId: 'd', docId: contest, uid: 2, attend: 1, startAt: beginAt,
    });
    // The fallback timestamp for each ObjectId is the start second, before startAt's
    // millisecond value. Second precision must admit both submissions into this window.
    await addRecord(contest, 'd', 1, beginAt.getTime());
    await addRecord(contest, 'd', 1, beginAt.getTime() + 1);
    await addRecord(contest, 'd', 2, beginAt.getTime() + 1000);
    await addRecord(contest, 'd', 2, beginAt.getTime() + 2000);
    const { summary } = await replay({ domainId: 'd' });
    assert.equal(summary.contests.processed, 1);
});

test('domain scope isolates same contest pid, emits A0 rating projections and cutoff-scoped evidence', async () => {
    const dContest = await addContest('d', beginAt, endAt);
    const otherContest = await addContest('other', beginAt, endAt);
    await addRecord(dContest, 'd', 11, beginAt.getTime() + 1000);
    await addRecord(dContest, 'd', 12, beginAt.getTime() + 2000);
    await addRecord(otherContest, 'other', 11, beginAt.getTime() + 1000);
    await addRecord(otherContest, 'other', 13, beginAt.getTime() + 2000);
    await db.collection('document.status').insertMany([
        { docType: 10, domainId: 'd', uid: 11, docId: 1, rid: oid(beginAt.getTime() + 500), status: 1, score: 100 },
        { docType: 10, domainId: 'd', uid: 14, docId: 2, rid: oid(beginAt.getTime() + 600), status: 1, score: 100 },
        { docType: 10, domainId: 'd', uid: 15, docId: 3, rid: oid(cutoff + 1000), status: 1, score: 100 },
    ]);
    const { docs } = await replay({ domainId: 'd' });
    assert(docs.filter((d) => d.kind === 'rating_state').every((d) => d.domainId === 'd'));
    const projection = docs.find((d) => d.kind === 'projection' && d.uid === 12);
    assert(projection);
    assert.equal(projection.a, 0);
    assert.equal(projection.rating, 1500);
    const unrated = docs.find((d) => d.kind === 'projection' && d.uid === 14);
    assert(unrated);
    assert.equal(unrated.rating, null);
    assert.equal(docs.some((d) => d.kind === 'projection' && d.uid === 15), false);
    assert(docs.filter((d) => d.kind === 'observation').every((d) => d.uid !== 13));
});
