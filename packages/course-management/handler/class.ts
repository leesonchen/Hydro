import {
    ContestModel, Handler, moment, NotFoundError, ObjectId, param, PERM, PermissionError,
    ProblemModel, StorageModel, Types, UserModel, ValidationError,
} from 'hydrooj';
import { ClassModel } from '../model/class';
import type { CourseTdoc } from '../model/course';
import { parseDag } from './course';

// 班级列表页面
export class ClassHandler extends Handler {
    async prepare() {
        this.checkPerm(PERM.PERM_EDIT_HOMEWORK, PERM.PERM_EDIT_HOMEWORK_SELF);
    }

    async get({ domainId }: { domainId: string }) {
        this.response.template = 'domain_class.html';
        this.response.body = {
            domain: this.domain,
            groups: await ClassModel.listGroup(domainId),
        };
    }
}

// 班级编辑页面
export class ClassEditHandler extends Handler {
    async prepare() {
        if (!this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)) {
            throw new PermissionError();
        }
    }

    @param('id', Types.ObjectId, true)
    async get(domainId: string, id?: ObjectId) {
        this.response.body = {
            page_name: id ? 'domain_class_edit' : 'domain_class_create',
            domain: this.domain,
        };

        let beginAt = moment().add(1, 'day').tz(this.user.timeZone).hour(0).minute(0).millisecond(0);
        let endAt = beginAt.clone().add(7, 'days').tz(this.user.timeZone).hour(23).minute(59).millisecond(0);

        const extra: any = {};
        const groups = (await UserModel.listGroup(domainId)).filter((g: any) => !g?.class);
        extra.groups = groups;

        if (id) {
            const gdoc = await ClassModel.getGroupById(domainId, id);
            if (!gdoc) throw new NotFoundError(domainId, id);

            const tdocs = await ContestModel.getMulti(domainId, {
                rule: 'course',
                assign: { $in: [gdoc.name] },
            }).toArray();

            // 获取可用的课程模板（当前域下 assign=teachers）
            const templates = await ContestModel.getMulti(domainId, {
                rule: 'course',
                assign: { $elemMatch: { $eq: 'teachers' } },
            }).sort({ title: 1 }).toArray();

            const usedTitles = tdocs.map((t) => t.title);

            extra.gdoc = gdoc;
            extra.tdocs = tdocs;
            extra.templates = templates.filter((t) => !usedTitles.includes(t.title));

            if (gdoc.beginAt) {
                beginAt = moment(gdoc.beginAt).tz(this.user.timeZone);
            }
            if (gdoc.endAt) {
                endAt = moment(gdoc.endAt).tz(this.user.timeZone);
            }

            // 如果没有设置时间但有课程，使用课程的时间范围
            if (!gdoc.beginAt && tdocs.length) {
                beginAt = moment.min(tdocs.map((t) => moment(t.beginAt).tz(this.user.timeZone)));
                endAt = moment.max(tdocs.map((t) => moment(t.endAt).tz(this.user.timeZone)));
            }
        }

        Object.assign(this.response.body, {
            dateBeginText: beginAt.format('YYYY-M-D'),
            timeBeginText: beginAt.format('H:mm'),
            dateEndText: endAt.format('YYYY-M-D'),
            timeEndText: endAt.format('H:mm'),
            ...extra,
        });

        this.response.template = 'domain_class_edit.html';
    }

    @param('id', Types.ObjectId)
    async postDelete(domainId: string, id: ObjectId) {
        const gdoc = await ClassModel.getGroupById(domainId, id);
        if (!gdoc) throw new NotFoundError(domainId, id);

        // 删除所有关联的课程
        const tdocs = await ContestModel.getMulti(domainId, {
            rule: 'course',
            assign: { $in: [gdoc.name] },
        }).toArray();

        await Promise.all(tdocs.map((t) => ContestModel.del(domainId, t._id)));
        await ClassModel.delGroup(domainId, id);

        this.response.redirect = this.url('domain_class');
    }

    @param('id', Types.ObjectId, true)
    @param('name', Types.String)
    @param('teachers', Types.NumericArray)
    @param('students', Types.NumericArray)
    @param('teacherGroups', Types.CommaSeperatedArray, true)
    @param('studentGroups', Types.CommaSeperatedArray, true)
    @param('beginAtDate', Types.String)
    @param('beginAtTime', Types.String)
    @param('EndAtDate', Types.String)
    @param('EndAtTime', Types.String)
    @param('archive', Types.Boolean)
    async postUpdate(
        domainId: string,
        id: ObjectId | undefined,
        name: string,
        teachers: number[],
        students: number[],
        teacherGroups: string[] = [],
        studentGroups: string[] = [],
        beginAtDate: string,
        beginAtTime: string,
        endAtDate: string,
        endAtTime: string,
        archive = false,
    ) {
        const beginAt = moment.tz(`${beginAtDate} ${beginAtTime}`, this.user.timeZone);
        if (!beginAt.isValid()) throw new ValidationError('beginAtDate', 'beginAtTime');

        const endAt = moment.tz(`${endAtDate} ${endAtTime}`, this.user.timeZone);
        if (!endAt.isValid()) throw new ValidationError('endAtDate', 'endAtTime');

        if (id) {
            const gdoc = await ClassModel.getGroupById(domainId, id);
            if (!gdoc) throw new NotFoundError(domainId, id);

            // 如果班级名称改变，更新所有关联的课程
            if (gdoc.name !== name) {
                const tdocs = await ContestModel.getMulti(domainId, {
                    rule: 'course',
                    assign: { $in: [gdoc.name] },
                }).toArray();

                await Promise.all(tdocs.map((t) => ContestModel.edit(domainId, t._id, { assign: [name] })));
            }

            await ClassModel.delGroup(domainId, id);
        }

        const groupDocs = (await UserModel.listGroup(domainId)).filter((g: any) => !g?.class);
        const groupMap = new Map<string, number[]>(groupDocs.map((g: any) => [g.name, (g.uids || []) as number[]]));
        const collectGroupUids = (groupNames: string[]) => groupNames.flatMap((groupName) => groupMap.get(groupName) || []);
        const mergedTeachers = Array.from(new Set([...teachers, ...collectGroupUids(teacherGroups)]));
        const mergedStudents = Array.from(new Set([...students, ...collectGroupUids(studentGroups)]));

        await ClassModel.updateGroup(
            domainId,
            name,
            mergedTeachers,
            mergedStudents,
            beginAt.toDate(),
            endAt.toDate(),
            archive,
        );

        // 更新所有关联课程的时间和维护者
        const tdocs = await ContestModel.getMulti(domainId, {
            rule: 'course',
            assign: { $in: [name] },
        }).toArray();

        await Promise.all(tdocs.map((t) => ContestModel.edit(domainId, t._id, {
            beginAt: beginAt.toDate(),
            endAt: endAt.toDate(),
            maintainer: mergedTeachers,
        })));

        this.response.redirect = this.url('domain_class');
    }

    @param('id', Types.ObjectId)
    @param('template', Types.CommaSeperatedArray)
    async postCopy(domainId: string, id: ObjectId, templateIds: string[]) {
        const gdoc = await ClassModel.getGroupById(domainId, id);
        if (!gdoc) throw new NotFoundError(domainId, id);

        const tdocs: any[] = [];

        for (const templateId of templateIds) {
            const template = await ContestModel.get(domainId, new ObjectId(templateId)) as CourseTdoc;
            if (!template) continue;

            const { title, content, dag } = template;

            // 解析并复制题目
            const parsedDag = await parseDag(domainId, JSON.stringify(dag));
            const newDag = parsedDag.map((node) => ({ ...node }));
            const allPids = Array.from(new Set(parsedDag.flatMap((node) => node.pids)));

            // 创建新课程
            const newTid = await ContestModel.add(
                domainId,
                title,
                content,
                this.user._id,
                'course',
                gdoc.beginAt,
                gdoc.endAt,
                allPids,
                false,
                {
                    dag: newDag,
                    assign: [gdoc.name],
                    maintainer: gdoc.teachers,
                    lecture: template.lecture,
                    files: template.files,
                },
            );

            // 复制文件
            if (template.files?.length) {
                await Promise.all(template.files.map((f) => StorageModel.copy(
                    `contest/${domainId}/${templateId}/public/${f.name}`,
                    `contest/${domainId}/${newTid}/public/${f.name}`,
                )));
            }

            const newTdoc = await ContestModel.get(domainId, newTid);
            (newTdoc as any).url = this.url('course_detail', { tid: newTid });
            tdocs.push(newTdoc);
        }

        this.response.body = { tdocs };
    }
}
