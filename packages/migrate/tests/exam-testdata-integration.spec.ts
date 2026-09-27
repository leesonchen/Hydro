/* eslint-disable no-await-in-loop */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
    analyzeExamPackage, applyExamPackage, computePlanHash, exportExamPackage, MigrationPlan, verifyExamMigration,
} from '../exam';
import { testdataAnalyze, testdataApply, testdataRollback, testdataVerify } from '../exam-testdata-run';

async function main() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'exam-testdata-integration-'));
    const server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
    const uri = server.getUri();
    const client = await MongoClient.connect(uri);
    try {
        const oldDir = path.join(root, 'old');
        const newDir = path.join(root, 'new');
        const repairDir = path.join(root, 'repair');
        const sourceRoot = path.join(root, 'source-files');
        const targetRoot = path.join(root, 'target-files');
        await fs.mkdir(targetRoot);
        const source = client.db('source');
        const target = client.db('target');
        await source.collection<any>('domain').insertOne({ _id: 'exam', owner: 1 });
        await source.collection<any>('user').insertOne({ _id: 1, uname: 'source-owner', mail: 'owner@example.org' });
        const content = '{"zh":"statement"}';
        await source.collection('document').insertMany([
            {
                domainId: 'exam', docType: 10, docId: 1, pid: 'P1', title: 'Prepared',
                content, owner: 1, config: 'old', data: [], additional_file: [],
                reference: { domainId: 'prepare', pid: 50 },
            },
            {
                domainId: 'prepare', docType: 10, docId: 50, pid: 50, title: 'Prepared',
                content, owner: 1, config: 'time: 1s',
                data: ['1.in', '1.out'].map((name) => ({
                    _id: name, name, size: 3,
                    lastModified: new Date('2025-01-02T03:04:05.000Z'),
                    etag: Buffer.from(`/data/file/hydro/source/${name}`).toString('base64'),
                })),
                additional_file: [],
            },
        ]);
        for (const name of ['1.in', '1.out']) {
            await fs.mkdir(path.join(sourceRoot, 'source'), { recursive: true });
            await fs.writeFile(path.join(sourceRoot, 'source', name), name === '1.in' ? 'abc' : 'xyz');
            await source.collection<any>('storage').insertOne({
                _id: `source/${name}`,
                path: `problem/prepare/50/testdata/${name}`,
                size: 3,
                owner: 1,
                lastModified: new Date('2025-01-02T03:04:05.000Z'),
                etag: Buffer.from(`/data/file/hydro/source/${name}`).toString('base64'),
            });
        }
        const exportOptions = { sourceUri: uri, sourceDatabase: 'source', sourceStorageRoot: sourceRoot };
        const oldManifest = await exportExamPackage({ ...exportOptions, runDir: oldDir });
        const newManifest = await exportExamPackage({ ...exportOptions, runDir: newDir });
        assert.equal(newManifest.materializedProblems?.count, 1);
        assert.equal(newManifest.files.filter((file) => file.included).length, 2);
        const freshRoot = path.join(root, 'fresh-files');
        await fs.mkdir(freshRoot);
        const freshOptions = {
            runDir: newDir, targetUri: uri, targetDatabase: 'fresh', targetStorageRoot: freshRoot,
        };
        const freshPlan = await analyzeExamPackage(freshOptions);
        assert.equal(freshPlan.problems[0].action, 'copy');
        assert.equal(freshPlan.storage.filter((file) => file.included).length, 2);
        const freshDryRun = await applyExamPackage({
            ...freshOptions, planHash: freshPlan.planHash, serviceControl: 'none', backup: false, dryRun: true,
        });
        assert.equal(freshDryRun.dryRun, true);
        await applyExamPackage({
            ...freshOptions, planHash: freshPlan.planHash, serviceControl: 'none', backup: false,
        });
        const freshProblem = await client.db('fresh').collection<any>('document').findOne({ domainId: 'exam', docType: 10 });
        assert.equal(freshProblem?.reference, undefined);
        assert.equal(freshProblem?.config, 'time: 1s');
        assert.equal(freshProblem?.data?.length, 2);
        const freshVerification = await verifyExamMigration(freshOptions);
        assert.equal(freshVerification.ok, true, freshVerification.errors.join('; '));

        const prior = {
            schemaVersion: 1, kind: 'hydro.exam-migration-plan', runId: oldManifest.runId,
            domainId: 'exam', packageHash: oldManifest.packageHash,
            problems: [{
                sourceDocId: 1, sourcePid: 'P1', action: 'copy', targetDomainId: 'exam',
                targetPid: 101, targetDocId: 101, reason: 'entity', sourceHasFiles: false,
            }],
        } as MigrationPlan;
        prior.planHash = computePlanHash(prior);
        await fs.writeFile(path.join(oldDir, 'plan.json'), `${JSON.stringify(prior)}\n`);
        await fs.writeFile(path.join(oldDir, 'apply.json'), `${JSON.stringify({
            runId: prior.runId, planHash: prior.planHash, packageHash: prior.packageHash,
            completedAt: new Date().toISOString(), phases: [],
        })}\n`);
        await target.collection<any>('exam.migration').insertOne({
            _id: prior.runId, status: 'complete', planHash: prior.planHash, packageHash: prior.packageHash,
        });
        await target.collection('document').insertOne({
            domainId: 'exam', docType: 10, docId: 101, pid: 101, title: 'Prepared',
            content, owner: 2, config: 'old', data: [], additional_file: [],
        });
        const options = {
            priorRunDir: oldDir, sourcePackageDir: newDir, repairRunDir: repairDir,
            targetUri: uri, targetDatabase: 'target', targetStorageRoot: targetRoot,
            noStop: true, noBackup: true,
        };
        const plan = await testdataAnalyze(options);
        assert.equal(plan.items.length, 1);
        assert.equal(plan.items[0].files.length, 2);
        const dryRun = await testdataApply({ ...options, planHash: plan.planHash, dryRun: true });
        assert.equal(dryRun.dryRun, true);
        assert.equal(await target.collection('storage').countDocuments({}), 0);
        assert.deepEqual((await target.collection('document').findOne({ docId: 101 }))?.data, []);

        // Force a storage-phase failure after both physical files have been
        // copied. The automatic rollback must leave the original problem and
        // unrelated storage metadata untouched.
        await target.collection<any>('storage').insertOne({ _id: 'unrelated', path: 'unrelated', domainId: 'exam' });
        await target.collection('storage').createIndex({ domainId: 1 }, { unique: true, name: 'force-storage-failure' });
        await assert.rejects(testdataApply({ ...options, planHash: plan.planHash }), /E11000/);
        assert.equal(await target.collection('storage').countDocuments({}), 1);
        assert.equal(await target.collection<any>('exam.migration').countDocuments({ _id: plan.runId }), 0);
        assert.deepEqual((await target.collection('document').findOne({ docId: 101 }))?.data, []);
        for (const file of plan.items[0].files) {
            await assert.rejects(fs.stat(path.join(targetRoot, file.file.targetStorageId!)), /ENOENT/);
        }
        await target.collection('storage').dropIndex('force-storage-failure');
        await target.collection<any>('storage').deleteOne({ _id: 'unrelated' });

        const applied = await testdataApply({ ...options, planHash: plan.planHash });
        assert.equal(applied.updated.length, 1);
        assert.equal((await target.collection<any>('document').findOne({ docId: 101 }))?.config, 'time: 1s');
        const verified = await testdataVerify(options);
        assert.equal(verified.ok, true, verified.errors.join('; '));
        assert.equal(verified.files.checked, 2);
        const rolledBack = await testdataRollback({ ...options, yes: true });
        assert.equal(rolledBack.documents, 1);
        assert.equal(rolledBack.files, 2);
        assert.equal(await target.collection('storage').countDocuments({}), 0);
        assert.deepEqual((await target.collection('document').findOne({ docId: 101 }))?.data, []);
        assert.equal((await target.collection<any>('document').findOne({ docId: 101 }))?.config, 'old');
    } finally {
        await client.close();
        await server.stop();
        await fs.rm(root, { recursive: true, force: true });
    }
}

main().then(() => console.log('exam testdata integration tests passed')).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
