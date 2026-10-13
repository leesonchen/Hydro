import { ObjectId } from 'mongodb';
import type { CourseTdoc } from '../builtin/course-management/model/course';
import { ForbiddenError, NotFoundError } from '../error';
import type { Tdoc } from '../interface';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import problem from '../model/problem';
import record from '../model/record';
import user from '../model/user';
import type { Handler } from '../service/server';
import { FeedbackInput, FeedbackValidationError } from './classroomFeedback';

export function feedbackEnabled(handler: Handler) {
    // Boolean domain settings are submitted by the settings form as "on".
    // Older/domain fixtures may also store the normalized boolean value.
    return handler.domain.classroomFeedback === true || handler.domain.classroomFeedback === 'on';
}

async function feedbackPermission(handler: Handler, tdoc: Tdoc) {
    if (!feedbackEnabled(handler) || !handler.user._id || !handler.user.hasPriv(PRIV.PRIV_USER_PROFILE)
        || handler.session.sudoUid || handler.session.uid !== handler.user._id) return null;
    if (!tdoc || tdoc.domainId !== handler.domain._id || !['course', 'homework'].includes(tdoc.rule)
        || (tdoc.rule === 'course' && !handler.domain.enableCourse)) return null;
    const names = (tdoc.assign || []).filter((g) => g !== 'teachers' && !/^\d+$/.test(g));
    const groups = names.length ? await user.listGroup(handler.domain._id, undefined, names) : [];
    const teachers = new Set([tdoc.owner, ...(tdoc.maintainer || []), ...groups.flatMap((g) => g.class ? g.teachers || [] : [])]);
    const manager = handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
    const assignedTeacher = teachers.has(handler.user._id);
    const canManage = manager || (assignedTeacher && handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF));
    return canManage ? { groups, teachers, manager } : null;
}

export async function canManageFeedback(handler: Handler, tdoc: Tdoc) {
    return !!await feedbackPermission(handler, tdoc);
}

export async function feedbackActivity(handler: Handler, activityType: 'course' | 'homework', activityId: string) {
    if (!feedbackEnabled(handler)) throw new ForbiddenError();
    if (!/^[a-f0-9]{24}$/.test(activityId)) throw new FeedbackValidationError('activityId');
    const domainId = handler.domain._id;
    const tdoc = await contest.get(domainId, new ObjectId(activityId)) as CourseTdoc;
    if (!tdoc || tdoc.rule !== activityType) throw new NotFoundError('Activity not found');
    const access = await feedbackPermission(handler, tdoc);
    if (!access) throw new ForbiddenError();
    const { groups, teachers, manager } = access;
    // editor is last edit attribution, not an enduring teaching grant.
    const explicit = (tdoc.assign || []).filter((g) => /^\d+$/.test(g)).map(Number);
    const students = groups.flatMap((g) => g.class ? g.students || [] : g.uids || []);
    if (!tdoc.assign?.length) {
        const statuses = await contest.getMultiStatus(domainId, {
            docId: tdoc.docId, $or: [{ attend: true }, { attend: { $gt: 0 } }],
        }).project({ uid: 1 }).toArray();
        students.push(...statuses.map((s) => s.uid));
    }
    const roster = [...new Set([...students, ...explicit])].filter((uid) => uid > 0 && !teachers.has(uid));
    return {
        tdoc, roster, manager,
        scope: { domainId, activityType, activityId },
        actor: { domainId, operatorUid: handler.user._id },
    };
}

export async function feedbackSubmission(domainId: string, input: Pick<FeedbackInput, 'studentUid' | 'pid' | 'activityId' | 'rid'>) {
    if (!input.rid) return;
    const rdoc = await record.get(domainId, new ObjectId(input.rid));
    if (!rdoc || rdoc.uid !== input.studentUid || rdoc.pid !== input.pid || rdoc.contest?.toHexString() !== input.activityId) {
        throw new ForbiddenError('Submission does not belong to this student, problem and activity');
    }
}

export async function authorizeFeedback(activity: Awaited<ReturnType<typeof feedbackActivity>>, input: FeedbackInput) {
    const { tdoc, roster, scope } = activity;
    if (input.activityType !== scope.activityType || input.activityId !== scope.activityId) throw new ForbiddenError();
    if (!roster.includes(input.studentUid)) throw new ForbiddenError('Student is not in the activity roster');
    const pdoc = await problem.get(scope.domainId, input.pid);
    if (!tdoc.pids.includes(input.pid) || !pdoc
        || !await user.getById(scope.domainId, input.studentUid)) throw new ForbiddenError();
    if (tdoc.rule === 'course') {
        const nodes = (tdoc.dag || []).filter((node) => node.pids.includes(input.pid));
        if ((input.nodeId !== undefined && !nodes.some((node) => node._id === input.nodeId))
            || (input.nodeId === undefined && nodes.length > 1)) throw new FeedbackValidationError('nodeId');
    }
    await feedbackSubmission(scope.domainId, input);
    const node = tdoc.rule === 'course' ? (tdoc.dag || []).find((n) => n.pids.includes(input.pid)
        && (input.nodeId === undefined || n._id === input.nodeId)) : undefined;
    return { courseTitle: tdoc.title, problemTitle: pdoc.title,
        ...(node ? { lessonTitle: node.title, nodeId: node._id } : {}) };
}
