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
    if (!course) deny();
    const node = course.dag?.find((n) => n._id === tdoc.sourceNodeId);
    if (course.rule !== 'course' || course.assign?.includes('teachers')
        || node?.kind !== 'assessment' || node.assessment?.contestTid !== tdoc.docId.toString()) deny();
    // The child-contest owner/maintainer copy is never a source of authority.
    const teacher = user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
        || (user.own(course) && user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF));
    if (teacher) return true;
    if (!user.hasPerm(PERM.PERM_VIEW_HOMEWORK)) deny();
    const groups = await UserModel.listGroup(tdoc.domainId, user._id);
    const assignedClassGroups = groups.filter((group) => course.assign?.includes(group.name)
        && group.class === true && !group.archive);
    // Class-group uids contains both students and teachers. Do not allow staff
    // members with missing edit permissions to fall through as exam students.
    if (user.own(course) || assignedClassGroups.some((group) => group.teachers?.includes(user._id))) deny();
    // Only actual class students and explicit extra-student UIDs are eligible;
    // neither a generic group nor an empty assign list grants test enrollment.
    const assigned = !!(course.assign?.includes(String(user._id))
        || assignedClassGroups.some((group) => group.students?.includes(user._id)));
    const status = await contest.getStatus(tdoc.domainId, course.docId, user._id);
    if (!assigned || !status?.attend || status.allow?.[tdoc.sourceNodeId] !== true) deny();
    return false;
}

export function canShowClassroomSelfRecord(tdoc: Tdoc): boolean {
    if (tdoc.sourceType !== 'course_assessment') return false;
    // Authorization comes from the live parent course. Reuse only the rule's
    // visibility window, not the child assign or contest-admin override.
    const rule = contest.RULES[tdoc.rule];
    return rule?.showSelfRecord
        ? rule.showSelfRecord(tdoc, new Date())
        : !tdoc.keepScoreboardHidden && (!tdoc.beginAt || new Date() > tdoc.beginAt);
}
