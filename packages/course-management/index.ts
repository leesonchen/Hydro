import Schema from 'schemastery';
import {
    ContestModel,
    Context,
    ForbiddenError,
    ObjectId,
    PERM,
    SettingModel,
} from 'hydrooj';
import {
    CourseDetailHandler, CourseEditHandler, CourseFileDownloadHandler,
    CourseLectureHandler, CourseMainHandler, CourseManageHandler, CourseScoreboardHandler,
} from './handler/course';
import { ClassEditHandler, ClassHandler } from './handler/class';
import './model/course'; // 注册课程规则

export const name = 'course-management';

export const Config = Schema.object({
    enable: Schema.boolean().default(true),
});

export async function apply(ctx: Context, config: typeof Config) {
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
        'View Course': '查看课程',
        'Course Name': '课程名称',
        'Join at': '进入于',
        Teachers: '教师',
        Students: '学生',
        Lecture: '讲义',
        Section: '章节',
        Archive: '归档',
        Visit: '访问',
        'Extra Students': '临时调课学生',
        'Extra Students Hint': '输入学生UID，多个用逗号分隔。这些学生可以临时访问本课程，不影响其所属班级。',

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
    });

    const isCourseEnabled = (handler: any) => config.enable || handler.domain?.enableCourse;
    const ensureCourseEnabled = async (handler: any) => {
        if (isCourseEnabled(handler)) return;
        throw new ForbiddenError('该域尚未启用课程功能。');
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
                throw new ForbiddenError('You are not assigned to this contest.');
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
