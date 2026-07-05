import * as document from '../model/document';
import type { ProblemDoc } from '../model/problem';
import ProblemModel from '../model/problem';

export const REFERENCE_CODE_TITLE = '【参考代码】';

interface ReferenceCodeProblemGroup {
    domainId: string;
    pids: number[];
}

export function isReferenceCodeSolution(doc: any) {
    return doc?.title === REFERENCE_CODE_TITLE;
}

function getProblemSource(pdoc: ProblemDoc) {
    return pdoc.reference || { domainId: pdoc.domainId, pid: pdoc.docId };
}

function buildReferenceCodeBaseQuery(pids: number[]) {
    return {
        parentType: document.TYPE_PROBLEM,
        parentId: { $in: pids },
    };
}

function buildReferenceCodeSolutionQuery(pids: number[]) {
    return {
        ...buildReferenceCodeBaseQuery(pids),
        title: REFERENCE_CODE_TITLE,
    };
}

export async function getReferenceCodeProblemGroups(domainId: string, pdoc: ProblemDoc): Promise<ReferenceCodeProblemGroup[]> {
    const source = getProblemSource(pdoc);
    const groups = new Map<string, Set<number>>();
    const addProblem = (problemDomainId: string, pid: number) => {
        if (!groups.has(problemDomainId)) groups.set(problemDomainId, new Set());
        groups.get(problemDomainId).add(pid);
    };

    addProblem(domainId, pdoc.docId);
    addProblem(source.domainId, source.pid);

    const related = await ProblemModel.getMulti('', {
        domainId: { $exists: true },
        'reference.domainId': source.domainId,
        'reference.pid': source.pid,
    } as any, ['domainId', 'docId']).toArray();
    for (const doc of related) addProblem(doc.domainId, doc.docId);
    return Array.from(groups, ([problemDomainId, pids]) => ({
        domainId: problemDomainId,
        pids: Array.from(pids),
    }));
}

export async function getReferenceCodeSolutions(domainId: string, pdoc: ProblemDoc) {
    const groups = await getReferenceCodeProblemGroups(domainId, pdoc);
    const refs = (await Promise.all(groups.map((group) => document
        .getMulti(group.domainId, document.TYPE_PROBLEM_SOLUTION, buildReferenceCodeSolutionQuery(group.pids) as any)
        .toArray()))).flat();
    return refs.sort((a: any, b: any) => a._id.getTimestamp().getTime() - b._id.getTimestamp().getTime());
}

export async function hasReferenceCodeSolution(domainId: string, pdoc: ProblemDoc) {
    const groups = await getReferenceCodeProblemGroups(domainId, pdoc);
    for (const group of groups) {
        // eslint-disable-next-line no-await-in-loop
        const ref = await document
            .getMulti(group.domainId, document.TYPE_PROBLEM_SOLUTION, buildReferenceCodeSolutionQuery(group.pids) as any)
            .project({ _id: 1 })
            .limit(1)
            .next();
        if (ref) return true;
    }
    return false;
}
