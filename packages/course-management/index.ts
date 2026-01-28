import Schema from 'schemastery';
import { ContestModel, Context, ObjectId, PERM, SettingModel } from 'hydrooj';
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
        (handler) => config.enable || handler.domain.enableCourse,
    );

    ctx.injectUI(
        'DomainManage',
        'domain_class',
        { family: 'Access Control', icon: 'user' },
        (handler: any) => config.enable || handler.domain.enableCourse,
    );
}
