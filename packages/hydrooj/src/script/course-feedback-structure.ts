import Schema from 'schemastery';
import type { CourseTdoc } from '../builtin/course-management/model/course';
import { problemAccessNodeIds, problemNodeIds } from '../builtin/course-management/model/structure';

export async function run(args: { domainId: string, execute?: boolean }, report: (data: any) => void) {
    // Scripts register before models finish loading; resolve these at execution.
    const contest: typeof import('../model/contest') = require('../model/contest');
    const document: typeof import('../model/document') = require('../model/document');
    const { courseNodeHighWatermark } = require('../builtin/course-management/handler/course');
    const courses = await contest.getMulti(args.domainId, { rule: 'course' }).toArray() as CourseTdoc[];
    let changed = 0;
    for (const course of courses) {
        // Read historical references before proposing the one-time initialization.
        // eslint-disable-next-line no-await-in-loop
        const high = await courseNodeHighWatermark(args.domainId, course);
        const patch = { nodeIdHighWatermark: high, problemNodeIds: problemNodeIds(course),
            problemAccessNodeIds: problemAccessNodeIds(course), dagRevision: course.dagRevision || 0 };
        const needed = course.nodeIdHighWatermark !== high || !course.problemNodeIds
            || !course.problemAccessNodeIds || course.dagRevision === undefined;
        if (args.execute && needed) {
            // eslint-disable-next-line no-await-in-loop
            const result = await document.setIfCondition(args.domainId, document.TYPE_CONTEST, course.docId,
                { dagRevision: course.dagRevision ?? { $exists: false }, dag: course.dag } as any, patch as Partial<CourseTdoc>);
            if (!result) throw new Error('课程结构并发变化，请重新检查。');
            changed++;
        }
        report({ message: JSON.stringify({ courseId: course.docId, high, needed, executed: !!args.execute && needed }) });
    }
    report({ message: `Checked ${courses.length} course(s), changed ${changed}.` });
    return true;
}

export const apply = (ctx) => ctx.addScript('course-feedback-structure', 'Initialize stable course IDs (read-only by default)',
    Schema.object({ domainId: Schema.string().required(), execute: Schema.boolean().default(false) }), run);
