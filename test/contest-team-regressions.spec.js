const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const moment = require('moment-timezone');
const ts = require('typescript');

function loadSource(file, dependencies = {}, globals = {}) {
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, {
        exports,
        require: (name) => dependencies[name] || {},
        ...globals,
    }, { filename: file });
    return exports;
}

test('contest edit keeps problem order and does not mutate its expected snapshot', async () => {
    const file = path.resolve(__dirname, '../packages/hydrooj/src/handler/contest.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const handler = source.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === 'ContestEditHandler');
    const method = handler.members.find((node) => node.name?.getText(source) === 'postUpdate');
    const params = method.parameters.map((param) => param.getText(source)).join(', ');
    const code = `export async function postUpdate(${params}) ${method.body.getText(source)}`;
    const exports = {};
    vm.runInNewContext(ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
        exports,
        moment,
        PERM: { PERM_VIEW_PROBLEM_HIDDEN: 1 },
        problem: { getList: async () => ({}) },
        ScheduleModel: { deleteMany: async () => {} },
        ValidationError: Error,
        contest: {
            RULES: { acm: { hidden: false } },
            edit: async (_domainId, _tid, update, expected) => {
                assert.deepEqual(Array.from(expected.pids), [2, 1]);
                assert.deepEqual(Array.from(update.pids), nextPids);
            },
            recalcStatus: async () => { recalculations++; },
        },
    }, { filename: file });

    let recalculations = 0;
    let nextPids = [2, 1];
    const beginAt = moment.tz('2026-09-25 12:00', 'Asia/Shanghai').toDate();
    const tdoc = {
        docId: 'contest', pids: [2, 1], beginAt,
        endAt: moment(beginAt).add(2, 'hours').toDate(),
        rule: 'acm', duration: null, lockAt: null,
    };
    const context = {
        tdoc, request: { body: {} }, user: { timeZone: 'Asia/Shanghai', hasPerm: () => true },
        response: {}, url: () => '/contest',
    };
    const update = (pids) => exports.postUpdate.call(
        context, 'domain', 'contest', '2026-09-25', '12:00', 2,
        'Title', '', 'acm', pids,
    );
    await update('2,1');
    assert.equal(recalculations, 0);
    assert.deepEqual(tdoc.pids, [2, 1]);

    nextPids = [1, 2];
    await update('1,2');
    assert.equal(recalculations, 1);
    assert.deepEqual(tdoc.pids, [2, 1]);
});

test('migration backfills boolean and numeric registrations exactly once', async () => {
    const file = path.resolve(__dirname, '../packages/hydrooj/src/lib/contest-participation.ts');
    const tdocs = [
        { domainId: 'domain', docType: 30, docId: 'course', rule: 'course', attend: 1 },
        { domainId: 'domain', docType: 30, docId: 'contest', rule: 'acm', attend: 1 },
    ];
    const statuses = [
        { _id: 'one', domainId: 'domain', docType: 30, docId: 'course', uid: 42, attend: true },
        { _id: 'two', domainId: 'domain', docType: 30, docId: 'contest', uid: 43, attend: 1 },
    ];
    const matches = (doc, query) => Object.entries(query).every(([key, value]) => {
        if (key === '$or') return value.some((branch) => matches(doc, branch));
        if (value && typeof value === 'object') {
            if ('$exists' in value) return Object.hasOwn(doc, key) === value.$exists;
            if ('$gt' in value) return typeof doc[key] === 'number' && doc[key] > value.$gt;
        }
        return doc[key] === value;
    });
    const cursor = (rows) => ({
        sort() { return this; },
        toArray: async () => rows,
        async *[Symbol.asyncIterator]() { yield* rows; },
    });
    let indexes = 0;
    const document = {
        TYPE_CONTEST: 30,
        coll: { find: (query) => cursor(tdocs.filter((doc) => matches(doc, query))) },
        collStatus: {
            find: (query) => cursor(statuses.filter((doc) => matches(doc, query))),
            updateOne: async (query, update) => {
                Object.assign(statuses.find((doc) => matches(doc, query)), update.$set);
                return { modifiedCount: 1 };
            },
            createIndex: async () => { indexes++; },
        },
    };
    const participation = loadSource(file, { '../model/document': document });
    assert.equal(await participation.countPendingContestParticipantUids(), 2);
    assert.equal(await participation.migrateContestParticipantUids(), 2);
    assert.equal(await participation.countPendingContestParticipantUids(), 0);
    assert.equal(await participation.migrateContestParticipantUids(), 0);
    assert.deepEqual(statuses.map((doc) => Array.from(doc.participantUids)), [[42], [43]]);
    assert.equal(indexes, 2);
});

test('JSON responses omit participantUids without modifying internal status', () => {
    const file = path.resolve(__dirname, '../framework/framework/serializer.ts');
    const serializer = loadSource(file).default;
    const status = { _id: 'one', uid: 42, members: [42], participantUids: [42] };
    const output = JSON.parse(JSON.stringify({ tsdoc: status, tsdict: { one: status } }, serializer()));
    assert.equal(output.tsdoc.participantUids, undefined);
    assert.equal(output.tsdict.one.participantUids, undefined);
    assert.deepEqual(output.tsdoc.members, [42]);
    assert.deepEqual(status.participantUids, [42]);
});
