const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');

// Match the repository's TypeScript unit-test approach, without loading Hydro
// or requiring MongoDB/AI-EDU. Real MongoDB and HTTP integration remain required.
const filename = path.resolve(__dirname, '../packages/hydrooj/src/lib/classroomFeedback.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
const imports = [];
loaded.require = (name) => {
    imports.push(name);
    return require(name);
};
loaded._compile(compiled, filename);
const { normalizeFeedbackInput, createLocalFeedbackWriter, FeedbackValidationError, FeedbackConflictError } = loaded.exports;
const actor = { domainId: 'class-a', operatorUid: 7 };
const allow = async () => {};
const input = (patch = {}) => ({
    requestId: '4aa1bc34-6f80-44a6-9e2b-f9c4aaaaca01', studentUid: 11,
    activityType: 'course', activityId: '0123456789abcdef01234567', pid: 42,
    kind: 'GUIDED', ...patch,
});

function fixture() {
    const records = new Map();
    const calls = [];
    const store = {
        async findOne(filter) {
            calls.push('read');
            return structuredClone(records.get(filter._id) || null);
        },
        async insertOne(record) {
            calls.push('insert');
            if (records.has(record._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
            records.set(record._id, structuredClone(record));
            return { acknowledged: true };
        },
    };
    const writer = createLocalFeedbackWriter(store, () => new Date('2026-10-05T00:00:00Z'));
    return { records, calls, store, writer };
}

test('runtime dependencies contain no AI-EDU, HTTP client, queue or framework', () => {
    assert.deepEqual(imports, ['node:crypto']);
});

test('accepts feedback without a submission, detail or mandatory note', async () => {
    const f = fixture();
    const saved = await f.writer.record(actor, input(), allow);
    assert.equal(saved.replayed, false);
    const doc = [...f.records.values()][0];
    assert.equal(doc.source, 'hydro');
    assert.equal(doc.eventType, 'OBSERVATION_RECORDED');
    assert.equal(doc.operatorUid, actor.operatorUid);
    assert.equal(doc.note, '');
    assert.equal('rid' in doc, false);
    assert.equal('rating' in doc, false);
});

for (const kind of ['GUIDED', 'CHECKED', 'NEEDS_RETEST']) {
    test(`accepts ${kind} as an observation, not a mastery score`, () => {
        assert.equal(normalizeFeedbackInput(input({ kind })).kind, kind);
    });
}

for (const [field, value] of [
    ['studentUid', 0], ['studentUid', '11'], ['studentUid', 1.2], ['studentUid', Number.MAX_SAFE_INTEGER + 1],
    ['pid', -1], ['pid', '42x'], ['pid', Infinity], ['activityId', 'bad-id'], ['activityType', 'contest'],
    ['rid', 'bad-id'], ['kind', 'INDEPENDENT'], ['detail', 'REFERENCE_COPY'], ['nodeId', -1], ['nodeId', 1.5],
    ['note', 3], ['note', 'x'.repeat(501)], ['requestId', 'short'], ['requestId', 'x'.repeat(81)],
    ['domainId', 'forged-domain'], ['operatorUid', 99], ['recordedAt', '2026-01-01'], ['rating', 2000],
]) {
    test(`rejects invalid or client-forged field ${field}=${String(value).slice(0, 25)}`, () => {
        assert.throws(() => normalizeFeedbackInput(input({ [field]: value })), FeedbackValidationError);
    });
}

for (const value of [null, [], 'text', 0]) {
    test(`rejects non-object body ${JSON.stringify(value)}`, () => {
        assert.throws(() => normalizeFeedbackInput(value), FeedbackValidationError);
    });
}

test('detail must belong to the selected observation kind', () => {
    assert.throws(() => normalizeFeedbackInput(input({ kind: 'CHECKED', detail: 'DEBUGGING' })), FeedbackValidationError);
    assert.equal(normalizeFeedbackInput(input({ detail: 'DEBUGGING' })).detail, 'DEBUGGING');
});

test('normalizes object IDs and notes deterministically', () => {
    const doc = normalizeFeedbackInput(input({ activityId: 'ABCDEFABCDEFABCDEFABCDEF', note: ' a\r\nb\r ' }));
    assert.equal(doc.activityId, 'abcdefabcdefabcdefabcdef');
    assert.equal(doc.note, 'a\nb');
    assert.equal(normalizeFeedbackInput(input({ note: '\u{1f600}'.repeat(500) })).note.length, 1000);
});

test('course node zero is valid; homework nodes are rejected', () => {
    assert.equal(normalizeFeedbackInput(input({ nodeId: 0 })).nodeId, 0);
    assert.throws(() => normalizeFeedbackInput(input({ activityType: 'homework', nodeId: 0 })), FeedbackValidationError);
    assert.equal(normalizeFeedbackInput(input({ activityType: 'homework' })).activityType, 'homework');
});

test('normalization does not mutate the incoming body', () => {
    const raw = Object.freeze(input({ note: ' hi ' }));
    assert.equal(normalizeFeedbackInput(raw).note, 'hi');
    assert.equal(raw.note, ' hi ');
});

test('authorization is mandatory and occurs before any local read/write', async () => {
    const f = fixture();
    await assert.rejects(f.writer.record(actor, input()), /authorizer/);
    await assert.rejects(f.writer.record(actor, input(), async () => { throw new Error('Forbidden'); }), /Forbidden/);
    assert.equal(f.calls.length, 0);
});

test('invalid input and invalid server identity never reach the store', async () => {
    const f = fixture();
    await assert.rejects(f.writer.record(actor, input({ pid: 0 }), allow), FeedbackValidationError);
    await assert.rejects(f.writer.record({ ...actor, domainId: ' class-a' }, input(), allow), FeedbackValidationError);
    await assert.rejects(f.writer.record({ ...actor, operatorUid: 0 }, input(), allow), FeedbackValidationError);
    assert.equal(f.calls.length, 0);
});

test('authorizer receives immutable normalized local identities and context', async () => {
    const f = fixture();
    await f.writer.record(actor, input({ nodeId: 1 }), async (a, i) => {
        assert.deepEqual(a, actor);
        assert.equal(i.nodeId, 1);
        assert.equal(Object.isFrozen(a), true);
        assert.equal(Object.isFrozen(i), true);
        assert.equal(f.calls.length, 0);
    });
});

test('retries keep one record and the original server recording time', async () => {
    const f = fixture();
    const first = await f.writer.record(actor, input(), allow);
    const later = createLocalFeedbackWriter(f.store, () => new Date('2026-10-06T00:00:00Z'));
    const second = await later.record(actor, input({ note: '  ' }), allow);
    assert.equal(second.eventId, first.eventId);
    assert.equal(second.recordedAt, first.recordedAt);
    assert.equal(second.replayed, true);
    assert.equal(f.records.size, 1);
});

test('retries are reauthorized after access has been revoked', async () => {
    const f = fixture();
    await f.writer.record(actor, input(), allow);
    const count = f.calls.length;
    await assert.rejects(f.writer.record(actor, input(), async () => { throw new Error('Revoked'); }), /Revoked/);
    assert.equal(f.calls.length, count);
});

test('reusing a requestId with different content is a conflict, never an overwrite', async () => {
    const f = fixture();
    await f.writer.record(actor, input(), allow);
    await assert.rejects(f.writer.record(actor, input({ kind: 'CHECKED' }), allow), FeedbackConflictError);
    assert.equal([...f.records.values()][0].kind, 'GUIDED');
});

test('domain and operator each namespace idempotency', async () => {
    const f = fixture();
    const results = await Promise.all([
        f.writer.record(actor, input(), allow),
        f.writer.record({ ...actor, domainId: 'class-b' }, input(), allow),
        f.writer.record({ ...actor, operatorUid: 8 }, input(), allow),
    ]);
    assert.equal(new Set(results.map((r) => r.eventId)).size, 3);
    assert.equal(f.records.size, 3);
});

test('simulated concurrent identical requests converge to one acknowledged insert', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 20 }, () => f.writer.record(actor, input(), allow)));
    assert.equal(f.records.size, 1);
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    assert.equal(new Set(results.map((r) => r.eventId)).size, 1);
});

test('simulated concurrent conflicting requests preserve the winning payload', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
        f.writer.record(actor, input(), allow), f.writer.record(actor, input({ note: 'changed' }), allow),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason instanceof FeedbackConflictError, true);
    assert.equal(f.records.size, 1);
});

test('unacknowledged writes cannot produce a successful receipt', async () => {
    const f = fixture();
    f.store.insertOne = async () => ({ acknowledged: false });
    await assert.rejects(f.writer.record(actor, input(), allow), /acknowledge/);
});

test('database read and write failures propagate without false success', async () => {
    const f = fixture();
    f.store.insertOne = async () => { throw new Error('Database unavailable'); };
    await assert.rejects(f.writer.record(actor, input(), allow), /Database unavailable/);
    f.store.findOne = async () => { throw new Error('Read unavailable'); };
    await assert.rejects(f.writer.record(actor, input(), allow), /Read unavailable/);
});

test('a lost acknowledgement can be retried without duplicating the saved fact', async () => {
    const f = fixture();
    const insert = f.store.insertOne;
    f.store.insertOne = async (doc) => {
        await insert(doc);
        throw new Error('Connection closed before acknowledgement');
    };
    await assert.rejects(f.writer.record(actor, input(), allow), /Connection closed/);
    const retry = await f.writer.record(actor, input(), allow);
    assert.equal(retry.replayed, true);
    assert.equal(f.records.size, 1);
});

test('a duplicate on another index is not misreported as a successful retry', async () => {
    const f = fixture();
    f.store.insertOne = async () => { throw Object.assign(new Error('Other index'), { code: 11000 }); };
    await assert.rejects(f.writer.record(actor, input(), allow), /Other index/);
});

test('invalid server timestamps are rejected before insertion', async () => {
    const f = fixture();
    const writer = createLocalFeedbackWriter(f.store, () => new Date('invalid'));
    await assert.rejects(writer.record(actor, input(), allow), FeedbackValidationError);
    assert.equal(f.records.size, 0);
});
