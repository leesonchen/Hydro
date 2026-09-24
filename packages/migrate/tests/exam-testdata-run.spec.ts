import assert from 'node:assert/strict';
import {
    computeTestdataRepairPlanHash,
    planExamTestdataRepair,
} from '../exam-testdata';
import {
    assertSeparateRepairDirectories,
    TESTDATA_REPAIR_KIND,
    testdataAnalyze,
    testdataApply,
    testdataRollback,
} from '../exam-testdata-run';

function minimalPlan() {
    const plan: any = {
        schemaVersion: 1,
        kind: 'hydro.exam-testdata-repair-plan',
        runId: 'repair-test',
        sourcePackageHash: 'source',
        priorPlanHash: 'prior',
        items: [],
    };
    return { ...plan, planHash: computeTestdataRepairPlanHash(plan) };
}

function testRepairPlanHashRoundTrip() {
    const plan = minimalPlan();
    assert.equal(plan.kind, 'hydro.exam-testdata-repair-plan');
    assert.equal(plan.planHash, computeTestdataRepairPlanHash({
        schemaVersion: plan.schemaVersion,
        kind: plan.kind,
        runId: plan.runId,
        sourcePackageHash: plan.sourcePackageHash,
        priorPlanHash: plan.priorPlanHash,
        items: plan.items,
    }));
    assert.equal(TESTDATA_REPAIR_KIND, 'hydro.exam-testdata-repair');
}

async function testOperatorGuards() {
    await assert.rejects(testdataAnalyze(), /原迁移目录缺失/);
    await assert.rejects(testdataApply({ repairRunDir: '/tmp/exam-testdata-run-test' }), /原迁移目录缺失/);
    await assert.rejects(testdataRollback({ repairRunDir: '/tmp/exam-testdata-run-test' }), /--yes/);
}

function testSeparateRunDirectories() {
    const options = {
        priorRunDir: '/tmp/exam-runs/old',
        sourcePackageDir: '/tmp/exam-runs/new',
        repairRunDir: '/tmp/exam-runs/repair',
    };
    assert.doesNotThrow(() => assertSeparateRepairDirectories(options));
    assert.throws(() => assertSeparateRepairDirectories({ ...options, repairRunDir: '/tmp/exam-runs/new/repair' }), /不能重叠/);
    assert.throws(() => assertSeparateRepairDirectories({ ...options, sourcePackageDir: '/tmp/exam-runs/repair/new' }), /不能重叠/);
}

function testPlannerRemainsTheSourceOfTruth() {
    const plan = planExamTestdataRepair({
        priorPlan: { problems: [] },
        snapshots: [],
        sourceProblems: [],
        targetProblems: [],
        runId: 'repair-test',
        sourcePackageHash: 'source',
        priorPlanHash: 'prior',
    });
    assert.deepEqual(plan.items, []);
}

testRepairPlanHashRoundTrip();
testPlannerRemainsTheSourceOfTruth();
testSeparateRunDirectories();
testOperatorGuards().then(
    () => console.log('exam testdata runner guard tests passed'),
    (error) => {
        console.error(error);
        process.exitCode = 1;
    },
);
