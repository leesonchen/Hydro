// Read-only reproductions against the reviewed commits. A passing test confirms a defect.
// Run from the repository root: node --test review/pr13-pr14-2026-10-11/reproduce.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { ObjectId } = require('mongodb');

const pr13 = '481d26f6270327a29d047f320cee0444e15e5df7';
const pr14 = '7e90aa00cb4f1c8ae86de317f412ed2d8033752e';
const source = (ref, file) => execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' });
function load(ref, file, mocks, extra = {}) {
    const exports = {};
    const code = ts.transpileModule(source(ref, file), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
            experimentalDecorators: true, esModuleInterop: true,
        },
    }).outputText;
    vm.runInNewContext(code, {
        exports, require: (name) => mocks[name] || {}, Date,
        global: { Hydro: { model: {} } }, ...extra,
    }, { filename: file });
    return exports;
}

function monitorHarness({ team = false, failSessionOnce = false } = {}) {
    const eventDocs = [];
    let state = null;
    const events = {
        updateOne: async (key, update) => {
            let doc = eventDocs.find((item) => item.sequence === key.sequence);
            if (!doc) {
                doc = { ...key, ...update.$setOnInsert };
                eventDocs.push(doc);
                return { upsertedId: 'inserted' };
            }
            Object.assign(doc, update.$set || {});
            return {};
        },
    };
    const sessions = {
        findOne: async () => state,
        updateOne: async (_, update) => {
            if (failSessionOnce) { failSessionOnce = false; throw new Error('transient database failure'); }
            state = { ...(state || {}), ...update.$set };
            for (const key of Object.keys(update.$unset || {})) delete state[key];
            return {};
        },
    };
    class ContestNotAttendedError extends Error {}
    const { ContestMonitorHandler } = load(pr13, 'packages/hydrooj/src/handler/contest-monitor.ts', {
        mongodb: { ObjectId },
        '../error': { ContestNotAttendedError, ForbiddenError: Error, ValidationError: Error },
        '../service/server': { Handler: class {}, param: () => () => {}, Types: {} },
        '../service/db': { collection: (name) => name.endsWith('.sessions') ? sessions : events },
        '../model/contest': {
            get: async () => ({ monitorMode: 'browser', allowTeam: team }),
            getTeamVid: async () => -100,
            getStatus: async (_, __, uid) => team && uid !== -100 ? null : { attend: true },
            isOngoing: () => true,
        },
    });
    const handler = new ContestMonitorHandler();
    handler.user = { _id: 42 };
    handler.response = {};
    handler.limitRate = async () => {};
    const send = (kind, seq) => handler.post('domain', new ObjectId(), kind, 'session-123456', 'page-123456', seq);
    return { send, handler, eventDocs, state: () => state, ContestNotAttendedError };
}

test('REPRODUCED PR13: admitted team member is rejected by monitoring attendance check', async () => {
    const h = monitorHarness({ team: true });
    await assert.rejects(h.send('heartbeat', 1), h.ContestNotAttendedError);
    assert.equal(h.state(), null);
});

test('REPRODUCED PR13: retry acknowledges persisted event without repairing failed session write', async () => {
    const h = monitorHarness({ failSessionOnce: true });
    await assert.rejects(h.send('page_hidden', 1), /transient database failure/);
    assert.equal(h.eventDocs.length, 1);
    await h.send('page_hidden', 1);
    assert.equal(h.handler.response.body.duplicate, true);
    assert.equal(h.state(), null);
    await h.send('page_visible', 2);
    assert.equal(h.eventDocs[1].durationMs, undefined);
});

test('REPRODUCED PR13: queue eviction of in-flight heartbeat drops an unacknowledged anomaly', async () => {
    const html = source(pr13, 'packages/ui-default/templates/partials/contest_monitor_client.html');
    const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
    const storage = new Map();
    const listeners = {};
    const requests = [];
    const intervals = [];
    let currentMs = 100000;
    const window = {
        crypto: { randomUUID: () => 'random-id-123456' },
        addEventListener: (name, listener) => { listeners[name] = listener; },
        removeEventListener: () => {},
    };
    const document = {
        hidden: false,
        getElementById: () => null,
        addEventListener: (name, listener) => { listeners[name] = listener; },
        removeEventListener: () => {},
    };
    vm.runInNewContext(script, {
        window, document, Date: { now: () => currentMs },
        sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        fetch: (_, options) => new Promise((resolve) => { requests.push({ body: JSON.parse(options.body), resolve }); }),
        setInterval: (callback) => { intervals.push(callback); return intervals.length; },
        clearInterval: () => {},
    });
    assert.equal(requests[0].body.eventType, 'heartbeat');
    for (let i = 0; i < 120; i++) { currentMs += 1100; listeners.paste(); }
    const queueKey = [...storage.keys()].find((key) => key.startsWith('hydro-monitor-queue:'));
    const before = JSON.parse(storage.get(queueKey));
    assert.equal(before.length, 120);
    assert.equal(before[0].sequence, 2);
    requests[0].resolve({ ok: true, json: async () => ({ ok: true }) });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const after = JSON.parse(storage.get(queueKey));
    assert.equal(after[0].sequence, 3);
    assert.equal(requests[1].body.sequence, 3);
    assert.ok(!requests.some((request) => request.body.sequence === 2));
});

test('REPRODUCED PR14: accepted ACM problem yields zero assessment score and fails positive threshold', async () => {
    const STATUS = { STATUS_ACCEPTED: 1, STATUS_COMPILE_ERROR: 7, STATUS_FORMAT_ERROR: 9, STATUS_CANCELED: 11 };
    const contest = load(pr14, 'packages/hydrooj/src/model/contest.ts', {
        mongodb: require('mongodb'), lodash: require('lodash'),
        '@hydrooj/utils/lib/utils': {
            Counter: () => new Proxy({}, { get: (obj, key) => obj[key] || 0 }),
            Time: { hour: 3600000, day: 86400000 },
        },
        '../service/db': { collection: () => ({}) },
        './builtin': { PERM: {}, STATUS, STATUS_SHORT_TEXTS: {} },
    });
    const now = Date.now();
    const courseTid = new ObjectId();
    const examTid = new ObjectId();
    const exam = {
        docId: examTid, rule: 'acm', pids: [1],
        beginAt: new Date(now - 7200000), endAt: new Date(now - 3600000),
        sourceType: 'course_assessment', sourceCourseTid: courseTid, sourceNodeId: 1,
    };
    const journal = [{ pid: 1, rid: ObjectId.createFromTime(Math.floor((now - 5400000) / 1000)), score: 100, status: 1 }];
    const stats = contest.RULES.acm.stat(exam, journal);
    assert.equal(stats.accept, 1);
    assert.equal(stats.score, undefined);
    const { getAssessmentResults } = load(pr14, 'packages/course-management/model/assessment.ts', {
        hydrooj: {
            ObjectId,
            ContestModel: {
                get: async () => exam,
                getStatus: async () => ({ attend: true, journal, ...stats }),
                isDone: contest.isDone,
            },
        },
    });
    const results = await getAssessmentResults('domain', {
        docId: courseTid,
        dag: [{ _id: 1, kind: 'assessment', assessment: { contestTid: examTid.toString(), passScore: 1 } }],
    }, 42);
    assert.equal(results[1].score, 0);
    assert.equal(results[1].completed, false);
});
