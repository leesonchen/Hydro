const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../packages/hydrooj/src/handler/problem.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, esModuleInterop: true },
}).outputText;

function fixture() {
    const PERM = new Proxy({}, { get: (_, name) => name });
    const PRIV = PERM;
    class PermissionError extends Error {}
    class Handler {
        checkPerm(perm) { if (!this.user.hasPerm(perm)) throw new PermissionError(perm); }
    }
    const student = { _id: 2, own: () => false, hasPriv: () => false, hasPerm: (p) => p === PERM.PERM_VIEW_PROBLEM };
    const sourceUser = { ...student, hasPerm: () => false };
    const target = { domainId: 'class', docId: 1, reference: { domainId: 'bank', pid: 2 } };
    const source = { domainId: 'bank', docId: 2, config: '', data: [{ name: 'secret.in', size: 1 }], additional_file: [{ name: 'grader.h', size: 1 }] };
    const signed = [];
    const boundary = new Error('Remaining page metadata is outside this test');
    const noopDecorator = () => () => {};
    const mocks = {
        '../logger': { Logger: class {} },
        '../error': new Proxy({ PermissionError }, { get: (obj, name) => obj[name] || Error }),
        '../model/builtin': { PERM, PRIV },
        '../model/problem': { get: async (domainId) => (domainId === 'bank' ? source : { ...target }), canViewBy: (pdoc, udoc) => !pdoc.hidden && udoc.hasPerm(PERM.PERM_VIEW_PROBLEM) },
        '../model/record': { STAT_QUERY: {} },
        '../model/domain': { get: async () => ({}) },
        '../model/user': { getById: async () => sourceUser },
        '../model/contest': { isNotStarted: () => false, isDone: () => false },
        '../model/oplog': { log: async () => {} },
        '../model/storage': { getMeta: async () => ({ size: 1 }), signDownloadLink: async (key) => { signed.push(key); return key; } },
        '../service/server': { Handler, param: noopDecorator, post: noopDecorator, query: noopDecorator, route: noopDecorator,
            Types: new Proxy({}, { get: () => () => {} }), Query: (_, fn) => fn },
        './contest': { ContestDetailBaseHandler: Handler },
        schemastery: require('schemastery'),
    };
    const exports = {};
    const math = Object.create(Math);
    math.sum = (values) => values?.reduce((a, b) => a + b, 0);
    vm.runInNewContext(compiled, { exports, require: (name) => mocks[name] || {}, Math: math }, { filename });
    async function prepare(handler, tid) {
        Object.assign(handler, { user: student, domain: {}, response: { body: {} }, ctx: { parallel: async () => { throw boundary; } } });
        try { await handler._prepare('class', 1, tid); } catch (e) { if (e !== boundary) throw e; }
    }
    return { exports, student, sourceUser, target, source, signed, prepare, PermissionError };
}

test('students can list and download referenced public attachments without source-domain membership', async () => {
    const { exports, source, signed, prepare, PermissionError } = fixture();
    const download = new exports.ProblemFileDownloadHandler();
    await prepare(download);
    assert.equal(download.pdoc.additional_file, source.additional_file);
    assert.equal(download.pdoc.data.length, 0);
    await download.get({}, 'additional_file', 'grader.h', false);
    assert.deepEqual(signed, ['problem/bank/2/additional_file/grader.h']);
    await assert.rejects(download.get({}, 'testdata', 'secret.in', false), PermissionError);
    const bulk = new exports.ProblemFilesHandler();
    await prepare(bulk);
    await bulk.postGetLinks('class', new Set(['grader.h']), 'additional_file');
    assert.equal(bulk.response.body.links['grader.h'], 'problem/bank/2/additional_file/grader.h');
    await assert.rejects(bulk.postGetLinks('class', new Set(['secret.in']), 'testdata'), PermissionError);
});

test('target-domain data privileges cannot bypass source-domain testdata permissions', async () => {
    const { exports, student, prepare, PermissionError } = fixture();
    student.hasPerm = () => true;
    const download = new exports.ProblemFileDownloadHandler();
    await prepare(download);
    await assert.rejects(download.get({}, 'testdata', 'secret.in', false), PermissionError);
});

test('source-domain data readers retain testdata access', async () => {
    const { exports, sourceUser, prepare, signed } = fixture();
    sourceUser.hasPerm = () => true;
    const download = new exports.ProblemFileDownloadHandler();
    await prepare(download);
    await download.get({}, 'testdata', 'secret.in', false);
    assert.deepEqual(signed, ['problem/bank/2/testdata/secret.in']);
});

test('hidden targets and locked course nodes still reject attachment requests', async () => {
    const { exports, target, prepare, PermissionError } = fixture();
    target.hidden = true;
    await assert.rejects(prepare(new exports.ProblemFileDownloadHandler()), PermissionError);
    target.hidden = false;
    const download = new exports.ProblemFileDownloadHandler();
    download.tdoc = { rule: 'course', pids: [1], dag: [{ _id: 'node', pids: [1] }] };
    download.tsdoc = { attend: true, startAt: new Date(), allow: {} };
    download.translate = (text) => text;
    await assert.rejects(prepare(download, 'course'), /not available yet/);
    download.tsdoc.allow.node = true;
    await prepare(download, 'course');
    await download.get({}, 'additional_file', 'grader.h', false, 'course');
});

test('the problem API exposes public attachments but no source testdata to students', async () => {
    const { exports, student, source } = fixture();
    const pdoc = await exports.ProblemApi.problem({ user: student }, { domainId: 'class', id: 1 });
    assert.equal(pdoc.additional_file, source.additional_file);
    assert.equal(pdoc.data.length, 0);
});
