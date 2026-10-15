import assert from 'assert';
import { canManageFeedback } from '../../../lib/classroomFeedbackAccess';
import { getReferenceCodeSolutions, isReferenceCodeSolution, REFERENCE_CODE_TITLE } from '../../../lib/referenceCode';
import { feedbackRepository } from '../../../model/classroomFeedback';
import FeedbackModel from '../../../model/feedback';
import {
    _, BadRequestError, ContestAlreadyAttendedError, ContestModel, ContestNotFoundError, ContestScoreboardHiddenError,
    DocumentModel, ForbiddenError, Handler, moment, NotAssignedError, ObjectId, OplogModel,
    param, PERM, post, PRIV, ProblemModel, ProblemNotFoundError, SolutionModel, sortFiles, STATUS, StorageModel, SystemModel,
    Types, UserModel, ValidationError,
} from '../../../plugin-api';
import bus from '../../../service/bus';
import type { AssessmentResult } from '../model/assessment';
import {
    cleanupInactiveAssessments, getAssessmentResults, syncAssessmentContests, validateAssessmentPlan,
} from '../model/assessment';
import { ClassModel } from '../model/class';
import type { CourseTdoc, DagNode } from '../model/course';
import { DEFAULT_COURSE_LESSON_DURATION_HOURS } from '../model/course';
import { nextStructure, nodeHighWatermark, problemAccessNodeIds, problemNodeIds } from '../model/structure';

const ASSESSMENT_RULES = ['acm', 'oi', 'ioi', 'strictioi'];

const TEMPLATE_ALL_KEY = 'templates::__all';
const TEMPLATE_UNCATEGORIZED_KEY = 'templates::__uncategorized';

function fillMessage(template: string, ...params: Array<string | number>) {
    return template.replace(/\{(\d+)\}/g, (match, index) => String(params[Number(index)] ?? ''));
}

function normalizeTemplateIds(templateIds: any) {
    const values = Array.isArray(templateIds) ? templateIds : [templateIds];
    return Array.from(new Set(values
        .flatMap((id) => (id === undefined || id === null ? '' : String(id)).split(','))
        .map((id) => id.trim())
        .filter(Boolean)));
}

type CompleteCondition = NonNullable<DagNode['completeCondition']>;

function normalizeCondition(condition: any): CompleteCondition {
    return condition || { type: 'all' };
}

function validateCondition(condition: any, field: string) {
    assert(typeof condition === 'object', `${field} must be an object`);
    assert(['all', 'problem', 'score'].includes(condition.type), `${field} type must be all, problem or score`);
    if (condition.type === 'all') {
        assert(!condition.value, `${field} value must not be set when type is all`);
    } else {
        assert(condition.value, `${field} value must be set when type is not all`);
    }
}

function checkProblemRuleComplete(tsdoc: any, pids: number[], condition: CompleteCondition): boolean {
    if (!tsdoc?.attend || !pids.length) return false;
    let acceptCount = 0;
    let totalScore = 0;
    for (const pid of pids) {
        const detail = tsdoc.detail?.[pid] || tsdoc.detail?.[String(pid)];
        if (detail?.status === STATUS.STATUS_ACCEPTED) acceptCount++;
        totalScore += detail?.score || 0;
    }
    if (condition.type === 'all') return acceptCount >= pids.length;
    if (condition.type === 'problem') return acceptCount >= (condition.value || 0);
    if (condition.type === 'score') return totalScore >= (condition.value || 0);
    return false;
}

function getExtraStudentUids(tdoc: CourseTdoc) {
    return (tdoc.assign || [])
        .filter((g: string) => /^\d+$/.test(g))
        .map((s: string) => Number.parseInt(s, 10))
        .filter((uid: number) => Number.isFinite(uid) && uid > 0);
}

function getAssignGroup(tdoc: CourseTdoc) {
    return (tdoc.assign || []).find((g: string) => g !== 'teachers' && !/^\d+$/.test(g)) || '';
}

function isAssignedToCourse(tdoc: CourseTdoc, user: any) {
    if (!tdoc.assign?.length) return true;
    const userIdStr = user._id.toString();
    return tdoc.assign.some((g: string) => user.group?.includes(g) || g === userIdStr);
}

async function getCourseAudience(domainId: string, tdoc: CourseTdoc) {
    const groupName = getAssignGroup(tdoc);
    const group = groupName ? await ClassModel.getGroupByName(domainId, groupName) : null;
    const teacherUids = new Set<number>([
        ...(group?.teachers || []),
        tdoc.owner,
        (tdoc as any).editor,
    ].filter(Boolean));
    const studentUids = new Set<number>([
        ...(group?.students || []),
        ...getExtraStudentUids(tdoc),
    ].filter((uid) => !teacherUids.has(uid)));
    return {
        teacherUids: Array.from(teacherUids),
        studentUids: Array.from(studentUids),
        restrictToStudentRoster: !!group || getExtraStudentUids(tdoc).length > 0,
    };
}

async function getCourseStudentUids(domainId: string, tdoc: CourseTdoc) {
    const groupName = getAssignGroup(tdoc);
    const group = groupName ? await ClassModel.getGroupByName(domainId, groupName) : null;
    return Array.from(new Set([...(group?.students || []), ...getExtraStudentUids(tdoc)].filter(Boolean)));
}

export function canEditCourse(handler: Handler, tdoc: CourseTdoc) {
    return handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
        || (handler.user.own(tdoc) && handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF));
}

// Apply to every response exit, including nested lists and problem-page hooks.
export function projectCourseResponse(value: any, handler: Handler): any {
    if (!value || typeof value !== 'object') return value;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
    const hideLectures = value.rule === 'course' && !canEditCourse(handler, value);
    let result = value;
    for (const [key, item] of Object.entries(value)) {
        const hidden = hideLectures && ['lecture', 'lectureMeta'].includes(key);
        const projected = hidden ? undefined : projectCourseResponse(item, handler);
        if (!hidden && projected === item) continue;
        if (result === value) result = Array.isArray(value) ? [...value] : Object.assign(Object.create(prototype), value);
        if (hidden) delete result[key];
        else result[key] = projected;
    }
    return result;
}

function studentCanViewCourseLecture(node: DagNode, tsdoc: any) {
    if (!tsdoc?.attend) return false;
    const nodeId = node._id;
    const lectureFlag = tsdoc.lectureAllow?.[nodeId];
    if (lectureFlag === false || lectureFlag === 0) return false;
    if (lectureFlag === true || lectureFlag === 1) return true;
    if (node.lectureRule) {
        return checkProblemRuleComplete(tsdoc, node.lectureRule.pids, node.lectureRule.condition);
    }
    return tsdoc.allow?.[nodeId] === true;
}

function canViewCourseLecture(handler: Handler, tdoc: CourseTdoc, node: DagNode, tsdoc: any) {
    return canEditCourse(handler, tdoc) || handler.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)
        || studentCanViewCourseLecture(node, tsdoc);
}

export async function courseNodeHighWatermark(domainId: string, tdoc: CourseTdoc) {
    const [statuses, max] = await Promise.all([
        ContestModel.getMultiStatus(domainId, { docId: tdoc.docId })
            .project({ allow: 1, lectureAllow: 1, score: 1, accept: 1 }).toArray(),
        feedbackRepository.maxNodeId({ domainId, activityType: 'course', activityId: tdoc.docId.toString() }),
    ]);
    const keys = statuses.flatMap((status) => ['allow', 'lectureAllow', 'score', 'accept']
        .flatMap((field) => Object.keys(status[field] || {}).map(Number))).filter(Number.isSafeInteger);
    return nodeHighWatermark(tdoc, Math.max(max, ...keys));
}

// 检查前置章节完成情况（按当前节点 completeCondition 聚合判断）
function checkPrerequisitesComplete(tsdoc: any, node: DagNode, tdoc: CourseTdoc, assessments: Record<number, AssessmentResult> = {}): boolean {
    if (!tsdoc) {
        console.log('[checkPrerequisitesComplete] tsdoc is null/undefined');
        return false;
    }

    const requireNids = node.requireNids || [];
    if (!requireNids.length) {
        console.log(`[checkPrerequisitesComplete] node ${node._id} has no requirements`);
        return true;
    }

    let acceptCount = 0;
    let totalScore = 0;
    let totalPids = 0;

    for (const nid of requireNids) {
        const reqNode = tdoc.dag.find((n) => n._id === nid);
        if (!reqNode) {
            console.log(`[checkPrerequisitesComplete] required node ${nid} not found in dag`);
            return false;
        }
        if (reqNode.kind === 'assessment') {
            acceptCount += assessments[nid]?.completed ? 1 : 0;
            totalScore += assessments[nid]?.score || 0;
            totalPids += 1;
        } else {
            acceptCount += tsdoc.accept?.[nid] ?? 0;
            totalScore += tsdoc.score?.[nid] ?? 0;
            totalPids += reqNode.pids?.length || 0;
        }
    }

    const condition = node.completeCondition || { type: 'all' };
    console.log(`[checkPrerequisitesComplete] node ${node._id}: acceptCount=${acceptCount}, totalScore=${totalScore},`
        + ` totalPids=${totalPids}, condition=${JSON.stringify(condition)}`);

    if (condition.type === 'all') {
        const result = acceptCount >= totalPids;
        console.log(`[checkPrerequisitesComplete] node ${node._id} type=all: ${acceptCount} >= ${totalPids} = ${result}`);
        return result;
    }
    if (condition.type === 'problem') {
        const result = acceptCount >= (condition.value || 0);
        console.log(`[checkPrerequisitesComplete] node ${node._id} type=problem: ${acceptCount} >= ${condition.value || 0} = ${result}`);
        return result;
    }
    if (condition.type === 'score') {
        const result = totalScore >= (condition.value || 0);
        console.log(`[checkPrerequisitesComplete] node ${node._id} type=score: ${totalScore} >= ${condition.value || 0} = ${result}`);
        return result;
    }
    console.log(`[checkPrerequisitesComplete] node ${node._id}: no matching condition type, returning false`);
    return false;
}

// 更新用户可访问的章节
export async function updateAllowedNodes(
    domainId: string,
    tid: ObjectId,
    uid: number,
    tdoc: CourseTdoc,
    _tsdoc?: any,
) {
    console.log(`[updateAllowedNodes] called: domainId=${domainId}, tid=${tid}, uid=${uid}`);

    // 重新获取最新的 tsdoc，确保 accept 数据是最新的
    const tsdoc = await ContestModel.getStatus(domainId, tid, uid);
    console.log('[updateAllowedNodes] tsdoc:', JSON.stringify({
        attend: tsdoc?.attend,
        accept: tsdoc?.accept,
        allow: tsdoc?.allow,
        uid: tsdoc?.uid,
    }));

    const assessmentResults = await getAssessmentResults(domainId, tdoc, uid);
    if (!tsdoc?.attend) return assessmentResults;

    const allow = { ...tsdoc.allow };
    const opened: number[] = [];

    // 如果没有DAG，所有章节默认开放（如果被手工禁止则需要手工允许）
    if (!tdoc.dag || tdoc.dag.length === 0) {
        console.log('[updateAllowedNodes] no DAG, returning');
        return assessmentResults;
    }

    console.log(`[updateAllowedNodes] dag nodes count: ${tdoc.dag.length}`);

    for (const node of tdoc.dag) {
        console.log(`[updateAllowedNodes] checking node ${node._id}: allow=${allow[node._id]}`);

        // 如果已经有明确设置（包括禁止），不覆盖
        if (allow[node._id] !== undefined) {
            console.log(`[updateAllowedNodes] node ${node._id} already has allow=${allow[node._id]}, skipping`);
            continue;
        }

        // 没有前置条件的节点，默认开放
        if (!node.requireNids || !node.requireNids.length) {
            console.log(`[updateAllowedNodes] node ${node._id} has no requirements, setting to true`);
            allow[node._id] = true;
            opened.push(node._id);
            continue;
        }

        console.log(`[updateAllowedNodes] node ${node._id} has requirements: ${JSON.stringify(node.requireNids)}`);

        const allRequirementsMet = checkPrerequisitesComplete(tsdoc || {}, node, tdoc, assessmentResults);

        console.log(`[updateAllowedNodes] node ${node._id} allRequirementsMet: ${allRequirementsMet}`);

        if (allRequirementsMet) {
            console.log(`[updateAllowedNodes] setting node ${node._id} to true`);
            allow[node._id] = true;
            opened.push(node._id);
        }
    }

    const snapshot: Record<number, { score: number, completed: boolean }> = {};
    for (const node of tdoc.dag) {
        if (node.kind !== 'assessment') continue;
        snapshot[node._id] = {
            score: assessmentResults[node._id]?.score ?? 0,
            completed: assessmentResults[node._id]?.completed ?? false,
        };
    }
    const totalUnits = tdoc.pids.length + tdoc.dag.filter((node) => node.kind === 'assessment').length;
    const completedAssessments = Object.values(snapshot).filter((v) => v.completed).length;
    const progress = totalUnits
        ? Math.floor(((tsdoc.accept?.[0] || 0) + completedAssessments) * 100 / totalUnits)
        : 0;
    const statusFilter = {
        _id: tsdoc._id, domainId, docType: DocumentModel.TYPE_CONTEST, docId: tid, uid, attend: tsdoc.attend,
        accept: tsdoc.accept ?? { $exists: false },
        // Score-based prerequisites can change without changing the AC count.
        score: tsdoc.score ?? { $exists: false },
        // Assessment scores live in other status documents; their writers fence this read.
        _assessmentRevision: tsdoc._assessmentRevision ?? { $exists: false },
        assessmentResults: tsdoc.assessmentResults ?? { $exists: false },
    };
    // Each automatic grant only fills an unset node. Manual allow/deny always wins.
    await Promise.all(opened.map((nodeId) => DocumentModel.collStatus.updateOne({
        ...statusFilter, [`allow.${nodeId}`]: { $exists: false },
    }, { $set: { [`allow.${nodeId}`]: true } })));
    if (tsdoc.progress !== progress
        || JSON.stringify(tsdoc.assessmentResults || {}) !== JSON.stringify(snapshot)) {
        if (!Object.values(assessmentResults).some((result) => result.updating)) {
            await DocumentModel.collStatus.updateOne({
                ...statusFilter,
                progress: tsdoc.progress ?? { $exists: false },
            }, { $set: { progress, assessmentResults: snapshot } });
        }
    }
    return assessmentResults;
}

// 检测DAG中是否存在循环依赖
function hasCycle(dag: any[]): boolean {
    const visited = new Set<number>();
    const recStack = new Set<number>();

    function dfs(nodeId: number, requireNids: number[] = []): boolean {
        visited.add(nodeId);
        recStack.add(nodeId);

        for (const nid of requireNids) {
            const nextNode = dag.find((n) => n._id === nid);
            if (!nextNode) continue;

            if (!visited.has(nid)) {
                if (dfs(nid, nextNode.requireNids)) return true;
            } else if (recStack.has(nid)) {
                return true;
            }
        }

        recStack.delete(nodeId);
        return false;
    }

    for (const node of dag) {
        if (!visited.has(node._id)) {
            if (dfs(node._id, node.requireNids || [])) return true;
        }
    }

    return false;
}

// 验证并解析 DAG 配置
export async function parseDag(domainId: string, dagJson: string): Promise<DagNode[]> {
    const result: DagNode[] = [];

    try {
        const dag = JSON.parse(dagJson);
        assert(dag instanceof Array, 'dag must be an array');

        const nodeIds = new Set(dag.map((n: any) => n._id));
        assert(dag.length, 'must have at least one node');
        assert(dag.length === nodeIds.size, '_id must be unique');

        // 检测循环依赖
        if (hasCycle(dag)) {
            throw new Error('DAG contains cycle dependency');
        }

        for await (const node of dag) {
            assert(node._id, 'each node should have a _id');
            assert(node.title, 'each node shoule have a title');
            assert(node.pids instanceof Array);
            // 允许空题目：如果 pids 为空数组，则不强制要求有题目

            if (node.completeCondition) validateCondition(node.completeCondition, 'completeCondition');

            for (const nid of node.requireNids || []) {
                assert(nodeIds.has(nid), `required nid ${nid} not found`);
                assert(Number.isSafeInteger(nid), 'required nid must be a number');
            }

            // 验证并转换题目 ID
            const pids: number[] = [];
            for await (const i of Object.keys(node.pids)) {
                const pdoc = await ProblemModel.get(domainId, node.pids[i]);
                if (!pdoc) throw new ProblemNotFoundError(domainId, node.pids[i]);
                pids.push(pdoc.docId);
            }

            let assessment: DagNode['assessment'];
            const kind = node.kind === 'assessment' ? 'assessment' : 'lesson';
            if (kind === 'assessment') {
                const settings = node.assessment || {};
                if (!ASSESSMENT_RULES.includes(settings.rule)) throw new Error('Invalid assessment rule');
                const beginAt = new Date(settings.beginAt);
                const endAt = new Date(settings.endAt);
                if (!Number.isFinite(beginAt.getTime()) || !Number.isFinite(endAt.getTime()) || beginAt >= endAt) {
                    throw new Error('Invalid assessment window');
                }
                if (!pids.length) throw new Error('Assessment requires at least one problem');
                if (!['off', 'browser', undefined].includes(settings.monitorMode)) throw new Error('Invalid monitoring mode');
                if (settings.allowPractice !== undefined && typeof settings.allowPractice !== 'boolean') throw new Error('Invalid post-test practice setting');
                assessment = {
                    rule: settings.rule,
                    monitorMode: settings.monitorMode || 'off',
                    allowPractice: settings.allowPractice === true,
                    beginAt: beginAt.toISOString(),
                    endAt: endAt.toISOString(),
                    rated: false, // explicit certification is required before rating
                    passScore: settings.passScore === undefined ? 0 : Number(settings.passScore),
                    ...(typeof settings.contestTid === 'string' && /^[a-f0-9]{24}$/i.test(settings.contestTid)
                        ? { contestTid: settings.contestTid } : {}),
                };
            }
            const lecture = typeof node.lecture === 'string' ? node.lecture.trim() : node.lecture;
            let lectureRule: DagNode['lectureRule'];
            if (lecture && node.lectureRule) {
                assert(typeof node.lectureRule === 'object', 'lectureRule must be an object');
                assert(node.lectureRule.pids instanceof Array, 'lectureRule pids must be an array');
                assert(node.lectureRule.pids.length, 'lectureRule pids must not be empty');
                const lectureRulePids: number[] = [];
                for await (const i of Object.keys(node.lectureRule.pids)) {
                    const pdoc = await ProblemModel.get(domainId, node.lectureRule.pids[i]);
                    if (!pdoc) throw new ProblemNotFoundError(domainId, node.lectureRule.pids[i]);
                    lectureRulePids.push(pdoc.docId);
                }
                const condition = normalizeCondition(node.lectureRule.condition);
                validateCondition(condition, 'lectureRule condition');
                lectureRule = {
                    pids: Array.from(new Set(lectureRulePids)),
                    condition,
                };
            }

            result.push({
                _id: +node._id,
                kind,
                ...(assessment ? { assessment } : {}),
                title: node.title,
                lecture: lecture || false,
                pids: Array.from(new Set(pids)),
                ...(node.requireNids ? { requireNids: Array.from(new Set(node.requireNids)) } : {}),
                completeCondition: node.completeCondition || { type: 'all' },
                ...(lectureRule ? { lectureRule } : {}),
            });
        }

        const coursePids = new Set(result.filter((node) => node.kind !== 'assessment').flatMap((node) => node.pids));
        for (const node of result) {
            if (!node.lectureRule) continue;
            for (const pid of node.lectureRule.pids) {
                assert(coursePids.has(pid), `lectureRule pid ${pid} is not in course dag`);
            }
        }
    } catch (e: any) {
        throw new ValidationError('dag', null, e instanceof ProblemNotFoundError ? e : e.message);
    }

    return result;
}

// 获取成绩板数据
async function getScoreboard(
    handler: Handler,
    domainId: string,
    tid: ObjectId,
    config: any,
    pids: number[] = [],
) {
    const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
    if (pids.length) {
        (tdoc as any).pids = pids;
    }

    if (!ContestModel.canShowScoreboard.call(handler, tdoc)) {
        throw new ContestScoreboardHiddenError(tid);
    }

    const cursor = ContestModel.getMultiStatus(domainId, { docId: tid });
    const pdict = await ProblemModel.getList(
        domainId,
        tdoc.pids,
        true,
        true,
        ProblemModel.PROJECTION_CONTEST_DETAIL,
    );

    const [rows, udict] = await ContestModel.RULES[tdoc.rule].scoreboard(
        config,
        handler.translate.bind(handler),
        tdoc,
        pdict,
        cursor,
    );

    await bus.parallel('contest/scoreboard', tdoc, rows, udict, pdict);
    return [tdoc, rows, udict, pdict] as const;
}

function getLessonDurationHours(tdoc?: Partial<CourseTdoc>) {
    const value = Number(tdoc?.lessonDurationHours);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_COURSE_LESSON_DURATION_HOURS;
}

function getDateValue(value: any, fallback: Date) {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    const date = value == null ? null : new Date(value);
    return date && Number.isFinite(date.getTime()) ? date : fallback;
}

function getCourseLessonWindow(course: any) {
    const courseBeginAt = getDateValue(course.beginAt, new Date(0));
    const lessonBeginAt = getDateValue(course.lessonBeginAt, courseBeginAt);
    const lessonEndAt = getDateValue(
        course.lessonEndAt,
        new Date(lessonBeginAt.getTime() + getLessonDurationHours(course) * 60 * 60 * 1000),
    );
    return { lessonBeginAt, lessonEndAt };
}

function getCourseOrderStatus(course: any, now: Date) {
    const nowTime = now.getTime();
    if (course.beginAt.getTime() > nowTime) return 1;
    if (course.endAt.getTime() < nowTime) return 3;

    const { lessonBeginAt, lessonEndAt } = getCourseLessonWindow(course);
    if (lessonBeginAt.getTime() <= nowTime && lessonEndAt.getTime() >= nowTime) return 0;
    return 2;
}

async function ensureCourseTitleAvailable(
    domainId: string,
    title: string,
    assignGroup: string,
    excludeTid?: ObjectId,
    translate: (value: string) => string = (value) => value,
) {
    const query: any = { rule: 'course', title, assign: { $in: [assignGroup] } };
    if (excludeTid) query._id = { $ne: excludeTid };
    const duplicated = await ContestModel.getMulti(domainId, query).limit(1).next();
    if (duplicated) {
        throw new BadRequestError(fillMessage(translate('Course "{0}" already exists in this domain.'), title));
    }
}

function compareCourseTitle(a: any, b: any) {
    return (a.title || '').localeCompare(b.title || '', 'zh-CN');
}

function compareCourses(a: any, b: any, now: Date) {
    const aStatus = getCourseOrderStatus(a, now);
    const bStatus = getCourseOrderStatus(b, now);
    if (aStatus !== bStatus) return aStatus - bStatus;

    const aLesson = getCourseLessonWindow(a);
    const bLesson = getCourseLessonWindow(b);
    const aLessonIsFuture = aStatus === 2 && aLesson.lessonBeginAt.getTime() > now.getTime();
    const bLessonIsFuture = bStatus === 2 && bLesson.lessonBeginAt.getTime() > now.getTime();
    if (aLessonIsFuture !== bLessonIsFuture) return aLessonIsFuture ? -1 : 1;

    const direction = aStatus === 1 || aLessonIsFuture ? 1 : -1;
    const beginDiff = aLesson.lessonBeginAt.getTime() - bLesson.lessonBeginAt.getTime();
    if (beginDiff !== 0) {
        return direction * beginDiff;
    }

    const lessonEndDiff = aLesson.lessonEndAt.getTime() - bLesson.lessonEndAt.getTime();
    if (lessonEndDiff !== 0) {
        return direction * lessonEndDiff;
    }

    const titleDiff = compareCourseTitle(a, b);
    if (titleDiff !== 0) return titleDiff;

    const endDiff = a.endAt.getTime() - b.endAt.getTime();
    if (endDiff !== 0) {
        return direction * endDiff;
    }

    return String(a.docId).localeCompare(String(b.docId));
}

function getTemplateCategory(assign: string[] = []) {
    const category = assign.includes('teachers') ? assign[1] : '';
    return (category || '').trim();
}

function getCourseLectureContent(lecture: CourseTdoc['lecture'], nodeId: number) {
    if (!lecture) return '';
    const content = lecture[nodeId] || (lecture as Record<string, string>)[String(nodeId)];
    return typeof content === 'string' && content.length ? content : '';
}

function copyLectureForTemplate(source: CourseTdoc | undefined, dag: DagNode[]) {
    const lecture: Record<number, string> = {};
    const lectureMeta: Record<number, { editor: number, updateAt: Date }> = {};
    if (!source) return { dag, lecture, lectureMeta };
    const nextDag = dag.map((node) => {
        const content = getCourseLectureContent(source.lecture, node._id);
        const sourceMeta = source.lectureMeta?.[node._id]
            || source.lectureMeta?.[String(node._id) as any];
        if (!content && !sourceMeta) return node;
        if (content) {
            lecture[node._id] = content;
            lectureMeta[node._id] = sourceMeta || {
                editor: source.owner,
                updateAt: source._id.getTimestamp(),
            };
        } else {
            lectureMeta[node._id] = sourceMeta;
        }
        if (!content || node.lecture) return node;
        return {
            ...node,
            lecture: node.title || `Lecture ${node._id}`,
        };
    });
    return { dag: nextDag, lecture, lectureMeta };
}

function getTemplateCategoryKey(course: any) {
    return course.templateCategory ? `templates::${course.templateCategory}` : TEMPLATE_UNCATEGORIZED_KEY;
}

function groupAndSortCourses(courseList: any[], now: Date) {
    const groups = _.groupBy(courseList, 'assignGroup');
    for (const key of Object.keys(groups)) {
        groups[key].sort((a, b) => compareCourses(a, b, now));
    }

    const sortedGroups = Object.entries(groups)
        .map(([key, list]) => ({ key, tdocs: list }))
        .sort((a, b) => {
            const courseDiff = compareCourses(a.tdocs[0], b.tdocs[0], now);
            if (courseDiff !== 0) return courseDiff;
            return a.key.localeCompare(b.key, 'zh-CN');
        });

    return { groups, sortedGroups };
}

function groupAndSortTemplates(templateList: any[], now: Date) {
    const sortedTemplates = [...templateList].sort((a, b) => compareCourses(a, b, now));
    const groups = _.groupBy(sortedTemplates, getTemplateCategoryKey);
    for (const key of Object.keys(groups)) {
        groups[key].sort((a, b) => compareCourses(a, b, now));
    }
    const sortedGroups = Object.entries(groups)
        .map(([key, list]) => ({ key, tdocs: list }))
        .sort((a, b) => a.key.localeCompare(b.key, 'zh-CN'));
    if (sortedTemplates.length) sortedGroups.unshift({ key: TEMPLATE_ALL_KEY, tdocs: sortedTemplates });
    return { groups, sortedGroups };
}

function getLessonWindow(tdoc: Partial<CourseTdoc> | undefined, beginAt: moment.Moment, timeZone: string) {
    const lessonDurationHours = getLessonDurationHours(tdoc);
    const lessonBeginAt = tdoc?.lessonBeginAt
        ? moment.utc(tdoc.lessonBeginAt).tz(timeZone)
        : beginAt.clone();
    const lessonEndAt = tdoc?.lessonEndAt
        ? moment.utc(tdoc.lessonEndAt).tz(timeZone)
        : lessonBeginAt.clone().add(lessonDurationHours, 'hours');
    return { lessonDurationHours, lessonBeginAt, lessonEndAt };
}

// 课程列表页面
export class CourseMainHandler extends Handler {
    @param('all', Types.Boolean)
    @param('type', Types.Int, true)
    async get(domainId: string, all = false, type = 1) {
        if (all && !this.user.hasPerm(PERM.PERM_MOD_BADGE)) {
            all = false;
        }
        const canViewAllCourses = this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK);
        const viewAll = all || canViewAllCourses;
        const isTeacher = this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
            || this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)
            || this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK);

        const groups = [...this.user.group];
        if (this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)) {
            groups.push('teachers');
        }
        const userId = this.user._id;
        const userGroups = new Set([...this.user.group, userId.toString()]);

        // 查询条件：匹配分配给用户组的课程，或未分配的课程（assign 为空数组、null 或不存在）
        const tdocs = await ContestModel.getMulti(domainId, {
            rule: 'course',
            ...(viewAll ? {} : {
                $or: [
                    { assign: { $in: groups } },
                    { assign: { $size: 0 } },
                    { assign: null },
                    { assign: { $exists: false } },
                    { assign: userId.toString() },
                ],
            }),
        })
            .sort({ beginAt: -1 })
            .project({
                _id: 1,
                docId: 1,
                title: 1,
                beginAt: 1,
                endAt: 1,
                assign: 1,
                rule: 1,
                owner: 1,
                editor: 1,
                updateAt: 1,
                lessonDurationHours: 1,
                lessonBeginAt: 1,
                lessonEndAt: 1,
            })
            .toArray();

        const uids = Array.from(new Set(tdocs.flatMap((t) => [t.owner, t.editor].filter(Boolean))));
        const [tsdict, classGroups, udict] = await Promise.all([
            ContestModel.getListStatus(domainId, this.user._id, tdocs.map((t) => t.docId)),
            ClassModel.listGroup(domainId),
            uids.length ? UserModel.getListForRender(domainId, uids, ['displayName']) : Promise.resolve({}),
        ]);

        const classInfo: Record<string, { archive: boolean }> = classGroups.reduce(
            (acc, g) => ({ ...acc, [g.name]: { archive: g.archive } }),
            {},
        );

        // 判断是否为"我的课程"
        const isMyCourse = (t: any) => t.assign?.some((g: string) => userGroups.has(g));

        // 处理课程数据
        const courses = tdocs.map((t) => ({
            ...t,
            assignGroup: t.assign?.includes('teachers') ? 'teachers' : t.assign?.[0],
            templateCategory: getTemplateCategory(t.assign),
            isTemplate: t.assign?.includes('teachers') || false,
        }));
        const now = new Date();

        // 过滤已归档课程（不展示）
        const nonArchivedCourses = courses.filter((c) => !classInfo[c.assignGroup]?.archive);

        // 分离模板课程和普通课程
        const templates = nonArchivedCourses.filter((c) => c.assignGroup === 'teachers');
        const regularCourses = nonArchivedCourses.filter((c) => c.assignGroup !== 'teachers');

        // 分离"我的课程"和"其他课程"
        const myCourses = regularCourses.filter(isMyCourse).sort((a, b) => compareCourses(a, b, now));
        const otherCourses = regularCourses.filter((c) => !isMyCourse(c)).sort((a, b) => compareCourses(a, b, now));

        const myCourseData = groupAndSortCourses(myCourses, now);
        const otherCourseData = groupAndSortCourses(otherCourses, now);
        const templateData = groupAndSortTemplates(templates, now);
        const templateCategoryOptions = Array.from(new Set(templates.map((t) => t.templateCategory).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b, 'zh-CN'));

        this.response.body = {
            myCourses: myCourseData.groups,
            myCourseGroups: myCourseData.sortedGroups,
            otherCourses: otherCourseData.groups,
            otherCourseGroups: otherCourseData.sortedGroups,
            templates: templateData.groups,
            templateGroups: templateData.sortedGroups,
            templateCategoryOptions,
            templateCount: templates.length,
            tsdict,
            udict,
            isTeacher,
            canEditCourseTemplate: this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK),
            layoutType: type,
        };
        this.response.template = 'course_main.html';
    }

    async updateTemplateCategories(domainId: string, templateIds: any, category: string) {
        this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        const rawIds = normalizeTemplateIds(templateIds);
        if (!rawIds.length) throw new ValidationError('templateIds');
        if (rawIds.some((id) => !ObjectId.isValid(id))) throw new ValidationError('templateIds');
        const ids = rawIds.map((id) => new ObjectId(id));
        const tdocs = await ContestModel.getMulti(domainId, {
            rule: 'course',
            docId: { $in: ids },
            assign: { $elemMatch: { $eq: 'teachers' } },
        })
            .project({ _id: 1, docId: 1 })
            .toArray();
        if (tdocs.length !== ids.length) throw new BadRequestError('请选择有效的课程模板。');
        const assign = category ? ['teachers', category] : ['teachers'];
        await Promise.all(tdocs.map((tdoc) => ContestModel.edit(domainId, tdoc._id, { assign })));
    }

    redirectToTemplateCategory(category: string, all?: boolean, type?: number) {
        const query: Record<string, string | boolean | number> = {
            tab: 'template',
            group: category ? `templates::${category}` : TEMPLATE_UNCATEGORIZED_KEY,
        };
        if (all !== undefined) query.all = all;
        if (type !== undefined) query.type = type;
        this.response.redirect = this.url('course_main', { query });
    }

    @param('templateIds', Types.Any)
    @param('templateCategory', Types.String)
    @param('all', Types.Boolean, true)
    @param('type', Types.Int, true)
    async postBatchSetTemplateCategory(
        domainId: string, templateIds: any, templateCategory: string, all?: boolean, type?: number,
    ) {
        const category = (templateCategory || '').trim();
        await this.updateTemplateCategories(domainId, templateIds, category);
        this.redirectToTemplateCategory(category, all, type);
    }

    @param('templateIds', Types.Any)
    @param('all', Types.Boolean, true)
    @param('type', Types.Int, true)
    async postBatchClearTemplateCategory(
        domainId: string, templateIds: any, all?: boolean, type?: number,
    ) {
        await this.updateTemplateCategories(domainId, templateIds, '');
        this.redirectToTemplateCategory('', all, type);
    }

    @param('oldCategory', Types.String)
    @param('newCategory', Types.String)
    @param('all', Types.Boolean, true)
    @param('type', Types.Int, true)
    async postRenameTemplateCategory(
        domainId: string, oldCategory: string, newCategory: string, all?: boolean, type?: number,
    ) {
        this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        const trimmedOld = (oldCategory || '').trim();
        const trimmedNew = (newCategory || '').trim();
        if (!trimmedOld) throw new ValidationError('oldCategory');
        if (!trimmedNew) throw new ValidationError('newCategory');
        if (trimmedOld === trimmedNew) {
            this.redirectToTemplateCategory(trimmedOld, all, type);
            return;
        }
        const tdocs = await ContestModel.getMulti(domainId, {
            rule: 'course',
            assign: { $all: ['teachers', trimmedOld] },
        })
            .project({ _id: 1, assign: 1 })
            .toArray();
        if (!tdocs.length) {
            this.redirectToTemplateCategory(trimmedOld, all, type);
            return;
        }
        const conflictQuery: any = {
            rule: 'course',
            assign: { $all: ['teachers', trimmedNew] },
        };
        if (await ContestModel.getMulti(domainId, conflictQuery).limit(1).next()) {
            const translate = (this as any).translate?.bind(this) || ((v: string) => v);
            throw new BadRequestError(fillMessage(translate('Template category "{0}" already exists.'), trimmedNew));
        }
        await Promise.all(tdocs.map((tdoc) => ContestModel.edit(domainId, tdoc._id, {
            assign: ['teachers', trimmedNew],
        })));
        this.redirectToTemplateCategory(trimmedNew, all, type);
    }
}

// 课程列表页面 - 卡片网格布局
export class CourseMain1Handler extends Handler {
    @param('all', Types.Boolean)
    async get(domainId: string, all = false) {
        if (all && !this.user.hasPerm(PERM.PERM_MOD_BADGE)) {
            all = false;
        }
        const canViewAllCourses = this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK);
        const viewAll = all || canViewAllCourses;
        const isTeacher = this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
            || this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)
            || this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK);

        const groups = [...this.user.group];
        if (this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)) {
            groups.push('teachers');
        }
        const userId = this.user._id;
        const userGroups = new Set([...this.user.group, userId.toString()]);

        const tdocs = await ContestModel.getMulti(domainId, {
            rule: 'course',
            ...(viewAll ? {} : {
                $or: [
                    { assign: { $in: groups } },
                    { assign: { $size: 0 } },
                    { assign: null },
                    { assign: { $exists: false } },
                    { assign: userId.toString() },
                ],
            }),
        })
            .sort({ beginAt: -1 })
            .project({
                _id: 1,
                docId: 1,
                title: 1,
                beginAt: 1,
                endAt: 1,
                assign: 1,
                rule: 1,
                owner: 1,
                editor: 1,
                updateAt: 1,
                lessonDurationHours: 1,
                lessonBeginAt: 1,
                lessonEndAt: 1,
            })
            .toArray();

        const uids = Array.from(new Set(tdocs.flatMap((t) => [t.owner, t.editor].filter(Boolean))));
        const [tsdict, classGroups, udict] = await Promise.all([
            ContestModel.getListStatus(domainId, this.user._id, tdocs.map((t) => t.docId)),
            ClassModel.listGroup(domainId),
            uids.length ? UserModel.getListForRender(domainId, uids, ['displayName']) : Promise.resolve({}),
        ]);

        const classInfo: Record<string, { archive: boolean }> = classGroups.reduce(
            (acc, g) => ({ ...acc, [g.name]: { archive: g.archive } }),
            {},
        );

        const isMyCourse = (t: any) => t.assign?.some((g: string) => userGroups.has(g));

        const courses = tdocs.map((t) => ({
            ...t,
            assignGroup: t.assign?.[0],
            category: `templates::${t.assign?.[1] || ''}`,
            isTemplate: t.assign?.includes('teachers') || false,
        }));
        const now = new Date();

        const nonArchivedCourses = courses.filter((c) => !classInfo[c.assignGroup]?.archive);
        const templates = nonArchivedCourses.filter((c) => c.assignGroup === 'teachers');
        const regularCourses = nonArchivedCourses.filter((c) => c.assignGroup !== 'teachers');

        const myCourses = regularCourses.filter(isMyCourse).sort((a, b) => compareCourses(a, b, now));
        const otherCourses = regularCourses.filter((c) => !isMyCourse(c)).sort((a, b) => compareCourses(a, b, now));

        const myCourseData = groupAndSortCourses(myCourses, now);
        const otherCourseData = groupAndSortCourses(otherCourses, now);
        const templateData = groupAndSortCourses(templates.sort((a, b) => compareCourses(a, b, now)), now);

        this.response.body = {
            myCourses: myCourseData.groups,
            myCourseGroups: myCourseData.sortedGroups,
            otherCourses: otherCourseData.groups,
            otherCourseGroups: otherCourseData.sortedGroups,
            templates: templateData.groups,
            templateGroups: templateData.sortedGroups,
            tsdict,
            udict,
            isTeacher,
        };
        this.response.template = 'course_main1.html';
    }
}

// 课程列表页面 - 优化侧边栏布局
export class CourseMain2Handler extends Handler {
    @param('all', Types.Boolean)
    async get(domainId: string, all = false) {
        if (all && !this.user.hasPerm(PERM.PERM_MOD_BADGE)) {
            all = false;
        }
        const canViewAllCourses = this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK);
        const viewAll = all || canViewAllCourses;
        const isTeacher = this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
            || this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)
            || this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK);

        const groups = [...this.user.group];
        if (this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)) {
            groups.push('teachers');
        }
        const userId = this.user._id;
        const userGroups = new Set([...this.user.group, userId.toString()]);

        const tdocs = await ContestModel.getMulti(domainId, {
            rule: 'course',
            ...(viewAll ? {} : {
                $or: [
                    { assign: { $in: groups } },
                    { assign: { $size: 0 } },
                    { assign: null },
                    { assign: { $exists: false } },
                    { assign: userId.toString() },
                ],
            }),
        })
            .sort({ beginAt: -1 })
            .project({
                _id: 1,
                docId: 1,
                title: 1,
                beginAt: 1,
                endAt: 1,
                assign: 1,
                rule: 1,
                owner: 1,
                editor: 1,
                updateAt: 1,
                lessonDurationHours: 1,
                lessonBeginAt: 1,
                lessonEndAt: 1,
            })
            .toArray();

        const uids = Array.from(new Set(tdocs.flatMap((t) => [t.owner, t.editor].filter(Boolean))));
        const [tsdict, classGroups, udict] = await Promise.all([
            ContestModel.getListStatus(domainId, this.user._id, tdocs.map((t) => t.docId)),
            ClassModel.listGroup(domainId),
            uids.length ? UserModel.getListForRender(domainId, uids, ['displayName']) : Promise.resolve({}),
        ]);

        const classInfo: Record<string, { archive: boolean }> = classGroups.reduce(
            (acc, g) => ({ ...acc, [g.name]: { archive: g.archive } }),
            {},
        );

        const isMyCourse = (t: any) => t.assign?.some((g: string) => userGroups.has(g));

        const courses = tdocs.map((t) => ({
            ...t,
            assignGroup: t.assign?.[0],
            category: `templates::${t.assign?.[1] || ''}`,
            isTemplate: t.assign?.includes('teachers') || false,
        }));
        const now = new Date();

        const nonArchivedCourses = courses.filter((c) => !classInfo[c.assignGroup]?.archive);
        const templates = nonArchivedCourses.filter((c) => c.assignGroup === 'teachers');
        const regularCourses = nonArchivedCourses.filter((c) => c.assignGroup !== 'teachers');

        const myCourses = regularCourses.filter(isMyCourse).sort((a, b) => compareCourses(a, b, now));
        const otherCourses = regularCourses.filter((c) => !isMyCourse(c)).sort((a, b) => compareCourses(a, b, now));

        const myCourseData = groupAndSortCourses(myCourses, now);
        const otherCourseData = groupAndSortCourses(otherCourses, now);
        const templateData = groupAndSortCourses(templates.sort((a, b) => compareCourses(a, b, now)), now);

        this.response.body = {
            myCourses: myCourseData.groups,
            myCourseGroups: myCourseData.sortedGroups,
            otherCourses: otherCourseData.groups,
            otherCourseGroups: otherCourseData.sortedGroups,
            templates: templateData.groups,
            templateGroups: templateData.sortedGroups,
            tsdict,
            udict,
            isTeacher,
        };
        this.response.template = 'course_main2.html';
    }
}

// 课程详情页面
export class CourseDetailHandler extends Handler {
    tdoc!: CourseTdoc;

    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        this.tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        if (this.tdoc.rule !== 'course') {
            throw new ContestNotFoundError(domainId, tid);
        }
        const isTemplate = this.tdoc.assign?.includes('teachers');
        const canBypassAssign = canEditCourse(this, this.tdoc)
            || this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK);
        if (!isTemplate && this.tdoc.assign?.length && !this.user.own(this.tdoc)
            && !isAssignedToCourse(this.tdoc, this.user)
            && !canBypassAssign) {
            throw new NotAssignedError('course', this.tdoc.docId);
        }
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.PositiveInt, true)
    @param('checkstu', Types.Boolean)
    async get(domainId: string, tid: ObjectId, uid = 0, checkstu = false) {
        let tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        const isTemplate = this.tdoc.assign?.includes('teachers');
        const isCourseTeacher = this.user.own(this.tdoc);
        const isTeacherEditor = isCourseTeacher
            || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
        const canViewAllProblems = isTeacherEditor || this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK);

        if (isCourseTeacher && !tsdoc?.attend) {
            try {
                await ContestModel.attend(domainId, tid, this.user._id);
            } catch (error) {
                if (!(error instanceof ContestAlreadyAttendedError)) throw error;
                const currentStatus = await ContestModel.getStatus(domainId, tid, this.user._id);
                if (!currentStatus?.attend) throw error;
            }
            tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        }

        const uids = Array.from(new Set([this.tdoc.owner, (this.tdoc as any).editor].filter(Boolean)));
        const udict = await UserModel.getListForRender(domainId, uids, ['displayName']);

        // 更新可访问章节
        const assessmentResults = await updateAllowedNodes(domainId, tid, this.user._id, this.tdoc, tsdoc);
        tsdoc &&= await ContestModel.getStatus(domainId, tid, this.user._id);
        const lectureAccess: Record<number, boolean> = {};
        for (const node of this.tdoc.dag || []) {
            lectureAccess[node._id] = canViewCourseLecture(this, this.tdoc, node, tsdoc);
        }

        this.response.template = 'course_detail.html';
        this.response.body = {
            tdoc: this.tdoc, tsdoc, udict, lectureAccess, assessments: assessmentResults,
            feedbackUrl: await canManageFeedback(this, this.tdoc) ? this.url('course_feedback', { tid }) : null,
        };

        // 查看学生列表（仅管理员）
        if ((checkstu || uid) && canEditCourse(this, this.tdoc)) {
            const group = await ClassModel.getGroupByName(domainId, this.tdoc.assign[0]);
            this.response.body.students = await UserModel.getListForRender(
                domainId,
                group?.students || [],
                ['displayName'],
            );
        }

        // 检查是否可查看题目
        if (!isTemplate && !canViewAllProblems
            && !this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD)
            && !canEditCourse(this, this.tdoc)
            && (ContestModel.isNotStarted(this.tdoc) || (!tsdoc?.attend && !ContestModel.isDone(this.tdoc)))) {
            return;
        }

        const pdict = await ProblemModel.getList(
            domainId,
            this.tdoc.pids,
            true,
            true,
            ProblemModel.PROJECTION_CONTEST_LIST,
        );

        const psdict: Record<number, any> = {};
        if (tsdoc) {
            if (tsdoc.attend && !tsdoc.startAt) {
                await DocumentModel.collStatus.updateOne({
                    _id: tsdoc._id, domainId, docType: DocumentModel.TYPE_CONTEST, docId: tid, uid: this.user._id, attend: tsdoc.attend,
                }, { $set: { startAt: new Date() } });
                tsdoc.startAt = new Date();
            }
            for (const j of tsdoc.journal || []) {
                psdict[j.pid] = j;
            }
        }

        Object.assign(this.response.body, { pdict, psdict });
    }

    @param('tid', Types.ObjectId)
    async postAttend(domainId: string, tid: ObjectId) {
        if (!this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) {
            this.checkPerm(PERM.PERM_ATTEND_HOMEWORK);
        }
        const isTemplate = this.tdoc.assign?.includes('teachers');
        if (isTemplate) throw new ForbiddenError();
        if (!isAssignedToCourse(this.tdoc, this.user)
            && !this.user.own(this.tdoc)
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
            && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK)) {
            throw new NotAssignedError('course', this.tdoc.docId);
        }
        if (ContestModel.isDone(this.tdoc)) {
            throw new ForbiddenError((this as any).translate('This course is not live.'));
        }
        await ContestModel.attend(domainId, tid, this.user._id);
        await updateAllowedNodes(domainId, tid, this.user._id, this.tdoc);
        this.back();
    }
}

// 课程创建/编辑页面
export class CourseEditHandler extends Handler {
    tdoc?: CourseTdoc;

    @param('tid', Types.ObjectId, true)
    @param('isTemplate', Types.Boolean)
    async prepare(domainId: string, tid?: ObjectId, isTemplate?: boolean) {
        if (tid) {
            this.tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
            if (!this.tdoc) throw new ContestNotFoundError(domainId, tid);
            if (this.tdoc.rule !== 'course') throw new ContestNotFoundError(domainId, tid);
            if (!canEditCourse(this, this.tdoc)) throw new ForbiddenError();
        } else if (isTemplate) {
            if (!this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) {
                throw new ForbiddenError('要创建课程模板，你需要拥有 PERM_EDIT_HOMEWORK 权限。');
            }
        } else if (!this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)) {
            throw new ForbiddenError('要创建课程，你需要拥有 PERM_CREATE_HOMEWORK 权限。');
        }
    }

    @param('isTemplate', Types.Boolean)
    async get(domainId: string, isTemplate?: boolean) {
        this.response.template = 'course_edit.html';

        const beginAt = this.tdoc
            ? moment.utc(this.tdoc.beginAt).tz(this.user.timeZone)
            : moment().add(1, 'day').tz(this.user.timeZone).hour(0).minute(0).millisecond(0);

        const endAt = this.tdoc
            ? moment.utc(this.tdoc.endAt).tz(this.user.timeZone)
            : beginAt.clone().add(7, 'days').tz(this.user.timeZone).hour(23).minute(59).millisecond(0);
        const { lessonDurationHours, lessonBeginAt, lessonEndAt } = getLessonWindow(this.tdoc, beginAt, this.user.timeZone);

        let templateCategoryOptions: string[] = [];
        if (isTemplate || this.tdoc?.assign?.includes('teachers')) {
            const templateTdocs = await ContestModel.getMulti(domainId, {
                rule: 'course',
                assign: { $elemMatch: { $eq: 'teachers' } },
            })
                .project({ assign: 1 })
                .toArray();
            templateCategoryOptions = Array.from(new Set(
                templateTdocs
                    .map((t) => (t.assign?.includes('teachers') ? (t.assign?.[1] || '').trim() : ''))
                    .filter(Boolean),
            )).sort((a, b) => a.localeCompare(b, 'zh-CN'));
        }

        this.response.body = {
            page_name: this.tdoc ? 'course_edit' : 'course_create',
            nodeIdHighWatermark: this.tdoc ? await courseNodeHighWatermark(domainId, this.tdoc) : 0,
            tdoc: this.tdoc,
            beginAtText: beginAt.format('YYYY-M-D H:mm'),
            endAtText: endAt.format('YYYY-M-D H:mm'),
            lessonDurationHours,
            lessonBeginAtText: lessonBeginAt.format('YYYY-M-D H:mm'),
            lessonEndAtText: lessonEndAt.format('YYYY-M-D H:mm'),
            templateCategory: getTemplateCategory(this.tdoc?.assign),
            templateCategoryOptions,
            isTemplate: isTemplate || this.tdoc?.assign?.includes('teachers'),
        };

        if (this.tdoc && !this.response.body.isTemplate) {
            this.response.body.assessmentTimeHistories = await ContestModel.getMulti(domainId, {
                sourceType: 'course_assessment', sourceCourseTid: this.tdoc.docId,
                $or: [{ 'timeChangeHistory.0': { $exists: true } }, { statsRecalc: { $exists: true } }],
            }).project({ title: 1, timeChangeHistory: 1, statsRecalc: 1, statsRevision: 1, sourceNodeId: 1 }).toArray();
        }

        if (this.tdoc) {
            this.response.body.dag = JSON.stringify(this.tdoc.dag, null, 2);
            // 从 assign 中分离出纯数字字符串作为 extraStudents
            const allAssign = this.tdoc.assign || [];
            this.response.body.assign = allAssign.filter((g) => !/^\d+$/.test(g));
            this.response.body.extraStudents = allAssign
                .filter((g) => /^\d+$/.test(g))
                .map((s) => Number.parseInt(s, 10));
        }
    }

    @param('nodeId', Types.UnsignedInt)
    @param('statsRevision', Types.UnsignedInt)
    async postRetryRecalc(domainId: string, nodeId: number, statsRevision: number) {
        const course = await ContestModel.get(domainId, this.tdoc.docId) as CourseTdoc;
        if (!canEditCourse(this, course)) throw new ForbiddenError();
        const node = course.dag.find((item) => item._id === nodeId && item.kind === 'assessment');
        if (!node?.assessment?.contestTid) throw new BadRequestError('课堂测试不存在。');
        const tid = new ObjectId(node.assessment.contestTid);
        const exam = await ContestModel.get(domainId, tid);
        if (exam.sourceType !== 'course_assessment' || !exam.sourceCourseTid?.equals(course.docId) || exam.sourceNodeId !== nodeId) {
            throw new ForbiddenError('课堂测试绑定已改变，请刷新后重试。');
        }
        if ((exam.statsRevision || 0) !== statsRevision) throw new BadRequestError('测试设置已更新，请刷新后重试。');
        await validateAssessmentPlan(domainId, course.dag, course, course.beginAt, course.endAt);
        await syncAssessmentContests(domainId, course.docId, [node], course.title, course.owner,
            course.assign || [], course.maintainer || [], this.user._id, false);
        const current = await ContestModel.get(domainId, tid);
        try {
            await ContestModel.recalcStatus(domainId, tid, current.statsRevision || 0);
        } catch {
            // Preserve the recoverable state and show it on the editor rather than suggesting the time was rolled back.
        }
        this.response.redirect = this.url('course_edit', { tid: course.docId });
    }

    async post(args: Record<string, any>) {
        if (!this.args.operation) return Reflect.apply(this.postUpdate, this, [args]);
        return undefined;
    }

    @param('tid', Types.ObjectId, true)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('dag', Types.Content)
    @param('beginAt', Types.String)
    @param('endAt', Types.String)
    @param('lessonDurationHours', Types.Float, true)
    @param('lessonBeginAt', Types.String, true)
    @param('lessonEndAt', Types.String, true)
    @param('isTemplate', Types.Boolean)
    @param('templateCategory', Types.String, true)
    @param('assign', Types.CommaSeperatedArray, true)
    @param('extraStudents', Types.CommaSeperatedArray, true)
    @param('publicScoreboard', Types.Boolean, true)
    @param('enablePenalty', Types.Boolean, true)
    @param('dagRevision', Types.UnsignedInt, true)
    async postUpdate(
        domainId: string,
        tid: ObjectId | undefined,
        title: string,
        content: string,
        dagJson: string,
        beginAtStr: string,
        endAtStr: string,
        lessonDurationHours = DEFAULT_COURSE_LESSON_DURATION_HOURS,
        lessonBeginAtStr = '',
        lessonEndAtStr = '',
        isTemplate = false,
        templateCategory = '',
        assign: string[] = [],
        extraStudentsStr: string[] = [],
        publicScoreboard = true,
        enablePenalty = true,
        dagRevision = 0,
    ) {
        assign = Array.from(new Set((assign || []).map((s) => (s || '').trim()).filter(Boolean)));
        templateCategory = (templateCategory || '').trim();
        const extraStudents = Array.from(new Set((extraStudentsStr || [])
            .map((s) => Number.parseInt(s, 10))
            .filter((n) => Number.isFinite(n) && n > 0)));
        if (!isTemplate && assign.includes('teachers')) {
            throw new BadRequestError('不能分配课程给 teachers 组');
        }

        const dag = await parseDag(domainId, dagJson);
        const pids = Array.from(new Set(dag.filter((n) => n.kind !== 'assessment').flatMap((n) => n.pids)));

        const beginAt = moment.tz(beginAtStr, 'YYYY-M-D H:mm', this.user.timeZone);
        if (!beginAt.isValid()) throw new ValidationError('beginAt');

        const endAt = moment.tz(endAtStr, 'YYYY-M-D H:mm', this.user.timeZone);
        if (!endAt.isValid()) throw new ValidationError('endAt');
        const normalizedLessonDurationHours = Number.isFinite(+lessonDurationHours) && +lessonDurationHours > 0
            ? +lessonDurationHours
            : DEFAULT_COURSE_LESSON_DURATION_HOURS;
        const lessonBeginAt = lessonBeginAtStr
            ? moment.tz(lessonBeginAtStr, 'YYYY-M-D H:mm', this.user.timeZone)
            : beginAt.clone();
        if (!lessonBeginAt.isValid()) throw new ValidationError('lessonBeginAt');
        const lessonEndAt = lessonEndAtStr
            ? moment.tz(lessonEndAtStr, 'YYYY-M-D H:mm', this.user.timeZone)
            : lessonBeginAt.clone().add(normalizedLessonDurationHours, 'hours');
        if (!lessonEndAt.isValid()) throw new ValidationError('lessonEndAt');
        if (lessonBeginAt.isSameOrAfter(lessonEndAt)) throw new ValidationError('lessonBeginAt', 'lessonEndAt');

        await validateAssessmentPlan(domainId, dag, this.tdoc, beginAt.toDate(), endAt.toDate());
        const editor = this.user._id;
        const updateAt = new Date();
        const editingTemplate = !!this.tdoc?.assign?.includes('teachers');
        const saveAsTemplate = !!(tid && isTemplate && !editingTemplate);
        const sourceTid = tid;
        const sourceCourseForTemplate = saveAsTemplate ? this.tdoc : undefined;
        const assignGroup = isTemplate ? 'teachers' : (assign[0] || '');
        let targetClassGroup: { _id: ObjectId, name: string } | undefined;

        if (isTemplate) {
            assign = ['teachers'];
            let teachersGroup = (await UserModel.listGroup(domainId, undefined, ['teachers']))[0];
            if (teachersGroup && !teachersGroup.class) {
                throw new BadRequestError('teachers 已被普通用户组占用');
            }
            if (!teachersGroup) {
                await ClassModel.updateGroup(
                    domainId,
                    'teachers',
                    [this.user._id],
                    [],
                    beginAt.toDate(),
                    endAt.toDate(),
                    false,
                );
                teachersGroup = await ClassModel.getGroupByName(domainId, 'teachers') || undefined;
            }
            if (!teachersGroup?.class) throw new BadRequestError('班级不存在');
            targetClassGroup = teachersGroup;
        } else if (assign.length) {
            const group = await ClassModel.getGroupByName(domainId, assign[0]);
            if (!group) throw new BadRequestError('班级不存在');
            if (group.archive) throw new BadRequestError('班级已归档');
            targetClassGroup = group;
        }

        const classGroups = new Map<string, { _id: ObjectId, name: string }>();
        if (targetClassGroup) classGroups.set(targetClassGroup._id.toHexString(), targetClassGroup);
        const sourceAssignGroup = this.tdoc
            ? (this.tdoc.assign?.includes('teachers') ? 'teachers' : getAssignGroup(this.tdoc))
            : '';
        let lockedSourceAssign = [...(this.tdoc?.assign || [])];
        if (sourceAssignGroup && sourceAssignGroup !== targetClassGroup?.name) {
            const sourceClassGroup = await ClassModel.getGroupByName(domainId, sourceAssignGroup);
            if (sourceClassGroup) classGroups.set(sourceClassGroup._id.toHexString(), sourceClassGroup);
        }

        const classGroupsToLock = [...classGroups.values()]
            .sort((a, b) => a._id.toHexString().localeCompare(b._id.toHexString()));
        const classEditToken = classGroupsToLock.length ? new ObjectId().toHexString() : undefined;
        const lockedClassGroups: Array<{ _id: ObjectId, name: string }> = [];

        try {
            for (const group of classGroupsToLock) {
                // eslint-disable-next-line no-await-in-loop
                const lock = await ClassModel.acquireEditLock(domainId, group._id, group.name, classEditToken!);
                if (!lock.matchedCount) {
                    throw new BadRequestError('Class is being edited. Please refresh and try again.');
                }
                lockedClassGroups.push(group);
            }
            await Promise.all(lockedClassGroups.map(async (group) => {
                const refreshed = await ClassModel.refreshEditLock(domainId, group._id, classEditToken!);
                if (!refreshed.matchedCount) throw new BadRequestError('The class edit lock was lost.');
            }));
            if (tid) {
                const lockedCourse = await ContestModel.get(domainId, tid) as CourseTdoc;
                const lockedSourceAssignGroup = lockedCourse.assign?.includes('teachers')
                    ? 'teachers'
                    : getAssignGroup(lockedCourse);
                if (lockedSourceAssignGroup !== sourceAssignGroup) {
                    throw new BadRequestError('Course assignment changed. Please refresh and try again.');
                }
                lockedSourceAssign = [...(lockedCourse.assign || [])];
            }
            if (targetClassGroup) {
                const lockedGroup = await ClassModel.getGroupById(domainId, targetClassGroup._id);
                if (!lockedGroup) throw new BadRequestError('班级不存在');
                if (lockedGroup.archive) throw new BadRequestError('班级已归档');
                if (!tid || saveAsTemplate) {
                    await ensureCourseTitleAvailable(
                        domainId,
                        title,
                        assignGroup,
                        undefined,
                        (this as any).translate?.bind(this),
                    );
                }
            }
            // 合并 extraStudents 到 assign（转为字符串）
            // 先过滤掉 assign 中旧的数字字符串（之前的 extraStudents），再添加新的
            const nonDigitAssign = isTemplate
                ? []
                : assign.filter((g: string) => !/^\d+$/.test(g));
            const finalAssign = isTemplate
                ? (templateCategory ? ['teachers', templateCategory] : ['teachers'])
                : [...nonDigitAssign, ...extraStudents.map((s) => s.toString())];
            const copiedLecture = copyLectureForTemplate(sourceCourseForTemplate, dag);
            const finalDag = copiedLecture.dag;
            if (isTemplate) {
                for (const node of finalDag) if (node.assessment) delete node.assessment.contestTid;
            }
            const finalLecture = copiedLecture.lecture;
            const finalLectureMeta = copiedLecture.lectureMeta;
            let structure: ReturnType<typeof nextStructure>;
            try {
                const current = tid && !saveAsTemplate ? this.tdoc : undefined;
                const historicalMax = current ? await courseNodeHighWatermark(domainId, current) : 0;
                structure = nextStructure(current, finalDag, current ? dagRevision : 0, historicalMax);
                if (saveAsTemplate && sourceCourseForTemplate) {
                    structure.problemNodeIds = problemNodeIds({ dag: finalDag, problemNodeIds: problemNodeIds(sourceCourseForTemplate) });
                    structure.problemAccessNodeIds = problemAccessNodeIds({
                        dag: finalDag, problemAccessNodeIds: problemAccessNodeIds(sourceCourseForTemplate),
                    });
                }
            } catch (error) {
                throw new BadRequestError(error.message);
            }

            if (tid && !saveAsTemplate) {
                const updated = await ContestModel.editIfAssigned(domainId, tid, lockedSourceAssign, {
                    title,
                    content,
                    pids,
                    beginAt: beginAt.toDate(),
                    endAt: endAt.toDate(),
                    lessonDurationHours: normalizedLessonDurationHours,
                    lessonBeginAt: lessonBeginAt.toDate(),
                    lessonEndAt: lessonEndAt.toDate(),
                    editor,
                    updateAt,
                    publicScoreboard,
                    enablePenalty,
                    ...structure,
                    assign: finalAssign,
                    ...(Object.keys(finalLecture).length ? { lecture: finalLecture } : {}),
                    ...(Object.keys(finalLectureMeta).length ? { lectureMeta: finalLectureMeta } : {}),
                }, { dagRevision: this.tdoc.dagRevision ?? { $exists: false } }, this.user._id);
                if (!updated) {
                    throw new BadRequestError('Course assignment changed. Please refresh and try again.');
                }
                await ContestModel.recalcStatus(domainId, tid);
            } else {
                tid = await ContestModel.add(
                    domainId,
                    title,
                    content,
                    this.user._id,
                    'course',
                    beginAt.toDate(),
                    endAt.toDate(),
                    pids,
                );
                await ContestModel.edit(domainId, tid, {
                    ...structure,
                    assign: finalAssign,
                    editor,
                    updateAt,
                    publicScoreboard,
                    enablePenalty,
                    lessonDurationHours: normalizedLessonDurationHours,
                    lessonBeginAt: lessonBeginAt.toDate(),
                    lessonEndAt: lessonEndAt.toDate(),
                    ...(Object.keys(finalLecture).length ? { lecture: finalLecture } : {}),
                    ...(Object.keys(finalLectureMeta).length ? { lectureMeta: finalLectureMeta } : {}),
                    ...(sourceCourseForTemplate?.files?.length ? { files: sourceCourseForTemplate.files } : {}),
                });
            }
            if (sourceCourseForTemplate?.files?.length && sourceTid) {
                await Promise.all(sourceCourseForTemplate.files.map((f) => StorageModel.copy(
                    `contest/${domainId}/${sourceTid}/public/${f.name}`,
                    `contest/${domainId}/${tid}/public/${f.name}`,
                )));
            }
            if (!isTemplate) await cleanupInactiveAssessments(domainId, tid, finalDag);
            // 清除旧的 extraStudents 字段（已合并到 assign）
            await DocumentModel.set(domainId, DocumentModel.TYPE_CONTEST, tid, undefined, { extraStudents: '' as any });
        } finally {
            if (classEditToken) {
                await Promise.allSettled(lockedClassGroups.map(
                    (group) => ClassModel.releaseEditLock(domainId, group._id, classEditToken),
                ));
            }
        }

        this.response.body = { tid };
        this.response.redirect = this.url('course_detail', { tid });
    }

    @param('tid', Types.ObjectId)
    async postDelete(domainId: string, tid: ObjectId) {
        if (this.user.own(this.tdoc!)) {
            this.checkPerm(PERM.PERM_EDIT_HOMEWORK, PERM.PERM_EDIT_HOMEWORK_SELF);
        } else {
            this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        }
        const currentCourse = await ContestModel.get(domainId, tid) as CourseTdoc;
        let expectedAssign = currentCourse.assign || [];
        const assignGroup = currentCourse.assign?.includes('teachers')
            ? 'teachers'
            : getAssignGroup(currentCourse);
        const classGroup = assignGroup ? await ClassModel.getGroupByName(domainId, assignGroup) : null;
        const editToken = classGroup ? new ObjectId().toHexString() : undefined;
        if (classGroup) {
            const lock = await ClassModel.acquireEditLock(domainId, classGroup._id, classGroup.name, editToken!);
            if (!lock.matchedCount) {
                throw new BadRequestError('Class is being edited. Please refresh and try again.');
            }
        }
        try {
            if (classGroup) {
                const lockedCourse = await ContestModel.get(domainId, tid) as CourseTdoc;
                const lockedAssignGroup = lockedCourse.assign?.includes('teachers')
                    ? 'teachers'
                    : getAssignGroup(lockedCourse);
                if (lockedAssignGroup !== classGroup.name) {
                    throw new BadRequestError('Course assignment changed. Please refresh and try again.');
                }
                expectedAssign = lockedCourse.assign || [];
            }
            await validateAssessmentPlan(domainId, [], currentCourse, currentCourse.beginAt, currentCourse.endAt);
            const deleted = await ContestModel.delIfAssignUnchanged(domainId, tid, expectedAssign);
            if (!deleted) {
                throw new BadRequestError('Course assignment changed. Please refresh and try again.');
            }
        } finally {
            if (classGroup && editToken) {
                try {
                    await ClassModel.releaseEditLock(domainId, classGroup._id, editToken);
                } catch { }
            }
        }
        await cleanupInactiveAssessments(domainId, tid, []);
        this.response.redirect = this.url('course_main');
    }
}

// 课程管理页面
export class CourseManageHandler extends Handler {
    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        const tdoc = await ContestModel.get(domainId, tid);
        if (tdoc.rule !== 'course') {
            throw new ContestNotFoundError(domainId, tid);
        }
        if (this.user.own(tdoc)) {
            this.checkPerm(PERM.PERM_EDIT_HOMEWORK_SELF, PERM.PERM_EDIT_HOMEWORK);
        } else {
            this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
        }
    }

    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const [tdoc, tsdocs] = await Promise.all([
            ContestModel.get(domainId, tid),
            ContestModel.getMultiStatus(domainId, { docId: tid }).toArray(),
        ]);

        const tsdict: Record<number, any> = {};
        for (const tsdoc of tsdocs) {
            tsdict[tsdoc.uid] = tsdoc;
        }

        const group = await ClassModel.getGroupByName(domainId, (tdoc as CourseTdoc).assign?.[0] || '');
        // 从 assign 中分离 extraStudents（纯数字字符串）
        const allAssign = (tdoc as CourseTdoc).assign || [];
        const extraStudents = allAssign
            .filter((g: string) => /^\d+$/.test(g))
            .map((s: string) => Number.parseInt(s, 10));
        const allUids = Array.from(new Set([
            ...tsdocs.map((t) => t.uid),
            ...(group?.students || []),
            ...(extraStudents),
            (tdoc as CourseTdoc).owner,
            (tdoc as any).editor,
        ].filter(Boolean)));
        const udict = await UserModel.getListForRender(domainId, allUids, ['displayName']);
        const course = tdoc as CourseTdoc;
        const students = await getCourseStudentUids(domainId, course);
        const accessCounts = Object.fromEntries(course.dag.map((node) => [node._id, {
            lecture: students.filter((uid) => studentCanViewCourseLecture(node, tsdict[uid])).length,
            problems: students.filter((uid) => tsdict[uid]?.attend && tsdict[uid]?.allow?.[node._id] === true).length,
            total: students.length,
        }]));

        this.response.template = 'course_manage.html';
        this.response.body = {
            page_name: 'course_manage',
            feedbackUrl: await canManageFeedback(this, tdoc) ? this.url('course_feedback', { tid }) : null,
            tdoc,
            tsdict,
            udict,
            group: group || { students: [] },
            extraStudents,
            accessCounts,
        };
    }

    private async batchResult(targets: number[], operation: (uid: number) => Promise<any>) {
        const outcomes = await Promise.allSettled(targets.map(operation));
        const results = outcomes.map((result, index) => ({
            uid: targets[index], success: result.status === 'fulfilled',
            ...(result.status === 'rejected' ? { error: '操作失败，请重试该学生。' } : {}),
        }));
        if (this.request.headers.accept?.includes('application/json')) this.response.body = { results };
        else this.back();
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.Int)
    @param('unrank', Types.Boolean, true)
    @param('clear', Types.Boolean, true)
    async postUnrank(domainId: string, tid: ObjectId, uid: number, unrank?: boolean, clear?: boolean) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        const students = await getCourseStudentUids(domainId, tdoc);
        if (uid && !students.includes(uid)) throw new BadRequestError('学生不在课程名单中');
        await this.batchResult(uid ? [uid] : students, (target) => clear
            ? ContestModel.setStatus(domainId, tid, target, {}, { unrank: 1 })
            : ContestModel.setStatus(domainId, tid, target, { unrank: !!unrank }));
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.Int)
    @param('allow', Types.Boolean)
    async postVisit(domainId: string, tid: ObjectId, uid: number, allow = false) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        const group = await ClassModel.getGroupByName(domainId, getAssignGroup(tdoc));
        const students = await getCourseStudentUids(domainId, tdoc);
        if (uid && !students.includes(uid)) throw new ForbiddenError('用户不在该课程的学生名单中');
        const targets = uid ? [uid] : group?.students || [];
        if (!uid && !group) throw new BadRequestError('没有找到班级');
        await this.batchResult(targets, async (target) => {
            const status = await ContestModel.getStatus(domainId, tid, target);
            if (allow && !status?.attend) {
                await ContestModel.attend(domainId, tid, target);
                await updateAllowedNodes(domainId, tid, target, tdoc);
            } else if (!allow && status?.attend) await ContestModel.cancelAttend(domainId, tid, target);
        });
    }

    private async setNodeAccess(domainId: string, tid: ObjectId, uid: number, node: number,
        field: 'allow' | 'lectureAllow', allow?: boolean, reset?: boolean) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        if (!tdoc.dag.some((item) => item._id === node)) throw new ValidationError('node', node, '节点不存在');
        const students = await getCourseStudentUids(domainId, tdoc);
        if (uid && !students.includes(uid)) throw new BadRequestError('学生不在课程名单中');
        if (!students.length) throw new BadRequestError('没有找到学生');
        if (!reset && typeof allow !== 'boolean') throw new ValidationError('allow');
        const key = `${field}.${node}`;
        await this.batchResult(uid ? [uid] : students, (target) => reset
            ? ContestModel.setStatus(domainId, tid, target, {}, { [key]: 1 })
            : ContestModel.setStatus(domainId, tid, target, { [key]: allow }));
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.Int)
    @param('node', Types.Int)
    @param('allow', Types.Boolean, true)
    @param('reset', Types.Boolean, true)
    async postAllowUser(domainId: string, tid: ObjectId, uid: number, node: number, allow = false, reset?: boolean) {
        await this.setNodeAccess(domainId, tid, uid, node, 'allow', allow, reset);
    }

    @param('tid', Types.ObjectId)
    @param('node', Types.PositiveInt)
    @param('uid', Types.Int)
    @param('allow', Types.Boolean, true)
    @param('reset', Types.Boolean, true)
    async postAllowLecture(domainId: string, tid: ObjectId, node: number, uid: number, allow = false, reset?: boolean) {
        await this.setNodeAccess(domainId, tid, uid, node, 'lectureAllow', allow, reset);
    }
}

// 课程讲义页面
export class CourseLectureHandler extends Handler {
    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        if (!tdoc || tdoc.rule !== 'course') {
            throw new ContestNotFoundError(domainId, tid);
        }
        const isTemplate = tdoc.assign?.includes('teachers');
        const canBypassAssign = canEditCourse(this, tdoc)
            || this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK);
        if (!isTemplate && tdoc.assign?.length && !this.user.own(tdoc)
            && !isAssignedToCourse(tdoc, this.user)
            && !canBypassAssign) {
            throw new NotAssignedError('course', tdoc.docId);
        }
    }

    async readableLecture(domainId: string, tid: ObjectId, id: number, edit = false) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        let tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        const node = tdoc.dag.find((n) => n._id === id);
        if (!node) throw new ValidationError('id', id, '节点不存在');
        if (tsdoc?.attend) {
            await updateAllowedNodes(domainId, tid, this.user._id, tdoc, tsdoc);
            tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        }

        // 权限检查
        if (!canEditCourse(this, tdoc)) {
            if (edit) throw new ForbiddenError();
            if (!canViewCourseLecture(this, tdoc, node, tsdoc)) throw new ForbiddenError('讲义尚未开放。');
        }
        return { tdoc, tsdoc, node };
    }

    @param('tid', Types.ObjectId)
    @param('id', Types.PositiveInt)
    @param('edit', Types.Boolean)
    @param('pjax', Types.Boolean)
    async get(domainId: string, tid: ObjectId, id: number, edit = false, pjax = false) {
        const { tdoc, tsdoc, node } = await this.readableLecture(domainId, tid, id, edit);

        const lectureContent = (tdoc.lecture?.[id] || tdoc.lecture?.[String(id)] || '')
            .replace(/\(file:\/\//g, '(../file/')
            .replace(/="file:\/\//g, '="../file/');

        const storedLectureMeta = tdoc.lectureMeta?.[id]
            || tdoc.lectureMeta?.[String(id) as any];
        const lectureMeta = storedLectureMeta || {
            editor: tdoc.owner,
            updateAt: tdoc._id.getTimestamp(),
        };
        const uids = Array.from(new Set([tdoc.owner, (tdoc as any).editor, lectureMeta.editor].filter(Boolean)));
        const udict = uids.length ? await UserModel.getListForRender(domainId, uids, ['displayName']) : {};
        const body = {
            tdoc,
            tsdoc,
            id,
            node,
            lecture: lectureContent,
            lectureMeta,
            edit,
            preventCopy: this.ctx.setting?.get?.('course.preventCopy'),
            files: sortFiles(tdoc.files || []),
            urlForFile: (filename: string) => this.url('course_file_download', { tid, filename }),
            page_name: 'course_lecture',
            udict,
        };

        if (edit) {
            body.page_name = 'contest_manage';
        }

        if (pjax) {
            this.response.body = {
                fragments: (await Promise.all([
                    this.renderHTML('partials/files.html', body),
                ])).map((html) => ({ html })),
            };
            this.response.template = '';
        } else {
            this.response.template = 'course_lecture.html';
            this.response.body = body;
        }
    }

    @param('tid', Types.ObjectId)
    @param('id', Types.PositiveInt)
    @param('content', Types.Content)
    @param('quote', Types.String, true)
    async postFeedback(domainId: string, tid: ObjectId, id: number, content: string, quote = '') {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { tdoc, node } = await this.readableLecture(domainId, tid, id);
        FeedbackModel.validateText(content);
        FeedbackModel.validateText(quote, 'quote', true);
        await this.limitRate('feedback_create_minute', 60, 3, '{{user}}');
        await this.limitRate('feedback_create_hour', 3600, 20, '{{user}}');
        this.back(await FeedbackModel.create(domainId, this.user._id, {
            type: 'lecture', tid, nodeId: id,
            title: `${tdoc.title} / ${node.lecture || id}`,
        }, content, quote));
    }

    @param('tid', Types.ObjectId)
    @param('id', Types.PositiveInt)
    @param('lecture', Types.Content)
    async postUpdate(domainId: string, tid: ObjectId, id: number, lecture: string) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        const user = (this as any).user;

        if (!canEditCourse(this, tdoc)) throw new ForbiddenError();

        await ContestModel.edit(domainId, tid, {
            [`lecture.${id}`]: lecture,
            [`lectureMeta.${id}`]: { editor: user._id, updateAt: new Date() },
        } as Partial<CourseTdoc>);
        this.response.redirect = this.url('course_lecture', { tid, id });
    }

    @param('tid', Types.ObjectId)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, tid: ObjectId, filename: string) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        if (!canEditCourse(this, tdoc)) throw new ForbiddenError();

        const remainingFiles = (tdoc.files || []).filter((file) => file.name !== filename);
        if (remainingFiles.length >= SystemModel.get('limit.contest_files')) {
            throw new ForbiddenError('文件数量已达上限');
        }

        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');

        const totalSize = remainingFiles.reduce((sum, f) => sum + f.size, 0) + file.size;
        if (totalSize >= SystemModel.get('limit.contest_files_size')) {
            throw new ForbiddenError('文件总大小已达上限');
        }

        await StorageModel.put(`contest/${domainId}/${tid}/public/${filename}`, file.filepath, this.user._id);
        const meta = await StorageModel.getMeta(`contest/${domainId}/${tid}/public/${filename}`);

        if (!meta) throw new BadRequestError('文件上传失败');

        const fileDoc = {
            _id: filename,
            name: filename,
            ..._.pick(meta, ['size', 'lastModified', 'etag']),
        };

        await ContestModel.edit(domainId, tid, {
            files: [...remainingFiles, fileDoc],
        });

        this.back();
    }

    @param('tid', Types.ObjectId)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, tid: ObjectId, files: string[]) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        if (!canEditCourse(this, tdoc)) throw new ForbiddenError();

        await Promise.all([
            StorageModel.del(files.map((f) => `contest/${domainId}/${tid}/public/${f}`), this.user._id),
            ContestModel.edit(domainId, tid, {
                files: tdoc.files?.filter((f) => !files.includes(f.name)),
            }),
        ]);

        this.back();
    }
}

export class CourseProblemReferenceHandler extends Handler {
    tdoc!: CourseTdoc;
    pdoc: any;
    tsdoc: any;
    canEdit = false;

    @param('tid', Types.ObjectId)
    @param('pid', Types.UnsignedInt)
    async prepare(domainId: string, tid: ObjectId, pid: number) {
        this.tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        if (this.tdoc.rule !== 'course') throw new ContestNotFoundError(domainId, tid);

        const canBypassAssign = this.user.hasPerm(
            PERM.PERM_CREATE_HOMEWORK,
            PERM.PERM_VIEW_HIDDEN_HOMEWORK,
        );
        const userIdStr = this.user._id.toString();
        const isInAssign = this.tdoc.assign?.some((g: string) => this.user.group?.includes(g) || g === userIdStr);
        if (this.tdoc.assign?.length && !this.user.own(this.tdoc) && !isInAssign && !canBypassAssign) {
            throw new NotAssignedError('course', this.tdoc.docId);
        }

        this.pdoc = await ProblemModel.get(domainId, pid);
        if (!this.pdoc) throw new ProblemNotFoundError(domainId, pid);
        const inCourse = this.tdoc.dag?.some((node) => node.pids?.includes(pid));
        if (!inCourse) throw new ProblemNotFoundError(domainId, pid);

        this.tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        this.canEdit = this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK);

        const accepted = this.tsdoc?.detail?.[pid]?.status === STATUS.STATUS_ACCEPTED;
        if (!this.canEdit && !accepted) throw new ForbiddenError('通过后才可查看参考代码。');
    }

    @param('tid', Types.ObjectId)
    @param('pid', Types.UnsignedInt)
    async get(domainId: string, tid: ObjectId, pid: number) {
        const refs = await getReferenceCodeSolutions(domainId, this.pdoc);
        const uids = Array.from(new Set([
            this.pdoc.owner,
            this.tdoc.owner,
            ...refs.map((doc: any) => doc.owner),
        ].filter(Boolean)));
        const udict = uids.length ? await UserModel.getListForRender(domainId, uids, ['displayName']) : {};
        this.response.template = 'course_problem_reference.html';
        this.response.body = {
            page_name: 'course_problem_reference',
            tdoc: this.tdoc,
            tsdoc: this.tsdoc,
            pdoc: this.pdoc,
            refs,
            udict,
            canEdit: this.canEdit,
            currentDomainId: domainId,
            canViewCourseReference: true,
            tid,
            pid,
        };
    }

    @param('tid', Types.ObjectId)
    @param('pid', Types.UnsignedInt)
    @param('content', Types.Content)
    async postSubmit(domainId: string, tid: ObjectId, pid: number, content: string) {
        if (!this.canEdit) throw new ForbiddenError('仅教师可编辑参考代码。');
        await DocumentModel.add(
            domainId,
            content,
            this.user._id,
            DocumentModel.TYPE_PROBLEM_SOLUTION,
            null,
            DocumentModel.TYPE_PROBLEM,
            pid,
            { reply: [], vote: 0, title: REFERENCE_CODE_TITLE },
        );
        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('pid', Types.UnsignedInt)
    @param('psid', Types.ObjectId)
    @param('content', Types.Content)
    async postEditSolution(domainId: string, tid: ObjectId, pid: number, psid: ObjectId, content: string) {
        if (!this.canEdit) throw new ForbiddenError('仅教师可编辑参考代码。');
        const psdoc = await SolutionModel.get(domainId, psid);
        if (psdoc.parentId !== pid || !isReferenceCodeSolution(psdoc)) {
            throw new ForbiddenError('只能编辑参考代码。');
        }
        await SolutionModel.edit(domainId, psid, content);
        if (psdoc.title !== REFERENCE_CODE_TITLE) {
            await DocumentModel.set(domainId, DocumentModel.TYPE_PROBLEM_SOLUTION, psid, { title: REFERENCE_CODE_TITLE } as any);
        }
        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('pid', Types.UnsignedInt)
    @param('psid', Types.ObjectId)
    async postDeleteSolution(domainId: string, tid: ObjectId, pid: number, psid: ObjectId) {
        if (!this.canEdit) throw new ForbiddenError('仅教师可编辑参考代码。');
        const psdoc = await SolutionModel.get(domainId, psid);
        if (psdoc.parentId !== pid || !isReferenceCodeSolution(psdoc)) {
            throw new ForbiddenError('只能删除参考代码。');
        }
        await SolutionModel.del(domainId, psid);
        this.back();
    }
}

// 课程文件下载
export class CourseFileDownloadHandler extends Handler {
    @param('tid', Types.ObjectId)
    @param('filename', Types.Filename)
    @param('noDisposition', Types.Boolean)
    async get(domainId: string, tid: ObjectId, filename: string, noDisposition = false) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        const tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        if (!canEditCourse(this, tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK) && !tsdoc?.attend) {
            throw new ForbiddenError();
        }

        this.response.addHeader('Cache-Control', 'public');

        const path = `contest/${domainId}/${tid}/public/${filename}`;
        const meta = await StorageModel.getMeta(path);

        await OplogModel.log(this, 'download.file.contest', {
            target: path,
            size: meta?.size || 0,
        });

        this.response.redirect = await StorageModel.signDownloadLink(
            path,
            noDisposition ? undefined : filename,
            false,
            'user',
        );
    }
}

// 课程成绩板
export class CourseScoreboardHandler extends Handler {
    @param('tid', Types.ObjectId)
    @param('id', Types.UnsignedInt)
    @param('ext', Types.Range(['csv', 'html', 'ghost']), true)
    async get(domainId: string, tid: ObjectId, id: number, ext = '') {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        const tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);

        const isEditor = canEditCourse(this, tdoc);
        if (!isEditor) {
            if (tdoc.publicScoreboard === false) {
                throw new ForbiddenError((this as any).translate('You are not allowed to view the scoreboard.'));
            }
            if (!this.user.hasPerm(PERM.PERM_VIEW_HOMEWORK_SCOREBOARD)) {
                throw new ForbiddenError((this as any).translate('You are not allowed to view the scoreboard.'));
            }
            if (!tsdoc?.attend) {
                throw new ForbiddenError((this as any).translate('You are not allowed to view the scoreboard.'));
            }
            if (ContestModel.isNotStarted(tdoc)) {
                throw new ForbiddenError((this as any).translate('This course is not live.'));
            }
        }

        const assessmentNode = tdoc.dag?.find((node) => node._id === id);
        if (assessmentNode?.kind === 'assessment' && assessmentNode.assessment?.contestTid) {
            if (!canEditCourse(this, tdoc)) throw new ForbiddenError('无权限查看课堂测试成绩板');
            const contestTid = new ObjectId(assessmentNode.assessment.contestTid);
            this.response.redirect = ext
                ? this.url('contest_scoreboard_view', { tid: contestTid, view: ext })
                : this.url('contest_scoreboard', { tid: contestTid });
            return;
        }
        if (ext) {
            await this.exportScoreboard(domainId, tid, id, ext);
            return;
        }

        const pids = id ? (tdoc.dag.find((n) => n._id === id)?.pids || []) : [];
        const audience = await getCourseAudience(domainId, tdoc);
        const config = {
            isExport: false,
            id,
            showDisplayName: this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO),
            currentUid: this.user._id,
            ...audience,
        };

        const [, rows, udict, pdict] = await getScoreboard(this, domainId, tid, config, pids);
        const feedbackEnabled = await canManageFeedback(this, tdoc);

        this.response.pjax = 'partials/scoreboard.html';
        this.response.template = 'contest_scoreboard.html';
        this.response.body = {
            tdoc,
            tsdoc,
            rows,
            udict,
            pdict,
            page_name: 'contest_scoreboard',
            courseProblemAccessNodeIds: problemAccessNodeIds(tdoc),
            feedbackUrl: feedbackEnabled ? this.url('course_feedback', { tid }) : null,
            feedbackNodeId: id || null,
            feedbackRoster: feedbackEnabled ? audience.studentUids : [],
        };
    }

    async exportScoreboard(domainId: string, tid: ObjectId, id: number, ext: string) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;

        // 权限检查：学生（非编辑权限）禁止导出成绩板
        if (!canEditCourse(this, tdoc)) {
            throw new ForbiddenError((this as any).translate('Students are not allowed to export the scoreboard.'));
        }

        await (this as any).limitRate('scoreboard_download', 60, 3);

        const exporters: Record<string, (rows: any[], tdoc: any) => Promise<string>> = {
            csv: async (rows) => `\uFEFF${rows.map(
                (row) => row.map((cell: any) => cell.value?.toString().replace(/\n/g, ' ')).join(','),
            ).join('\n')}`,
            html: async (rows, doc) => this.renderHTML('contest_scoreboard_download_html.html', { rows, tdoc: doc }) as any as Promise<string>,
        };

        const pids = id ? (tdoc.dag.find((n) => n._id === id)?.pids || []) : [];
        const audience = await getCourseAudience(domainId, tdoc);
        const config = {
            isExport: true,
            id,
            showDisplayName: this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO),
            currentUid: this.user._id,
            ...audience,
        };

        const [, rows] = await getScoreboard(this, domainId, tid, config, pids);
        (this as any).binary(await exporters[ext](rows, tdoc), `${tdoc.title}.${ext}`);
    }
}
