import { canCreateClass, canManageClass } from '../../../model/user';
import {
    BadRequestError, ContestModel, DomainModel, Handler, moment, NotFoundError, ObjectId, param, PERM, PermissionError,
    ProblemModel, StorageModel, Types, UserModel, ValidationError,
} from '../../../plugin-api';
import { cleanupInactiveAssessments, validateAssessmentPlan } from '../model/assessment';
import { ClassModel } from '../model/class';
import type { CourseTdoc } from '../model/course';
import { DEFAULT_COURSE_LESSON_DURATION_HOURS } from '../model/course';
import { nextStructure, problemAccessNodeIds, problemNodeIds } from '../model/structure';
import { parseDag } from './course';

function calcCourseTimeRange(baseBeginAt: moment.Moment, classEndAt: moment.Moment) {
    const beginAt = baseBeginAt.clone();
    return { beginAt, endAt: classEndAt.clone() };
}

function getLessonDurationHours(tdoc?: Partial<CourseTdoc>) {
    const value = Number(tdoc?.lessonDurationHours);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_COURSE_LESSON_DURATION_HOURS;
}

function calcLessonTimeRange(beginAt: moment.Moment, lessonDurationHours: number) {
    return {
        lessonDurationHours,
        lessonBeginAt: beginAt.toDate(),
        lessonEndAt: beginAt.clone().add(lessonDurationHours, 'hours').toDate(),
    };
}

async function restoreCourseAssignments(
    domainId: string,
    tids: ObjectId[],
    name: string,
    previousName: string,
) {
    const results = await Promise.allSettled(tids.map(
        (tid) => ContestModel.replaceAssignGroup(domainId, tid, name, previousName),
    ));
    const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Failed to restore course assignments.');
}

async function refreshClassEditLock(domainId: string, classId: ObjectId, editToken: string) {
    const refreshed = await ClassModel.refreshEditLock(domainId, classId, editToken);
    if (!refreshed.matchedCount) throw new Error('The class edit lock was lost.');
}

async function renameClassCourses(
    domainId: string,
    classId: ObjectId,
    previousName: string,
    name: string,
    editToken: string,
) {
    const renamedCourseIds = new Map<string, ObjectId>();
    try {
        for (let pass = 0; pass < 10; pass++) {
            // eslint-disable-next-line no-await-in-loop
            await refreshClassEditLock(domainId, classId, editToken);
            // eslint-disable-next-line no-await-in-loop
            const tdocs = await ContestModel.getMulti(domainId, {
                rule: 'course',
                assign: { $in: [previousName] },
            }).toArray();
            if (!tdocs.length) {
                return () => restoreCourseAssignments(
                    domainId,
                    [...renamedCourseIds.values()],
                    name,
                    previousName,
                );
            }
            // eslint-disable-next-line no-await-in-loop
            const results = await Promise.allSettled(tdocs.map(async (tdoc) => {
                renamedCourseIds.set(tdoc._id.toString(), tdoc._id);
                await ContestModel.replaceAssignGroup(
                    domainId,
                    tdoc._id,
                    previousName,
                    name,
                );
            }));
            const failure = results.find(
                (result): result is PromiseRejectedResult => result.status === 'rejected',
            );
            if (failure) throw failure.reason;
        }
        throw new Error('Course assignments kept changing while the class was being renamed.');
    } catch (error) {
        const rollbackErrors: unknown[] = [error];
        let classRestored = false;
        try {
            await refreshClassEditLock(domainId, classId, editToken);
            const rollback = await ClassModel.renameGroup(domainId, classId, name, previousName, editToken);
            classRestored = !!rollback.matchedCount;
            if (!classRestored) {
                rollbackErrors.push(new Error('The class name changed again before it could be restored.'));
            }
        } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
        }
        if (classRestored) {
            try {
                await restoreCourseAssignments(
                    domainId,
                    [...renamedCourseIds.values()],
                    name,
                    previousName,
                );
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
            }
        }
        if (rollbackErrors.length > 1) {
            throw new AggregateError(rollbackErrors, 'Failed to rename class courses and restore their state.');
        }
        throw error;
    }
}

function fillMessage(template: string, ...params: Array<string | number>) {
    return template.replace(/\{(\d+)\}/g, (_, index) => String(params[Number(index)] ?? ''));
}

async function ensureCourseTitleAvailable(
    domainId: string,
    title: string,
    assignGroup: string,
    translate: (value: string) => string = (value) => value,
) {
    const duplicated = await ContestModel.getMulti(domainId, {
        rule: 'course',
        title,
        assign: { $in: [assignGroup] },
    }).limit(1).next();
    if (duplicated) {
        throw new BadRequestError(fillMessage(translate('Course "{0}" already exists in this domain.'), title));
    }
}

async function resolveCanonicalDomainId(domainId: string) {
    const requestedDomainId = String(domainId || '').trim();
    if (!requestedDomainId) return requestedDomainId;
    const ddoc = await DomainModel.get(requestedDomainId);
    return ddoc?._id || requestedDomainId;
}

async function assertCourseCopyAllowed(sourceDomainId: string, targetDomainId: string, translate: (value: string) => string = (value) => value) {
    const ddoc = await DomainModel.get(sourceDomainId);
    if (!ddoc) {
        throw new BadRequestError(fillMessage(translate('Source domain {0} does not exist.'), sourceDomainId));
    }
    const canonicalSourceDomainId = ddoc._id;
    const canonicalTargetDomainId = await resolveCanonicalDomainId(targetDomainId);
    if (canonicalSourceDomainId.toLowerCase() === canonicalTargetDomainId.toLowerCase()) {
        return ddoc;
    }
    const sharedDomains = String(ddoc.share || '')
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean);
    if (!sharedDomains.includes('*') && !sharedDomains.includes(canonicalTargetDomainId.toLowerCase())) {
        throw new BadRequestError(fillMessage(
            translate('You are not allowed to copy this course from {0} to {1}.'),
            canonicalSourceDomainId, canonicalTargetDomainId,
        ));
    }
    return ddoc;
}

async function assertProblemCopyAllowed(
    sourceDomainId: string, targetDomainId: string, originPid: number,
    translate: (value: string) => string = (value) => value,
) {
    const ddoc = await DomainModel.get(sourceDomainId);
    if (!ddoc) {
        throw new BadRequestError(fillMessage(translate('Source domain {0} does not exist.'), sourceDomainId));
    }
    const canonicalSourceDomainId = ddoc._id;
    const canonicalTargetDomainId = await resolveCanonicalDomainId(targetDomainId);
    if (canonicalSourceDomainId.toLowerCase() === canonicalTargetDomainId.toLowerCase()) {
        return ddoc;
    }
    const sharedDomains = String(ddoc.share || '')
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter(Boolean);
    if (!sharedDomains.includes('*') && !sharedDomains.includes(canonicalTargetDomainId.toLowerCase())) {
        throw new BadRequestError(fillMessage(
            translate('Problem {0} in {1} is not allowed to be copied to {2}.'),
            originPid, canonicalSourceDomainId, canonicalTargetDomainId,
        ));
    }
    return ddoc;
}

async function resolveProblemOrigin(domainId: string, pid: number, translate: (value: string) => string = (value) => value) {
    const readOrigin = async (sourceDomainId: string, sourcePid: number): ReturnType<typeof ProblemModel.get> => {
        const current = await ProblemModel.get(sourceDomainId, sourcePid);
        if (!current) {
            throw new BadRequestError(fillMessage(translate('Referenced source problem {0} in domain {1} does not exist.'), pid, domainId));
        }
        if (current.reference) return readOrigin(current.reference.domainId, current.reference.pid);
        return current;
    };
    const current = await readOrigin(domainId, pid);
    return {
        originDomainId: current.domainId,
        originPid: current.docId,
    };
}

async function buildPidMapping(
    sourceDomainId: string,
    targetDomainId: string,
    pids: number[],
    translate: (value: string) => string = (value) => value,
) {
    const mapping = new Map<number, number>();
    const missing: Array<{ pid: number, originDomainId: string, originPid: number }> = [];

    for await (const pid of Array.from(new Set(pids))) {
        const origin = await resolveProblemOrigin(sourceDomainId, pid, translate);
        // Dot notation: an exact-match query on the whole `reference` subdocument
        // would miss copies that carry extra sync fields (sourceUpdateAt/lastSyncAt).
        let matched = await ProblemModel.getMulti(targetDomainId, {
            'reference.domainId': origin.originDomainId,
            'reference.pid': origin.originPid,
        }, ['docId', 'reference']).limit(1).next();

        if (!matched && targetDomainId === origin.originDomainId) {
            matched = await ProblemModel.get(targetDomainId, origin.originPid);
        }

        if (!matched) {
            missing.push({ pid, originDomainId: origin.originDomainId, originPid: origin.originPid });
            continue;
        }

        mapping.set(pid, matched.docId);
    }

    return { mapping, missing };
}

async function copyMissingProblemsToTarget(
    targetDomainId: string,
    missing: Array<{ pid: number, originDomainId: string, originPid: number }>,
    userId: number,
    translate: (value: string) => string = (value) => value,
) {
    const targetUser = await UserModel.getById(targetDomainId, userId);
    if (!targetUser?.hasPerm(PERM.PERM_CREATE_PROBLEM)) {
        throw new PermissionError(PERM.PERM_CREATE_PROBLEM);
    }

    const uniqueOrigins = Array.from(new Map(
        missing.map((item) => [`${item.originDomainId}:${item.originPid}`, item]),
    ).values());

    for await (const item of uniqueOrigins) {
        await assertProblemCopyAllowed(item.originDomainId, targetDomainId, item.originPid, translate);
        await ProblemModel.copy(item.originDomainId, item.originPid, targetDomainId);
    }
}

function rewriteDagPids(dag: any[], mapping: Map<number, number>) {
    return dag.map((node) => ({
        ...node,
        pids: Array.isArray(node.pids)
            ? node.pids.map((pid: number) => mapping.get(pid) || pid)
            : node.pids,
    }));
}

function getLectureContent(lecture: Record<string | number, string>, nodeId: number) {
    const content = lecture[nodeId] || lecture[String(nodeId)];
    return typeof content === 'string' && content.length ? content : '';
}

function getLectureTitle(sourceNode: any, targetNode: any, targetNodeId: number) {
    if (typeof sourceNode?.lecture === 'string' && sourceNode.lecture.trim()) return sourceNode.lecture;
    if (typeof targetNode?.lecture === 'string' && targetNode.lecture.trim()) return targetNode.lecture;
    if (typeof sourceNode?.title === 'string' && sourceNode.title.trim()) return sourceNode.title;
    if (typeof targetNode?.title === 'string' && targetNode.title.trim()) return targetNode.title;
    return `Lecture ${targetNodeId}`;
}

function copyCourseLecture(template: CourseTdoc, sourceDag: any[], targetDag: any[]) {
    const lecture = template.lecture || {};
    const lectureMeta = template.lectureMeta || {};
    const nextLecture: Record<number, string> = {};
    const nextLectureMeta: Record<number, { editor: number, updateAt: Date }> = {};
    const nextDag = targetDag.map((node, index) => {
        const sourceNode = sourceDag[index] || node;
        const sourceContent = getLectureContent(lecture, sourceNode._id);
        const targetContent = getLectureContent(lecture, node._id);
        const content = sourceContent || targetContent;
        const sourceMeta = lectureMeta[sourceNode._id] || lectureMeta[String(sourceNode._id)];
        const targetMeta = lectureMeta[node._id] || lectureMeta[String(node._id)];
        if (!content && !sourceMeta && !targetMeta) return node;
        if (content) {
            nextLecture[node._id] = content;
            nextLectureMeta[node._id] = (sourceContent ? sourceMeta : targetMeta) || {
                editor: template.owner,
                updateAt: template._id.getTimestamp(),
            };
        } else {
            nextLectureMeta[node._id] = sourceMeta || targetMeta;
        }
        if (!content) return node;
        if (node.lecture) return node;
        return {
            ...node,
            lecture: getLectureTitle(sourceNode, node, node._id),
        };
    });
    return { dag: nextDag, lecture: nextLecture, lectureMeta: nextLectureMeta };
}

// 班级列表页面
export class ClassHandler extends Handler {
    async prepare() {
        if (!canCreateClass(this.user) && !this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)) {
            throw new PermissionError(PERM.PERM_EDIT_HOMEWORK_SELF);
        }
    }

    async get({ domainId }: { domainId: string }) {
        const groups = (await ClassModel.listGroup(domainId))
            .filter((group) => canManageClass(this.user, group));

        // 过滤掉 teachers 特殊班级
        const filteredGroups = groups
            .filter((g) => g.name !== 'teachers')
            .sort((a, b) => String(b._id).localeCompare(String(a._id)));

        // 获取每个班级的课程数量
        const groupsWithCourseCount = await Promise.all(
            filteredGroups.map(async (g) => {
                const count = await ContestModel.getMulti(domainId, {
                    rule: 'course',
                    assign: { $in: [g.name] },
                }).count();
                return { ...g, courseCount: count };
            }),
        );

        this.response.template = 'domain_class.html';
        this.response.body = {
            canCreateClass: canCreateClass(this.user),
            domain: this.domain,
            groups: groupsWithCourseCount,
        };
    }
}

// 班级编辑页面
export class ClassEditHandler extends Handler {
    @param('id', Types.ObjectId, true)
    async prepare(domainId: string, id?: ObjectId) {
        if (!id) {
            if (!canCreateClass(this.user)) throw new PermissionError(PERM.PERM_CREATE_HOMEWORK);
            return;
        }
        const group = await ClassModel.getGroupById(domainId, id);
        if (!group || group.name === 'teachers') throw new NotFoundError(domainId, id);
        if (!canManageClass(this.user, group)) throw new PermissionError(PERM.PERM_EDIT_HOMEWORK);
    }

    @param('id', Types.ObjectId, true)
    async get(domainId: string, id?: ObjectId) {
        this.response.body = {
            page_name: id ? 'domain_class_edit' : 'domain_class_create',
            domain: this.domain,
        };

        let beginAt = moment().add(1, 'day').tz(this.user.timeZone).hour(0).minute(0).millisecond(0);
        let endAt = beginAt.clone().add(7, 'days').tz(this.user.timeZone).hour(23).minute(59).millisecond(0);
        let intervalDays = 1;

        const extra: any = {};
        const groups = (await UserModel.listGroup(domainId)).filter((g: any) => !g?.class);
        extra.groups = groups;
        const visibleDomainIds = Object.keys(await DomainModel.getDictUserByDomainId(this.user._id));
        extra.availableSourceDomains = visibleDomainIds.length
            ? (await DomainModel.getMulti({ _id: { $in: visibleDomainIds } }).toArray())
                .sort((a, b) => a.name.localeCompare(b.name) || a._id.localeCompare(b._id))
                .map((ddoc: any) => ({ _id: ddoc._id, name: ddoc.name }))
            : [];

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
                beginAt = moment.utc(gdoc.beginAt).tz(this.user.timeZone);
            }
            if (gdoc.endAt) {
                endAt = moment.utc(gdoc.endAt).tz(this.user.timeZone);
            }
            if (typeof gdoc.intervalDays === 'number') {
                intervalDays = gdoc.intervalDays;
            }

            // 如果没有设置时间但有课程，使用课程的时间范围
            if (!gdoc.beginAt && tdocs.length) {
                beginAt = moment.min(tdocs.map((t) => moment(t.beginAt).tz(this.user.timeZone)));
                endAt = moment.max(tdocs.map((t) => moment(t.endAt).tz(this.user.timeZone)));
            }
        }

        const intervalPreset = intervalDays === 1 ? '1' : intervalDays === 7 ? '7' : 'custom';
        const publicScoreboard = extra.gdoc ? extra.gdoc.publicScoreboard !== false : true;
        const enablePenalty = extra.gdoc ? extra.gdoc.enablePenalty !== false : true;
        Object.assign(this.response.body, {
            dateBeginText: beginAt.format('YYYY-M-D'),
            timeBeginText: beginAt.format('H:mm'),
            dateEndText: endAt.format('YYYY-M-D'),
            timeEndText: endAt.format('H:mm'),
            intervalDays,
            intervalPreset,
            publicScoreboard,
            enablePenalty,
            ...extra,
        });

        this.response.template = 'domain_class_edit.html';
    }

    @param('id', Types.ObjectId)
    async postDelete(domainId: string, id: ObjectId) {
        const gdoc = await ClassModel.getGroupById(domainId, id);
        if (!gdoc) throw new NotFoundError(domainId, id);

        const editToken = new ObjectId().toHexString();
        const lock = await ClassModel.acquireEditLock(domainId, id, gdoc.name, editToken);
        if (!lock.matchedCount) {
            throw new BadRequestError('Class is being edited. Please refresh and try again.');
        }

        try {
            const lockedGroup = await ClassModel.getGroupById(domainId, id);
            if (!lockedGroup) throw new NotFoundError(domainId, id);
            await refreshClassEditLock(domainId, id, editToken);
            if (!canManageClass(this.user, lockedGroup)) throw new PermissionError(PERM.PERM_EDIT_HOMEWORK);

            // 删除所有仍关联到该班级的课程
            const tdocs = await ContestModel.getMulti(domainId, {
                rule: 'course',
                assign: { $in: [gdoc.name] },
            }).toArray();

            // Validate the whole class before deleting any parent courses or test history.
            await Promise.all(tdocs.map((t) => validateAssessmentPlan(domainId, [], t as CourseTdoc, t.beginAt, t.endAt)));
            await Promise.all(tdocs.map(async (t) => {
                const deleted = await ContestModel.delIfAssigned(domainId, t._id, gdoc.name);
                if (deleted) await cleanupInactiveAssessments(domainId, t.docId, []);
            }));
            await ClassModel.delGroup(domainId, id, editToken);
        } finally {
            try {
                await ClassModel.releaseEditLock(domainId, id, editToken);
            } catch { }
        }

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
    @param('intervalDays', Types.Int, true)
    @param('archive', Types.Boolean)
    @param('publicScoreboard', Types.Boolean, true)
    @param('enablePenalty', Types.Boolean, true)
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
        intervalDays = 1,
        archive = false,
        publicScoreboard = true,
        enablePenalty = true,
    ) {
        const beginAt = moment.tz(`${beginAtDate} ${beginAtTime}`, 'YYYY-M-D H:mm', this.user.timeZone);
        if (!beginAt.isValid()) throw new ValidationError('beginAtDate', 'beginAtTime');

        const endAt = moment.tz(`${endAtDate} ${endAtTime}`, 'YYYY-M-D H:mm', this.user.timeZone);
        if (!endAt.isValid()) throw new ValidationError('endAtDate', 'endAtTime');

        if (!intervalDays || intervalDays < 1) intervalDays = 1;

        name = name.trim();
        if (!name || name === 'teachers' || name.includes(',') || /^\d+$/.test(name)) {
            throw new ValidationError('name');
        }
        if (await UserModel.collGroup.findOne({
            domainId,
            name,
            ...(id ? { _id: { $ne: id } } : {}),
        })) {
            throw new ValidationError('name');
        }

        let shouldUpdateCourseTimes = true;
        let revokeClassInvitation = false;
        let expectedName: string | undefined;
        let previousName: string | undefined;

        if (id) {
            const gdoc = await ClassModel.getGroupById(domainId, id);
            if (!gdoc) throw new NotFoundError(domainId, id);
            expectedName = gdoc.name;
            revokeClassInvitation = gdoc.name === 'teachers' || !!gdoc.archive || archive;

            // 检查时间相关字段是否发生变化
            const oldBeginAt = moment.utc(gdoc.beginAt).tz(this.user.timeZone);
            const oldEndAt = moment.utc(gdoc.endAt).tz(this.user.timeZone);
            const oldIntervalDays = gdoc.intervalDays || 1;

            const beginAtChanged = !beginAt.isSame(oldBeginAt, 'minute');
            const endAtChanged = !endAt.isSame(oldEndAt, 'minute');
            const intervalChanged = intervalDays !== oldIntervalDays;

            shouldUpdateCourseTimes = beginAtChanged || endAtChanged || intervalChanged;

            if (gdoc.name !== name) previousName = gdoc.name;
        }

        const groupDocs = (await UserModel.listGroup(domainId)).filter((g: any) => !g?.class);
        const groupMap = new Map<string, number[]>(groupDocs.map((g: any) => [g.name, (g.uids || []) as number[]]));
        const collectGroupUids = (groupNames: string[]) => groupNames.flatMap((groupName) => groupMap.get(groupName) || []);
        const creatorTeachers = !id && !this.user.hasPerm(PERM.PERM_EDIT_DOMAIN, PERM.PERM_EDIT_HOMEWORK)
            ? [this.user._id]
            : [];
        const mergedTeachers = Array.from(new Set([
            ...teachers,
            ...collectGroupUids(teacherGroups),
            ...creatorTeachers,
        ]));
        const mergedStudents = Array.from(new Set([...students, ...collectGroupUids(studentGroups)]));

        const editToken = id ? new ObjectId().toHexString() : undefined;
        if (id) {
            const lock = await ClassModel.acquireEditLock(domainId, id, expectedName!, editToken!);
            if (!lock.matchedCount) {
                throw new BadRequestError('Class is being edited. Please refresh and try again.');
            }
        }

        try {
            if (id) {
                const lockedGroup = await ClassModel.getGroupById(domainId, id);
                if (!lockedGroup) throw new NotFoundError(domainId, id);
                await refreshClassEditLock(domainId, id, editToken!);
                if (!canManageClass(this.user, lockedGroup)) throw new PermissionError(PERM.PERM_EDIT_HOMEWORK);
            }
            let restoreRenamedCourses: (() => Promise<void>) | undefined;
            if (previousName) {
                const renameResult = await ClassModel.renameGroup(
                    domainId,
                    id!,
                    previousName,
                    name,
                    editToken!,
                );
                if (!renameResult.matchedCount) {
                    throw new BadRequestError('Class has been modified. Please refresh and try again.');
                }
                restoreRenamedCourses = await renameClassCourses(
                    domainId,
                    id!,
                    previousName,
                    name,
                    editToken!,
                );
                expectedName = name;
            }

            try {
                if (id) await refreshClassEditLock(domainId, id, editToken!);
                const groupUpdate = await ClassModel.updateGroup(
                    domainId,
                    name,
                    mergedTeachers,
                    mergedStudents,
                    beginAt.toDate(),
                    endAt.toDate(),
                    archive,
                    intervalDays,
                    id || new ObjectId(),
                    revokeClassInvitation,
                    expectedName,
                    editToken,
                    publicScoreboard,
                    enablePenalty,
                );
                if (id && !groupUpdate.matchedCount) {
                    throw new BadRequestError('Class has been modified. Please refresh and try again.');
                }
            } catch (error) {
                if (!previousName) throw error;
                const rollbackErrors: unknown[] = [error];
                let classRestored = false;
                try {
                    await refreshClassEditLock(domainId, id!, editToken!);
                    const rollback = await ClassModel.renameGroup(
                        domainId,
                        id!,
                        name,
                        previousName,
                        editToken!,
                    );
                    classRestored = !!rollback.matchedCount;
                    if (!classRestored) {
                        rollbackErrors.push(new Error('The class name changed again before it could be restored.'));
                    }
                } catch (rollbackError) {
                    rollbackErrors.push(rollbackError);
                }
                if (classRestored) {
                    try {
                        await restoreRenamedCourses?.();
                    } catch (rollbackError) {
                        rollbackErrors.push(rollbackError);
                    }
                }
                if (rollbackErrors.length > 1) {
                    throw new AggregateError(rollbackErrors, 'Failed to update the renamed class and restore its state.');
                }
                throw error;
            }
            // 更新所有关联课程的维护者（始终更新）
            const tdocs = await ContestModel.getMulti(domainId, {
                rule: 'course',
                assign: { $in: [name] },
            }).sort({ beginAt: 1, _id: 1 }).toArray();

            // 只有时间相关字段变化时，才更新课程时间
            if (shouldUpdateCourseTimes) {
                await Promise.all(tdocs.map((t, index) => {
                    const baseBeginAt = beginAt.clone().add(index * intervalDays, 'days');
                    const { beginAt: courseBeginAt, endAt: courseEndAt } = calcCourseTimeRange(baseBeginAt, endAt);
                    const lessonWindow = calcLessonTimeRange(courseBeginAt, getLessonDurationHours(t as CourseTdoc));
                    return ContestModel.editIfAssigned(domainId, t._id, name, {
                        beginAt: courseBeginAt.toDate(),
                        endAt: courseEndAt.toDate(),
                        ...lessonWindow,
                        maintainer: mergedTeachers,
                    });
                }));
            } else {
                // 仅更新维护者
                await Promise.all(tdocs.map((t) => ContestModel.editIfAssigned(domainId, t._id, name, {
                    maintainer: mergedTeachers,
                })));
            }
        } finally {
            if (id && editToken) {
                try {
                    await ClassModel.releaseEditLock(domainId, id, editToken);
                } catch { }
            }
        }

        this.response.redirect = this.url('domain_class');
    }

    @param('id', Types.ObjectId)
    @param('sourceDomain', Types.String)
    async postGetTemplates(domainId: string, id: ObjectId, sourceDomain: string) {
        domainId = await resolveCanonicalDomainId(domainId);
        const gdoc = await ClassModel.getGroupById(domainId, id);
        if (!gdoc) throw new NotFoundError(domainId, id);
        const requestedSourceDomainId = (sourceDomain || '').trim();
        if (!requestedSourceDomainId) throw new ValidationError('sourceDomain');

        const sourceDomainDoc = await assertCourseCopyAllowed(
            requestedSourceDomainId,
            domainId,
            (this as any).translate?.bind(this),
        );
        const sourceDomainId = sourceDomainDoc._id;

        const [templates, tdocs] = await Promise.all([
            ContestModel.getMulti(sourceDomainId, {
                rule: 'course',
                assign: { $elemMatch: { $eq: 'teachers' } },
            }).sort({ title: 1 }).toArray(),
            ContestModel.getMulti(domainId, {
                rule: 'course',
                assign: { $in: [gdoc.name] },
            }).toArray(),
        ]);

        const usedTitles = new Set(tdocs.map((t) => t.title));
        this.response.body = {
            templates: templates
                .filter((t) => !usedTitles.has(t.title))
                .map((t) => ({
                    _id: `${sourceDomainId}:${t._id}`,
                    name: t.title,
                    title: t.title,
                    sourceDomainId,
                })),
        };
    }

    @param('id', Types.ObjectId)
    @param('template', Types.CommaSeperatedArray)
    async postCopy(domainId: string, id: ObjectId, templateIds: string[]) {
        // Route/domain IDs are resolved case-insensitively, while document
        // records store the original domain ID and query it case-sensitively.
        // Use the domain document's canonical ID for every target-side query.
        domainId = await resolveCanonicalDomainId(domainId);
        let gdoc = await ClassModel.getGroupById(domainId, id);
        if (!gdoc) throw new NotFoundError(domainId, id);
        const user = (this as any).user;
        const editToken = new ObjectId().toHexString();
        const lock = await ClassModel.acquireEditLock(domainId, id, gdoc.name, editToken);
        if (!lock.matchedCount) {
            throw new BadRequestError('Class is being edited. Please refresh and try again.');
        }

        try {
            const lockedGroup = await ClassModel.getGroupById(domainId, id);
            if (!lockedGroup) throw new NotFoundError(domainId, id);
            await refreshClassEditLock(domainId, id, editToken);
            if (!canManageClass(this.user, lockedGroup)) throw new PermissionError(PERM.PERM_EDIT_HOMEWORK);
            gdoc = lockedGroup;

            const intervalDays = typeof gdoc.intervalDays === 'number' && gdoc.intervalDays > 0 ? gdoc.intervalDays : 1;
            const classBeginAt = moment.utc(gdoc.beginAt).tz(user.timeZone);
            const classEndAt = moment.utc(gdoc.endAt).tz(this.user.timeZone);

            const lastCourse = await ContestModel.getMulti(domainId, {
                rule: 'course',
                assign: { $in: [gdoc.name] },
            }).sort({ beginAt: -1, _id: -1 }).limit(1).next();

            let nextBaseBeginAt = lastCourse
                ? moment.utc(lastCourse.beginAt).tz(user.timeZone).add(intervalDays, 'days')
                : classBeginAt.clone();

            const tdocs: any[] = [];

            for await (const templateValue of templateIds) {
                const [sourceDomainIdRaw, templateIdRaw] = String(templateValue || '').split(':');
                const requestedSourceDomainId = (sourceDomainIdRaw || '').trim();
                const templateId = (templateIdRaw || '').trim();
                if (!requestedSourceDomainId || !templateId) continue;

                const sourceDomainDoc = await assertCourseCopyAllowed(
                    requestedSourceDomainId,
                    domainId,
                    (this as any).translate?.bind(this),
                );
                const sourceDomainId = sourceDomainDoc._id;

                const template = await ContestModel.get(sourceDomainId, new ObjectId(templateId)) as CourseTdoc;
                if (!template) continue;

                const { title, content, dag } = template;
                await ensureCourseTitleAvailable(domainId, title, gdoc.name, (this as any).translate?.bind(this));

                const parsedDag = await parseDag(sourceDomainId, JSON.stringify(dag));
                const sourcePids = Array.from(new Set(parsedDag.flatMap((node) => node.pids)));
                let { mapping, missing } = await buildPidMapping(sourceDomainId, domainId, sourcePids, (this as any).translate?.bind(this));
                if (missing.length) {
                    await copyMissingProblemsToTarget(domainId, missing, user._id, (this as any).translate?.bind(this));
                    ({ mapping, missing } = await buildPidMapping(sourceDomainId, domainId, sourcePids, (this as any).translate?.bind(this)));
                    if (missing.length) {
                        const missingText = missing.map((item) => `${item.pid} -> ${item.originDomainId}:${item.originPid}`).join(', ');
                        throw new BadRequestError(fillMessage(
                            (this as any).translate?.('Missing referenced problems in target domain: {0}')
                            || 'Missing referenced problems in target domain: {0}',
                            missingText,
                        ));
                    }
                }
                const newDag = rewriteDagPids(parsedDag, mapping);
                const copiedLecture = copyCourseLecture(template, parsedDag, newDag);
                const finalDag = copiedLecture.dag;
                const newLecture = copiedLecture.lecture;
                const newLectureMeta = copiedLecture.lectureMeta;
                const allPids = Array.from(new Set(finalDag.filter((node) => node.kind !== 'assessment').flatMap((node) => node.pids)));

                const { beginAt, endAt } = calcCourseTimeRange(nextBaseBeginAt, classEndAt);
                const shiftMs = beginAt.valueOf() - new Date(template.beginAt).getTime();
                for (const node of finalDag) {
                    if (node.kind !== 'assessment' || !node.assessment) continue;
                    delete node.assessment.contestTid;
                    node.assessment.rated = false;
                    node.assessment.beginAt = new Date(new Date(node.assessment.beginAt).getTime() + shiftMs).toISOString();
                    node.assessment.endAt = new Date(new Date(node.assessment.endAt).getTime() + shiftMs).toISOString();
                }
                await validateAssessmentPlan(domainId, finalDag, undefined, beginAt.toDate(), endAt.toDate());
                const lessonWindow = calcLessonTimeRange(beginAt, getLessonDurationHours(template));

                const classPublicScoreboard = gdoc.publicScoreboard !== false;
                const classEnablePenalty = gdoc.enablePenalty !== false;

                await refreshClassEditLock(domainId, id, editToken);
                // 创建新课程
                const newTid = await ContestModel.add(
                    domainId,
                    title,
                    content,
                    user._id,
                    'course',
                    beginAt.toDate(),
                    endAt.toDate(),
                    allPids,
                    false,
                    {
                        ...nextStructure(undefined, finalDag, 0),
                        ...{ problemNodeIds: Object.fromEntries(Object.entries(problemNodeIds(template))
                            .map(([pid, node]) => [mapping.get(+pid) || +pid, node])) },
                        ...{ problemAccessNodeIds: Object.fromEntries(Object.entries(problemAccessNodeIds(template))
                            .map(([pid, node]) => [mapping.get(+pid) || +pid, node])) },
                        assign: [gdoc.name],
                        maintainer: gdoc.teachers,
                        lecture: newLecture,
                        lectureMeta: newLectureMeta,
                        files: template.files,
                        publicScoreboard: classPublicScoreboard,
                        enablePenalty: classEnablePenalty,
                        ...lessonWindow,
                    },
                );

                // ContestModel.add may be extended by hooks; explicitly persist copied lectures and settings after creation
                // so cross-domain course copies do not lose lecture bodies and class settings.
                await ContestModel.edit(domainId, newTid, {
                    publicScoreboard: classPublicScoreboard,
                    enablePenalty: classEnablePenalty,
                    ...(Object.keys(newLecture).length || Object.keys(newLectureMeta).length ? {
                        lecture: newLecture,
                        lectureMeta: newLectureMeta,
                    } : {}),
                });

                // 复制文件
                if (template.files?.length) {
                    await Promise.all(template.files.map((f) => StorageModel.copy(
                        `contest/${sourceDomainId}/${templateId}/public/${f.name}`,
                        `contest/${domainId}/${newTid}/public/${f.name}`,
                    )));
                }

                const newTdoc = await ContestModel.get(domainId, newTid);
                (newTdoc as any).url = this.url('course_detail', { tid: newTid });
                tdocs.push(newTdoc);

                nextBaseBeginAt = nextBaseBeginAt.clone().add(intervalDays, 'days');
            }

            this.response.body = { tdocs };
        } finally {
            try {
                await ClassModel.releaseEditLock(domainId, id, editToken);
            } catch { }
        }
    }
}
