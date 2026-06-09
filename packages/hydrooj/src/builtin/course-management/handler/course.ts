import assert from 'assert';
import {
    _, BadRequestError, ContestModel, ContestNotFoundError, ContestScoreboardHiddenError,
    DocumentModel, ForbiddenError, Handler, moment, NotAssignedError, ObjectId, OplogModel,
    param, PERM, post, ProblemModel, ProblemNotFoundError, sortFiles, StorageModel, SystemModel,
    SolutionModel, STATUS, Types, UserModel, ValidationError,
} from '../../../plugin-api';
import bus from '../../../service/bus';
import { DEFAULT_COURSE_LESSON_DURATION_HOURS } from '../model/course';
import type { CourseTdoc, DagNode } from '../model/course';
import { ClassModel } from '../model/class';

const REFERENCE_CODE_TITLE = '【参考代码】';
const TEMPLATE_ALL_KEY = 'templates::__all';
const TEMPLATE_UNCATEGORIZED_KEY = 'templates::__uncategorized';

function fillMessage(template: string, ...params: Array<string | number>) {
    return template.replace(/\{(\d+)\}/g, (_, index) => String(params[Number(index)] ?? ''));
}

function isReferenceCodeSolutionByContent(content = '') {
    const firstLine = content.split(/\r?\n/).find((line) => line.trim());
    if (!firstLine) return false;
    const title = firstLine.trim().replace(/^#+\s*/, '');
    return title.startsWith(REFERENCE_CODE_TITLE);
}

function isReferenceCodeSolution(doc: any) {
    return doc?.title === REFERENCE_CODE_TITLE || isReferenceCodeSolutionByContent(doc?.content || '');
}

function normalizeTemplateIds(templateIds: any) {
    const values = Array.isArray(templateIds) ? templateIds : [templateIds];
    return Array.from(new Set(values
        .flatMap((id) => (id === undefined || id === null ? '' : String(id)).split(','))
        .map((id) => id.trim())
        .filter(Boolean)));
}

// 检查前置章节完成情况（按当前节点 completeCondition 聚合判断）
function checkPrerequisitesComplete(tsdoc: any, node: DagNode, tdoc: CourseTdoc): boolean {
    if (!tsdoc) {
        console.log(`[checkPrerequisitesComplete] tsdoc is null/undefined`);
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
        acceptCount += tsdoc.accept?.[nid] ?? 0;
        totalScore += tsdoc.score?.[nid] ?? 0;
        totalPids += reqNode.pids?.length || 0;
    }

    const condition = node.completeCondition || { type: 'all' };
    console.log(`[checkPrerequisitesComplete] node ${node._id}: acceptCount=${acceptCount}, totalScore=${totalScore}, totalPids=${totalPids}, condition=${JSON.stringify(condition)}`);

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
    console.log(`[updateAllowedNodes] tsdoc:`, JSON.stringify({
        attend: tsdoc?.attend,
        accept: tsdoc?.accept,
        allow: tsdoc?.allow,
        uid: tsdoc?.uid,
    }));
    
    if (!tsdoc?.attend) {
        console.log(`[updateAllowedNodes] tsdoc not found or not attended, returning`);
        return;
    }
    
    const allow = tsdoc?.allow || {};
    let updated = false;

    // 如果没有DAG，所有章节默认开放（如果被手工禁止则需要手工允许）
    if (!tdoc.dag || tdoc.dag.length === 0) {
        console.log(`[updateAllowedNodes] no DAG, returning`);
        return;
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
            updated = true;
            continue;
        }

        console.log(`[updateAllowedNodes] node ${node._id} has requirements: ${JSON.stringify(node.requireNids)}`);
        
        const allRequirementsMet = checkPrerequisitesComplete(tsdoc || {}, node, tdoc);

        console.log(`[updateAllowedNodes] node ${node._id} allRequirementsMet: ${allRequirementsMet}`);

        if (allRequirementsMet) {
            console.log(`[updateAllowedNodes] setting node ${node._id} to true`);
            allow[node._id] = true;
            updated = true;
        }
    }

    if (updated) {
        console.log(`[updateAllowedNodes] updating allow:`, JSON.stringify(allow));
        await ContestModel.setStatus(domainId, tid, uid, { allow, attend: true });
    } else {
        console.log(`[updateAllowedNodes] no updates needed`);
    }
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

        for (const node of dag) {
            assert(node._id, 'each node should have a _id');
            assert(node.title, 'each node shoule have a title');
            assert(node.pids instanceof Array);
            // 允许空题目：如果 pids 为空数组，则不强制要求有题目

            if (node.completeCondition) {
                assert(typeof node.completeCondition === 'object', 'completeCondition must be an object');
                assert(
                    ['all', 'problem', 'score'].includes(node.completeCondition.type),
                    'completeCondition type must be all, problem or score',
                );
                if (node.completeCondition.type === 'all') {
                    assert(!node.completeCondition.value, 'completeCondition value must not be set when type is all');
                } else {
                    assert(node.completeCondition.value, 'completeCondition value must be set when type is not all');
                }
            }

            for (const nid of node.requireNids || []) {
                assert(nodeIds.has(nid), `required nid ${nid} not found`);
                assert(Number.isSafeInteger(nid), 'required nid must be a number');
            }

            // 验证并转换题目 ID
            const pids: number[] = [];
            for (const i in node.pids) {
                const pdoc = await ProblemModel.get(domainId, node.pids[i]);
                if (!pdoc) throw new ProblemNotFoundError(domainId, node.pids[i]);
                pids.push(pdoc.docId);
            }

            result.push({
                _id: +node._id,
                title: node.title,
                lecture: node.lecture || false,
                pids: Array.from(new Set(pids)),
                ...(node.requireNids ? { requireNids: Array.from(new Set(node.requireNids)) } : {}),
                completeCondition: node.completeCondition || { type: 'all' },
            });
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

function getCourseOrderStatus(course: any, now: Date) {
    if (course.beginAt.getTime() > now.getTime()) return 0;
    if (course.endAt.getTime() < now.getTime()) return 2;
    return 1;
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

function compareCoursePriorityTime(a: any, b: any, now: Date) {
    const aStatus = getCourseOrderStatus(a, now);
    const bStatus = getCourseOrderStatus(b, now);
    if (aStatus !== bStatus) return aStatus - bStatus;

    const beginDiff = a.beginAt.getTime() - b.beginAt.getTime();
    if (beginDiff !== 0) {
        return aStatus === 0 ? beginDiff : -beginDiff;
    }

    return 0;
}

function compareCourses(a: any, b: any, now: Date) {
    const aStatus = getCourseOrderStatus(a, now);
    const bStatus = getCourseOrderStatus(b, now);
    if (aStatus !== bStatus) return aStatus - bStatus;

    const beginDiff = a.beginAt.getTime() - b.beginAt.getTime();
    if (beginDiff !== 0) {
        return aStatus === 0 ? beginDiff : -beginDiff;
    }

    const titleDiff = compareCourseTitle(a, b);
    if (titleDiff !== 0) return titleDiff;

    const endDiff = a.endAt.getTime() - b.endAt.getTime();
    if (endDiff !== 0) {
        return aStatus === 0 ? endDiff : -endDiff;
    }

    return String(a.docId).localeCompare(String(b.docId));
}

function getTemplateCategory(assign: string[] = []) {
    const category = assign.includes('teachers') ? assign[1] : '';
    return (category || '').trim();
}

function getTemplateCategoryKey(course: any) {
    return course.templateCategory ? `templates::${course.templateCategory}` : TEMPLATE_UNCATEGORIZED_KEY;
}

function groupAndSortCourses(courseList: any[], now: Date) {
    const groups = _.groupBy(courseList, 'assignGroup');
    Object.keys(groups).forEach((key) => {
        groups[key].sort((a, b) => compareCourses(a, b, now));
    });

    const sortedGroups = Object.entries(groups)
        .map(([key, list]) => ({ key, tdocs: list }))
        .sort((a, b) => {
            const courseDiff = compareCoursePriorityTime(a.tdocs[0], b.tdocs[0], now);
            if (courseDiff !== 0) return courseDiff;
            return a.key.localeCompare(b.key, 'zh-CN');
        });

    return { groups, sortedGroups };
}

function groupAndSortTemplates(templateList: any[], now: Date) {
    const sortedTemplates = [...templateList].sort((a, b) => compareCourses(a, b, now));
    const groups = _.groupBy(sortedTemplates, getTemplateCategoryKey);
    Object.keys(groups).forEach((key) => {
        groups[key].sort((a, b) => compareCourses(a, b, now));
    });
    const sortedGroups = Object.entries(groups)
        .map(([key, list]) => ({ key, tdocs: list }))
        .sort((a, b) => a.key.localeCompare(b.key, 'zh-CN'));
    if (sortedTemplates.length) sortedGroups.unshift({ key: TEMPLATE_ALL_KEY, tdocs: sortedTemplates });
    return { groups, sortedGroups };
}

function getLessonDurationHours(tdoc?: Partial<CourseTdoc>) {
    const value = Number(tdoc?.lessonDurationHours);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_COURSE_LESSON_DURATION_HOURS;
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
        this.response.redirect = this.url('course_main');
    }

    @param('templateIds', Types.Any)
    @param('templateCategory', Types.String)
    async postBatchSetTemplateCategory(domainId: string, templateIds: any, templateCategory: string) {
        await this.updateTemplateCategories(domainId, templateIds, (templateCategory || '').trim());
    }

    @param('templateIds', Types.Any)
    async postBatchClearTemplateCategory(domainId: string, templateIds: any) {
        await this.updateTemplateCategories(domainId, templateIds, '');
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
            .project({ _id: 1, docId: 1, title: 1, beginAt: 1, endAt: 1, assign: 1, rule: 1, owner: 1, editor: 1, updateAt: 1 })
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
            .project({ _id: 1, docId: 1, title: 1, beginAt: 1, endAt: 1, assign: 1, rule: 1, owner: 1, editor: 1, updateAt: 1 })
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
        const canBypassAssign = this.user.hasPerm(
            PERM.PERM_EDIT_HOMEWORK,
            PERM.PERM_EDIT_HOMEWORK_SELF,
            PERM.PERM_VIEW_HIDDEN_HOMEWORK,
        );
        const userIdStr = this.user._id.toString();
        const isInAssign = this.tdoc.assign?.some((g: string) => this.user.group?.includes(g) || g === userIdStr);
        if (!isTemplate && this.tdoc.assign?.length && !this.user.own(this.tdoc)
            && !isInAssign
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
        const isTeacherEditor = this.user.own(this.tdoc)
            || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK);
        const canViewAllProblems = isTeacherEditor || this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK);

        // 如果是临时学生且尚未建状态，自动加入并复制当前开放的章节/讲义状态
        const userIdStr = this.user._id.toString();
        const isExtraStudent = this.tdoc.assign?.some((g: string) => g === userIdStr);
        if (!tsdoc && isExtraStudent) {
            const tsdocs = await ContestModel.getMultiStatus(domainId, { docId: tid }).toArray();
            const mergedAllow: Record<number, boolean> = {};
            const mergedLectureAllow: Record<number, boolean> = {};
            for (const t of tsdocs) {
                Object.entries(t.allow || {}).forEach(([k, v]) => {
                    if (v) mergedAllow[+k] = true;
                });
                Object.entries(t.lectureAllow || {}).forEach(([k, v]) => {
                    if (v) mergedLectureAllow[+k] = true;
                });
            }
            await ContestModel.attend(domainId, tid, this.user._id);
            await ContestModel.setStatus(domainId, tid, this.user._id, {
                attend: true,
                allow: mergedAllow,
                lectureAllow: mergedLectureAllow,
            });
            tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        }

        // 普通学生首次访问且已分配到课程时自动加入（attend）
        const isInAssign = this.tdoc.assign?.some((g: string) => this.user.group?.includes(g) || g === userIdStr);
        if (!tsdoc && isInAssign && !isTemplate) {
            await ContestModel.attend(domainId, tid, this.user._id);
            tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        }

        // 如果用户未加入且有编辑权限，自动加入
        if (!tsdoc && this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK, PERM.PERM_EDIT_HOMEWORK_SELF)) {
            await ContestModel.attend(domainId, tid, this.user._id);
            tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        }

        const uids = Array.from(new Set([this.tdoc.owner, (this.tdoc as any).editor].filter(Boolean)));
        const udict = await UserModel.getListForRender(domainId, uids, ['displayName']);

        // 更新可访问章节
        await updateAllowedNodes(domainId, tid, this.user._id, this.tdoc, tsdoc);
        if (tsdoc) {
            tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        }

        this.response.template = 'course_detail.html';
        this.response.body = { tdoc: this.tdoc, tsdoc, udict };

        // 查看学生列表（仅管理员）
        if ((checkstu || uid) && (this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF) || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK))) {
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
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK, PERM.PERM_EDIT_HOMEWORK_SELF)
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
                await ContestModel.setStatus(domainId, tid, this.user._id, { startAt: new Date() });
                tsdoc.startAt = new Date();
            }
            for (const j of tsdoc.journal || []) {
                psdict[j.pid] = j;
            }
        }

        Object.assign(this.response.body, { pdict, psdict });
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
            if (!this.user.own(this.tdoc)) {
                this.checkPerm(PERM.PERM_EDIT_HOMEWORK);
            }
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

        this.response.body = {
            page_name: this.tdoc ? 'course_edit' : 'course_create',
            tdoc: this.tdoc,
            beginAtText: beginAt.format('YYYY-M-D H:mm'),
            endAtText: endAt.format('YYYY-M-D H:mm'),
            lessonDurationHours,
            lessonBeginAtText: lessonBeginAt.format('YYYY-M-D H:mm'),
            lessonEndAtText: lessonEndAt.format('YYYY-M-D H:mm'),
            templateCategory: getTemplateCategory(this.tdoc?.assign),
            isTemplate: isTemplate || this.tdoc?.assign?.includes('teachers'),
        };

        if (this.tdoc) {
            this.response.body.dag = JSON.stringify(this.tdoc.dag, null, 2);
            // 从 assign 中分离出纯数字字符串作为 extraStudents
            const allAssign = this.tdoc.assign || [];
            this.response.body.assign = allAssign.filter((g) => !/^\d+$/.test(g));
            this.response.body.extraStudents = allAssign
                .filter((g) => /^\d+$/.test(g))
                .map((s) => parseInt(s, 10));
        }
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
    async post(
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
    ) {
        assign = Array.from(new Set((assign || []).map((s) => (s || '').trim()).filter(Boolean)));
        templateCategory = (templateCategory || '').trim();
        const extraStudents = Array.from(new Set((extraStudentsStr || [])
            .map((s) => parseInt(s, 10))
            .filter((n) => Number.isFinite(n) && n > 0)));
        if (!isTemplate && assign.includes('teachers')) {
            throw new BadRequestError('不能分配课程给 teachers 组');
        }

        const dag = await parseDag(domainId, dagJson);
        const pids = Array.from(new Set(dag.flatMap((n) => n.pids)));

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

        const editor = this.user._id;
        const updateAt = new Date();
        const editingTemplate = !!this.tdoc?.assign?.includes('teachers');
        const saveAsTemplate = !!(tid && isTemplate && !editingTemplate);
        const assignGroup = isTemplate ? 'teachers' : (assign[0] || '');

        if (isTemplate) {
            assign = ['teachers'];
            const teachersGroup = await ClassModel.getGroupByName(domainId, 'teachers');
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
            }
        } else if (assign.length) {
            const group = await ClassModel.getGroupByName(domainId, assign[0]);
            if (!group) throw new BadRequestError('班级不存在');
            if (group.archive) throw new BadRequestError('班级已归档');
        }

        if ((!tid || saveAsTemplate) && assignGroup) {
            await ensureCourseTitleAvailable(domainId, title, assignGroup, undefined, (this as any).translate?.bind(this));
        }

        if (tid && !saveAsTemplate) {
            await ContestModel.edit(domainId, tid, {
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
            });
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
        }

        // 合并 extraStudents 到 assign（转为字符串）
        // 先过滤掉 assign 中旧的数字字符串（之前的 extraStudents），再添加新的
        const nonDigitAssign = isTemplate
            ? []
            : assign.filter((g: string) => !/^\d+$/.test(g));
        const finalAssign = isTemplate
            ? (templateCategory ? ['teachers', templateCategory] : ['teachers'])
            : [...nonDigitAssign, ...extraStudents.map((s) => s.toString())];

        await ContestModel.edit(domainId, tid, {
            dag,
            assign: finalAssign,
            editor,
            updateAt,
            publicScoreboard,
            enablePenalty,
            lessonDurationHours: normalizedLessonDurationHours,
            lessonBeginAt: lessonBeginAt.toDate(),
            lessonEndAt: lessonEndAt.toDate(),
        });
        // 清除旧的 extraStudents 字段（已合并到 assign）
        await DocumentModel.set(domainId, DocumentModel.TYPE_CONTEST, tid, undefined, { extraStudents: '' as any });

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
        await ContestModel.del(domainId, tid);
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
            .map((s: string) => parseInt(s, 10));
        const allUids = Array.from(new Set([
            ...tsdocs.map((t) => t.uid),
            ...(group?.students || []),
            ...(extraStudents),
            (tdoc as CourseTdoc).owner,
            (tdoc as any).editor,
        ].filter(Boolean)));
        const udict = await UserModel.getListForRender(domainId, allUids, ['displayName']);

        this.response.template = 'course_manage.html';
        this.response.body = {
            page_name: 'course_manage',
            tdoc,
            tsdict,
            udict,
            group: group || { students: [] },
            extraStudents,
        };
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.Int)
    @param('unrank', Types.Boolean, true)
    @param('clear', Types.Boolean, true)
    async postUnrank(domainId: string, tid: ObjectId, uid: number, unrank?: boolean, clear?: boolean) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        const group = await ClassModel.getGroupByName(domainId, tdoc.assign?.[0] || '');
        const allAssign = (tdoc as CourseTdoc).assign || [];
        const extraStudents = allAssign
            .filter((g: string) => /^\d+$/.test(g))
            .map((s: string) => parseInt(s, 10));
        const targets = uid === 0
            ? Array.from(new Set([...(group?.students || []), ...extraStudents].filter(Boolean)))
            : [uid];

        if (!targets.length) {
            this.back();
            return;
        }

        // Ensure status exists for targets so scoreboard can read unrank consistently.
        const existing = await ContestModel.getMultiStatus(domainId, { docId: tid, uid: { $in: targets } }).toArray();
        const existingUids = new Set(existing.map((t) => t.uid));
        const toAttend = targets.filter((u) => !existingUids.has(u));
        if (toAttend.length) {
            await Promise.all(toAttend.map((u) => ContestModel.attend(domainId, tid, u)));
        }

        if (clear) {
            // Unset unrank so it falls back to default ranked behavior.
            await Promise.all(targets.map((u) => ContestModel.setStatus(domainId, tid, u, { unrank: null })));
        } else {
            await Promise.all(targets.map((u) => ContestModel.setStatus(domainId, tid, u, { unrank: !!unrank })));
        }
        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.Int)
    @param('allow', Types.Boolean)
    async postVisit(domainId: string, tid: ObjectId, uid: number, allow = false) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        const group = await ClassModel.getGroupByName(domainId, tdoc.assign?.[0] || '');

        if (group && group.students.includes(uid)) {
            if (allow) {
                await ContestModel.attend(domainId, tid, uid);
            } else {
                await DocumentModel.deleteMultiStatus(domainId, DocumentModel.TYPE_CONTEST, { docId: tid, uid });
            }
        } else if (tdoc.assign?.includes(uid.toString())) {
            // 处理临时学生（UID 已作为字符串存储在 assign 中）
            if (allow) {
                await ContestModel.attend(domainId, tid, uid);
            } else {
                await DocumentModel.deleteMultiStatus(domainId, DocumentModel.TYPE_CONTEST, { docId: tid, uid });
            }
        } else if (uid === 0) {
            // 批量操作
            if (!group) throw new BadRequestError('没有找到班级');

            const existingStatus = await ContestModel.getMultiStatus(domainId, {
                docId: tid,
                uid: { $in: group.students },
            }).toArray();

            if (allow) {
                const toAdd = group.students.filter((s) => !existingStatus.some((e) => e.uid === s));
                await Promise.all(toAdd.map((s) => ContestModel.attend(domainId, tid, s)));
            } else {
                const toRemove = group.students.filter((s) => existingStatus.some((e) => e.uid === s));
                await DocumentModel.deleteMultiStatus(domainId, DocumentModel.TYPE_CONTEST, {
                    docId: tid,
                    uid: { $in: toRemove },
                });
            }
        } else {
            throw new ForbiddenError('用户不在该课程的学生名单中');
        }

        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('uid', Types.Int)
    @param('node', Types.Int)
    @param('allow', Types.Boolean, true)
    @param('reset', Types.Boolean, true)
    async postAllowUser(domainId: string, tid: ObjectId, uid: number, node: number, allow?: boolean, reset?: boolean) {
        const [tdoc, tsdocs] = await Promise.all([
            ContestModel.get(domainId, tid) as Promise<CourseTdoc>,
            ContestModel.getMultiStatus(domainId, { docId: tid }).toArray(),
        ]);

        if (!tdoc.dag.find((n) => n._id === node)) {
            throw new ValidationError('node', node, '节点不存在');
        }

        if (uid === 0) {
            // 批量操作：为所有班级学生设置权限
            const group = await ClassModel.getGroupByName(domainId, tdoc.assign?.[0] || '');
            if (!group) throw new BadRequestError('没有找到班级');
            
            // 先确保所有学生都有课程状态（attend）
            const existingUids = new Set(tsdocs.map((t) => t.uid));
            const newStudents = group.students.filter((s) => !existingUids.has(s));
            
            // 为新学生创建状态
            await Promise.all(newStudents.map((s) => ContestModel.attend(domainId, tid, s)));
            
            // 重新获取所有状态
            const allTsdocs = await ContestModel.getMultiStatus(domainId, { docId: tid }).toArray();
            
            // 为所有学生设置节点权限
            await Promise.all(allTsdocs.map((tsdoc) => {
                let newAllow;
                if (reset) {
                    // 重置：删除该节点的状态
                    const { [node]: _, ...rest } = tsdoc?.allow || {};
                    newAllow = rest;
                } else {
                    newAllow = { ...tsdoc?.allow || {}, [node]: allow };
                }
                return ContestModel.setStatus(domainId, tid, tsdoc.uid, { allow: newAllow });
            }));
        } else {
            const tsdoc = tsdocs.find((t) => t.uid === uid);
            let newAllow;
            if (reset) {
                // 重置：删除该节点的状态
                const { [node]: _, ...rest } = tsdoc?.allow || {};
                newAllow = rest;
            } else {
                newAllow = { ...tsdoc?.allow || {}, [node]: allow };
            }
            await ContestModel.setStatus(domainId, tid, uid, { allow: newAllow });
        }

        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('node', Types.PositiveInt)
    @param('uid', Types.Int)
    @param('allow', Types.Boolean, true)
    @param('reset', Types.Boolean, true)
    async postAllowLecture(domainId: string, tid: ObjectId, node: number, uid: number, allow?: boolean, reset?: boolean) {
        const [tdoc, tsdocs] = await Promise.all([
            ContestModel.get(domainId, tid) as Promise<CourseTdoc>,
            ContestModel.getMultiStatus(domainId, { docId: tid }).toArray(),
        ]);

        if (!tdoc.dag.find((n) => n._id === node)) {
            throw new ValidationError('node', node, '节点不存在');
        }

        if (uid === 0) {
            // 批量操作：为所有班级学生设置权限
            const group = await ClassModel.getGroupByName(domainId, tdoc.assign?.[0] || '');
            if (!group) throw new BadRequestError('没有找到班级');
            
            // 先确保所有学生都有课程状态（attend）
            const existingUids = new Set(tsdocs.map((t) => t.uid));
            const newStudents = group.students.filter((s) => !existingUids.has(s));
            
            // 为新学生创建状态
            await Promise.all(newStudents.map((s) => ContestModel.attend(domainId, tid, s)));
            
            // 重新获取所有状态
            const allTsdocs = await ContestModel.getMultiStatus(domainId, { docId: tid }).toArray();
            
            // 为所有学生设置讲义权限
            await Promise.all(allTsdocs.map((tsdoc) => {
                let newLectureAllow;
                if (reset) {
                    // 重置：删除该节点的状态
                    const { [node]: _, ...rest } = tsdoc?.lectureAllow || {};
                    newLectureAllow = rest;
                } else {
                    newLectureAllow = { ...tsdoc?.lectureAllow || {}, [node]: allow };
                }
                return ContestModel.setStatus(domainId, tid, tsdoc.uid, { lectureAllow: newLectureAllow });
            }));
        } else {
            const tsdoc = tsdocs.find((t) => t.uid === uid);
            let newLectureAllow;
            if (reset) {
                // 重置：删除该节点的状态
                const { [node]: _, ...rest } = tsdoc?.lectureAllow || {};
                newLectureAllow = rest;
            } else {
                newLectureAllow = { ...tsdoc?.lectureAllow || {}, [node]: allow };
            }
            await ContestModel.setStatus(domainId, tid, uid, { lectureAllow: newLectureAllow });
        }

        this.back();
    }
}

// 课程讲义页面
export class CourseLectureHandler extends Handler {
    @param('tid', Types.ObjectId)
    async prepare(domainId: string, tid: ObjectId) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        if (tdoc.rule !== 'course') {
            throw new ContestNotFoundError(domainId, tid);
        }
        const isTemplate = tdoc.assign?.includes('teachers');
        const canBypassAssign = this.user.hasPerm(
            PERM.PERM_EDIT_HOMEWORK,
            PERM.PERM_EDIT_HOMEWORK_SELF,
            PERM.PERM_VIEW_HIDDEN_HOMEWORK,
        );
        // 检查用户是否在 assign 中（assign 已包含 extraStudents）
        const userIdStr = this.user._id.toString();
        const isInAssign = tdoc.assign?.some((g: string) => this.user.group?.includes(g) || g === userIdStr);
        if (!isTemplate && tdoc.assign?.length && !this.user.own(tdoc)
            && !isInAssign
            && !canBypassAssign) {
            throw new NotAssignedError('course', tdoc.docId);
        }
    }

    @param('tid', Types.ObjectId)
    @param('id', Types.PositiveInt)
    @param('edit', Types.Boolean)
    @param('pjax', Types.Boolean)
    async get(domainId: string, tid: ObjectId, id: number, edit = false, pjax = false) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        const tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);

        // 权限检查
        if (!this.user.own(tdoc)
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)) {
            if (edit) throw new ForbiddenError();
            const lectureFlag = tsdoc?.lectureAllow?.[id];
            if (lectureFlag === false || lectureFlag === 0) throw new ForbiddenError('讲义尚未开放。');
        }

        const node = tdoc.dag.find((n) => n._id === id);
        const lectureContent = (tdoc.lecture?.[id] || '')
            .replace(/\(file:\/\//g, '(../file/')
            .replace(/="file:\/\//g, '="../file/');

        const uids = Array.from(new Set([tdoc.owner, (tdoc as any).editor].filter(Boolean)));
        const udict = uids.length ? await UserModel.getListForRender(domainId, uids, ['displayName']) : {};
        const body = {
            tdoc,
            tsdoc,
            id,
            node,
            lecture: lectureContent,
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
    @param('lecture', Types.Content)
    async postUpdate(domainId: string, tid: ObjectId, id: number, lecture: string) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;
        const user = (this as any).user;

        if (user.own(tdoc)) {
            if (!user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF) && !user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) {
                throw new ForbiddenError();
            }
        } else {
            if (!user.hasPerm(PERM.PERM_EDIT_HOMEWORK)) {
                throw new ForbiddenError();
            }
        }

        const lectureData = tdoc.lecture || {};
        lectureData[id] = lecture;

        await ContestModel.edit(domainId, tid, { lecture: lectureData });
        this.response.redirect = this.url('course_lecture', { tid, id });
    }

    @param('tid', Types.ObjectId)
    @post('filename', Types.Filename, true)
    async postUploadFile(domainId: string, tid: ObjectId, filename: string) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;

        if ((tdoc.files?.length || 0) >= SystemModel.get('limit.contest_files')) {
            throw new ForbiddenError('文件数量已达上限');
        }

        const file = this.request.files?.file;
        if (!file) throw new ValidationError('file');

        const totalSize = Math.sum((tdoc.files || []).map((f) => f.size)) + file.size;
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
            files: [...(tdoc.files || []), fileDoc],
        });

        this.back();
    }

    @param('tid', Types.ObjectId)
    @post('files', Types.ArrayOf(Types.Filename))
    async postDeleteFiles(domainId: string, tid: ObjectId, files: string[]) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;

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
            PERM.PERM_EDIT_HOMEWORK,
            PERM.PERM_EDIT_HOMEWORK_SELF,
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
        this.canEdit = this.user.own(this.tdoc)
            || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
            || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF);

        const accepted = this.tsdoc?.detail?.[pid]?.status === STATUS.STATUS_ACCEPTED;
        if (!this.canEdit && !accepted) throw new ForbiddenError('通过后才可查看参考代码。');
    }

    @param('tid', Types.ObjectId)
    @param('pid', Types.UnsignedInt)
    async get(domainId: string, tid: ObjectId, pid: number) {
        const refs = (await SolutionModel.getMulti(domainId, pid).toArray())
            .filter((doc: any) => isReferenceCodeSolution(doc))
            .sort((a: any, b: any) => a._id.getTimestamp().getTime() - b._id.getTimestamp().getTime());
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
        const tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        if (!tsdoc) throw new ForbiddenError();

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

        const isEditor = this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
            || this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
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

        if (ext) {
            await this.exportScoreboard(domainId, tid, id, ext);
            return;
        }

        const pids = id ? (tdoc.dag.find((n) => n._id === id)?.pids || []) : [];
        const config = {
            isExport: false,
            id,
            showDisplayName: this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO),
        };

        const [, rows, udict, pdict] = await getScoreboard(this, domainId, tid, config, pids);

        this.response.template = 'contest_scoreboard.html';
        this.response.body = {
            tdoc,
            tsdoc,
            rows,
            udict,
            pdict,
            page_name: 'contest_scoreboard',
        };
    }

    async exportScoreboard(domainId: string, tid: ObjectId, id: number, ext: string) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;

        // 权限检查：学生（非编辑权限）禁止导出成绩板
        if (!this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)) {
            throw new ForbiddenError((this as any).translate('Students are not allowed to export the scoreboard.'));
        }

        await (this as any).limitRate('scoreboard_download', 60, 3);

        const exporters: Record<string, (rows: any[], tdoc: any) => Promise<string>> = {
            csv: async (rows) => `\uFEFF${rows.map((row) => row.map((cell: any) => cell.value?.toString().replace(/\n/g, ' ')).join(',')).join('\n')}`,
            html: async (rows, doc) => this.renderHTML('contest_scoreboard_download_html.html', { rows, tdoc: doc }) as any as Promise<string>,
        };

        const pids = id ? (tdoc.dag.find((n) => n._id === id)?.pids || []) : [];
        const config = {
            isExport: true,
            id,
            showDisplayName: this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO),
        };

        const [, rows] = await getScoreboard(this, domainId, tid, config, pids);
        (this as any).binary(await exporters[ext](rows, tdoc), `${tdoc.title}.${ext}`);
    }
}
