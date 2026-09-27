/* eslint-disable no-await-in-loop */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Db } from 'mongodb';
import { checkConfirmedP105Files, MaterializedProblemSnapshot, MigrationPlan, sha256 } from '../exam';

async function main() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'exam-p105-files-'));
    try {
        const clonedFiles: MaterializedProblemSnapshot['clonedFiles'] = [];
        const targetFiles = [];
        const storage = new Map<string, any>();
        await fs.mkdir(path.join(root, 'p105'), { recursive: true });
        for (let index = 0; index < 40; index++) {
            const name = `${index}.in`;
            const id = `p105/${index}.in`;
            const body = Buffer.from(`case-${index}`);
            await fs.writeFile(path.join(root, id), body);
            const targetPath = `problem/contests/3230/testdata/${name}`;
            storage.set(targetPath, { _id: id, path: targetPath });
            targetFiles.push({ name });
            clonedFiles.push({
                kind: 'data', name,
                originPath: `problem/prepare/88/testdata/${name}`,
                originStorageId: `source/${index}`,
                storage: { _id: `source/${index}` },
                file: {
                    sourceStorageId: `source/${index}`,
                    sourcePath: `problem/exam/105/testdata/${name}`,
                    targetPath: `problem/exam/105/testdata/${name}`,
                    packagePath: `files/${sha256(body)}`,
                    sha256: sha256(body), included: true, required: true,
                },
            });
        }
        const snapshot = {
            sourceDocId: 105, clonedFiles,
            effectiveSource: {
                domainId: 'prepare', docId: 88, pid: 88, path: 'problem/prepare/88',
                referenceChain: [{ domainId: 'prepare', pid: 88 }],
            },
        } as MaterializedProblemSnapshot;
        const plan = { problems: [{ sourceDocId: 105, reason: 'confirmed-reuse' }] } as MigrationPlan;
        const db = { collection: (name: string) => ({
            findOne: async (query: any) => name === 'document'
                ? { domainId: 'contests', docId: 3230, data: targetFiles }
                : storage.get(query.path),
        }) } as unknown as Db;
        const checked = await checkConfirmedP105Files(db, root, plan, [snapshot]);
        assert.equal(checked.checked, 40);
        assert.deepEqual(checked.errors, []);
        await fs.writeFile(path.join(root, 'p105/0.in'), 'corrupted');
        const corrupted = await checkConfirmedP105Files(db, root, plan, [snapshot]);
        assert.match(corrupted.errors.join('\n'), /SHA-256 不一致/);
        assert.match((await checkConfirmedP105Files(db, undefined, plan, [snapshot])).errors.join('\n'), /存储根目录/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

main().then(() => console.log('exam P105 physical-file tests passed')).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
