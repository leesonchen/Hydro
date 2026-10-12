const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');

function load(relative, imports = {}) {
    const filename = path.resolve(__dirname, relative);
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = module.paths;
    loaded.require = (name) => imports[name] || require(name);
    loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, filename);
    return loaded.exports;
}

const api = {
    ContestModel: { buildContestRule: (rule) => rule, RULES: { ioi: {} } },
    Counter: () => new Proxy({}, { get: (obj, key) => obj[key] || 0 }),
    STATUS: { STATUS_ACCEPTED: 1, STATUS_COMPILE_ERROR: 7, STATUS_FORMAT_ERROR: 9 },
};
const structure = load('../packages/hydrooj/src/builtin/course-management/model/structure.ts');
const { courseRule } = load('../packages/hydrooj/src/builtin/course-management/model/course.ts', {
    '../../../plugin-api': api, './structure': structure,
});
const dag = [{ _id: 1, title: 'A', pids: [10, 11] }, { _id: 2, title: 'B', pids: [10], requireNids: [1] }];
const course = { dag, pids: [10, 11] };
const journal = [{ pid: 10, score: 100, status: 1 }, { pid: 11, score: 35, status: 2 }];

test('legacy courses without a DAG can be edited while reserving historical lecture IDs', () => {
    const legacy = { pids: [10], lecture: { 8: 'historical lecture' } };
    const next = structure.nextStructure(legacy, [{ _id: 9, title: 'New lesson', pids: [10] }], 0);
    assert.equal(next.nodeIdHighWatermark, 9);
    assert.equal(next.problemNodeIds[10], 9);
});

test('shared course submissions keep their score owner when display order changes', () => {
    const before = courseRule.stat(course, journal);
    const after = courseRule.stat({ ...course, dag: [...dag].reverse(), problemNodeIds: { 10: 2, 11: 1 } }, journal);
    assert.deepEqual(after, before);
    assert.equal(before.score[0], 135);
    assert.equal(before.accept[0], 1);
});

test('a repeated problem contributes only once to course score and completion', () => {
    const result = courseRule.stat(course, journal);
    assert.equal(result.score[0], 135);
    assert.equal(result.accept[0], 1);
    assert.equal(result.progress, 50);
    assert.deepEqual(Object.keys(result.detail), ['10', '11']);
});

test('shared problems preserve the first access node separately from the last grading node', () => {
    const next = structure.nextStructure(course, [...dag].reverse(), 0);
    assert.equal(next.problemNodeIds[10], 2);
    assert.equal(next.problemAccessNodeIds[10], 1);
    assert.equal(structure.problemAccessNodeIds({ ...course, ...next })[10], 1);
});

test('reordering keeps IDs, shared score ownership and dependency references', () => {
    const next = structure.nextStructure(course, [...dag].reverse(), 0);
    assert.deepEqual(next.dag.map((node) => node._id), [2, 1]);
    assert.deepEqual(next.dag[0].requireNids, [1]);
    assert.deepEqual(courseRule.stat({ ...course, ...next }, journal), courseRule.stat(course, journal));
});

test('deleted IDs and stale structure revisions cannot be reused', () => {
    const current = { ...course, dagRevision: 2, nodeIdHighWatermark: 9 };
    assert.throws(() => structure.nextStructure(current, [...dag, { _id: 3, pids: [] }], 2), /历史编号/);
    assert.throws(() => structure.nextStructure(current, dag, 1), /已更新/);
    const next = structure.nextStructure(current, [...dag, { _id: 10, pids: [] }], 2);
    assert.equal(next.nodeIdHighWatermark, 10);
    assert.equal(next.dagRevision, 3);
});


test('assessment nodes never take exercise grading or access ownership even with historical mappings', () => {
    const mixed = { ...course, dag: [...dag, { _id: 3, kind: 'assessment', pids: [10] }],
        problemNodeIds: { 10: 3 }, problemAccessNodeIds: { 10: 3 } };
    assert.equal(structure.problemNodeIds(mixed)[10], 2);
    assert.equal(structure.problemAccessNodeIds(mixed)[10], 1);
    const next = structure.nextStructure(mixed, [...mixed.dag].reverse(), 0);
    assert.equal(next.problemNodeIds[10], 2);
    assert.equal(next.problemAccessNodeIds[10], 1);
    assert.deepEqual(courseRule.stat({ ...mixed, ...next }, journal), courseRule.stat(course, journal));
});
