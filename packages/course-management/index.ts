import Schema from 'schemastery';
import {
    ContestModel,
    Context,
    DocumentModel,
    ForbiddenError,
    ObjectId,
    PERM,
    STATUS,
    SettingModel,
    SolutionModel,
} from 'hydrooj';
import {
    CourseDetailHandler, CourseEditHandler, CourseFileDownloadHandler,
    CourseLectureHandler, CourseMainHandler, CourseManageHandler, CourseProblemReferenceHandler, CourseScoreboardHandler,
} from './handler/course';
import { ClassEditHandler, ClassHandler } from './handler/class';
import './model/course'; // 注册课程规则

export const name = 'course-management';

export const Config = Schema.object({
    enable: Schema.boolean().default(true),
});

export async function apply(ctx: Context, config: any) {
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
        domain_class: '管理班级',
        domain_class_create: '创建班级',
        domain_class_edit: '编辑班级',

        // 界面文字
        'Create Course Template': '创建课程模板',
        'Enable Course': '启用课程功能',
        'Class Name': '班级名称',
        'Classes Manage': '班级管理',
        'Edit Class': '编辑班级',
        'Create Class': '创建班级',
        'All Courses': '所有课程',
        'Create Course': '创建课程',
        'Course Templates': '课程模板',
        'Add Course': '添加课程',
        'Copy Source Domain': '源域',
        'Source Domain': '源域',
        'Source Domain is required.': '必须填写源域。',
        'No available course templates.': '没有可用的课程模板。',
        'View Course': '查看课程',
        'Edit Course': '编辑课程',
        'Course Management': '课程管理',
        'Course Name': '课程名称',
        'Join at': '进入于',
        'Joined Course': '已进入课程',
        'Not Joined Course': '未进入课程',
        'Enter Course': '进入课程',
        'Login to Enter Course': '登录后进入课程',
        'Join Domain to Enter Course': '加入域后进入课程',
        'No Permission to Enter Course': '无权限进入课程',
        'Course Status': '课程状态',
        'Reference Code': '参考代码',
        'Create Reference Code': '创建参考代码',
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
        Lecture: '讲义',
        Section: '章节',
        Archive: '归档',
        Visit: '访问',
        'Extra Students': '临时调课学生',
        'Extra Students Hint': '输入学生UID，多个用逗号分隔。这些学生可以临时访问本课程，不影响其所属班级。',
        'Enable Penalty': '多次提交罚分',
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
        'Source domain {0} does not exist.': '源域 {0} 不存在。',
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
        domain_class: 'Class Management',
        domain_class_create: 'Create Class',
        domain_class_edit: 'Edit Class',
        'Edit Course': 'Edit Course',
        'Course Management': 'Course Management',
        'Copy Source Domain': 'Source Domain',
        'Source Domain': 'Source Domain',
        'Source Domain is required.': 'Source Domain is required.',
        'No available course templates.': 'No available course templates.',
        'Joined Course': 'Joined Course',
        'Not Joined Course': 'Not Joined Course',
        'Enter Course': 'Enter Course',
        'Login to Enter Course': 'Login to Enter Course',
        'Join Domain to Enter Course': 'Join Domain to Enter Course',
        'No Permission to Enter Course': 'No Permission to Enter Course',
        'Course Status': 'Course Status',
        'Reference Code': 'Reference Code',
        'Create Reference Code': 'Create Reference Code',
        'This course is not live.': 'This course is not live.',
        "You haven't joined this course yet.": "You haven't joined this course yet.",
        'This problem is not available yet.': 'This problem is not available yet.',
        'Public Scoreboard': 'Public Scoreboard',
        'Enable Penalty': 'Enable Penalty',
        'You are not allowed to view the scoreboard.': 'You are not allowed to view the scoreboard.',
        'Students are not allowed to export the scoreboard.': 'Students are not allowed to export the scoreboard.',
        'Course is not enabled in this domain.': 'Course is not enabled in this domain.',
        'You are not assigned to this course.': 'You are not assigned to this course.',
        'You are not allowed to copy this course from {0} to {1}.': 'You are not allowed to copy this course from {0} to {1}.',
        'Problem {0} in {1} is not allowed to be copied to {2}.': 'Problem {0} in {1} is not allowed to be copied to {2}.',
        'Course "{0}" already exists in this domain.': 'Course "{0}" already exists in this domain.',
        'Source domain {0} does not exist.': 'Source domain {0} does not exist.',
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

    const isCourseEnabled = (handler: any) => config.enable || handler.domain?.enableCourse;
    const ensureCourseEnabled = async (handler: any) => {
        if (isCourseEnabled(handler)) return;
        throw new ForbiddenError((handler as any).translate('Course is not enabled in this domain.'));
    };

    // 处理 Contest 页面重定向到 Course 页面
    function redirectToCourse(routeName: string) {
        return async (handler: any) => {
            if (!handler.args.tid) return;
            const { tid } = handler.args;
            const tdoc = await ContestModel.get(handler.args.domainId, new ObjectId(tid));
            if (tdoc.rule === 'course') {
                handler.response.redirect = handler.url(routeName, { tid });
                return 'cleanup';
            }
        };
    }

    // 注册事件处理
    ctx.on('handler/after', async (handler) => {
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
        if (!handler.args.tid) return;
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
    });

    // 题目详情页：查询关联的课程
    ctx.on('handler/after/ProblemDetail', async (handler) => {
        // 课程内题目：注入“参考代码”可见性（教师可见；学生需通过）
        handler.response.body.canViewCourseReference = false;
        handler.response.body.hasReferenceCode = false;
        handler.response.body.canEditCourseReference = false;
        if (handler.tdoc?.rule === 'course') {
            const canEdit = handler.user.own(handler.tdoc)
                || handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
                || handler.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF);
            const accepted = handler.psdoc?.status === STATUS.STATUS_ACCEPTED;
            handler.response.body.canViewCourseReference = !!(canEdit || accepted);
            handler.response.body.canEditCourseReference = !!canEdit;
            // 检查是否存在参考代码
            const pid = handler.pdoc?.docId;
            if (pid) {
                const refs = await SolutionModel.getMulti(handler.args.domainId, pid)
                    .project({ docId: 1, title: 1 }).toArray();
                const REFERENCE_CODE_TITLE = '【参考代码】';
                const hasRef = refs.some((d: any) => d.title === REFERENCE_CODE_TITLE);
                handler.response.body.hasReferenceCode = hasRef;
            }
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
        if (tdoc.assign?.length && !handler.user.own(tdoc) && !handler.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)) {
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
