import { NotAssignedError } from '../error';
import type { Tdoc } from '../interface';
import { PERM } from '../model/builtin';
import * as contest from '../model/contest';
import UserModel, { User } from '../model/user';

/** The parent course remains the authority for access to its independently scheduled test. */
export async function assertCourseAssessmentAccess(user: User, tdoc: Tdoc) {
    if (tdoc.sourceType !== 'course_assessment') return false;
    const deny = () => { throw new NotAssignedError('contest', tdoc.docId); };
    if (!tdoc.sourceCourseTid || !Number.isSafeInteger(tdoc.sourceNodeId)) deny();
    const course = await contest.get(tdoc.domainId, tdoc.sourceCourseTid);
    const node = course.dag?.find((n) => n._id === tdoc.sourceNodeId);
    if (course.rule !== 'course' || course.assign?.includes('teachers')
        || node?.kind !== 'assessment' || node.assessment?.contestTid !== tdoc.docId.toString()) deny();
    const teacher = user.own(course) || user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
        || (course.maintainer?.includes(user._id) && user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF));
    if (teacher) return true;
    const groups = await UserModel.listGroup(tdoc.domainId, user._id);
    const assigned = !course.assign?.length || course.assign.some((g) => g === String(user._id)
        || groups.some((group) => group.name === g && !group.archive));
    const status = await contest.getStatus(tdoc.domainId, course.docId, user._id);
    if (!assigned || !status?.attend || status.allow?.[tdoc.sourceNodeId] !== true) deny();
    return false;
}
