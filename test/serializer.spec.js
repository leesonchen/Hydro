const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../framework/framework/serializer.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exportsHolder = {};
vm.runInNewContext(compiled, { exports: exportsHolder }, { filename });
const serializer = exportsHolder.default;

test('public dictionary keys are preserved while internal fields on their values stay private', () => {
    const member = { _id: 1, _secret: 'private', role: '__proto__' };
    const members = Object.assign(Object.create(null), Object.fromEntries([
        ['__proto__', [member]], ['_teacher', [member]], ['constructor', [member]],
    ]));
    const body = { members, domain: { _id: 'test', _join: { code: 'private' } }, _secret: 'private' };
    const handler = { response: { publicDictionaries: [null, 1, members] } };
    const parsed = JSON.parse(JSON.stringify(body, serializer(false, handler)));
    assert.deepEqual(Object.keys(parsed.members), ['__proto__', '_teacher', 'constructor']);
    for (const users of Object.values(parsed.members)) assert.deepEqual(users, [{ _id: 1, role: '__proto__' }]);
    assert.deepEqual(parsed.domain, { _id: 'test' });
    assert.equal(Object.hasOwn(parsed, '_secret'), false);
    const ordinary = JSON.parse(JSON.stringify(body, serializer()));
    assert.deepEqual(Object.keys(ordinary.members), ['constructor']);
    assert.equal(Object.hasOwn(Object.prototype, '_secret'), false);
});

test('explicit dictionary handling preserves bigint and model serialization behavior', () => {
    const handler = { response: { publicDictionaries: [] }, uid: 9 };
    const model = { serialize: (context) => ({ owner: context.uid, perm: 7n, _secret: 'private' }) };
    const members = Object.fromEntries([['_custom', [model]]]);
    handler.response.publicDictionaries.push(members);
    assert.deepEqual(JSON.parse(JSON.stringify({ members }, serializer(false, handler))), {
        members: { _custom: [{ owner: 9, perm: 'BigInt::7' }] },
    });
});

test('public dictionaries keep role keys while hiding contest participant ownership', () => {
    const status = { _id: 'team', members: [42], participantUids: [42], _secret: 'private' };
    const roles = { _teacher: status };
    const handler = { response: { publicDictionaries: [roles] } };
    const parsed = JSON.parse(JSON.stringify({ roles, status }, serializer(false, handler)));
    assert.deepEqual(parsed.roles, { _teacher: { _id: 'team', members: [42] } });
    assert.deepEqual(parsed.status, { _id: 'team', members: [42] });
    assert.deepEqual(status.participantUids, [42]);
});
