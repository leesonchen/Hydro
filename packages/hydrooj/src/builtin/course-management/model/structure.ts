import type { CourseTdoc, DagNode } from './course';

function nodeIds(course: Partial<CourseTdoc>, field: 'problemNodeIds' | 'problemAccessNodeIds'): Record<number, number> {
    const owners: Record<number, number> = {};
    for (const node of course.dag || []) {
        if (node.kind === 'assessment') continue;
        for (const pid of node.pids) {
            // Legacy grading uses the last matching node; access uses the first.
            if (field === 'problemNodeIds' || owners[pid] === undefined) owners[pid] = node._id;
        }
    }
    for (const [pid, id] of Object.entries(course[field] || {})) {
        if (course.dag?.some((node) => node._id === id && node.kind !== 'assessment' && node.pids.includes(+pid))) owners[+pid] = id;
    }
    return owners;
}

export const problemNodeIds = (course: Partial<CourseTdoc>) => nodeIds(course, 'problemNodeIds');
export const problemAccessNodeIds = (course: Partial<CourseTdoc>) => nodeIds(course, 'problemAccessNodeIds');

export function nodeHighWatermark(course?: Partial<CourseTdoc>, historicalMax = 0) {
    return Math.max(0, historicalMax, course?.nodeIdHighWatermark || 0,
        ...(course?.dag || []).map((node) => node._id),
        ...Object.keys(course?.lecture || {}).map(Number));
}

export function nextStructure(current: CourseTdoc | undefined, dag: DagNode[], expectedRevision: number, historicalMax = 0) {
    if (expectedRevision !== (current?.dagRevision || 0)) throw new Error('课程结构已更新，请重新打开编辑页面。');
    const previousIds = new Set(current?.dag?.map((node) => node._id) || []);
    const high = nodeHighWatermark(current, historicalMax);
    if (current && dag.some((node) => !previousIds.has(node._id) && node._id <= high)) {
        throw new Error('新课时不能复用历史编号，请重新打开编辑页面。');
    }
    const owners = problemNodeIds({ dag });
    const accessOwners = problemAccessNodeIds({ dag });
    for (const [pid, id] of Object.entries(current ? problemNodeIds(current) : {})) {
        if (dag.some((node) => node._id === id && node.kind !== 'assessment' && node.pids.includes(+pid))) owners[+pid] = id;
    }
    for (const [pid, id] of Object.entries(current ? problemAccessNodeIds(current) : {})) {
        if (dag.some((node) => node._id === id && node.kind !== 'assessment' && node.pids.includes(+pid))) accessOwners[+pid] = id;
    }
    return { dag, problemNodeIds: owners, problemAccessNodeIds: accessOwners,
        nodeIdHighWatermark: Math.max(high, ...dag.map((node) => node._id)),
        dagRevision: expectedRevision + 1 };
}
