import assert from 'node:assert/strict';
import { Db } from 'mongodb';
import { resolveMaterializedProblem } from '../exam';

function fakeDb(documents: any[]): Db {
    return { collection: () => ({
        find: (query: any) => ({
            limit: (limit: number) => ({
                toArray: async () => documents.filter((doc) => doc.domainId === query.domainId
                    && doc.docType === query.docType
                    && query.$or.some((part: any) => Object.entries(part)
                        .every(([key, value]) => String(doc[key]) === String(value)))).slice(0, limit),
            }),
        }),
    }) } as unknown as Db;
}

async function main() {
    const wrapper = { domainId: 'exam', docType: 10, docId: 18, reference: { domainId: 'prepare', pid: 18 } };
    const prepare = { domainId: 'prepare', docType: 10, docId: 18, pid: 'P18', config: 'time: 1s', data: [{ name: '1.in' }] };
    const result = await resolveMaterializedProblem(fakeDb([prepare]), wrapper);
    assert.equal(result?.effectiveSource.domainId, 'prepare');
    assert.equal(result?.effectiveSource.docId, 18);
    assert.equal(result?.problem.data.length, 1);
    assert.equal(await resolveMaterializedProblem(fakeDb([prepare]), {
        ...wrapper, reference: { domainId: 'oler', pid: 18 },
    }), null, 'non-prepare references remain outside the materialization scope');
    await assert.rejects(resolveMaterializedProblem(fakeDb([]), wrapper), /不存在/);
    await assert.rejects(resolveMaterializedProblem(fakeDb([{
        ...prepare, reference: { domainId: 'prepare', pid: 18 },
    }]), wrapper), /循环/);
}

main().then(() => console.log('exam materialized-reference tests passed')).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
