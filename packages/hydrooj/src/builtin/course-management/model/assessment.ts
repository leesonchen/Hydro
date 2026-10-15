/* eslint-disable no-await-in-loop -- Binding writes and cleanup must be ordered and awaited. */
import type { Tdoc } from '../../../plugin-api';
import {
    BadRequestError, ContestModel, ForbiddenError, ObjectId, ProblemModel,
} from '../../../plugin-api';
import type { CourseTdoc, DagNode } from './course';

const rules = ['acm', 'oi', 'ioi', 'strictioi'];

function hasStarted(exam: Tdoc) {
    return exam.beginAt <= new Date() || exam.timeChangeHistory?.some((change) => change.state !== 'upcoming');
}

/** Verify all rules before changing the course document, including edits of already-started tests. */
export async function validateAssessmentPlan(
    domainId: string, dag: DagNode[], previous: CourseTdoc | undefined,
    beginAt: Date, endAt: Date,
) {
    const linked = previous?.docId ? await ContestModel.getMulti(domainId, {
        sourceType: 'course_assessment', sourceCourseTid: previous.docId,
    }).toArray() : [];
    for (const node of dag) {
        if (node.kind !== 'assessment') continue;
        const assessment = node.assessment;
        if (!assessment) throw new BadRequestError('Missing classroom test settings');
        const start = new Date(assessment.beginAt);
        const end = new Date(assessment.endAt);
        if (!rules.includes(assessment.rule) || !node.pids.length
            || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
            || start < beginAt || end > endAt || start >= end
            || !Number.isFinite(assessment.passScore ?? 0) || (assessment.passScore ?? 0) < 0
            || (assessment.rule === 'acm' && (!Number.isInteger(assessment.passScore ?? 0)
                || (assessment.passScore ?? 0) > node.pids.length))) {
            throw new BadRequestError('课堂测试时间必须处于课程范围内，题目与达标门槛必须有效。');
        }
        if (assessment.allowPractice !== undefined && typeof assessment.allowPractice !== 'boolean') {
            throw new BadRequestError('Invalid classroom test post-test practice setting');
        }
        if (assessment.monitorMode === 'browser') {
            // Validate before any course mutation/synchronization, so students are
            // never given a monitored test containing a file-only question.
            const pdict = await ProblemModel.getList(
                domainId, node.pids, true, true, ProblemModel.PROJECTION_CONTEST_LIST,
            );
            const filePid = node.pids.find((pid) => pdict[pid]?.config
                && typeof pdict[pid].config === 'object'
                && pdict[pid].config.type === 'submit_answer');
            if (filePid !== undefined) {
                throw new BadRequestError(`课堂测试监控模式不支持文件提交题 P${filePid}。请先调整题目。`);
            }
        }
        const recorded = linked.find((exam) => exam.sourceNodeId === node._id);
        if (recorded && hasStarted(recorded) && (
            recorded.rule !== assessment.rule
            || JSON.stringify(recorded.pids) !== JSON.stringify(node.pids)
        )) throw new ForbiddenError('已开赛的课堂测试不能修改赛制或题目。');
    }
    for (const recorded of linked) {
        if (dag.some((node) => node.kind === 'assessment' && node._id === recorded.sourceNodeId)) continue;
        if (hasStarted(recorded) || recorded.attend > 0) {
            throw new ForbiddenError('课堂测试已开赛或已有参赛记录，不能删除章节。');
        }
    }
}

/** Idempotently synchronize test contests after a course is created or edited. */
export async function syncAssessmentContests(
    domainId: string, courseTid: ObjectId, dag: DagNode[],
    title: string, owner: number, assign: string[], maintainer: number[] = [],
    actorUid = 0,
    recalculate = true,
) {
    for (const node of dag) {
        if (node.kind !== 'assessment' || !node.assessment) continue;
        const { assessment } = node;
        const selector = {
            sourceType: 'course_assessment' as const, sourceCourseTid: courseTid, sourceNodeId: node._id,
        };
        const matches = await ContestModel.getMulti(domainId, selector).limit(2).toArray();
        if (matches.length > 1) throw new ForbiddenError('Multiple contests bound to one classroom test');
        const current = matches[0];
        if (current) {
            if (hasStarted(current)) {
                if (current.rule !== assessment.rule
                    || JSON.stringify(current.pids) !== JSON.stringify(node.pids)) {
                    throw new ForbiddenError('Started classroom test rules and problems cannot be modified');
                }
            }
            const beginAt = new Date(assessment.beginAt);
            const endAt = new Date(assessment.endAt);
            const timeChanged = current.beginAt.getTime() !== beginAt.getTime() || current.endAt.getTime() !== endAt.getTime();
            // Enrollment and schedule may change, but rating still requires explicit certification.
            const updated = await ContestModel.edit(domainId, current.docId, {
                ...(!hasStarted(current) ? { title: `${title} - ${node.title}` } : {}),
                owner, assign, maintainer, rule: assessment.rule, monitorMode: assessment.monitorMode || 'off',
                allowPractice: assessment.allowPractice !== false,
                beginAt, endAt, pids: node.pids, rated: false,
            }, current, ['beginAt', 'endAt', 'rule', 'pids'], actorUid);
            if (recalculate && (timeChanged || (updated.statsRevision || 0) !== (current.statsRevision || 0))) {
                try {
                    await ContestModel.recalcStatus(domainId, current.docId);
                } catch {
                    // Settings are already durable. The editor exposes the pending attempt and its manual retry.
                }
            }
            assessment.contestTid = current.docId.toString();
            continue;
        }
        let newTid: ObjectId;
        try {
            newTid = await ContestModel.add(
                domainId, `${title} - ${node.title}`, '', owner, assessment.rule,
                new Date(assessment.beginAt), new Date(assessment.endAt), node.pids, false,
                { ...selector, assign, maintainer, monitorMode: assessment.monitorMode || 'off',
                    allowPractice: assessment.allowPractice !== false },
            );
        } catch (error: any) {
            // Concurrent saves may race on the unique binding index. Reuse the winning instance.
            if (error?.code !== 11000) throw error;
            const winner = await ContestModel.getMulti(domainId, selector).limit(1).next();
            if (!winner) throw error;
            newTid = winner.docId;
        }
        assessment.contestTid = newTid.toString();
    }
    return dag;
}

/** Delete only unused future test instances that are no longer present in the course DAG. */
export async function cleanupInactiveAssessments(domainId: string, courseTid: ObjectId, dag: DagNode[]) {
    const exams = await ContestModel.getMulti(domainId, {
        sourceType: 'course_assessment', sourceCourseTid: courseTid,
    }).toArray();
    for (const exam of exams) {
        if (dag.some((node) => node.kind === 'assessment' && node._id === exam.sourceNodeId)) continue;
        if (hasStarted(exam) || exam.attend > 0) {
            throw new ForbiddenError('Already-started classroom tests cannot be deleted');
        }
        await ContestModel.del(domainId, exam.docId);
    }
}

export interface AssessmentResult {
    score: number | null;
    completed: boolean;
    finished: boolean;
    updating: boolean;
    recalcState?: Tdoc['statsRecalc']['state'];
    attend: boolean;
    tid: ObjectId;
    rule: string;
    beginAt: Date;
    endAt: Date;
    metric: 'accepted' | 'score';
}

export async function getAssessmentResults(domainId: string, course: CourseTdoc, uid: number) {
    const results: Record<number, AssessmentResult> = {};
    await Promise.all((course.dag || []).filter((node) =>
        node.kind === 'assessment' && !!node.assessment?.contestTid,
    ).map(async (node) => {
        const assessment = node.assessment;
        if (!assessment?.contestTid) return;
        const tid = new ObjectId(assessment.contestTid);
        const [exam, tsdoc] = await Promise.all([
            ContestModel.get(domainId, tid),
            ContestModel.getStatus(domainId, tid, uid),
        ]);
        if (!exam || exam.sourceType !== 'course_assessment'
            || exam.sourceCourseTid?.toString() !== course.docId.toString()
            || exam.sourceNodeId !== node._id) return;
        const finished = ContestModel.isDone(exam, tsdoc);
        // A status write can span journal/statistics updates or delete/recreate enrollment.
        // Its marker lives on the exam so replacing the status cannot lose it.
        const updating = !!exam._assessmentStatusUpdates?.[uid]?.length || !ContestModel.isStatsReady(exam, tsdoc);
        const score = finished && tsdoc?.attend && !updating ? Number((exam.rule === 'acm' ? tsdoc.accept : tsdoc.score) || 0) : null;
        const completed = !!(finished && tsdoc?.attend && tsdoc.journal?.length
            && score !== null && score >= (assessment.passScore ?? 0));
        results[node._id] = {
            score, completed, finished, updating, recalcState: exam.statsRecalc?.state,
            attend: !!tsdoc?.attend, tid, rule: exam.rule,
            beginAt: exam.beginAt, endAt: exam.endAt, metric: exam.rule === 'acm' ? 'accepted' : 'score',
        };
    }));
    return results;
}
