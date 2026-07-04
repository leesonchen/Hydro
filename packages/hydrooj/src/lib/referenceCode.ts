import * as document from '../model/document';
import type { ProblemDoc } from '../model/problem';
import ProblemModel from '../model/problem';

export const REFERENCE_CODE_TITLE = '【参考代码】';

export function isReferenceCodeSolutionByContent(content = '') {
    const firstLine = content.split(/\r?\n/).find((line) => line.trim());
    if (!firstLine) return false;
    const title = firstLine.trim().replace(/^#+\s*/, '');
    return title.startsWith(REFERENCE_CODE_TITLE);
}

export function isReferenceCodeSolution(doc: any) {
    return doc?.title === REFERENCE_CODE_TITLE || isReferenceCodeSolutionByContent(doc?.content || '');
}

function getProblemSource(pdoc: ProblemDoc) {
    return pdoc.reference || { domainId: pdoc.domainId, pid: pdoc.docId };
}

export async function getReferenceCodeProblemIds(domainId: string, pdoc: ProblemDoc) {
    const source = getProblemSource(pdoc);
    const pids = new Set<number>([pdoc.docId]);
    if (source.domainId === domainId) pids.add(source.pid);

    const related = await ProblemModel.getMulti(domainId, {
        'reference.domainId': source.domainId,
        'reference.pid': source.pid,
    } as any, ['docId']).toArray();
    for (const doc of related) pids.add(doc.docId);
    return Array.from(pids);
}

export async function getReferenceCodeSolutions(domainId: string, pdoc: ProblemDoc) {
    const pids = await getReferenceCodeProblemIds(domainId, pdoc);
    const refs = await document.getMulti(domainId, document.TYPE_PROBLEM_SOLUTION, {
        parentType: document.TYPE_PROBLEM,
        parentId: { $in: pids },
    }).toArray();
    return refs
        .filter((doc: any) => isReferenceCodeSolution(doc))
        .sort((a: any, b: any) => a._id.getTimestamp().getTime() - b._id.getTimestamp().getTime());
}

export async function hasReferenceCodeSolution(domainId: string, pdoc: ProblemDoc) {
    const refs = await getReferenceCodeSolutions(domainId, pdoc);
    return refs.length > 0;
}
