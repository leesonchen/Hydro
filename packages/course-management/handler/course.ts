import assert from 'assert';
import {
    _, BadRequestError, ContestModel, ContestNotFoundError, ContestScoreboardHiddenError,
    DocumentModel, ForbiddenError, Handler, moment, NotAssignedError, ObjectId, OplogModel,
    param, PERM, post, ProblemModel, ProblemNotFoundError, sortFiles, StorageModel, SystemModel,
    Types, UserModel, ValidationError,
} from 'hydrooj';
import bus from 'hydrooj/src/service/bus';
import type { CourseTdoc, DagNode } from '../model/course';
import { ClassModel } from '../model/class';

// 检查章节是否完成
function checkNodeComplete(tsdoc: any, node: DagNode): boolean {
    if (!tsdoc) return false;
    if (!node.pids?.length) return false;

    const acceptCount = tsdoc.accept?.[node._id] ?? 0;
    const totalScore = tsdoc.score?.[node._id] ?? 0;

    if (node.completeCondition?.type === 'all') {
        return acceptCount >= node.pids.length;
    }
    if (node.completeCondition?.type === 'problem') {
        return acceptCount >= (node.completeCondition.value || 0);
    }
    if (node.completeCondition?.type === 'score') {
        return totalScore >= (node.completeCondition.value || 0);
    }
    return false;
}

// 更新用户可访问的章节
export async function updateAllowedNodes(
    domainId: string,
    tid: ObjectId,
    uid: number,
    tdoc: CourseTdoc,
    tsdoc: any,
) {
    if (!tsdoc?.attend) return;
    const allow = tsdoc?.allow || {};
    let updated = false;

    for (const node of tdoc.dag) {
        if (allow[node._id]) continue;
        if (!node.requireNids || !node.requireNids.length) continue;

        const allRequirementsMet = node.requireNids!.every((nid) => {
            const reqNode = tdoc.dag.find((n) => n._id === nid);
            if (!reqNode) return false;
            return checkNodeComplete(tsdoc || {}, reqNode);
        });

        if (allRequirementsMet) {
            allow[node._id] = true;
            updated = true;
        }
    }

    if (updated) {
        await ContestModel.setStatus(domainId, tid, uid, { allow, attend: true });
    }
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

        for (const node of dag) {
            assert(node._id, 'each node should have a _id');
            assert(node.title, 'each node shoule have a title');
            assert(node.pids instanceof Array);
            assert(node.pids.length, 'each node should have at least one problem');

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

// 课程列表页面
export class CourseMainHandler extends Handler {
    @param('all', Types.Boolean)
    async get(domainId: string, all = false) {
        if (all && !this.user.hasPerm(PERM.PERM_MOD_BADGE)) {
            all = false;
        }
        const canViewAllCourses = this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_HOMEWORK);
        const viewAll = all || canViewAllCourses;

        const groups = [...this.user.group];
        if (this.user.hasPerm(PERM.PERM_CREATE_HOMEWORK)) {
            groups.push('teachers');
        }
        const userId = this.user._id;

        // 查询条件：匹配分配给用户组的课程，或未分配的课程（assign 为空数组、null 或不存在）
        const tdocs = await ContestModel.getMulti(domainId, {
            rule: 'course',
            ...(viewAll ? {} : {
                $or: [
                    { assign: { $in: groups } },
                    { assign: { $size: 0 } },
                    { assign: null },
                    { assign: { $exists: false } },
                    { extraStudents: userId },
                ],
            }),
        })
            .sort({ endAt: -1 })
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

        const courses = tdocs
            .sort((a, b) => b.endAt.getTime() - a.endAt.getTime())
            .map((t) => ({
                ...t,
                assignGroup: t.assign?.[0],
                category: `templates::${t.assign?.[1] || ''}`,
            }));

        const templates = courses.filter((c) => c.assignGroup === 'teachers');
        const unassigned = courses.filter((c) => !c.assignGroup);
        const archived = courses.filter((c) => classInfo[c.assignGroup]?.archive);
        const active = courses.filter(
            (c) => !templates.includes(c) && !unassigned.includes(c) && !archived.includes(c),
        );

        this.response.body = {
            tdocs: {
                ...(templates.length ? _.groupBy(templates, 'category') : {}),
                ...(unassigned.length ? { unassigned } : {}),
                ..._.groupBy(active, 'assignGroup'),
                ..._.groupBy(archived, 'assignGroup'),
            },
            tsdict,
            udict,
        };
        this.response.template = 'course_main.html';
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
        const isExtraStudent = this.tdoc.extraStudents?.includes(this.user._id);
        if (!isTemplate && this.tdoc.assign?.length && !this.user.own(this.tdoc)
            && !Set.intersection(this.tdoc.assign, this.user.group).size
            && !canBypassAssign && !isExtraStudent) {
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
        const isExtraStudent = this.tdoc.extraStudents?.includes(this.user._id);
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
            await ContestModel.attend(domainId, tid, this.user._id, { unrank: true });
            await ContestModel.setStatus(domainId, tid, this.user._id, {
                attend: true,
                allow: mergedAllow,
                lectureAllow: mergedLectureAllow,
            });
            tsdoc = await ContestModel.getStatus(domainId, tid, this.user._id);
        }

        // 如果用户未加入且有编辑权限，自动加入
        if (!tsdoc && this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK, PERM.PERM_EDIT_HOMEWORK_SELF)) {
            await ContestModel.attend(domainId, tid, this.user._id, { unrank: true });
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
            ? moment(this.tdoc.beginAt).tz(this.user.timeZone)
            : moment().add(1, 'day').tz(this.user.timeZone).hour(0).minute(0).millisecond(0);

        const endAt = this.tdoc
            ? moment(this.tdoc.endAt).tz(this.user.timeZone)
            : beginAt.clone().add(7, 'days').tz(this.user.timeZone).hour(23).minute(59).millisecond(0);

        this.response.body = {
            page_name: this.tdoc ? 'course_edit' : 'course_create',
            tdoc: this.tdoc,
            beginAtText: beginAt.format('YYYY-M-D H:mm'),
            endAtText: endAt.format('YYYY-M-D H:mm'),
            isTemplate: isTemplate || this.tdoc?.assign?.includes('teachers'),
        };

        if (this.tdoc) {
            this.response.body.dag = JSON.stringify(this.tdoc.dag, null, 2);
        }
    }

    @param('tid', Types.ObjectId, true)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('dag', Types.Content)
    @param('beginAt', Types.String)
    @param('endAt', Types.String)
    @param('isTemplate', Types.Boolean)
    @param('templateCategory', Types.String, true)
    @param('assign', Types.CommaSeperatedArray, true)
    @param('extraStudents', Types.CommaSeperatedArray, true)
    async post(
        domainId: string,
        tid: ObjectId | undefined,
        title: string,
        content: string,
        dagJson: string,
        beginAtStr: string,
        endAtStr: string,
        isTemplate = false,
        templateCategory = '',
        assign: string[] = [],
        extraStudentsStr: string[] = [],
    ) {
        assign = Array.from(new Set((assign || []).map((s) => (s || '').trim()).filter(Boolean)));
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

        const editor = this.user._id;
        const updateAt = new Date();

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

        if (tid) {
            await ContestModel.edit(domainId, tid, {
                title,
                content,
                pids,
                beginAt: beginAt.toDate(),
                endAt: endAt.toDate(),
                editor,
                updateAt,
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

        await ContestModel.edit(domainId, tid, {
            dag,
            assign: isTemplate ? (templateCategory ? ['teachers', templateCategory] : ['teachers']) : assign,
            editor,
            updateAt,
            extraStudents: isTemplate ? [] : extraStudents,
        });

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
        const extraStudents = (tdoc as CourseTdoc).extraStudents || [];
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
        } else if (tdoc.extraStudents?.includes(uid)) {
            // 处理临时学生
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
    @param('allow', Types.Boolean)
    async postAllowUser(domainId: string, tid: ObjectId, uid: number, node: number, allow = false) {
        const [tdoc, tsdocs] = await Promise.all([
            ContestModel.get(domainId, tid) as Promise<CourseTdoc>,
            ContestModel.getMultiStatus(domainId, { docId: tid }).toArray(),
        ]);

        if (!tdoc.dag.find((n) => n._id === node)) {
            throw new ValidationError('node', node, '节点不存在');
        }

        if (uid === 0) {
            await Promise.all(tsdocs.map((tsdoc) => ContestModel.setStatus(domainId, tid, tsdoc.uid, {
                allow: { ...tsdoc?.allow || {}, [node]: allow },
            })));
        } else {
            const tsdoc = tsdocs.find((t) => t.uid === uid);
            await ContestModel.setStatus(domainId, tid, uid, {
                allow: { ...tsdoc?.allow || {}, [node]: allow },
            });
        }

        this.back();
    }

    @param('tid', Types.ObjectId)
    @param('node', Types.PositiveInt)
    @param('uid', Types.Int)
    @param('allow', Types.Boolean)
    async postAllowLecture(domainId: string, tid: ObjectId, node: number, uid: number, allow = false) {
        const [tdoc, tsdocs] = await Promise.all([
            ContestModel.get(domainId, tid) as Promise<CourseTdoc>,
            ContestModel.getMultiStatus(domainId, { docId: tid }).toArray(),
        ]);

        if (!tdoc.dag.find((n) => n._id === node)) {
            throw new ValidationError('node', node, '节点不存在');
        }

        if (uid === 0) {
            await Promise.all(tsdocs.map((tsdoc) => ContestModel.setStatus(domainId, tid, tsdoc.uid, {
                lectureAllow: { ...tsdoc?.lectureAllow || {}, [node]: allow },
            })));
        } else {
            const tsdoc = tsdocs.find((t) => t.uid === uid);
            await ContestModel.setStatus(domainId, tid, uid, {
                lectureAllow: { ...tsdoc?.lectureAllow || {}, [node]: allow },
            });
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
        const isExtraStudent = tdoc.extraStudents?.includes(this.user._id);
        if (!isTemplate && tdoc.assign?.length && !this.user.own(tdoc)
            && !Set.intersection(tdoc.assign, this.user.group).size
            && !canBypassAssign && !isExtraStudent) {
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
            if (!tsdoc?.lectureAllow?.[id]) throw new ForbiddenError('讲义尚未开放。');
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

        if (!this.user.own(tdoc)) {
            if (domainId !== 'system') {
                throw new NotAssignedError('course', tdoc.docId);
            }
            if (!this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)) {
                throw new ForbiddenError();
            }
            if (this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)) {
                throw new ForbiddenError('你的权限不允许修改此课程！');
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

        // 权限检查
        if (!tsdoc?.allow?.[id]
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
            && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)) {
            throw new ForbiddenError();
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
            rows,
            udict,
            pdict,
            page_name: 'contest_scoreboard',
        };
    }

    async exportScoreboard(domainId: string, tid: ObjectId, id: number, ext: string) {
        const tdoc = await ContestModel.get(domainId, tid) as CourseTdoc;

        await (this as any).limitRate('scoreboard_download', 60, 3);

        const exporters: Record<string, (rows: any[], tdoc: any) => Promise<string>> = {
            csv: async (rows) => `\uFEFF${rows.map((row) => row.map((cell: any) => cell.value?.toString().replace(/\n/g, ' ')).join(',')).join('\n')}`,
            html: (rows, doc) => this.renderHTML('contest_scoreboard_download_html.html', { rows, tdoc: doc }),
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
