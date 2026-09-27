/* eslint-disable max-len, style/quote-props, simple-import-sort/imports */
import assert from 'node:assert/strict';
import { Long, ObjectId } from 'bson';
import {
    CONFIRMED_USER_MAP,
    CONFIRMED_DECISIONS,
    CONFIRMED_TEST_EMAIL_SOURCE_UIDS,
    USERNAME_CONFLICT_MAP,
    buildProblemDecisions,
    buildContestDecisions,
    isHealthyProblemReference,
    computePlanHash,
    normalizeIdentityEmail,
    mapDocumentForApply,
    planStorage,
    redactForLog,
    resolveIdentities,
    rewriteObjectIds,
    rewriteProblemReferences,
    rewriteUserIds,
    stableStringify,
} from '../exam';

function testIdentityPrecedence() {
    assert.equal(Object.keys(CONFIRMED_USER_MAP).length, 0);
    assert.equal(Object.keys(USERNAME_CONFLICT_MAP).length, 0);
    assert.deepEqual([...CONFIRMED_TEST_EMAIL_SOURCE_UIDS], [270, 298, 314, 334, 415, 523, 600, 1204]);
    const source = [
        { _id: 1, uname: 'Conflict', mail: 'wrong@example.org' },
        { _id: 2, uname: 'ByName', mail: 'different@example.org' },
        { _id: 3, uname: 'EmailFirst', mail: 'person@example.org' },
        { _id: 4, uname: 'NoNameSource', mail: 'person+tag@example.org' },
        { _id: 5, uname: 'BrandNew', mail: 'brand@example.org' },
        { _id: 6, uname: 'TestMatch', mail: 'same@test.com' },
    ];
    const target = [
        { _id: 11, uname: 'ManualTarget', mail: 'manual@target.org' },
        { _id: 12, uname: 'Conflict', mail: 'conflict@example.org' },
        { _id: 13, uname: 'ByName', mail: 'byname@example.org' },
        { _id: 14, uname: 'NoName', mail: 'other@example.org' },
        { _id: 15, uname: 'EmailTarget', mail: 'person@example.org' },
        { _id: 16, uname: 'TestTarget', mail: 'same@test.com' },
    ];
    const decisions = resolveIdentities(source, target);
    assert.deepEqual(decisions.map((item) => [item.sourceUid, item.targetUid, item.method]), [
        [1, 17, 'new'],
        [2, 18, 'new'],
        [3, 15, 'email'],
        [4, 19, 'new'],
        [5, 20, 'new'],
        [6, 21, 'new'],
    ]);
    assert.equal(decisions[0].targetUname, 'Conflict_exam');
    assert.equal(decisions[0].note, '未找到可确认的非 @test.com 邮箱，创建独立账号');
    assert.equal(decisions[5].emailConflict, true);
    assert.match(decisions[5].targetMail!, /^exam-6-21@invalid\.exam$/);

    const confirmedTestEmail = resolveIdentities([
        { _id: 270, uname: 'Student', mail: 's0266@test.com' },
    ], [
        { _id: 99, uname: 'Student', mail: 's0266@test.com' },
    ]);
    assert.deepEqual(
        [confirmedTestEmail[0].targetUid, confirmedTestEmail[0].method, confirmedTestEmail[0].created],
        [99, 'email', false],
    );
    assert.match(confirmedTestEmail[0].note!, /明确例外/);

    const unconfirmedTestEmail = resolveIdentities([
        { _id: 271, uname: 'Student', mail: 's0266@test.com' },
    ], [
        { _id: 99, uname: 'Student', mail: 's0266@test.com' },
    ]);
    assert.equal(unconfirmedTestEmail[0].method, 'new');
}

function testEmailRules() {
    assert.equal(normalizeIdentityEmail('USER+one@gmail.com'), 'user+one@gmail.com');
    assert.equal(normalizeIdentityEmail('u.ser@googlemail.com'), 'u.ser@googlemail.com');
    assert.equal(normalizeIdentityEmail('a+test@example.org'), 'a+test@example.org');
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

function testProblemReferenceRewrites() {
    const problems = new Map<string, number | string>([
        ['3', 118],
        ['17', 132],
        ['101', 5],
        ['109', 13],
        ['115', 3],
    ]);
    const status = rewriteProblemReferences({
        detail: {
            '101': { pid: 101, score: 100 },
            '115': { pid: 115, score: 80 },
        },
        display: {
            '101': { pid: 101, score: 100 },
        },
        journal: [{ pid: 115 }, { pid: 101 }],
    }, problems);
    assert.deepEqual(Object.keys(status.detail), ['3', '5']);
    assert.deepEqual(Object.keys(status.display), ['5']);
    assert.deepEqual(status.journal.map((item: any) => item.pid), [3, 5]);

    const plan: any = {
        identities: [],
        objectIds: { values: {} },
        storage: [],
        problemIds: { '3': 118, '115': 3 },
        problems: [
            { sourceDocId: 3, sourcePid: 'P3', action: 'copy', targetDomainId: 'exam', targetPid: 118, targetDocId: 118, reason: 'entity', sourceHasFiles: false },
            { sourceDocId: 115, sourcePid: 'P115', action: 'copy', targetDomainId: 'exam', targetPid: 3, targetDocId: 3, reason: 'entity', sourceHasFiles: false },
            { sourceDocId: 101, sourcePid: 'P101', action: 'copy', targetDomainId: 'exam', targetPid: 5, targetDocId: 5, reason: 'entity', sourceHasFiles: false },
        ],
    };
    const contest = mapDocumentForApply(
        { docType: 30, docId: 'contest', domainId: 'exam', pids: [115, 101] },
        plan, 'exam', new Map(), new Map(), new Map(), new Map([
            ['115', 3], ['101', 5], ['3', 118],
        ]),
    );
    assert.deepEqual(contest.pids, [3, 5], 'contest PID mapping must happen exactly once');

    const problemStatus = mapDocumentForApply(
        { docType: 10, docId: 115, domainId: 'exam', uid: 10 },
        plan, 'exam', new Map(), new Map(), new Map(), new Map([['115', 3]]), false,
    );
    assert.equal(problemStatus.docId, 3, 'problem status docId must follow the problem mapping');

    const copiedSourceId = 'migration/source/18/testdata/1.in';
    const copiedTargetId = 'migration/target/118/testdata/1.in';
    const materialized = mapDocumentForApply({
        docType: 10, docId: 18, domainId: 'exam', title: 'Prepared',
        reference: { domainId: 'prepare', pid: 18 }, config: 'time: 1s',
        data: [{ name: '1.in', etag: Buffer.from(`/data/file/hydro/${copiedSourceId}`).toString('base64') }],
        additional_file: [],
    }, {
        ...plan,
        problems: [{ sourceDocId: 18, sourcePid: 'P18', action: 'copy', targetDomainId: 'exam', targetPid: 118, targetDocId: 118, reason: 'entity', sourceHasFiles: true }],
    }, 'exam', new Map(), new Map(), new Map([[copiedSourceId, copiedTargetId]]), new Map([['18', 118]]), true);
    assert.equal(materialized.docId, 118);
    assert.equal(materialized.reference, undefined, 'materialized entity must not retain prepare reference');
    assert.equal(Buffer.from(materialized.data[0].etag, 'base64').toString(), `/data/file/hydro/${copiedTargetId}`);
    assert.equal(materialized.config, 'time: 1s');
}

function testProblemDecisions() {
    const plannedMaterializedFiles = planStorage([
        { sourceStorageId: 'source-18', sourcePath: 'problem/exam/18/testdata/1.in', targetPath: 'problem/exam/18/testdata/1.in', included: true, required: true, sha256: 'a'.repeat(64), packagePath: 'files/a' },
        { sourceStorageId: 'source-105', sourcePath: 'problem/exam/105/testdata/1.in', targetPath: 'problem/exam/105/testdata/1.in', included: true, required: true, sha256: 'b'.repeat(64), packagePath: 'files/b' },
    ], [
        { sourceDocId: 18, sourcePid: 'P18', action: 'copy', targetDomainId: 'exam', targetPid: 130, targetDocId: 130, reason: 'entity', sourceHasFiles: false },
        { sourceDocId: 105, sourcePid: 'P105', action: 'reuse', targetDomainId: 'exam', targetPid: 9, targetDocId: 9, reason: 'confirmed-reuse', sourceHasFiles: false },
    ], [], new Map(), { values: {} }, 'test-materialize');
    assert.equal(plannedMaterializedFiles[0].targetPath, 'problem/exam/130/testdata/1.in');
    assert.equal(plannedMaterializedFiles[0].included, true);
    assert.equal(plannedMaterializedFiles[1].included, false, 'P105 source data is audit-only and must not overwrite the reuse target');

    const finalEntity = { domainId: 'yizhong', docId: 507, pid: 'AT7' };
    const middleReference = { domainId: 'cpptrain', docId: 4762, pid: 'AT7', reference: { domainId: 'yizhong', pid: 507 } };
    const firstReference = { domainId: 'exam', docId: 68, reference: { domainId: 'cpptrain', pid: 'AT7' } };
    const chainedDomains = [{ _id: 'exam' }, { _id: 'cpptrain' }, { _id: 'yizhong' }];
    assert.equal(isHealthyProblemReference(firstReference, [middleReference, finalEntity], chainedDomains), true);
    assert.equal(isHealthyProblemReference(firstReference, [middleReference], chainedDomains), false,
        'a missing entity at the end of a reference chain is not healthy');
    assert.equal(isHealthyProblemReference(firstReference, [
        { ...middleReference, reference: { domainId: 'prepare', pid: 74 } }, finalEntity,
    ], chainedDomains), false, 'a nested prepare reference is not healthy');
    assert.equal(isHealthyProblemReference(firstReference, [
        { ...middleReference, reference: { domainId: 'exam', pid: 68 } }, firstReference,
    ], chainedDomains), false, 'a reference cycle is not healthy');

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

    const merged = buildProblemDecisions([
        { docId: 1, title: 'Existing', content: 'same', config: '' },
        { docId: 2, title: 'New', content: 'new', config: '' },
    ], [
        { domainId: 'exam', docId: 1, title: 'Existing', content: 'same', config: '' },
    ], [{ _id: 'exam' }], { mergeExisting: true, domainId: 'exam' });
    assert.equal(merged[0].action, 'reuse');
    assert.equal(merged[0].targetDocId, 1);
    assert.equal(merged[1].targetDocId, 2);

    const p105Source = {
        docId: 105, pid: 'P105', title: '翻转链（reversal）', content: 'source', config: '',
    };
    const p105Reference = {
        domainId: 'contests', docId: 3230, title: '翻转链（reversal）', content: 'tests', config: '',
        data: Array.from({ length: 40 }, (_, index) => ({ name: `data-${index}` })),
    };
    const p105Target = {
        domainId: 'exam', docId: 9, title: '翻转链（reversal）', content: 'target', config: '',
        reference: { domainId: 'contests', pid: 3230 }, data: [],
    };
    const p105Domains = [{ _id: 'exam' }, { _id: 'contests' }];
    const p105Targets = [p105Target, p105Reference];
    const reused = buildProblemDecisions(
        [p105Source], p105Targets, p105Domains, { mergeExisting: true, domainId: 'exam' },
    )[0];
    assert.equal(reused.action, 'reuse');
    assert.equal(reused.targetDocId, 9);
    assert.equal(reused.targetPid, 9);
    assert.equal(reused.reason, 'confirmed-reuse');
    const numericPid = buildProblemDecisions(
        [{ ...p105Source, pid: 105 }], p105Targets, p105Domains,
        { mergeExisting: true, domainId: 'exam' },
    )[0];
    assert.equal(numericPid.targetDocId, 9, 'numeric PID 105 must follow P105 -> 9 mapping');

    const p105Failure = (candidateTargets: any[], domains = p105Domains) => buildProblemDecisions(
        [p105Source], candidateTargets, domains, { mergeExisting: true, domainId: 'exam' },
    );
    assert.throws(() => p105Failure([p105Reference]), /P105.*exam\/9/, 'missing exam/9 must fail closed');
    assert.throws(() => buildProblemDecisions(
        [{ ...p105Source, docId: 106 }], p105Targets, p105Domains,
        { mergeExisting: true, domainId: 'exam' },
    ), /P105.*exam\/9/, 'mismatched source docId must fail closed');
    assert.throws(() => p105Failure([
        { ...p105Target, title: '错误题目' }, p105Reference,
    ]), /P105.*exam\/9/, 'wrong target title must fail closed');
    assert.throws(() => p105Failure([
        { ...p105Target, reference: { domainId: 'contests', pid: 999 } }, p105Reference,
    ]), /P105.*exam\/9/, 'wrong target reference must fail closed');
    assert.throws(() => p105Failure([
        p105Target, { ...p105Reference, reference: { domainId: 'prepare', pid: 88 } },
    ]), /P105.*exam\/9/, 'unhealthy referenced entity must fail closed');
    assert.throws(() => p105Failure([
        p105Target, { ...p105Reference, data: p105Reference.data.slice(0, 39) },
    ]), /P105.*exam\/9/, 'incomplete referenced testdata must fail closed');

    const nonMerge = buildProblemDecisions(
        [p105Source], p105Targets, p105Domains, { domainId: 'exam' },
    )[0];
    assert.notEqual(nonMerge.reason, 'confirmed-reuse', 'P105 reuse is merge-only');

    const contests = buildContestDecisions([
        { _id: new ObjectId('64b000000000000000000010'), docId: new ObjectId('64b000000000000000000010'), title: 'Same', pids: [1], rule: 'oi', beginAt: new Date('2026-01-01'), endAt: new Date('2026-01-02') },
        { _id: new ObjectId('64b000000000000000000011'), docId: new ObjectId('64b000000000000000000011'), title: 'New', pids: [2], rule: 'oi', beginAt: new Date('2026-01-01'), endAt: new Date('2026-01-02') },
    ], [
        { _id: new ObjectId('64b000000000000000000012'), docId: new ObjectId('64b000000000000000000012'), title: 'Same', pids: [1], rule: 'oi', beginAt: new Date('2026-01-01'), endAt: new Date('2026-01-02') },
    ], [
        { sourceDocId: 1, sourcePid: 'P1', action: 'copy', targetDomainId: 'exam', targetPid: 1, targetDocId: 1, reason: 'entity', sourceHasFiles: false },
        { sourceDocId: 2, sourcePid: 'P2', action: 'copy', targetDomainId: 'exam', targetPid: 2, targetDocId: 2, reason: 'entity', sourceHasFiles: false },
    ], true);
    assert.equal(contests[0].action, 'reuse');
    assert.equal(contests[0].targetObjectId, '64b000000000000000000012');
    assert.equal(contests[1].action, 'copy');

    const p105Contest = buildContestDecisions([
        { _id: new ObjectId('64b000000000000000000013'), docId: new ObjectId('64b000000000000000000013'), title: 'P105 contest', pids: [105], rule: 'oi', beginAt: new Date('2026-01-03'), endAt: new Date('2026-01-04') },
    ], [
        { _id: new ObjectId('64b000000000000000000014'), docId: new ObjectId('64b000000000000000000014'), title: 'P105 contest', pids: [9], rule: 'oi', beginAt: new Date('2026-01-03'), endAt: new Date('2026-01-04') },
    ], [
        { sourceDocId: 105, sourcePid: 'P105', action: 'reuse', targetDomainId: 'exam', targetPid: 9, targetDocId: 9, reason: 'confirmed-reuse', sourceHasFiles: false },
    ], true);
    assert.equal(p105Contest[0].action, 'reuse', 'contest PID 105 must follow P105 -> 9 mapping');
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
testProblemReferenceRewrites();
testProblemDecisions();
testHashesAndRedaction();
console.log('exam migration pure tests passed');
