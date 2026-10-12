const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

// Compile problem model
const modelFilename = path.resolve(__dirname, '../packages/hydrooj/src/model/problem.ts');
const compiledModel = ts.transpileModule(fs.readFileSync(modelFilename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, esModuleInterop: true },
}).outputText;

// Compile problem handler
const handlerFilename = path.resolve(__dirname, '../packages/hydrooj/src/handler/problem.ts');
const compiledHandler = ts.transpileModule(fs.readFileSync(handlerFilename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, esModuleInterop: true },
}).outputText;

function createObjectId(timestampSeconds) {
    return {
        getTimestamp: () => new Date(timestampSeconds * 1000),
    };
}

test('ProblemModel.isModifiedLocally detects modifications and avoids false conflicts', () => {
    const exports = {};
    const mocks = {
        '../service/bus': { emit: async () => {}, parallel: async () => {} },
        '../service/db': { collection: () => ({}) },
        '../model/domain': { get: async () => ({}) },
        '../model/document': {
            coll: { countDocuments: async () => 0, find: () => ({ toArray: async () => [] }) },
            TYPE_PROBLEM: 10,
        },
        '@hydrooj/utils': { Logger: class { warn() {} error() {} info() {} } },
        '@hydrooj/utils/lib/utils': { Logger: class { warn() {} error() {} info() {} }, sortFiles: (f) => f },
        '@hydrooj/common': { PRIV: {}, PERM: {}, STATUS: {} },
        '../utils': { Logger: class { warn() {} error() {} info() {} }, buildProjection: () => ({}) },
        mongodb: require('mongodb'),
        lodash: require('lodash'),
    };
    vm.runInNewContext(
        compiledModel,
        { global: { Hydro: { model: {} } }, exports, require: (name) => mocks[name] || {} },
        { filename: modelFilename },
    );
    const { ProblemModel } = exports;

    const source = {
        docId: 1,
        title: 'Original Title',
        content: 'Original Content',
        tag: ['math'],
        difficulty: 3,
        updateAt: new Date('2026-09-01T00:00:00Z'),
    };

    // 1. Unmodified copy with lastSyncAt
    const copy1 = {
        docId: 10,
        title: 'Original Title',
        content: 'Original Content',
        tag: ['math'],
        difficulty: 3,
        updateAt: new Date('2026-09-01T00:00:00Z'),
        reference: {
            domainId: 'system',
            pid: 1,
            lastSyncAt: new Date('2026-09-01T00:00:00Z'),
        },
    };
    assert.equal(ProblemModel.isModifiedLocally(copy1, source), false);

    // 2. Modified copy with lastSyncAt
    const copy2 = {
        docId: 11,
        title: 'Custom Title',
        content: 'Modified Content',
        tag: ['math'],
        difficulty: 3,
        updateAt: new Date('2026-09-05T00:00:00Z'),
        reference: {
            domainId: 'system',
            pid: 1,
            lastSyncAt: new Date('2026-09-01T00:00:00Z'),
        },
    };
    assert.equal(ProblemModel.isModifiedLocally(copy2, source), true);

    // A real edit 500ms after the last sync is a local modification.
    const copySubsecond = {
        ...copy1,
        title: 'Edited within one second',
        updateAt: new Date('2026-09-01T00:00:00.500Z'),
    };
    assert.equal(ProblemModel.isModifiedLocally(copySubsecond, source), true);

    // 3. Legacy copy without lastSyncAt (never edited locally: updateAt is older than creation time)
    const copy3 = {
        _id: createObjectId(Math.floor(new Date('2026-09-03T00:00:00Z').getTime() / 1000)),
        docId: 12,
        title: 'Original Title',
        content: 'Original Content',
        tag: ['math'],
        difficulty: 3,
        updateAt: new Date('2026-09-01T00:00:00Z'),
        reference: {
            domainId: 'system',
            pid: 1,
        },
    };
    assert.equal(ProblemModel.isModifiedLocally(copy3, source), false);

    // Legacy copies use an ObjectId timestamp with one-second precision, so the
    // compatibility tolerance remains limited to this branch.
    const legacySubsecond = {
        ...copy3,
        updateAt: new Date('2026-09-03T00:00:00.500Z'),
    };
    assert.equal(ProblemModel.isModifiedLocally(legacySubsecond, source), false);

    // Legacy copies without either synchronization or edit metadata are
    // treated conservatively: an exact match is safe, divergent content is a
    // conflict rather than an automatic overwrite.
    const legacyWithoutMetadata = { ...copy3, updateAt: undefined };
    assert.equal(ProblemModel.isModifiedLocally(legacyWithoutMetadata, source), false);
    const legacyWithoutMetadataEdited = {
        ...legacyWithoutMetadata,
        title: 'Edited before metadata tracking',
    };
    assert.equal(ProblemModel.isModifiedLocally(legacyWithoutMetadataEdited, source), true);

    // 4. Legacy copy without lastSyncAt (edited locally: updateAt is after creation time)
    const copy4 = {
        _id: createObjectId(Math.floor(new Date('2026-09-03T00:00:00Z').getTime() / 1000)),
        docId: 13,
        title: 'Locally Edited Title',
        content: 'Locally Edited Content',
        tag: ['math'],
        difficulty: 3,
        updateAt: new Date('2026-09-06T00:00:00Z'),
        reference: {
            domainId: 'system',
            pid: 1,
        },
    };
    assert.equal(ProblemModel.isModifiedLocally(copy4, source), true);

    // 5. Touched locally but content is exactly identical to source => not treated as conflict
    const copy5 = {
        _id: createObjectId(Math.floor(new Date('2026-09-03T00:00:00Z').getTime() / 1000)),
        docId: 14,
        title: 'Original Title',
        content: 'Original Content',
        tag: ['math'],
        difficulty: 3,
        updateAt: new Date('2026-09-06T00:00:00Z'),
        reference: {
            domainId: 'system',
            pid: 1,
        },
    };
    assert.equal(ProblemModel.isModifiedLocally(copy5, source), false);

    // 6. Tags in different order but otherwise identical => not treated as conflict
    const copy6 = {
        _id: createObjectId(Math.floor(new Date('2026-09-03T00:00:00Z').getTime() / 1000)),
        docId: 15,
        title: 'Original Title',
        content: 'Original Content',
        tag: ['tree', 'math'],
        difficulty: 3,
        updateAt: new Date('2026-09-06T00:00:00Z'),
        reference: {
            domainId: 'system',
            pid: 1,
            lastSyncAt: new Date('2026-09-01T00:00:00Z'),
        },
    };
    const sourceWithMultipleTags = { ...source, tag: ['math', 'tree'] };
    assert.equal(ProblemModel.isModifiedLocally(copy6, sourceWithMultipleTags), false);
});

test('ProblemFilesHandler exposes copiedCount, lists copies with permission filtering, and synchronizes unedited copies', async () => {
    const PERM = new Proxy({}, { get: (_, name) => name });
    const PRIV = new Proxy({}, { get: (_, name) => name });
    class PermissionError extends Error {}
    class ProblemIsReferencedError extends Error {}
    class Handler {
        checkPerm(perm) { if (!this.user.hasPerm(perm)) throw new PermissionError(perm); }
    }

    const sourceProblem = {
        domainId: 'system',
        docId: 1,
        pid: 'P1001',
        title: 'Source Title Updated',
        content: 'Source Content Updated',
        tag: ['dp', 'tree'],
        difficulty: 5,
        updateAt: new Date('2026-09-10T12:00:00Z'),
        data: [],
        additional_file: [],
    };

    const copies = [
        // Copy 1 in domain "school_a": unedited, can view
        {
            _id: createObjectId(100),
            domainId: 'school_a',
            docId: 101,
            pid: 'P101',
            title: 'Old Title',
            content: 'Old Content',
            tag: ['dp'],
            difficulty: 3,
            updateAt: new Date('2026-09-01T00:00:00Z'),
            reference: { domainId: 'system', pid: 1, lastSyncAt: new Date('2026-09-01T00:00:00Z') },
        },
        // Copy 2 in domain "school_b": modified locally, can view
        {
            _id: createObjectId(100),
            domainId: 'school_b',
            docId: 202,
            pid: 'P202',
            title: 'School B Custom Title',
            content: 'School B Custom Content',
            tag: ['dp'],
            difficulty: 4,
            updateAt: new Date('2026-09-05T00:00:00Z'),
            reference: { domainId: 'system', pid: 1, lastSyncAt: new Date('2026-09-01T00:00:00Z') },
        },
        // Copy 3 in domain "private_school": unedited, user has NO permission in this domain
        {
            _id: createObjectId(100),
            domainId: 'private_school',
            docId: 303,
            pid: 'P303',
            title: 'Old Title',
            content: 'Old Content',
            tag: ['dp'],
            difficulty: 3,
            updateAt: new Date('2026-09-01T00:00:00Z'),
            reference: { domainId: 'system', pid: 1, lastSyncAt: new Date('2026-09-01T00:00:00Z') },
        },
    ];

    const editedRecords = [];
    let targetPermissionMode = 'editor';
    let conditionalUpdateMode = 'ok';

    const problemModelMock = {
        get: async () => sourceProblem,
        countCopies: async () => copies.length,
        getCopies: async () => copies,
        isModifiedLocally: (copy, _source) => {
            if (copy.domainId === 'school_b') return true;
            return false;
        },
        canViewBy: (pdoc, udoc) => udoc.hasPerm(PERM.PERM_VIEW_PROBLEM),
        editIfCondition: async (domainId, docId, condition, update) => {
            const copy = copies.find((c) => c.domainId === domainId && c.docId === docId);
            if (conditionalUpdateMode === 'concurrent-content' && copy) copy.content = 'Concurrent imported content';
            if (conditionalUpdateMode === 'concurrent-hidden' && copy) copy.hidden = true;
            if (conditionalUpdateMode === 'deleted') return null;
            const readPath = (value, key) => key.split('.').reduce((current, part) => current?.[part], value);
            const matches = (actual, expected) => {
                if (expected && typeof expected === 'object' && '$exists' in expected) {
                    return (actual !== undefined) === expected.$exists;
                }
                if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime();
                if (Array.isArray(actual) || Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
                return actual === expected;
            };
            if (!copy || !Object.entries(condition).every(([key, expected]) => matches(readPath(copy, key), expected))) return null;
            editedRecords.push({ domainId, docId, update });
            Object.assign(copy, update);
            return copy;
        },
    };

    const domainModelMock = {
        get: async (domainId) => ({ _id: domainId, name: domainId.toUpperCase() }),
    };

    const userModelMock = {
        getById: async (domainId, uid) => {
            if (domainId === 'private_school' || targetPermissionMode === 'denied') {
                return { _id: uid, hasPerm: () => false };
            }
            if (targetPermissionMode === 'view-only') {
                return { _id: uid, own: () => false, hasPerm: (p) => p === PERM.PERM_VIEW || p === PERM.PERM_VIEW_PROBLEM };
            }
            return {
                _id: uid,
                own: () => false,
                hasPerm: (p) => p === PERM.PERM_VIEW || p === PERM.PERM_VIEW_PROBLEM || p === PERM.PERM_EDIT_PROBLEM,
            };
        },
    };

    const noopDecorator = () => () => {};
    const mocks = {
        '../logger': { Logger: class {} },
        '../error': new Proxy({ PermissionError, ProblemIsReferencedError }, { get: (obj, name) => obj[name] || Error }),
        '../model/builtin': { PERM, PRIV },
        '../model/problem': problemModelMock,
        '../model/domain': domainModelMock,
        '../model/user': userModelMock,
        '../model/record': { STAT_QUERY: {}, add: async () => 'rid' },
        '../model/oplog': { log: async () => {} },
        '../model/storage': { getMeta: async () => ({ size: 1 }) },
        '@hydrooj/utils': { Logger: class {}, sortFiles: (f) => f || [], streamToBuffer: async () => Buffer.from('') },
        '@hydrooj/utils/lib/utils': { sortFiles: (f) => f || [], randomstring: () => 'rnd' },
        '@hydrooj/utils/lib/search': {},
        '@hydrooj/common': { PRIV: {}, PERM: {}, STATUS: {} },
        '../service/server': {
            Handler,
            param: noopDecorator,
            post: noopDecorator,
            query: noopDecorator,
            route: noopDecorator,
            Types: new Proxy({}, { get: () => () => {} }),
            Query: (_, fn) => fn,
        },
        './contest': { ContestDetailBaseHandler: Handler },
        schemastery: require('schemastery'),
    };

    const handlerExports = {};
    vm.runInNewContext(compiledHandler, { exports: handlerExports, require: (name) => mocks[name] || {} }, { filename: handlerFilename });

    const userEditor = {
        _id: 1,
        own: () => true,
        hasPerm: (_p) => true,
        hasPriv: () => false,
    };

    // Test 1: get() returns copiedCount = 3 for source problem
    const handler = new handlerExports.ProblemFilesHandler();
    handler.pdoc = sourceProblem;
    handler.user = userEditor;
    handler.response = { body: {} };
    handler.args = {};
    await handler.get({});
    assert.equal(handler.response.body.copiedCount, 3);

    // Test 2: postGetCopiedProblems filters by target-domain permissions
    handler.response = { body: {} };
    await handler.postGetCopiedProblems();
    assert.equal(handler.response.body.total, 3);
    assert.equal(handler.response.body.copies.length, 2); // school_a and school_b
    assert.equal(handler.response.body.unauthorizedCount, 1); // private_school hidden
    assert.equal(handler.response.body.copies[0].hasModified, false); // school_a
    assert.equal(handler.response.body.copies[1].hasModified, true); // school_b

    // View-only target users can list copies but cannot synchronize them.
    targetPermissionMode = 'view-only';
    handler.response = { body: {} };
    await handler.postSyncCopiedProblems();
    assert.equal(handler.response.body.synced.length, 0);
    assert.equal(handler.response.body.unauthorizedCount, 3);
    targetPermissionMode = 'editor';

    // Without domain access, copies are neither listed nor synchronized.
    targetPermissionMode = 'denied';
    handler.response = { body: {} };
    await handler.postGetCopiedProblems();
    assert.equal(handler.response.body.copies.length, 0);
    handler.response = { body: {} };
    await handler.postSyncCopiedProblems();
    assert.equal(handler.response.body.synced.length, 0);
    assert.equal(handler.response.body.unauthorizedCount, 3);
    targetPermissionMode = 'editor';

    // PRIV_VIEW_ALL_DOMAIN bypasses only domain entry. It does not grant target
    // problem visibility or edit permission.
    const viewAllUser = {
        _id: 999,
        own: () => true,
        hasPerm: () => true,
        hasPriv: (priv) => priv === PRIV.PRIV_VIEW_ALL_DOMAIN,
    };
    handler.user = viewAllUser;
    targetPermissionMode = 'view-only';
    handler.response = { body: {} };
    await handler.postGetCopiedProblems();
    assert.equal(handler.response.body.copies.length, 2);
    assert.equal(handler.response.body.unauthorizedCount, 1);
    handler.response = { body: {} };
    await handler.postSyncCopiedProblems();
    assert.equal(handler.response.body.synced.length, 0);
    assert.equal(handler.response.body.unauthorizedCount, 3);
    targetPermissionMode = 'editor';

    // Test 4: postSyncCopiedProblems only syncs copies in authorized domains and skips unauthorized domains
    handler.user = userEditor;
    handler.response = { body: {} };
    await handler.postSyncCopiedProblems();

    // school_a should be synced, school_b has conflict, private_school is unauthorized (skipped)
    assert.equal(handler.response.body.synced.length, 1);
    assert.equal(handler.response.body.synced[0].domainId, 'school_a');
    assert.equal(handler.response.body.conflicts.length, 1); // school_b had local modifications
    assert.equal(handler.response.body.conflicts[0].domainId, 'school_b');
    assert.equal(handler.response.body.unauthorizedCount, 1); // private_school was not leaked or modified

    // Verify private_school was NOT updated by userEditor
    const syncedPrivateSchool = editedRecords.find((r) => r.domainId === 'private_school');
    assert.equal(syncedPrivateSchool, undefined);

    // Verify school_a was updated with sourceProblem content
    const syncedSchoolA = editedRecords.find((r) => r.domainId === 'school_a');
    assert.ok(syncedSchoolA);
    assert.equal(syncedSchoolA.update.title, sourceProblem.title);
    assert.equal(syncedSchoolA.update.content, sourceProblem.content);
    assert.deepEqual(syncedSchoolA.update.tag, sourceProblem.tag);
    assert.equal(syncedSchoolA.update.difficulty, sourceProblem.difficulty);
    assert.ok(syncedSchoolA.update.reference.lastSyncAt);

    // Timestamp-free concurrent content changes are rejected by snapshot predicates.
    conditionalUpdateMode = 'concurrent-content';
    sourceProblem.updateAt = new Date(Date.now() + 60000);
    const editCountBeforeConflict = editedRecords.length;
    handler.response = { body: {} };
    await handler.postSyncCopiedProblems();
    assert.equal(handler.response.body.synced.length, 0);
    assert.equal(handler.response.body.conflicts.length, 2);
    assert.equal(editedRecords.length, editCountBeforeConflict);
    copies[0].content = sourceProblem.content;

    // A concurrent hide is also rejected even though hide does not update updateAt.
    conditionalUpdateMode = 'concurrent-hidden';
    handler.response = { body: {} };
    await handler.postSyncCopiedProblems();
    assert.equal(handler.response.body.synced.length, 0);
    assert.equal(handler.response.body.conflicts.length, 2);
    assert.equal(editedRecords.length, editCountBeforeConflict);
    delete copies[0].hidden;

    // A deleted target produces a conflict and cannot be recreated by the non-upserting update.
    conditionalUpdateMode = 'deleted';
    handler.response = { body: {} };
    await handler.postSyncCopiedProblems();
    assert.equal(handler.response.body.synced.length, 0);
    assert.equal(editedRecords.length, editCountBeforeConflict);
    conditionalUpdateMode = 'ok';

    // Test 5: View-all still cannot bypass target-problem permissions
    handler.user = viewAllUser;
    handler.args = {};
    handler.response = { body: {} };
    await handler.postSyncCopiedProblems();
    // private_school remains unauthorized even for a view-all user
    const adminSyncedPrivate = editedRecords.find((r) => r.domainId === 'private_school');
    assert.equal(adminSyncedPrivate, undefined);
    assert.equal(handler.response.body.unauthorizedCount, 1);

    // Test 6: Force sync allows overwriting locally modified copies for authorized domains
    handler.user = userEditor;
    handler.args = { force: true };
    handler.response = { body: {} };
    await handler.postSyncCopiedProblems();
    // school_a and school_b should be synced (even though school_b was modified), private_school is unauthorized
    assert.equal(handler.response.body.synced.length, 2);
    assert.equal(handler.response.body.conflicts.length, 0);
    assert.equal(handler.response.body.unauthorizedCount, 1);
    assert.equal(handler.response.body.force, true);
    const forceSyncedSchoolB = editedRecords.find((r) => r.domainId === 'school_b');
    assert.ok(forceSyncedSchoolB);
    assert.equal(forceSyncedSchoolB.update.title, sourceProblem.title);
    assert.equal(forceSyncedSchoolB.update.content, sourceProblem.content);

    // Test 7: System admin with PRIV_EDIT_SYSTEM can force sync even without domain membership
    const systemAdminUser = {
        _id: 1,
        own: () => true,
        hasPerm: () => true,
        hasPriv: (priv) => priv === PRIV.PRIV_EDIT_SYSTEM,
    };
    handler.user = systemAdminUser;
    handler.args = { force: true };
    handler.response = { body: {} };
    await handler.postSyncCopiedProblems();
    assert.equal(handler.response.body.synced.length, 3);
    assert.equal(handler.response.body.conflicts.length, 0);
    assert.equal(handler.response.body.unauthorizedCount, 0);
    const forceSyncedPrivate = editedRecords.find((r) => r.domainId === 'private_school');
    assert.ok(forceSyncedPrivate);

    // Test 8: Selective force sync only syncs specified targets
    editedRecords.length = 0;
    handler.user = userEditor;
    // Only select school_b (which was locally modified)
    handler.args = {
        force: true,
        targets: [{ domainId: 'school_b', docId: 202 }],
    };
    handler.response = { body: {} };
    await handler.postSyncCopiedProblems();
    assert.equal(handler.response.body.synced.length, 1);
    assert.equal(handler.response.body.synced[0].domainId, 'school_b');
    assert.equal(handler.response.body.conflicts.length, 0);
    assert.equal(handler.response.body.unauthorizedCount, 0);
    assert.equal(editedRecords.length, 1);
    assert.equal(editedRecords[0].domainId, 'school_b');
});

