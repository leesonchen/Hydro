import './model/course'; // 注册课程规则

import Schema from 'schemastery';
import { hasReferenceCodeSolution } from '../../lib/referenceCode';
import {
    ContestModel,
    Context,
    DocumentModel,
    ForbiddenError,
    ObjectId,
    PERM,
    SettingModel,
    STATUS,
} from '../../plugin-api';
import { ClassEditHandler, ClassHandler } from './handler/class';
import {
    CourseDetailHandler, CourseEditHandler, CourseFileDownloadHandler,
    CourseLectureHandler, CourseMainHandler, CourseManageHandler, CourseProblemReferenceHandler, CourseScoreboardHandler,
    projectCourseResponse,
} from './handler/course';
import { cleanupInactiveAssessments, syncAssessmentContests, validateAssessmentPlan } from './model/assessment';
import type { CourseTdoc } from './model/course';

export const name = 'course-management';

export const Config = Schema.object({
    enable: Schema.boolean().default(true),
});

export async function apply(ctx: Context, config: any) {
    await ctx.db.ensureIndexes(DocumentModel.coll, {
        key: { domainId: 1, docType: 1, sourceType: 1, sourceCourseTid: 1, sourceNodeId: 1 },
        name: 'classroomAssessmentBinding', unique: true,
        partialFilterExpression: { sourceType: 'course_assessment' },
    });
    ctx.on('contest/before-edit', async (tdoc, changes) => {
        if (tdoc.sourceType === 'course_assessment') {
            if (changes.rated === true) throw new ForbiddenError('Classroom test rating requires certification');
            if ((changes.sourceType && changes.sourceType !== tdoc.sourceType)
                || (changes.sourceCourseTid && !changes.sourceCourseTid.equals(tdoc.sourceCourseTid))
                || (changes.sourceNodeId !== undefined && changes.sourceNodeId !== tdoc.sourceNodeId)) {
                throw new ForbiddenError('Classroom test bindings cannot be changed');
            }
        }
        if (tdoc.rule !== 'course') return;
        // Class schedule changes automatically shift only unopened tests.
        if (changes.beginAt && !changes.dag) {
            const shiftMs = changes.beginAt.getTime() - tdoc.beginAt.getTime();
            if (shiftMs) {
                changes.dag = structuredClone((tdoc as CourseTdoc).dag || []);
                for (const node of changes.dag) {
                    if (node.kind !== 'assessment' || !node.assessment || new Date(node.assessment.beginAt) <= new Date()) continue;
                    node.assessment.beginAt = new Date(new Date(node.assessment.beginAt).getTime() + shiftMs).toISOString();
                    node.assessment.endAt = new Date(new Date(node.assessment.endAt).getTime() + shiftMs).toISOString();
                }
            }
        }
        const next = { ...tdoc, ...changes } as CourseTdoc;
        await validateAssessmentPlan(tdoc.domainId, next.dag || [], tdoc as CourseTdoc, next.beginAt, next.endAt);
    });
    ctx.on('contest/edit', async (tdoc, actorUid) => {
        if (tdoc.rule !== 'course' || tdoc.assign?.includes('teachers')) return;
        const course = tdoc as CourseTdoc;
        const dag = structuredClone(course.dag || []);
        await syncAssessmentContests(course.domainId, course.docId, dag, course.title, course.owner,
            course.assign || [], course.maintainer || [], actorUid);
        if (JSON.stringify(dag) !== JSON.stringify(course.dag || [])) {
            const updated = await ContestModel.editIfAssigned(course.domainId, course.docId, course.assign || [], { dag },
                { dagRevision: course.dagRevision ?? { $exists: false } });
            if (!updated) throw new ForbiddenError('Course changed while synchronizing classroom tests; retry');
        }
        await cleanupInactiveAssessments(course.domainId, course.docId, dag);
    });
    // i18n 翻译
    ctx.i18n.load('zh', {
        // 页面标题
        course_create: '创建课程',
        course_main: '课程',
        course_detail: '课程详情',
        course_edit: '编辑课程',
        course_lecture: '课程讲义',
        course_manage: '课程管理',
        course_scoreboard: '课程成绩',
        course_detail_problem: '题目详情',
        classroom_test_detail: '课堂测试',
        classroom_test_problemlist: '题目列表',
        classroom_scoreboard: '课堂测试成绩板',
        classroom_scoreboard_view: '课堂测试成绩板',
        domain_class: '管理班级',
        domain_class_create: '创建班级',
        domain_class_edit: '编辑班级',

        // 界面文字
        'Create Course Template': '创建课程模板',
        'Enable Course': '启用课程功能',
        'Class Name': '班级名称',
        'Search classes by name...': '输入班级名称搜索...',
        'No matching classes found in class list': '没有找到匹配的班级',
        Classes: '班级',
        'Classes Manage': '班级管理',
        'Edit Class': '编辑班级',
        'Create Class': '创建班级',
        'All Courses': '所有课程',
        'Create Course': '创建课程',
        'Course Statistics': '课程统计',
        'Course Templates': '课程模板',
        'My Courses': '我的课程',
        'Other Courses': '其他课程',
        Courses: '课程数量',
        courses: '门课程',
        Template: '模板',
        Templates: '模板',
        'Template Category': '模板分类',
        Uncategorized: '未分类',
        'Leave blank to put this template in Uncategorized.': '留空则归入未分类。',
        'No template selected': '未选择模板',
        'Selected templates': '已选模板',
        'Batch Set Category': '批量设置分类',
        'Batch Remove Category': '批量移除分类',
        'Please select at least one course template to perform this operation.': '请选择至少一个课程模板进行操作。',
        'Please input template category.': '请输入模板分类。',
        'Lesson Duration (hours)': '时长（小时）',
        'Lesson Begin at': '上课开始',
        'Lesson End at': '上课结束',
        Unassigned: '未分配',
        'No courses': '暂无课程',
        'Search courses by keyword...': '输入关键词搜索课程...',
        'No matching courses found': '没有找到匹配的课程',
        'Add Course': '添加课程',
        'Course added.': '课程已添加。',
        'Copy Source Domain': '源域',
        'Source Domain': '源域',
        'Source Domain is required.': '必须填写源域。',
        'No available course templates.': '没有可用的课程模板。',
        'Template selection is stale. Please select a template again.': '模板选择已过期，请重新选择课程模板。',
        'View Course': '查看课程',
        'Edit Course': '编辑课程',
        'Course Management': '课程管理',
        'Course Name': '课程名称',
        'Save as Template': '另存为模板',
        'Join at': '进入于',
        'Last Updated': '上次更新',
        'Last Edited By': '最后编辑人',
        'Last updated: {0} at {1}': '上次更新：{0} 于 {1}',
        'Joined Course': '已进入课程',
        'Not Joined Course': '未进入课程',
        'Enter Course': '进入课程',
        'Login to Enter Course': '登录后进入课程',
        'Join Domain to Enter Course': '加入域后进入课程',
        'No Permission to Enter Course': '无权限进入课程',
        'Claim Course': '认领课程',
        'Login to Claim Course': '登录后认领课程',
        'Join Domain to Claim Course': '加入域后认领课程',
        'No Permission to Claim Course': '无权限认领课程',
        'Please claim the course to see the lessons.': '认领课程后才可以查看课程内容。',
        'Course Status': '课程状态',
        'Reference Code': '参考代码',
        'Create Reference Code': '创建参考代码',
        'Exclude hidden problems': '不看隐藏题目',
        'This course is not live.': '此课程尚未开始。',
        "You haven't joined this course yet.": '你尚未进入此课程。',
        'This problem is not available yet.': '该题目尚未开放。',
        'Public Scoreboard': '公开成绩',
        'You are not allowed to view the scoreboard.': '无权限查看成绩板',
        'Students are not allowed to export the scoreboard.': '学生无权导出成绩板',
        'Course is not enabled in this domain.': '该域尚未启用课程功能。',
        'You are not assigned to this course.': '你未被分配到此课程。',
        Teachers: '教师',
        Students: '学生',
        'Teacher Groups': '教师用户组',
        'Student Groups': '学生用户组',
        Lecture: '讲义',
        Section: '章节',
        Archive: '归档',
        Visit: '访问',
        Updated: '已更新',
        Tries: '尝试次数',
        Interval: '上课间隔',
        'Interval Days': '间隔天数',
        'Every day': '每天',
        'Every week (7 days)': '每周（7天）',
        'Custom days': '自定义天数',
        'Extra Students': '临时调课学生',
        'Extra Students Hint': '输入学生UID，多个用逗号分隔。这些学生可以临时访问本课程，不影响其所属班级。',
        'Enable Penalty': '多次提交罚分',
        'Applied as default for newly added courses': '（作为新增课程的默认配置）',
        'Ranking Settings': '排名设置',
        'Set as Unranked': '设为不排名',
        'Restore Ranking': '恢复排名',
        'Bulk Allow Access': '批量允许访问',
        'Bulk Deny Access': '批量禁止访问',
        'Allow Access': '允许访问',
        'Deny Access': '禁止访问',
        'Bulk Set as Unranked': '批量设为不排名',
        'Bulk Clear Unranked': '批量清除不排名',
        'Confirm to set all class students as unranked?': '确认将班级所有学生设为不参与排名（unrank）？',
        'Confirm to clear unranked status for all class students?': '确认清除班级所有学生的不排名状态（unrank）？',
        'Confirm to set all extra students as unranked?': '确认将所有临时调课学生设为不参与排名（unrank）？',
        'Confirm to clear unranked status for all extra students?': '确认清除所有临时调课学生的不排名状态（unrank）？',
        'Edit Extra Students': '编辑临时学生名单',
        'No extra students.': '暂无临时调课学生。',
        'You are not allowed to copy this course from {0} to {1}.': '不允许将课程从 {0} 复制到 {1}。',
        'Problem {0} in {1} is not allowed to be copied to {2}.': '题目 {0} 所在域 {1} 未向 {2} 开放复制权限。',
        'Course "{0}" already exists in this domain.': '当前域已存在同名课程“{0}”。',
        'Template category "{0}" already exists.': '模板分类“{0}”已存在。',
        'Source domain {0} does not exist.': '源域 {0} 不存在。',
        'Referenced source problem {0} in domain {1} does not exist.': '源域 {1} 中引用的题目 {0} 不存在。',
        'Missing referenced problems in target domain: {0}': '目标域缺少以下同源题目：{0}',

        // 题目详情页关联课程
        'In following courses': '在以下课程中',
    });

    ctx.i18n.load('en', {
        course_create: 'Create Course',
        course_main: 'Course',
        course_detail: 'Course Detail',
        course_edit: 'Edit Course',
        course_lecture: 'Course Lecture',
        course_manage: 'Course Manage',
        course_scoreboard: 'Course Scoreboard',
        course_detail_problem: 'Course Problem Detail',
        classroom_test_detail: 'Classroom Test',
        classroom_test_problemlist: 'Problem List',
        classroom_scoreboard: 'Classroom Test Scoreboard',
        classroom_scoreboard_view: 'Classroom Test Scoreboard',
        domain_class: 'Class Management',
        domain_class_create: 'Create Class',
        domain_class_edit: 'Edit Class',
        'Class Name': 'Class Name',
        'Search classes by name...': 'Search classes by name...',
        'No matching classes found in class list': 'No matching classes found',
        Classes: 'Classes',
        'All Courses': 'All Courses',
        'Create Course': 'Create Course',
        'Create Course Template': 'Create Course Template',
        'Course Statistics': 'Course Statistics',
        'Course Templates': 'Course Templates',
        'My Courses': 'My Courses',
        'Other Courses': 'Other Courses',
        Courses: 'Courses',
        courses: 'courses',
        Template: 'Template',
        Templates: 'Templates',
        'Template Category': 'Template Category',
        Uncategorized: 'Uncategorized',
        'Leave blank to put this template in Uncategorized.': 'Leave blank to put this template in Uncategorized.',
        'No template selected': 'No template selected',
        'Selected templates': 'Selected templates',
        'Batch Set Category': 'Batch Set Category',
        'Batch Remove Category': 'Batch Remove Category',
        'Please select at least one course template to perform this operation.':
            'Please select at least one course template to perform this operation.',
        'Please input template category.': 'Please input template category.',
        'Lesson Duration (hours)': 'Lesson Duration (hours)',
        'Lesson Begin at': 'Lesson Begin at',
        'Lesson End at': 'Lesson End at',
        Unassigned: 'Unassigned',
        'No courses': 'No courses',
        'Search courses by keyword...': 'Search courses by keyword...',
        'No matching courses found': 'No matching courses found',
        'Classes Manage': 'Classes Manage',
        'Add Course': 'Add Course',
        'Course added.': 'Course added.',
        'Course Name': 'Course Name',
        'Edit Course': 'Edit Course',
        'Course Management': 'Course Management',
        'Save as Template': 'Save as Template',
        'Copy Source Domain': 'Source Domain',
        'Source Domain': 'Source Domain',
        'Source Domain is required.': 'Source Domain is required.',
        'No available course templates.': 'No available course templates.',
        'Template selection is stale. Please select a template again.': 'Template selection is stale. Please select a template again.',
        'Join at': 'Join at',
        'Last Updated': 'Last Updated',
        'Last Edited By': 'Last Edited By',
        'Last updated: {0} at {1}': 'Last updated: {0} at {1}',
        'Joined Course': 'Joined Course',
        'Not Joined Course': 'Not Joined Course',
        'Enter Course': 'Enter Course',
        'Login to Enter Course': 'Login to Enter Course',
        'Join Domain to Enter Course': 'Join Domain to Enter Course',
        'No Permission to Enter Course': 'No Permission to Enter Course',
        'Claim Course': 'Claim Course',
        'Login to Claim Course': 'Login to Claim Course',
        'Join Domain to Claim Course': 'Join Domain to Claim Course',
        'No Permission to Claim Course': 'No Permission to Claim Course',
        'Please claim the course to see the lessons.': 'Please claim the course to see the lessons.',
        'Course Status': 'Course Status',
        'Reference Code': 'Reference Code',
        'Create Reference Code': 'Create Reference Code',
        'Exclude hidden problems': 'Exclude hidden problems',
        'This course is not live.': 'This course is not live.',
        "You haven't joined this course yet.": "You haven't joined this course yet.",
        'This problem is not available yet.': 'This problem is not available yet.',
        'Public Scoreboard': 'Public Scoreboard',
        'Enable Penalty': 'Enable Penalty',
        'Applied as default for newly added courses': '(Applied as default for newly added courses)',
        Teachers: 'Teachers',
        Students: 'Students',
        'Teacher Groups': 'Teacher Groups',
        'Student Groups': 'Student Groups',
        Lecture: 'Lecture',
        Section: 'Section',
        Archive: 'Archive',
        Visit: 'Visit',
        Updated: 'Updated',
        Tries: 'Tries',
        Interval: 'Interval',
        'Interval Days': 'Interval Days',
        'Every day': 'Every day',
        'Every week (7 days)': 'Every week (7 days)',
        'Custom days': 'Custom days',
        'You are not allowed to view the scoreboard.': 'You are not allowed to view the scoreboard.',
        'Students are not allowed to export the scoreboard.': 'Students are not allowed to export the scoreboard.',
        'Course is not enabled in this domain.': 'Course is not enabled in this domain.',
        'You are not assigned to this course.': 'You are not assigned to this course.',
        'You are not allowed to copy this course from {0} to {1}.': 'You are not allowed to copy this course from {0} to {1}.',
        'Problem {0} in {1} is not allowed to be copied to {2}.': 'Problem {0} in {1} is not allowed to be copied to {2}.',
        'Course "{0}" already exists in this domain.': 'Course "{0}" already exists in this domain.',
        'Template category "{0}" already exists.': 'Template category "{0}" already exists.',
        'Source domain {0} does not exist.': 'Source domain {0} does not exist.',
        'Referenced source problem {0} in domain {1} does not exist.': 'Referenced source problem {0} in domain {1} does not exist.',
        'Missing referenced problems in target domain: {0}': 'Missing referenced problems in target domain: {0}',
        'Ranking Settings': 'Ranking Settings',
        'Set as Unranked': 'Set as Unranked',
        'Restore Ranking': 'Restore Ranking',
        'Bulk Allow Access': 'Bulk Allow Access',
        'Bulk Deny Access': 'Bulk Deny Access',
        'Allow Access': 'Allow Access',
        'Deny Access': 'Deny Access',
        'Bulk Set as Unranked': 'Bulk Set as Unranked',
        'Bulk Clear Unranked': 'Bulk Clear Unranked',
        'Confirm to set all class students as unranked?': 'Confirm to set all class students as unranked?',
        'Confirm to clear unranked status for all class students?': 'Confirm to clear unranked status for all class students?',
        'Confirm to set all extra students as unranked?': 'Confirm to set all extra students as unranked?',
        'Confirm to clear unranked status for all extra students?': 'Confirm to clear unranked status for all extra students?',
        'Edit Extra Students': 'Edit Extra Students',
        'No extra students.': 'No extra students.',
    });

    ctx.i18n.load('zh_TW', {
        classroom_test_detail: '課堂測驗',
        classroom_test_problemlist: '題目列表',
        classroom_scoreboard: '課堂測驗成績板',
        classroom_scoreboard_view: '課堂測驗成績板',
    });

    const isCourseEnabled = (handler: any) => config.enable || handler.domain?.enableCourse;
    const ensureCourseEnabled = async (handler: any) => {
        if (isCourseEnabled(handler)) return;
        throw new ForbiddenError((handler as any).translate('Course is not enabled in this domain.'));
    };

    // 处理 Contest 页面重定向到 Course 页面
    function redirectToCourse(routeName: string) {
        return async (handler: any) => {
            if (!handler.args.tid) return undefined;
            const { tid } = handler.args;
            const tdoc = await ContestModel.get(handler.args.domainId, new ObjectId(tid));
            if (tdoc.rule === 'course') {
                handler.response.redirect = handler.url(routeName, { tid });
                return 'cleanup';
            }
            return undefined;
        };
    }

    // 注册事件处理
    ctx.on('handler/after', async (handler) => {
        handler.response.body = projectCourseResponse(handler.response.body, handler);
        if (handler.response.body?.overrideNav && (handler as any).tdoc?.rule === 'course') {
            delete handler.response.body.overrideNav;
        }
    });

    ctx.on('handler/before-prepare/ContestDetail', redirectToCourse('course_detail'));
    ctx.on('handler/before-prepare/ContestEdit', redirectToCourse('course_edit'));
    ctx.on('handler/before/ContestManagement', redirectToCourse('course_manage'));

    const guardedHandlers = [
        'CourseMainHandler',
        'CourseDetailHandler',
        'CourseEditHandler',
        'CourseManageHandler',
        'CourseLectureHandler',
        'CourseProblemReferenceHandler',
        'CourseScoreboardHandler',
        'CourseFileDownloadHandler',
        'ClassHandler',
        'ClassEditHandler',
    ];
    for (const handlerName of guardedHandlers) {
        ctx.on(`handler/before-prepare/${handlerName}`, ensureCourseEnabled);
    }

    ctx.on('handler/before-prepare/ContestScoreboard', async (handler) => {
        if (!handler.args.tid) return undefined;
        const { tid } = handler.args;
        const tdoc = await ContestModel.get(handler.args.domainId, new ObjectId(tid));
        if (tdoc.rule === 'course') {
            const extra = handler.args.view
                ? {
                    ext: handler.args.view,
                    id: handler.request.referer.split('/')[handler.request.referer.split('/').length - 1],
                }
                : {};
            handler.response.redirect = handler.url(
                handler.args.view ? 'course_scoreboard_download' : 'course_scoreboard',
                { tid, id: 0, ...extra },
            );
            return 'cleanup';
        }
        return undefined;
    });

    ctx.on('problem/list', async (query: any, handler: any) => {
        if (!handler.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)) return;
        const hideHidden = handler.request.query?.hideHidden === 'true';
        if (hideHidden) query.hidden = false;
    });

    // 题解题面：注入 tdoc/tsdoc，使模板可附加 tid 参数
    ctx.on('handler/after/ProblemSolution#get', async (handler) => {
        if (handler.tdoc) {
            handler.response.body.tdoc = handler.tdoc;
            handler.response.body.tsdoc = handler.tsdoc;
            handler.response.body.canViewSolution = true;
            handler.response.body.solutionCount = handler.response.body.pscount;
        }
    });

    // 题目详情页：查询关联的课程
    ctx.on('handler/after/ProblemDetail', async (handler) => {
        // 课程/作业内题目：注入"参考代码"可见性（教师可见；学生需通过）
        handler.response.body.canViewCourseReference = false;
        handler.response.body.hasReferenceCode = false;
        handler.response.body.canEditCourseReference = false;
        handler.response.body.canViewHomeworkReference = false;
        handler.response.body.hasHomeworkReferenceCode = false;
        handler.response.body.canEditHomeworkReference = false;
        // 题解可见性（与参考代码使用相同的 AC 判断逻辑）
        handler.response.body.canViewSolution = false;
        if (handler.tdoc?.rule === 'course' || handler.tdoc?.rule === 'homework') {
            const canEdit = handler.tdoc.rule === 'course'
                ? handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
                || (handler.user.own(handler.tdoc) && handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF))
                : handler.user.hasPerm(PERM.PERM_CREATE_HOMEWORK);
            const accepted = handler.tsdoc?.detail?.[String(handler.pdoc?.docId)]?.status === STATUS.STATUS_ACCEPTED;
            // 检查是否存在参考代码
            const pid = handler.pdoc?.docId;
            let hasRef = false;
            if (pid) {
                hasRef = await hasReferenceCodeSolution(handler.args.domainId, handler.pdoc);
            }
            if (handler.tdoc.rule === 'course') {
                handler.response.body.canViewCourseReference = !!(canEdit || accepted);
                handler.response.body.canEditCourseReference = !!canEdit;
                handler.response.body.hasReferenceCode = hasRef;
            } else {
                handler.response.body.canViewHomeworkReference = !!(canEdit || accepted);
                handler.response.body.canEditHomeworkReference = !!canEdit;
                handler.response.body.hasHomeworkReferenceCode = hasRef;
            }
            // 题解可见性：使用课程/作业内 AC 状态（tsdoc.detail）
            handler.response.body.canViewSolution = handler.user.hasPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION)
                || (handler.user.hasPerm(PERM.PERM_VIEW_PROBLEM_SOLUTION_ACCEPT) && accepted);
            return;
        }
        // 只在非课程/作业/比赛模式下查询（即普通题目详情页）
        if (handler.tdoc) return;
        const domainId = handler.args.domainId;
        const pid = handler.pdoc?.docId;
        if (!pid) return;

        try {
            // 查询包含此题目的课程
            const courses = await ContestModel.getMulti(domainId, {
                rule: 'course',
                pids: pid,
            }).toArray();

            // 过滤用户有权限查看的课程
            const visibleCourses = courses.filter((tdoc: any) => {
                // 教师或管理员可见
                if (handler.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)) return true;
                // 分配了班级的课程，检查用户是否在班级中
                if (!tdoc.assign?.length) return true;
                const userGroups = new Set(handler.user.group || []);
                return tdoc.assign.some((g: string) => userGroups.has(g));
            });

            if (visibleCourses.length) {
                handler.response.body.cdocs = visibleCourses;
            }
        } catch (e) {
            // 忽略错误，不影响页面正常显示
            console.error('[Course Management] Failed to query related courses:', e);
        }
    });

    // 题目详情页权限检查：课程类型只需要检查 assign（extraStudents 已合并到 assign）
    ctx.on('handler/before-prepare/ProblemDetail', async (handler) => {
        const { tid } = handler.args;
        if (!tid) return;

        // 获取课程信息
        const tdoc = await ContestModel.get(handler.args.domainId, new ObjectId(tid));
        if (!tdoc || tdoc.rule !== 'course') return;

        // 检查是否是分配的课程（assign 已包含 extraStudents）
        if (tdoc.assign?.length
            && !handler.user.own(tdoc)
            && !handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
            && !handler.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)) {
            const userGroups = new Set(handler.user.group || []);
            // 把用户ID转为字符串进行比较（因为 assign 中可能包含数字字符串）
            const userIdStr = handler.user._id.toString();
            const isInAssign = tdoc.assign.some((g: string) => userGroups.has(g) || g === userIdStr);

            if (!isInAssign) {
                throw new ForbiddenError((handler as any).translate('You are not assigned to this course.'));
            }
        }
    });

    // 域设置
    ctx.inject(['setting'], (c) => {
        c.setting.DomainSetting(
            SettingModel.Setting('setting_course', 'enableCourse', false, 'boolean', 'Enable Course'),
        );
    });

    // 注册路由
    ctx.Route('course_create', '/course/create', CourseEditHandler, PERM.PERM_CREATE_HOMEWORK);
    ctx.Route('course_main', '/course', CourseMainHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_detail', '/course/:tid', CourseDetailHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_edit', '/course/:tid/edit', CourseEditHandler);
    ctx.Route('course_manage', '/course/:tid/manage', CourseManageHandler);
    ctx.Route('course_lecture', '/course/:tid/lecture/:id', CourseLectureHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_scoreboard', '/course/:tid/scoreboard/:id', CourseScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
    ctx.Route('course_scoreboard_download', '/course/:tid/scoreboard/:id/:ext', CourseScoreboardHandler, PERM.PERM_VIEW_HOMEWORK_SCOREBOARD);
    ctx.Route('course_file_download', '/course/:tid/file/:filename', CourseFileDownloadHandler, PERM.PERM_VIEW_HOMEWORK);
    ctx.Route('course_problem_reference', '/course/:tid/problem/:pid/reference', CourseProblemReferenceHandler, PERM.PERM_VIEW_HOMEWORK);

    ctx.Route('domain_class', '/domain/class', ClassHandler);
    ctx.Route('domain_class_create', '/domain/class/create', ClassEditHandler);
    ctx.Route('domain_class_edit', '/domain/class/:id/edit', ClassEditHandler);

    // UI 注入
    ctx.injectUI(
        'Nav',
        'course_main',
        { before: 'training_main', prefix: 'course' },
        PERM.PERM_VIEW_HOMEWORK,
        (handler) => isCourseEnabled(handler),
    );

    ctx.injectUI(
        'DomainManage',
        'domain_class',
        { family: 'Access Control', icon: 'user' },
        (handler: any) => isCourseEnabled(handler),
    );
}
