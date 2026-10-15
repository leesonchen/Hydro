import {
    omit, pick, throttle, uniqBy,
} from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import {
    ContestNotFoundError, HackRejudgeFailedError,
    PermissionError, PretestRejudgeFailedError, ProblemConfigError,
    ProblemNotFoundError, RecordNotFoundError, UserNotFoundError,
} from '../error';
import { ContestStatusDoc, RecordDoc, Tdoc, User } from '../interface';
import { canManageFeedback } from '../lib/classroomFeedbackAccess';
import { canManagePractice, canReadPractice, canSubmitPractice } from '../lib/contest-practice';
import { assertCourseAssessmentAccess, canShowClassroomSelfRecord } from '../lib/course-assessment-access';
import { PERM, PRIV, STATUS } from '../model/builtin';
import * as contest from '../model/contest';
import domain from '../model/domain';
import problem, { ProblemDoc } from '../model/problem';
import record from '../model/record';
import { langs } from '../model/setting';
import storage from '../model/storage';
import system from '../model/system';
import TaskModel from '../model/task';
import user from '../model/user';
import {
    ConnectionHandler, param, subscribe, Types,
} from '../service/server';
import { buildProjection, Time } from '../utils';
import { ContestDetailBaseHandler } from './contest';
import { postJudge } from './judge';

/** Shared by HTTP reads and live delivery, after resolving the record's activity. */
async function assertRecordActivityAccess(viewer: User, tdoc: Tdoc, rdoc: RecordDoc, requireManager = false) {
    if (!tdoc) throw new ContestNotFoundError(rdoc.domainId, rdoc.practiceContest || rdoc.contest);
    const classroomManager = await assertCourseAssessmentAccess(viewer, tdoc);
    if (tdoc.sourceType === 'course_assessment') {
        if (!classroomManager && (requireManager || rdoc.uid !== viewer._id
            || (!rdoc.practiceContest && rdoc.contest?.toString() === tdoc.docId.toString()
                && !canShowClassroomSelfRecord(tdoc)))) throw new PermissionError(PERM.PERM_VIEW_RECORD);
    }
    if (rdoc.practiceContest && (!canReadPractice(viewer, tdoc, rdoc.uid, classroomManager)
        || (requireManager && !canManagePractice(viewer, tdoc, classroomManager)))) throw new PermissionError(PERM.PERM_VIEW_RECORD);
    return classroomManager;
}

export class RecordListHandler extends ContestDetailBaseHandler {
    @param('page', Types.PositiveInt, true)
    @param('pid', Types.ProblemId, true)
    @param('tid', Types.ObjectId, true)
    @param('uidOrName', Types.UidOrName, true)
    @param('lang', Types.String, true)
    @param('status', Types.Int, true)
    @param('fullStatus', Types.Boolean)
    @param('all', Types.Boolean)
    @param('allDomain', Types.Boolean)
    @param('stat', Types.Boolean)
    @param('practice', Types.Boolean)
    async get(
        domainId: string, page = 1, pid?: string | number, tid?: ObjectId,
        uidOrName?: string, lang?: string, status?: number, full = false,
        all = false, allDomain = false, stat = false,
        practice = false,
    ) {
        const notification = [];
        let tdoc = null;
        let invalid = false;
        this.response.template = 'record_main.html';
        if (practice && (!tid || all || allDomain)) throw new PermissionError(PERM.PERM_VIEW_RECORD);
        const q: Filter<RecordDoc> = practice
            ? { practiceContest: tid } : { contest: tid, practiceContest: { $exists: false } };
        if (full) uidOrName = this.user._id.toString();
        if (uidOrName) {
            const udoc = await user.getById(domainId, +uidOrName)
                || await user.getByUname(domainId, uidOrName)
                || await user.getByEmail(domainId, uidOrName);
            if (udoc) q.uid = udoc._id;
            else invalid = true;
        }
        // Team: a member viewing the contest record list sees the whole team's submissions.
        let teamMembers: number[] | null = null;
        if (!practice && tid && this.team && (q.uid === undefined || q.uid === this.user._id)) {
            // this.tsdoc is already the team vuser's tsdoc (swapped in __prepare); no extra DB fetch needed
            teamMembers = this.tsdoc?.members?.length ? this.tsdoc.members : null;
        }
        const viewingTeammate = !!(tid && this.team && typeof q.uid === 'number'
            && this.tsdoc?.members?.includes(q.uid));
        if (!tid && !practice && q.uid !== this.user._id && !teamMembers && !viewingTeammate) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        let classroomManager = false;
        if (tid) {
            tdoc = await contest.get(domainId, tid);
            this.tdoc = tdoc;
            if (!tdoc) throw new ContestNotFoundError(domainId, pid);
            if (tdoc.sourceType === 'course_assessment') {
                // Global record-list flags remove the contest predicate. A teacher's
                // course-scoped grant must never authorize records in other activities.
                if (all || allDomain) throw new PermissionError(PERM.PERM_VIEW_RECORD);
                classroomManager = await assertCourseAssessmentAccess(this.user, tdoc);
                if (!practice && !classroomManager) {
                    if (q.uid !== undefined && q.uid !== this.user._id) throw new PermissionError(PERM.PERM_VIEW_RECORD);
                    q.uid = this.user._id;
                    uidOrName = this.user._id.toString();
                }
            } else if (!practice && q.uid !== this.user._id && !teamMembers && !viewingTeammate) {
                this.checkPerm(PERM.PERM_VIEW_RECORD);
            }
            if (practice) {
                if (tdoc.sourceType === 'course_assessment') await assertCourseAssessmentAccess(this.user, tdoc);
                if (!canManagePractice(this.user, tdoc, classroomManager) && q.uid === undefined) {
                    q.uid = this.user._id;
                    uidOrName = this.user._id.toString();
                }
                if (!canReadPractice(this.user, tdoc, typeof q.uid === 'number' ? q.uid : this.user._id, classroomManager)) {
                    throw new PermissionError(PERM.PERM_VIEW_RECORD);
                }
            }
            if (!practice && tdoc.sourceType !== 'course_assessment'
                && !contest.canShowScoreboard.call(this, tdoc, true)) throw new PermissionError(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
            const viewingSelf = q.uid === this.user._id || !!teamMembers || viewingTeammate;
            if (!practice && !(tdoc.sourceType === 'course_assessment'
                ? (classroomManager || canShowClassroomSelfRecord(tdoc))
                : contest[viewingSelf ? 'canShowSelfRecord' : 'canShowRecord'].call(this, tdoc, true))) {
                throw new PermissionError(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
            }
            if (!practice && !classroomManager && !this.team
                && !(await contest.getStatus(domainId, tid, this.user._id))?.attend) {
                const name = tdoc.rule === 'homework'
                    ? "You haven't claimed this homework yet."
                    : "You haven't attended this contest yet.";
                notification.push({ name, args: { type: 'note' }, checker: () => true });
            }
        }
        if (pid) {
            if (typeof pid === 'string' && tdoc && /^[A-Z]$/.test(pid)) {
                pid = tdoc.pids[Number.parseInt(pid, 36) - 10];
            }
            const pdoc = await problem.get(domainId, pid);
            if (pdoc) q.pid = pdoc.docId;
            else invalid = true;
        }
        if (lang) q.lang = lang;
        if (typeof status === 'number') q.status = status;
        if (all) {
            this.checkPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
            this.checkPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD);
            delete q.contest;
        }
        if (allDomain) {
            this.checkPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN);
            delete q.contest;
            q._id = { $gt: Time.getObjectID(new Date(Date.now() - 10 * Time.week)) };
        }
        if (teamMembers && !all && !allDomain) q.uid = { $in: teamMembers };
        let cursor = record.getMulti(allDomain ? '' : domainId, q).sort('_id', -1);
        if (!full) cursor = cursor.project(buildProjection(record.PROJECTION_LIST));
        const limit = full ? 10 : system.get('pagination.record');
        let rdocs = invalid
            ? [] as RecordDoc[]
            : await cursor.skip((page - 1) * limit).limit(limit).toArray();
        const recordPageHasRows = rdocs.length > 0;
        if (all || allDomain) {
            // Global contest permissions do not grant access to classroom records.
            const activities = new Map<string, Promise<Tdoc>>();
            const visible = await Promise.all(rdocs.map(async (rdoc) => {
                if (!rdoc.contest || rdoc.contest.toString().startsWith('0'.repeat(23))) return rdoc;
                const key = `${rdoc.domainId}/${rdoc.contest}`;
                try {
                    if (!activities.has(key)) activities.set(key, contest.get(rdoc.domainId, rdoc.contest));
                    const activity = await activities.get(key);
                    if (activity?.sourceType !== 'course_assessment') return rdoc;
                    // Cross-domain privileges do not carry this domain's course role.
                    const viewer = rdoc.domainId === domainId ? this.user : await user.getById(rdoc.domainId, this.user._id, this.user.scope);
                    const manager = await assertRecordActivityAccess(viewer, activity, rdoc);
                    return manager ? rdoc : contest.applyProjection(activity, { ...rdoc }, viewer);
                } catch {
                    return null;
                }
            }));
            rdocs = visible.filter((rdoc) => rdoc !== null);
        }
        const canViewHiddenProblem = this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN) || this.user._id;
        const [udict, pdict] = full ? [{}, {}]
            : await Promise.all([
                user.getList(domainId, rdocs.map((rdoc) => rdoc.uid)),
                tid
                    ? problem.getList(domainId, rdocs.map((rdoc) => rdoc.pid), true, false, problem.PROJECTION_CONTEST_LIST)
                    : this.user.hasPerm(PERM.PERM_VIEW_PROBLEM)
                        ? problem.getList(domainId, rdocs.map((rdoc) => rdoc.pid), canViewHiddenProblem, false, problem.PROJECTION_LIST)
                        : Object.fromEntries(uniqBy(rdocs, 'pid').map((rdoc) => [rdoc.pid, { ...problem.default, pid: rdoc.pid }])),
            ]);
        if (!practice && this.tdoc && (this.tdoc.sourceType === 'course_assessment'
            ? !classroomManager : !this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST))) {
            rdocs = rdocs.map((i) => contest.applyProjection(tdoc, i, this.user));
        }
        this.response.body = {
            page,
            rdocs,
            recordPageHasRows,
            tdoc,
            pdict,
            udict,
            all,
            allDomain,
            practice,
            filterPid: pid,
            filterTid: tid,
            filterUidOrName: uidOrName,
            filterLang: lang,
            filterStatus: status,
            notification,
        };
        if (this.user.hasPriv(PRIV.PRIV_VIEW_JUDGE_STATISTICS) && stat) {
            this.response.body.statistics = await record.stat(allDomain ? undefined : domainId);
        }
    }
}

export class RecordDetailHandler extends ContestDetailBaseHandler {
    rdoc: RecordDoc;

    @param('rid', Types.ObjectId)
    async prepare(domainId: string, rid: ObjectId) {
        this.rdoc = await record.get(domainId, rid);
        if (!this.rdoc) throw new RecordNotFoundError(rid);
        let classroomManager = false;
        if (this.rdoc.practiceContest) {
            this.tdoc = await contest.get(domainId, this.rdoc.practiceContest);
            classroomManager = await assertRecordActivityAccess(this.user, this.tdoc, this.rdoc);
            this.classroomTeacher = classroomManager;
            if (!canReadPractice(this.user, this.tdoc, this.rdoc.uid, classroomManager)) throw new PermissionError(PERM.PERM_VIEW_RECORD);
            this.args.tid = this.tdoc.docId;
            this.practiceReady = await canSubmitPractice(this.user, this.tdoc);
            return;
        }
        if (this.rdoc.contest && !this.rdoc.contest.toString().startsWith('0'.repeat(23))) {
            const exam = await contest.get(domainId, this.rdoc.contest);
            if (!exam) throw new ContestNotFoundError(domainId, this.rdoc.contest);
            if (exam?.sourceType === 'course_assessment') {
                classroomManager = await assertRecordActivityAccess(this.user, exam, this.rdoc);
                this.classroomTeacher = classroomManager;
            }
        }
        if (!classroomManager && !(await contest.isOwnOrTeammateRecord(domainId, this.rdoc, this.user._id))) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
    }

    async download() {
        for (const file of ['code', 'hack']) {
            if (!this.rdoc.files?.[file]) continue;
            const [id, filename] = this.rdoc.files?.[file]?.split('#') || [];
            // eslint-disable-next-line no-await-in-loop
            this.response.redirect = await storage.signDownloadLink(`submission/${id}`, filename || file, true, 'user');
            return;
        }
        const lang = langs[this.rdoc.lang]?.pretest || this.rdoc.lang;
        this.response.body = this.rdoc.code;
        this.response.type = 'text/plain';
        this.response.disposition = `attachment; filename="${langs[lang]?.code_file || `foo.${this.rdoc.lang}`}"`;
    }

    @param('rid', Types.ObjectId)
    @param('download', Types.Boolean)
    @param('rev', Types.ObjectId, true)
    // eslint-disable-next-line consistent-return
    async get(domainId: string, rid: ObjectId, download = false, rev?: ObjectId) {
        let rdoc = this.rdoc;
        const allRev = await record.collHistory.find({ rid })
            .project({ _id: 1, judgeAt: 1 }).sort({ _id: -1 }).toArray();
        const allRevs: Record<string, Date> = Object.fromEntries(allRev.map((i) => [i._id.toString(), i.judgeAt]));
        if (rev && allRevs[rev.toString()]) {
            rdoc = { ...rdoc, ...omit(await record.collHistory.findOne({ _id: rev }), ['_id']), progress: null };
        }
        const isOwnOrTeammate = await contest.isOwnOrTeammateRecord(domainId, rdoc, this.user._id);
        let canViewDetail = true;
        let classroomManager = false;
        if (rdoc.practiceContest) {
            if (this.tdoc.sourceType === 'course_assessment') {
                classroomManager = await assertCourseAssessmentAccess(this.user, this.tdoc);
            }
            if (!canReadPractice(this.user, this.tdoc, rdoc.uid, classroomManager)) {
                throw new PermissionError(PERM.PERM_VIEW_RECORD);
            }
        } else if (rdoc.contest?.toString().startsWith('0'.repeat(23))) {
            if (rdoc.uid !== this.user._id) throw new PermissionError(PERM.PERM_READ_RECORD_CODE);
        } else if (rdoc.contest) {
            this.tdoc = await contest.get(domainId, rdoc.contest);
            if (this.tdoc.sourceType === 'course_assessment') {
                classroomManager = await assertCourseAssessmentAccess(this.user, this.tdoc);
                if (!classroomManager && !isOwnOrTeammate) throw new PermissionError(PERM.PERM_VIEW_RECORD);
            }
            let canView = classroomManager || (this.tdoc.sourceType !== 'course_assessment' && this.user.own(this.tdoc));
            if (this.tdoc.sourceType === 'course_assessment') {
                canView ||= canShowClassroomSelfRecord(this.tdoc) && isOwnOrTeammate;
            } else {
                canView ||= contest.canShowRecord.call(this, this.tdoc);
                canView ||= contest.canShowSelfRecord.call(this, this.tdoc, true) && isOwnOrTeammate;
            }
            if (!canView) throw new PermissionError(rid);
            canViewDetail = canView;
            this.args.tid = this.tdoc.docId;
            if (this.tdoc.sourceType === 'course_assessment'
                ? !classroomManager : !this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) {
                rdoc = contest.applyProjection(this.tdoc, { ...rdoc }, this.user);
                this.rdoc = rdoc;
            }
        }

        // eslint-disable-next-line prefer-const
        let [pdoc, self, udoc] = await Promise.all([
            problem.get(rdoc.domainId, rdoc.pid, problem.PROJECTION_LIST.concat('config')),
            problem.getVisibleStatus(
                domainId, rdoc.pid, this.user._id,
                (tdoc, uid) => contest.canShowProblemStatus(this.user, uid, tdoc),
            ),
            user.getById(domainId, rdoc.uid),
        ]);

        let canViewCode = isOwnOrTeammate;
        canViewCode ||= this.user.hasPriv(PRIV.PRIV_READ_RECORD_CODE);
        canViewCode ||= this.user.hasPerm(PERM.PERM_READ_RECORD_CODE);
        canViewCode ||= this.user.hasPerm(PERM.PERM_READ_RECORD_CODE_ACCEPT) && self?.status === STATUS.STATUS_ACCEPTED;
        if (this.tdoc) {
            const teamVid = this.tdoc.allowTeam ? await contest.getTeamVid(domainId, this.tdoc.docId, this.user._id) : null;
            this.tsdoc = await contest.getStatus(domainId, this.tdoc.docId, teamVid ?? this.user._id);
            canViewCode ||= classroomManager || (this.tdoc.sourceType !== 'course_assessment' && this.user.own(this.tdoc));
            if (rdoc.practiceContest) canViewCode ||= canManagePractice(this.user, this.tdoc, classroomManager);
            if (this.tdoc.allowViewCode && contest.isDone(this.tdoc)) {
                canViewCode ||= !!this.tsdoc?.attend;
            }
            if (!rdoc.practiceContest && !classroomManager && !this.tsdoc?.attend && pdoc && !problem.canViewBy(pdoc, this.user)) {
                throw new PermissionError(PERM.PERM_VIEW_PROBLEM_HIDDEN);
            }
        } else if (pdoc && !problem.canViewBy(pdoc, this.user)) throw new PermissionError(PERM.PERM_VIEW_PROBLEM_HIDDEN);
        if (!canViewCode) {
            rdoc.code = '';
            rdoc.files = {};
            rdoc.compilerTexts = [];
        } else if (download) return await this.download();
        let submissionHistory: RecordDoc[] = [];
        let submissionHistoryCount = 0;
        const isActiveContest = this.tdoc
            && !rdoc.practiceContest
            && !['homework', 'course'].includes(this.tdoc.rule)
            && !contest.isDone(this.tdoc);
        const canShowSubmissionHistory = canViewDetail && !isActiveContest;
        if (canShowSubmissionHistory) {
            const submissionHistoryFilter: Filter<RecordDoc> = {
                uid: rdoc.uid,
                pid: rdoc.pid,
                'files.hack': { $exists: false },
                contest: rdoc.contest || { $exists: false },
                practiceContest: rdoc.practiceContest || { $exists: false },
            };
            [submissionHistory, submissionHistoryCount] = await Promise.all([
                record.getMulti(domainId, submissionHistoryFilter)
                    .project<RecordDoc>(buildProjection(['_id', 'domainId', 'status', 'score']))
                    .sort({ _id: -1 }).limit(20).toArray(),
                record.count(domainId, submissionHistoryFilter),
            ]);
        }
        this.response.template = 'record_detail.html';
        this.response.body = {
            udoc,
            rdoc: canViewDetail ? rdoc : pick(rdoc, ['_id', 'lang', 'code']),
            pdoc,
            tdoc: this.tdoc,
            feedbackUrl: await canManageFeedback(this, this.tdoc)
                ? this.url(`${this.tdoc.rule}_feedback`, {
                    tid: this.tdoc.docId, query: { studentUid: rdoc.uid, pid: rdoc.pid, rid: rdoc._id },
                }) : null,
            rev,
            allRevs,
            submissionHistory,
            submissionHistoryCount,
        };
    }

    @param('rid', Types.ObjectId)
    async post() {
        this.checkPerm(PERM.PERM_REJUDGE);
        if (this.rdoc.files?.hack) throw new HackRejudgeFailedError();
        if (this.rdoc.contest?.toString().startsWith('0'.repeat(23))) throw new PretestRejudgeFailedError();
    }

    @param('rid', Types.ObjectId)
    async postRejudge(domainId: string, rid: ObjectId) {
        const pdoc = await problem.get(domainId, this.rdoc.pid);
        if (!pdoc?.config || typeof pdoc.config === 'string') throw new ProblemConfigError();
        const priority = await record.submissionPriority(this.user._id, -20);
        const rdoc = await record.reset(domainId, rid, true);
        this.ctx.broadcast('record/change', rdoc);
        await record.judge(domainId, rid, priority, this.rdoc.contest ? { detail: false } : {});
        this.back();
    }

    @param('rid', Types.ObjectId)
    async postCancel(domainId: string, rid: ObjectId) {
        const $set = {
            status: STATUS.STATUS_CANCELED,
            score: 0,
            time: 0,
            memory: 0,
            testCases: [{
                id: 0, subtaskId: 0, status: 9, score: 0, time: 0, memory: 0, message: 'score canceled',
            }],
            subtasks: {},
        };
        const [latest] = await Promise.all([
            record.update(domainId, rid, $set),
            TaskModel.deleteMany({ rid: this.rdoc._id }),
        ]);
        if (latest) {
            this.ctx.broadcast('record/change', latest);
            await postJudge(latest);
        }
        this.back();
    }
}

interface LiveRecordAccess {
    viewer: User;
    tdoc: Tdoc;
    classroomManager: boolean;
}

function recordVisibility(access?: LiveRecordAccess | false) {
    return access && access.tdoc.sourceType === 'course_assessment'
        ? JSON.stringify(pick(access.tdoc, ['rule', 'beginAt', 'endAt', 'lockAt', 'unlocked', 'keepScoreboardHidden'])) : '';
}

async function checkPracticeAccess(
    handler: RecordMainConnectionHandler | RecordDetailConnectionHandler, rdoc: RecordDoc, requireManager = false,
): Promise<LiveRecordAccess | false> {
    if (handler.practiceStopped) return false;
    try {
        const [udoc, tdoc] = await Promise.all([
            user.coll.findOne({ _id: handler.user._id }),
            contest.get(rdoc.domainId, !rdoc.practiceContest && rdoc.contest?.toString() === '0'.repeat(24)
            && handler.tdoc?.sourceType === 'course_assessment'
                ? handler.tdoc.docId : rdoc.practiceContest || rdoc.contest),
        ]);
        let viewer: User;
        if (udoc && (udoc.priv & PRIV.PRIV_USER_PROFILE)) {
            const [dudoc, groups] = await Promise.all([
                domain.getDomainUser(rdoc.domainId, udoc),
                user.listGroup(rdoc.domainId, udoc._id),
            ]);
            dudoc.group = groups.map((group) => group.name);
            // getById caches User instances and can discard the connection's scope.
            viewer = await new user.User(udoc, dudoc, handler.user.scope).init();
        }
        if (handler.practiceStopped) return false;
        if (viewer) {
            // A connection opened as a course teacher must close on demotion,
            // including when its original payload contained unprojected own records.
            if (tdoc?.sourceType === 'course_assessment') {
                const classroomManager = await assertRecordActivityAccess(viewer, tdoc, rdoc, requireManager || handler.classroomManager);
                return { viewer, classroomManager, tdoc };
            }
            if (canReadPractice(viewer, tdoc, rdoc.uid)
                && (!requireManager || canManagePractice(viewer, tdoc))) return { viewer, classroomManager: false, tdoc };
        }
    } catch (error) {
        // A global stream has no grant to this particular classroom. Skip that
        // activity without interrupting unrelated ordinary contest updates.
        if ('tid' in handler && (!handler.tid || handler.all || handler.allDomain) && !handler.practice) return false;
        if (!handler.practiceStopped) {
            handler.cleanup();
            await handler.onerror(error);
        }
        return false;
    }
    handler.cleanup();
    handler.close(4003, 'Permission revoked');
    return false;
}

export class RecordMainConnectionHandler extends ConnectionHandler {
    all = false;
    allDomain = false;
    tid: string;
    uid: number;
    pid: number;
    status: number;
    pretest = false;
    practice = false;
    tdoc: Tdoc;
    teamMembers?: number[];
    applyProjection = false;
    noTemplate = false;
    queue: Map<string, () => Promise<any>> = new Map();
    throttleQueueClear: ReturnType<typeof throttle>;
    practiceStopped = false;
    classroomManager = false;

    @param('tid', Types.ObjectId, true)
    @param('pid', Types.ProblemId, true)
    @param('uidOrName', Types.UidOrName, true)
    @param('status', Types.Int, true)
    @param('pretest', Types.Boolean)
    @param('all', Types.Boolean)
    @param('allDomain', Types.Boolean)
    @param('noTemplate', Types.Boolean, true)
    @param('practice', Types.Boolean)
    async prepare(
        domainId: string, tid?: ObjectId, pid?: string | number, uidOrName?: string,
        status?: number, pretest = false, all = false, allDomain = false, noTemplate = false,
        practice = false,
    ) {
        if (practice && (!tid || pretest || all || allDomain)) throw new PermissionError(PERM.PERM_VIEW_RECORD);
        this.practice = practice;
        if (tid) {
            this.tdoc = await contest.get(domainId, tid);
            if (!this.tdoc) throw new ContestNotFoundError(domainId, tid);
            if (this.tdoc.sourceType === 'course_assessment') {
                if (all || allDomain) throw new PermissionError(PERM.PERM_VIEW_RECORD);
                this.classroomManager = await assertCourseAssessmentAccess(this.user, this.tdoc);
                if (!practice && !pretest && !this.classroomManager
                    && !canShowClassroomSelfRecord(this.tdoc)) {
                    throw new PermissionError(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
                }
            } else if (!practice && !pretest
                && !contest.canShowRecord.call(this, this.tdoc, true)
                && !contest.canShowSelfRecord.call(this, this.tdoc, true)) {
                throw new PermissionError(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
            }
            if (practice || pretest || this.tdoc.sourceType === 'course_assessment'
                || contest.canShowScoreboard.call(this, this.tdoc, true)) this.tid = tid.toHexString();
            else throw new PermissionError(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
            if (!practice && (this.tdoc.sourceType === 'course_assessment'
                ? !this.classroomManager : !this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST))) {
                this.applyProjection = true;
            }
        }
        if (pretest) {
            this.pretest = true;
            this.uid = this.user._id;
        } else if (uidOrName) {
            let udoc = await user.getById(domainId, +uidOrName);
            if (udoc) this.uid = udoc._id;
            else {
                udoc = await user.getByUname(domainId, uidOrName);
                if (udoc) this.uid = udoc._id;
                else throw new UserNotFoundError(uidOrName);
            }
        }
        if (!practice && this.tdoc?.allowTeam && !pretest && !all && !allDomain && (this.uid === undefined || this.uid === this.user._id)) {
            const teamVid = await contest.getTeamVid(domainId, this.tdoc.docId, this.user._id);
            if (teamVid) {
                const tsdoc = await contest.getStatus(domainId, this.tdoc.docId, teamVid);
                this.teamMembers = tsdoc?.members?.length ? tsdoc.members : undefined;
            }
        }
        if (practice) {
            if (this.tdoc.sourceType === 'course_assessment') await assertCourseAssessmentAccess(this.user, this.tdoc);
            if (!canManagePractice(this.user, this.tdoc, this.classroomManager) && this.uid === undefined) {
                this.uid = this.user._id;
            }
            if (!canReadPractice(this.user, this.tdoc, this.uid ?? this.user._id, this.classroomManager)) {
                throw new PermissionError(PERM.PERM_VIEW_RECORD);
            }
        }
        if (!practice && !pretest && this.tdoc?.sourceType === 'course_assessment'
            && !this.classroomManager) {
            if (this.uid !== undefined && this.uid !== this.user._id) {
                throw new PermissionError(PERM.PERM_VIEW_RECORD);
            }
            this.uid = this.user._id;
        }
        if (!practice && !this.classroomManager && this.uid !== this.user._id && !this.teamMembers) {
            const sameTeam = this.tdoc?.allowTeam && typeof this.uid === 'number'
                && await contest.isSameTeam(domainId, this.tdoc.docId, this.uid, this.user._id);
            if (!sameTeam) this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        if (pid) {
            const pdoc = await problem.get(domainId, pid);
            if (pdoc) this.pid = pdoc.docId;
            else throw new ProblemNotFoundError(domainId, pid);
        }
        if (status) this.status = status;
        if (all) {
            this.checkPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
            this.checkPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD);
            this.all = true;
        }
        if (allDomain) {
            this.checkPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN);
            this.allDomain = true;
        }
        this.noTemplate = noTemplate;
        this.throttleQueueClear = throttle(this.queueClear, 100, { trailing: true });
    }

    async message(msg: { rids: string[] }) {
        if (!(msg.rids instanceof Array)) return;
        const rids = msg.rids.map((id) => new ObjectId(id));
        const rdocs = await record.getMulti(this.args.domainId, { _id: { $in: rids } })
            .project<RecordDoc>(buildProjection(record.PROJECTION_LIST)).toArray();
        await Promise.all(rdocs.map((rdoc) => this.onRecordChange(rdoc)));
    }

    @subscribe('record/change')
    async onRecordChange(rdoc: RecordDoc) {
        if (this.practiceStopped) return;
        if (rdoc.practiceContest) {
            if (!this.practice || rdoc.domainId !== this.args.domainId || rdoc.practiceContest.toHexString() !== this.tid) return;
        } else if (this.practice) return;
        if (this.tdoc?.sourceType === 'course_assessment' && !rdoc.practiceContest
            && rdoc.contest?.toString() !== this.tid) {
            // Pretests carry no activity grant. Only an explicit pretest stream
            // may receive the viewer's own runs for questions in this test.
            if (!this.pretest || rdoc.contest?.toString() !== '0'.repeat(24)
                || rdoc.uid !== this.user._id || !this.tdoc.pids.includes(rdoc.pid)) return;
        }
        if (rdoc.contest?.toString() === '0'.repeat(24) && rdoc.uid !== this.user._id) return;
        if (!this.allDomain) {
            if (rdoc.domainId !== this.args.domainId) return;
            if (!this.pretest && typeof rdoc.input === 'string') return;
            if (!this.all && !this.practice) {
                if (!rdoc.contest && this.tid) return;
                if (rdoc.contest && ![this.tid, '000000000000000000000000'].includes(rdoc.contest.toString())) return;
                if (this.tid && rdoc.contest?.toString() !== '0'.repeat(24)) {
                    const own = await contest.isOwnOrTeammateRecord(this.args.domainId, rdoc, this.user._id);
                    if (!own && !this.classroomManager && !contest.canShowRecord.call(this, this.tdoc, true)) return;
                    if (own && !this.classroomManager
                        && !(this.tdoc?.sourceType === 'course_assessment'
                            ? canShowClassroomSelfRecord(this.tdoc)
                            : contest.canShowSelfRecord.call(this, this.tdoc, true))) return;
                }
            }
        }
        if (typeof this.pid === 'number' && rdoc.pid !== this.pid) return;
        if (this.teamMembers) {
            if (!this.teamMembers.includes(rdoc.uid)) return;
        } else if (typeof this.uid === 'number' && rdoc.uid !== this.uid) return;
        let activity: Tdoc;
        if (!rdoc.practiceContest && rdoc.contest && !rdoc.contest.toString().startsWith('0'.repeat(23))) {
            try {
                activity = rdoc.contest.toString() === this.tid ? this.tdoc : await contest.get(rdoc.domainId, rdoc.contest);
            } catch (error) {
                if (error instanceof ContestNotFoundError) return;
                throw error;
            }
        }
        const liveAccess = !!rdoc.practiceContest || activity?.sourceType === 'course_assessment'
            || this.tdoc?.sourceType === 'course_assessment';
        const access = liveAccess ? await checkPracticeAccess(this, rdoc, this.uid === undefined) : null;
        if (liveAccess && !access) return;

        let [udoc, pdoc] = await Promise.all([
            user.getById(this.args.domainId, rdoc.uid),
            problem.get(rdoc.domainId, rdoc.pid),
        ]);
        const tdoc = access && access.tdoc.sourceType === 'course_assessment' ? access.tdoc : this.tid ? this.tdoc : null;
        if (pdoc && !rdoc.contest && !rdoc.practiceContest) {
            if (!problem.canViewBy(pdoc, this.user)) pdoc = null;
            if (!this.user.hasPerm(PERM.PERM_VIEW_PROBLEM)) pdoc = null;
        }
        if (activity?.sourceType !== 'course_assessment' && this.applyProjection && rdoc.contest?.toString() !== '0'.repeat(24)) {
            rdoc = contest.applyProjection(tdoc, rdoc, this.user);
        }
        const projected = (latest?: LiveRecordAccess | false) => (latest && latest.tdoc.sourceType === 'course_assessment'
            && !rdoc.practiceContest && rdoc.contest?.toString() === latest.tdoc.docId.toString()
            && !latest.classroomManager ? contest.applyProjection(latest.tdoc, { ...rdoc }, latest.viewer) : rdoc);
        const requireManager = this.uid === undefined || !!(access && access.classroomManager);
        if (this.pretest) {
            this.queueSend(
                rdoc._id.toHexString(), async (latest) => ({ rdoc: omit(projected(latest), ['code', 'input']) }),
                rdoc, liveAccess, requireManager,
            );
        } else if (this.noTemplate) {
            this.queueSend(rdoc._id.toHexString(), async (latest) => ({ rdoc: projected(latest) }), rdoc, liveAccess, requireManager);
        } else {
            this.queueSend(rdoc._id.toHexString(), async (latest) => ({
                html: await this.renderHTML('record_main_tr.html', {
                    rdoc: projected(latest), udoc, pdoc, tdoc, allDomain: this.allDomain,
                }),
            }), rdoc, liveAccess, requireManager);
        }
    }

    queueSend(
        rid: string, fn: (access?: LiveRecordAccess | false) => Promise<any>, rdoc?: RecordDoc,
        liveAccess = false, requireManager = this.uid === undefined,
    ) {
        if (this.practiceStopped) return;
        this.queue.set(rid, async () => {
            const recheck = liveAccess || rdoc?.practiceContest || this.tdoc?.sourceType === 'course_assessment';
            const access = recheck ? await checkPracticeAccess(this, rdoc, requireManager) : undefined;
            if (recheck && !access) return null;
            const visibility = recordVisibility(access);
            const payload = await fn(access);
            if (recheck) {
                const latest = await checkPracticeAccess(this, rdoc, requireManager);
                if (!latest || recordVisibility(latest) !== visibility) return null;
            }
            return payload;
        });
        this.throttleQueueClear();
    }

    async queueClear() {
        const pending = [...this.queue.values()];
        this.queue.clear();
        await Promise.all(pending.map(async (fn) => {
            const payload = await fn();
            if (payload && !this.practiceStopped) this.send(payload);
        }));
    }

    cleanup() {
        this.practiceStopped = true;
        this.throttleQueueClear?.cancel();
        this.queue.clear();
    }
}

export class RecordDetailConnectionHandler extends ConnectionHandler {
    pdoc: ProblemDoc;
    tdoc?: Tdoc;
    tsdoc?: ContestStatusDoc;
    rid: string = '';
    disconnectTimeout: NodeJS.Timeout;
    throttleSend: any;
    applyProjection = false;
    noTemplate = false;
    canViewCode = false;
    practiceStopped = false;
    classroomManager = false;

    @param('rid', Types.ObjectId)
    @param('noTemplate', Types.Boolean, true)
    async prepare(domainId: string, rid: ObjectId, noTemplate = false) {
        const rdoc = await record.get(domainId, rid);
        if (!rdoc) return;
        const isOwnOrTeammate = await contest.isOwnOrTeammateRecord(domainId, rdoc, this.user._id);
        let classroomManager = false;
        if (rdoc.practiceContest) {
            this.tdoc = await contest.get(domainId, rdoc.practiceContest);
            if (!this.tdoc) throw new ContestNotFoundError(domainId, rdoc.practiceContest);
            if (this.tdoc.sourceType === 'course_assessment') {
                classroomManager = await assertCourseAssessmentAccess(this.user, this.tdoc);
            }
            if (!canReadPractice(this.user, this.tdoc, rdoc.uid, classroomManager)) {
                throw new PermissionError(PERM.PERM_VIEW_RECORD);
            }
        }
        if (rdoc.contest && ![record.RECORD_GENERATE, record.RECORD_PRETEST].some((i) => i.toHexString() === rdoc.contest.toHexString())) {
            this.tdoc = await contest.get(domainId, rdoc.contest);
            if (!this.tdoc) throw new ContestNotFoundError(domainId, rdoc.contest);
            if (this.tdoc.sourceType === 'course_assessment') {
                classroomManager = await assertCourseAssessmentAccess(this.user, this.tdoc);
                if (!classroomManager && !isOwnOrTeammate) throw new PermissionError(PERM.PERM_VIEW_RECORD);
            }
            let canView = classroomManager || (this.tdoc.sourceType !== 'course_assessment' && this.user.own(this.tdoc));
            if (this.tdoc.sourceType === 'course_assessment') {
                canView ||= isOwnOrTeammate && canShowClassroomSelfRecord(this.tdoc);
            } else {
                canView ||= contest.canShowRecord.call(this, this.tdoc);
                canView ||= isOwnOrTeammate && contest.canShowSelfRecord.call(this, this.tdoc);
            }
            if (!canView) throw new PermissionError(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
            if (this.tdoc.sourceType === 'course_assessment'
                ? !classroomManager : !this.user.own(this.tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) {
                this.applyProjection = true;
            }
            const teamVid = this.tdoc.allowTeam ? await contest.getTeamVid(domainId, this.tdoc.docId, this.user._id) : null;
            this.tsdoc = await contest.getStatus(domainId, this.tdoc.docId, teamVid ?? this.user._id);
        }
        if (rdoc.contest?.toString().startsWith('0'.repeat(23)) && rdoc.uid !== this.user._id) {
            throw new PermissionError(PERM.PERM_READ_RECORD_CODE);
        }
        this.classroomManager = classroomManager;
        const [pdoc, self] = await Promise.all([
            problem.get(rdoc.domainId, rdoc.pid),
            problem.getVisibleStatus(
                domainId, rdoc.pid, this.user._id,
                (tdoc, uid) => contest.canShowProblemStatus(this.user, uid, tdoc),
            ),
        ]);

        this.canViewCode = isOwnOrTeammate || classroomManager;
        if (rdoc.practiceContest) this.canViewCode ||= canManagePractice(this.user, this.tdoc, classroomManager);
        this.canViewCode ||= this.user.hasPriv(PRIV.PRIV_READ_RECORD_CODE);
        this.canViewCode ||= this.user.hasPerm(PERM.PERM_READ_RECORD_CODE);
        this.canViewCode ||= this.user.hasPerm(PERM.PERM_READ_RECORD_CODE_ACCEPT) && self?.status === STATUS.STATUS_ACCEPTED;

        if (!rdoc.practiceContest && !classroomManager && !this.tsdoc?.attend && pdoc && !problem.canViewBy(pdoc, this.user)) {
            throw new PermissionError(PERM.PERM_VIEW_PROBLEM_HIDDEN);
        }

        this.pdoc = pdoc;
        this.noTemplate = noTemplate;
        this.throttleSend = throttle(this.sendUpdate, 1000, { trailing: true });
        this.rid = rid.toString();
        this.onRecordChange(rdoc);
    }

    async sendUpdate(rdoc: RecordDoc) {
        if (this.practiceStopped) return;
        const recheck = rdoc.practiceContest || (rdoc.contest && this.tdoc?.sourceType === 'course_assessment');
        const access = recheck ? await checkPracticeAccess(this, rdoc) : undefined;
        if (recheck && !access) return;
        const visibility = recordVisibility(access);
        if (access && access.tdoc.sourceType === 'course_assessment' && !rdoc.practiceContest && !access.classroomManager) {
            rdoc = contest.applyProjection(access.tdoc, { ...rdoc }, access.viewer);
        } else if (this.applyProjection) rdoc = contest.applyProjection(this.tdoc, rdoc, this.user);
        if (this.noTemplate) {
            this.send({ rdoc });
        } else {
            const payload = {
                status: rdoc.status,
                status_html: await this.renderHTML('record_detail_status.html', { rdoc, pdoc: this.pdoc }),
                summary_html: await this.renderHTML('record_detail_summary.html', { rdoc, pdoc: this.pdoc }),
            };
            if (this.practiceStopped) return;
            if (recheck) {
                const latest = await checkPracticeAccess(this, rdoc);
                if (!latest || recordVisibility(latest) !== visibility) return;
            }
            this.send(payload);
        }
    }

    @subscribe('record/change')
    // eslint-disable-next-line
    async onRecordChange(rdoc: RecordDoc, $set?: any, $push?: any) {
        if (this.practiceStopped || rdoc.domainId !== this.args.domainId || rdoc._id.toString() !== this.rid) return;
        if ((rdoc.practiceContest || (rdoc.contest && this.tdoc?.sourceType === 'course_assessment'))
            && !await checkPracticeAccess(this, rdoc)) return;
        if (this.disconnectTimeout) {
            clearTimeout(this.disconnectTimeout);
            this.disconnectTimeout = null;
        }
        // TODO: frontend doesn't support incremental update
        // if ($set) this.send({ $set, $push });
        if (!this.canViewCode) {
            rdoc = {
                ...rdoc,
                code: '',
                compilerTexts: [],
            };
        }
        if (![STATUS.STATUS_WAITING, STATUS.STATUS_JUDGING, STATUS.STATUS_COMPILING, STATUS.STATUS_FETCHED].includes(rdoc.status)) {
            this.disconnectTimeout = setTimeout(() => this.close(4001, 'Ended'), 30000);
        }
        this.throttleSend(rdoc);
    }

    cleanup() {
        this.practiceStopped = true;
        this.throttleSend?.cancel();
        if (this.disconnectTimeout) clearTimeout(this.disconnectTimeout);
        this.disconnectTimeout = null;
    }
}

export async function apply(ctx) {
    ctx.Route('record_main', '/record', RecordListHandler);
    ctx.Route('record_detail', '/record/:rid', RecordDetailHandler);
    ctx.Connection('record_conn', '/record-conn', RecordMainConnectionHandler);
    ctx.Connection('record_detail_conn', '/record-detail-conn', RecordDetailConnectionHandler);
}
