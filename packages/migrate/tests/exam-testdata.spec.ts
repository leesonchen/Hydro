import assert from 'node:assert/strict';
import {
    FileEntry,
    hashObject,
    MaterializedProblemSnapshot,
    ProblemDecision,
} from '../exam';
import {
    computeTestdataRepairPlanHash,
    planExamTestdataRepair,
    TestdataRepairPlannerInput,
} from '../exam-testdata';

function decision(overrides: Partial<ProblemDecision> = {}): ProblemDecision {
    return {
        sourceDocId: 1,
        sourcePid: 'P1',
        action: 'copy',
        targetDomainId: 'exam',
        targetPid: 101,
        targetDocId: 101,
        reason: 'entity',
        sourceHasFiles: false,
        ...overrides,
    };
}

function file(sourceDocId = 1, name = '1.in', storageId = 'source-storage-1'): FileEntry {
    return {
        sourceStorageId: storageId,
        sourcePath: `problem/exam/${sourceDocId}/testdata/${name}`,
        targetPath: `problem/exam/${sourceDocId}/testdata/${name}`,
        targetStorageId: storageId,
        packagePath: `files/${storageId}`,
        size: 3,
        sha256: 'a'.repeat(64),
        required: true,
        included: true,
    };
}

function snapshot(sourceDocId = 1, sourceFile = file(sourceDocId)): MaterializedProblemSnapshot {
    return {
        sourceDocId,
        sourcePid: `P${sourceDocId}`,
        sourceReference: { domainId: 'prepare', pid: 50 },
        effectiveSource: {
            domainId: 'prepare',
            docId: 50,
            pid: 50,
            path: 'problem/prepare/50',
            referenceChain: [{ domainId: 'prepare', pid: 50 }],
        },
        config: 'time: 1s',
        data: [{ name: sourceFile.sourcePath.split('/').pop() }],
        additional_file: [],
        clonedFiles: [{
            kind: 'data',
            name: sourceFile.sourcePath.split('/').pop()!,
            originPath: 'problem/prepare/50/testdata/1.in',
            originStorageId: 'prepare-storage-1',
            storage: {
                _id: sourceFile.sourceStorageId,
                path: sourceFile.sourcePath,
                etag: Buffer.from(`/data/file/hydro/${sourceFile.sourceStorageId}`).toString('base64'),
                size: 3,
            },
            file: sourceFile,
        }],
    };
}

function baseInput(overrides: Partial<TestdataRepairPlannerInput> = {}): TestdataRepairPlannerInput {
    return {
        priorPlan: { problems: [decision()] },
        snapshots: [snapshot()],
        sourceProblems: [{ domainId: 'exam', docId: 1, pid: 'P1', title: 'Prepared', reference: { domainId: 'prepare', pid: 50 } }],
        targetProblems: [{ domainId: 'exam', docId: 101, pid: 101, title: 'Prepared', owner: 77, data: [] }],
        runId: 'repair-20260924',
        sourcePackageHash: 'source-package-hash',
        priorPlanHash: 'prior-plan-hash',
        ...overrides,
    };
}

function testPlanShapeAndDeterminism() {
    const first = planExamTestdataRepair(baseInput());
    const second = planExamTestdataRepair({
        ...baseInput(),
        sourceProblems: [...baseInput().sourceProblems].reverse(),
        targetProblems: [...baseInput().targetProblems].reverse(),
        snapshots: [...baseInput().snapshots].reverse(),
    });
    assert.deepEqual(first, second);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].sourceDocId, 1);
    assert.equal(first.items[0].targetDocId, 101);
    assert.equal(first.items[0].targetDocumentFingerprint, hashObject(baseInput().targetProblems[0]));
    assert.equal(first.items[0].files[0].file.sourcePath, 'problem/exam/1/testdata/1.in');
    assert.equal(first.items[0].files[0].file.targetPath, 'problem/exam/101/testdata/1.in');
    assert.match(first.items[0].files[0].file.targetStorageId!, /^migration\/repair-20260924\/repair\/101\//);
    assert.equal(first.items[0].files[0].storage._id, first.items[0].files[0].file.targetStorageId);
    assert.equal(first.items[0].files[0].storage.path, first.items[0].files[0].file.targetPath);
    assert.equal(first.items[0].files[0].storage.owner, 77);
    assert.equal(first.items[0].files[0].sourceFile.packagePath, 'files/source-storage-1');
    assert.equal(first.planHash, computeTestdataRepairPlanHash({
        schemaVersion: first.schemaVersion,
        kind: first.kind,
        runId: first.runId,
        sourcePackageHash: first.sourcePackageHash,
        priorPlanHash: first.priorPlanHash,
        items: first.items,
    }));
}

function testP105AndNonCandidatesAreExcluded() {
    const input = baseInput({
        priorPlan: {
            problems: [
                decision(),
                decision({ sourceDocId: 105, sourcePid: 'P105', targetDocId: 9, targetPid: 9, action: 'reuse' }),
                decision({ sourceDocId: 2, sourcePid: 'P2', targetDocId: 102, targetPid: 102, sourceHasFiles: true }),
                decision({ sourceDocId: 3, sourcePid: 'P3', targetDocId: 103, targetPid: 103, action: 'reference' }),
            ],
        },
        snapshots: [snapshot(), snapshot(105, file(105, 'p105.in', 'p105-storage'))],
        sourceProblems: [
            { domainId: 'exam', docId: 1, pid: 'P1', title: 'Prepared', reference: { domainId: 'prepare', pid: 50 } },
            { domainId: 'exam', docId: 105, pid: 'P105', title: 'P105', reference: { domainId: 'prepare', pid: 105 } },
        ],
        targetProblems: [
            { domainId: 'exam', docId: 101, pid: 101, title: 'Prepared', owner: 77, data: [] },
            { domainId: 'exam', docId: 9, pid: 9, title: 'P105', owner: 77, data: [] },
        ],
    });
    assert.deepEqual(planExamTestdataRepair(input).items.map((item) => item.sourceDocId), [1]);
}

function testMissingAndInvalidInputsFailClosed() {
    assert.throws(() => planExamTestdataRepair(baseInput({ snapshots: [] })), /缺少 materialized/);
    assert.throws(() => planExamTestdataRepair(baseInput({
        snapshots: [{ ...snapshot(), data: [] }],
    })), /源测试数据为空/);
    assert.throws(() => planExamTestdataRepair(baseInput({
        snapshots: [{ ...snapshot(), sourceReference: { domainId: 'prepare', pid: 999 } }],
    })), /快照引用不匹配/);
    assert.throws(() => planExamTestdataRepair(baseInput({
        targetProblems: [{ domainId: 'exam', docId: 101, pid: 101, title: 'Changed', owner: 77, data: [] }],
    })), /标题不匹配/);
    assert.throws(() => planExamTestdataRepair(baseInput({
        targetProblems: [{ domainId: 'exam', docId: 101, pid: 101, title: 'Prepared', owner: 77, data: [{ name: 'existing.in' }] }],
    })), /目标已有测试数据/);
    assert.throws(() => planExamTestdataRepair(baseInput({
        targetProblems: [{
            domainId: 'exam', docId: 101, pid: 101, title: 'Prepared', owner: 77, data: [],
            reference: { domainId: 'prepare', pid: 50 },
        }],
    })), /目标仍有引用/);
    assert.throws(() => planExamTestdataRepair(baseInput({
        priorPlan: { problems: [decision({ targetDocId: 999 })] },
    })), /目标文档不存在/);
}

function testStorageDuplicatesAndSourceMetadata() {
    const duplicateId = file(1, '2.in', 'source-storage-1');
    const malformed = snapshot();
    malformed.data = [{ name: '1.in' }, { name: '2.in' }];
    malformed.clonedFiles = [malformed.clonedFiles[0], {
        ...malformed.clonedFiles[0],
        name: '2.in',
        storage: { ...malformed.clonedFiles[0].storage, path: duplicateId.sourcePath },
        file: duplicateId,
    }];
    assert.throws(() => planExamTestdataRepair(baseInput({ snapshots: [malformed] })), /源 storage ID 重复/);

    const missingSha = snapshot();
    missingSha.clonedFiles[0] = {
        ...missingSha.clonedFiles[0],
        file: { ...missingSha.clonedFiles[0].file, sha256: undefined },
    };
    assert.throws(() => planExamTestdataRepair(baseInput({ snapshots: [missingSha] })), /packagePath\/SHA-256/);

    const wrongStorage = snapshot();
    wrongStorage.clonedFiles[0].storage.path = 'problem/prepare/50/testdata/1.in';
    assert.throws(() => planExamTestdataRepair(baseInput({ snapshots: [wrongStorage] })), /storage 元数据不一致/);

    const wrongKind = snapshot();
    wrongKind.clonedFiles[0].file.sourcePath = 'problem/exam/1/additional_file/1.in';
    assert.throws(() => planExamTestdataRepair(baseInput({ snapshots: [wrongKind] })), /源文件类型或名称不匹配/);
}

testPlanShapeAndDeterminism();
testP105AndNonCandidatesAreExcluded();
testMissingAndInvalidInputsFailClosed();
testStorageDuplicatesAndSourceMetadata();
console.log('exam testdata repair pure tests passed');
