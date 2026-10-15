import { createHash } from 'crypto';
import { ObjectId } from 'mongodb';
import { ContestNotLiveError, InvalidTokenError, PermissionError } from '../error';
import type { RecordDoc, Tdoc, User } from '../interface';
import { assertCourseAssessmentAccess } from './course-assessment-access';
import { PERM, STATUS } from '../model/builtin';
import * as contest from '../model/contest';
import record from '../model/record';
import db from '../service/db';

interface PracticeAccessDoc {
    domainId: string;
    tid: ObjectId;
    uid: number;
    codeHash: string;
}

declare module '../service/db' {
    interface Collections {
        'contest.practiceAccess': PracticeAccessDoc;
    }
}

export function supportsPractice(tdoc: Tdoc) {
    return !!tdoc && !['course', 'homework'].includes(tdoc.rule) && !!contest.RULES[tdoc.rule] && !contest.RULES[tdoc.rule].hidden;
}

export function isPracticeOpen(tdoc: Tdoc) {
    // Classroom tests default to practice, including existing tests without this setting.
    // Ordinary contests keep their explicit opt-in behavior.
    return supportsPractice(tdoc) && contest.isDone(tdoc)
        && (tdoc.sourceType === 'course_assessment' ? tdoc.allowPractice !== false : tdoc.allowPractice === true);
}

export function canManagePractice(user: User, tdoc: Tdoc, parentCourseTeacher = false) {
    // The child contest's owner/maintainer fields are only synchronized copies.
    // Never use them to grant classroom management rights after a course role changes.
    if (tdoc.sourceType === 'course_assessment') return parentCourseTeacher;
    return user.own(tdoc) || user.hasPerm(PERM.PERM_EDIT_CONTEST);
}

export function canReadPractice(user: User, tdoc: Tdoc, uid: number, parentCourseTeacher = false) {
    if (!supportsPractice(tdoc) || user._id <= 0) return false;
    const manager = canManagePractice(user, tdoc, parentCourseTeacher);
    if (tdoc.sourceType === 'course_assessment') {
        // Caller must have validated the live parent-course enrollment and node grant.
        // The child contest's stale assign or standalone contest perms are not authorities.
        return (manager || (user.hasPerm(PERM.PERM_VIEW_HOMEWORK) && user.hasPerm(PERM.PERM_VIEW_PROBLEM)))
            && (uid === user._id || manager);
    }
    return user.hasPerm(PERM.PERM_VIEW_CONTEST) && user.hasPerm(PERM.PERM_VIEW_PROBLEM)
        && (manager || contest.canAccessAssignedContest(user, tdoc)) && (uid === user._id || manager);
}

function codeHash(tdoc: Tdoc) {
    return createHash('sha256').update(tdoc._code || '').digest('hex');
}

async function hasInvitationAccess(user: User, tdoc: Tdoc, parentCourseTeacher = false) {
    if (!tdoc._code || canManagePractice(user, tdoc, parentCourseTeacher)) return true;
    const status = await contest.getStatus(tdoc.domainId, tdoc.docId, user._id);
    if (status?.attend) return true;
    if (tdoc.allowTeam) {
        const vid = await contest.getTeamVid(tdoc.domainId, tdoc.docId, user._id);
        if (vid && (await contest.getStatus(tdoc.domainId, tdoc.docId, vid))?.attend) return true;
    }
    return !!await db.collection('contest.practiceAccess').findOne({
        domainId: tdoc.domainId, tid: tdoc.docId, uid: user._id, codeHash: codeHash(tdoc),
    });
}

export async function canSubmitPractice(user: User, tdoc: Tdoc) {
    const parentCourseTeacher = await assertCourseAssessmentAccess(user, tdoc);
    return isPracticeOpen(tdoc) && canReadPractice(user, tdoc, user._id, parentCourseTeacher)
        && user.hasPerm(PERM.PERM_SUBMIT_PROBLEM) && await hasInvitationAccess(user, tdoc, parentCourseTeacher);
}

export async function grantPracticeAccess(user: User, tdoc: Tdoc, code: string) {
    const parentCourseTeacher = await assertCourseAssessmentAccess(user, tdoc);
    if (!isPracticeOpen(tdoc)) throw new ContestNotLiveError(tdoc.docId);
    if (!canReadPractice(user, tdoc, user._id, parentCourseTeacher) || !user.hasPerm(PERM.PERM_SUBMIT_PROBLEM)) {
        throw new PermissionError(PERM.PERM_SUBMIT_PROBLEM);
    }
    if (await hasInvitationAccess(user, tdoc, parentCourseTeacher)) return;
    if (code !== tdoc._code) throw new InvalidTokenError('Contest Invitation');
    await db.collection('contest.practiceAccess').updateOne(
        { domainId: tdoc.domainId, tid: tdoc.docId, uid: user._id },
        { $set: { codeHash: codeHash(tdoc) } }, { upsert: true },
    );
}

export async function getPracticeResults(domainId: string, tid: ObjectId, uid: number, pids: number[]) {
    const pending = [STATUS.STATUS_WAITING, STATUS.STATUS_FETCHED, STATUS.STATUS_COMPILING, STATUS.STATUS_JUDGING];
    // Recompute from records so rejudging cannot leave a stale accepted result.
    const rows = await record.coll.aggregate<RecordDoc>([
        { $match: { domainId, practiceContest: tid, uid, pid: { $in: pids } } },
        { $set: {
            _completed: { $cond: [{ $in: ['$status', pending] }, 0, 1] },
            _accepted: { $cond: [{ $eq: ['$status', STATUS.STATUS_ACCEPTED] }, 1, 0] },
        } },
        { $sort: { _completed: -1, _accepted: -1, score: -1, _id: -1 } },
        { $group: { _id: '$pid', result: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$result' } },
        { $project: { _completed: 0, _accepted: 0, code: 0, files: 0, testCases: 0, compilerTexts: 0, judgeTexts: 0 } },
    ]).toArray();
    return Object.fromEntries(rows.map((rdoc) => [rdoc.pid, { rid: rdoc._id, status: rdoc.status, score: rdoc.score }]));
}
