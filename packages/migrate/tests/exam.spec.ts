/* eslint-disable max-len, style/quote-props, simple-import-sort/imports */
import assert from 'node:assert/strict';
import { Long, ObjectId } from 'bson';
import {
    CONFIRMED_USER_MAP,
    CONFIRMED_DECISIONS,
    USERNAME_CONFLICT_MAP,
    buildProblemDecisions,
    computePlanHash,
    normalizeIdentityEmail,
    redactForLog,
    resolveIdentities,
    rewriteObjectIds,
    rewriteUserIds,
    stableStringify,
} from '../exam';

function testIdentityPrecedence() {
    assert.equal(Object.keys(CONFIRMED_USER_MAP).length, 27);
    assert.equal(Object.keys(USERNAME_CONFLICT_MAP).length, 12);
    const source = [
        { _id: 1, uname: 'Manual', mail: 'manual@example.org' },
        { _id: 2, uname: 'Conflict', mail: 'wrong@example.org' },
        { _id: 3, uname: 'ByName', mail: 'different@example.org' },
        { _id: 4, uname: 'NoNameSource', mail: 'person+tag@example.org' },
        { _id: 5, uname: 'BrandNew', mail: 'brand@example.org' },
    ];
    const target = [
        { _id: 11, uname: 'manual-target', mail: 'manual@target.org' },
        { _id: 12, uname: 'Conflict', mail: 'conflict@example.org' },
        { _id: 13, uname: 'ByName', mail: 'byname@example.org' },
        { _id: 14, uname: 'NoName', mail: 'other@example.org' },
        { _id: 15, uname: 'EmailTarget', mail: 'person@example.org' },
    ];
    const decisions = resolveIdentities(source, target, {
        manualMap: { 1: 11 },
        conflictMap: { 2: 12 },
    });
    assert.deepEqual(decisions.map((item) => [item.sourceUid, item.targetUid, item.method]), [
        [1, 11, 'manual'],
        [2, 12, 'username-conflict'],
        [3, 13, 'username'],
        [4, 15, 'email'],
        [5, 16, 'new'],
    ]);

    // An ordinary match must not consume a target reserved for a later
    // confirmed mapping merely because source UIDs are processed in order.
    const reserved = resolveIdentities([
        { _id: 1, uname: 'ReservedTarget', mail: 'one@example.org' },
        { _id: 2, uname: 'SourceTwo', mail: 'two@example.org' },
    ], [
        { _id: 20, uname: 'ReservedTarget', mail: 'target@example.org' },
        { _id: 21, uname: 'OtherTarget', mail: 'one@example.org' },
    ], {
        manualMap: { 2: 20 },
        conflictMap: {},
    });
    assert.deepEqual(reserved.map((item) => [item.sourceUid, item.targetUid, item.method]), [
        [1, 21, 'email'],
        [2, 20, 'manual'],
    ]);
}

function testEmailRules() {
    assert.equal(normalizeIdentityEmail('USER+one@gmail.com'), 'user@gmail.com');
    assert.equal(normalizeIdentityEmail('u.ser@googlemail.com'), 'user@gmail.com');
    assert.equal(normalizeIdentityEmail('a+test@example.org'), 'a@example.org');
    assert.equal(normalizeIdentityEmail('a@test.com'), null);
    assert.equal(normalizeIdentityEmail('not-an-email'), null);
}

function testNestedRewrites() {
    const users = new Map([[10, 20], [11, 21]]);
    const rewritten = rewriteUserIds({
        uid: 10,
        owner: 11,
        judger: 10,
        reply: [{ owner: 10, editor: 11 }],
        detail: { '10': { score: 1 } },
        pids: [10],
    }, users);
    assert.equal(rewritten.uid, 20);
    assert.equal(rewritten.owner, 21);
    assert.equal(rewritten.judger, 20);
    assert.equal(rewritten.reply[0].owner, 20);
    assert.equal(rewritten.reply[0].editor, 21);
    assert.equal(rewritten.pids[0], 10, 'pids are problem IDs, not user IDs');

    const original = new ObjectId('64b000000000000000000001');
    const mapped = new ObjectId('64b000000000000000000002');
    const object = rewriteObjectIds({ _id: original, nested: [{ rid: original }] }, new Map([[original.toHexString(), mapped]]));
    assert.equal(object._id.toHexString(), mapped.toHexString());
    assert.equal(object.nested[0].rid.toHexString(), mapped.toHexString());
    const long = Long.fromNumber(3);
    assert.equal(stableStringify(long), '{"$numberLong":"3"}');
    assert.equal(rewriteObjectIds({ value: long }, new Map()).value.toString(), '3');
}

function testProblemDecisions() {
    const explicit = CONFIRMED_DECISIONS.problemReferences.P11;
    const source = [
        { docId: 11, pid: 'P11', title: 'A+B', content: 'statement', config: 'time: 1s', data: [{ name: '1.in' }] },
        { docId: 12, pid: 'P12', title: 'Dangling', content: 'different', config: 'time: 1s' },
        { docId: 20, pid: 'P20', title: 'Copied', content: 'new', config: 'time: 2s' },
    ];
    const targets = [
        { domainId: explicit.domainId, docId: explicit.pid, pid: String(explicit.pid), title: 'A+B', content: 'statement', config: 'time: 1s' },
        { domainId: 'oler', docId: 2, pid: '2', title: 'Dangling', content: 'different', config: 'time: 1s', reference: { domainId: 'test', pid: 99 } },
    ];
    const decisions = buildProblemDecisions(source, targets, [{ _id: 'oler' }]);
    assert.equal(decisions[0].action, 'reference');
    assert.equal(decisions[0].reason, 'confirmed-reference');
    assert.equal(decisions[1].action, 'copy', 'dangling test reference cannot be reused');
    assert.equal(decisions[2].action, 'copy');
}

function testHashesAndRedaction() {
    const base: any = { schemaVersion: 1, kind: 'hydro.exam-migration-plan', runId: 'r', domainId: 'exam', packageHash: 'p', targetBefore: {}, identities: [], problems: [], objectIds: { values: {} }, storage: [], expectedCounts: {}, excludedFiles: [], confirmedDecisions: {}, phases: [] };
    const first = computePlanHash(base);
    const second = computePlanHash({ ...base, targetBefore: {}, identities: [] });
    assert.equal(first, second);
    assert.match(stableStringify({ b: 1, a: 2 }), /"a"/);
    const safe = redactForLog({ uri: 'mongodb://user:password@host/db?password=query-secret', password: 'hash', hash: 'password-hash', nested: { token: 'secret' } });
    assert.equal(safe.password, '[REDACTED]');
    assert.equal(safe.hash, '[REDACTED]');
    assert.equal(safe.nested.token, '[REDACTED]');
    assert.match(safe.uri, /\[REDACTED\]/);
    assert.doesNotMatch(safe.uri, /query-secret/);
}

testIdentityPrecedence();
testEmailRules();
testNestedRewrites();
testProblemDecisions();
testHashesAndRedaction();
console.log('exam migration pure tests passed');
