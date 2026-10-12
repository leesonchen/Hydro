import { createHash } from 'crypto';
import { ObjectId } from 'mongodb';
import type { RatingContestInput } from './eligibility';

/** Resolve the authoritative course binding; source tags alone never certify a test. */
export async function resolveClassroomBinding(dbh: { collection(name: string): any }, exam: RatingContestInput) {
    if (exam.sourceType !== 'course_assessment' || !ObjectId.isValid(String(exam.sourceCourseTid))
        || !Number.isSafeInteger(exam.sourceNodeId)) return null;
    const course = await dbh.collection('document').findOne({
        docType: 30, domainId: exam.domainId, docId: new ObjectId(String(exam.sourceCourseTid)), rule: 'course',
    });
    const node = course?.dag?.find((n: any) => n._id === exam.sourceNodeId);
    if (!course || course.assign?.includes('teachers') || node?.kind !== 'assessment'
        || node.assessment?.contestTid !== String(exam.docId)
        || node.assessment.rule !== exam.rule
        || new Date(node.assessment.beginAt).getTime() !== exam.beginAt.getTime()
        || new Date(node.assessment.endAt).getTime() !== exam.endAt.getTime()
        || JSON.stringify(node.pids) !== JSON.stringify(exam.pids)) return null;
    const courseSignature = createHash('sha256').update(JSON.stringify({
        domainId: course.domainId, docId: String(course.docId),
        beginAt: course.beginAt, endAt: course.endAt, owner: course.owner,
        assign: [...(course.assign || [])].sort(), maintainer: [...(course.maintainer || [])].sort(),
        dag: course.dag.map((n: any) => ({
            _id: n._id, kind: n.kind, pids: n.pids, requireNids: n.requireNids,
            completeCondition: n.completeCondition, lectureRule: n.lectureRule, assessment: n.assessment,
        })),
    })).digest('hex');
    return { course, courseSignature };
}

export async function isClassroomBindingCurrent(dbh: { collection(name: string): any }, exam: RatingContestInput) {
    if (exam.sourceType !== 'course_assessment') return true;
    const binding = await resolveClassroomBinding(dbh, exam);
    return !!binding && binding.courseSignature === exam.ratingPolicy?.classroom?.courseSignature;
}
