/* eslint-disable no-await-in-loop -- Frozen problem revisions are resolved in contest order. */
import { ObjectId } from 'mongodb';
import Schema from 'schemastery';
import { ValidationError } from '../error';
import { assertCourseAssessmentAccess } from '../lib/course-assessment-access';
import { isClassroomBindingCurrent, resolveClassroomBinding } from '../lib/rating-v2/classroom';
import {
    blocksCertifiedResult, ContestRatingPolicy, contestSignature, isOfficialRecordEligible, isRatingContestEligible, isScoreWithinFullScore,
} from '../lib/rating-v2/eligibility';
import { resolveProblemEvidence } from '../lib/submission-provenance';
import { PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import UserModel from '../model/user';
import db from '../service/db';

declare module '../service/db' {
    interface Collections {
        ratingv2_certification_lock: { _id: string, token: ObjectId, createdAt: Date };
    }
}

export const description = 'Freeze an explicit future contest for certified shadow replay, or mark its results released';

interface CertificationOptions {
    domainId: string; tid: string; operation: 'certify' | 'release'; approvedBy: number;
    poolId?: string; minParticipants?: number;
    participantUids?: number[];
}

async function runLocked(options: CertificationOptions, report: (message: any) => void) {
    const approver = await UserModel.getById(options.domainId, options.approvedBy);
    if (!approver?.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) throw new ValidationError('approvedBy');
    const tdoc = await contest.get(options.domainId, new ObjectId(options.tid));
    const now = new Date();
    const classroom = tdoc.sourceType === 'course_assessment';
    let policy: ContestRatingPolicy;
    const poolId = options.operation === 'certify' ? options.poolId : tdoc.ratingPolicy?.poolId;
    if (!poolId) throw new ValidationError('poolBinding');
    const policies = db.collection('document');
    if (await policies.findOne({ docType: 30, domainId: { $ne: options.domainId },
        'ratingPolicy.enabled': true, 'ratingPolicy.poolId': poolId })
    || await policies.findOne({ docType: 30, domainId: options.domainId,
        'ratingPolicy.enabled': true, 'ratingPolicy.poolId': { $ne: poolId } })) {
        throw new ValidationError('poolBinding');
    }
    if (await policies.findOne({ docType: 30, docId: { $ne: tdoc.docId },
        'ratingPolicy.enabled': true, 'ratingPolicy.poolId': poolId,
        beginAt: { $lt: tdoc.endAt }, endAt: { $gt: tdoc.beginAt } })) throw new ValidationError('overlappingContest');
    if (options.operation === 'certify') {
        if (tdoc.beginAt <= now || (classroom ? tdoc.rated : !tdoc.rated) || tdoc.allowTeam || tdoc.duration
            || !['acm', 'oi'].includes(tdoc.rule) || !tdoc.pids.length
            || !options.poolId || !Number.isSafeInteger(options.minParticipants) || options.minParticipants < 2) {
            throw new ValidationError('certification');
        }
        let classroomPolicy: ContestRatingPolicy['classroom'];
        if (classroom) {
            const binding = await resolveClassroomBinding(db, tdoc);
            const participantUids = options.participantUids;
            if (!binding || !Array.isArray(participantUids) || participantUids.length < options.minParticipants
                || new Set(participantUids).size !== participantUids.length
                || !participantUids.every((uid) => Number.isSafeInteger(uid) && uid > 0)) throw new ValidationError('classroomRoster');
            for (const uid of participantUids) {
                const participant = await UserModel.getById(options.domainId, uid);
                if (!participant?.hasPriv(PRIV.PRIV_USER_PROFILE) || await assertCourseAssessmentAccess(participant, tdoc)) {
                    throw new ValidationError('classroomParticipant', uid);
                }
            }
            classroomPolicy = {
                courseId: String(tdoc.sourceCourseTid), nodeId: tdoc.sourceNodeId,
                courseSignature: binding.courseSignature, sessionId: new ObjectId().toHexString(),
                participantUids: [...participantUids].sort((a, b) => a - b),
            };
        }
        const problemRevisions: Record<number, string> = {};
        for (const pid of tdoc.pids) {
            const evidence = await resolveProblemEvidence(db, options.domainId, pid);
            if (!evidence.problemRevisionId || !evidence.canonicalProblemKey || !evidence.problemFullScore) {
                throw new ValidationError('problemRevision', pid);
            }
            problemRevisions[pid] = evidence.problemRevisionId;
        }
        if (tdoc.beginAt <= new Date()) throw new ValidationError('certification');
        policy = {
            enabled: true, eventKind: classroom ? 'classroom_assessment' : 'timed_individual_contest', mode: 'synchronous',
            poolId: options.poolId, ruleVersion: 'hydro-local-cf-v1',
            eligibilityVersion: classroom ? 'classroom-assessment-v1' : 'timed-contest-v1',
            approvedBy: approver._id, approvedAt: now, minParticipants: options.minParticipants,
            resultRelease: 'manual', contestSignature: contestSignature(tdoc), problemRevisions,
            ...(classroomPolicy ? { classroom: classroomPolicy } : {}),
        };
    } else if (options.operation === 'release') {
        if (!tdoc.ratingPolicy?.enabled || tdoc.endAt > now || tdoc.keepScoreboardHidden
            || tdoc.ratingPolicy.contestSignature !== contestSignature(tdoc)) throw new ValidationError('resultRelease');
        const records = await db.collection('record').find({ domainId: options.domainId, contest: tdoc.docId }).toArray();
        const decisions = records.map((record) => isOfficialRecordEligible(tdoc, record));
        if (decisions.some((d) => blocksCertifiedResult(d.reasonCodes))) {
            throw new ValidationError('unfinishedJudgement');
        }
        policy = { ...tdoc.ratingPolicy, resultsReleasedAt: now };
        const participants = new Set(records.filter((_, i) => decisions[i].allowed).map((record) => record.uid));
        const eligibility = isRatingContestEligible({ ...tdoc, ratingPolicy: policy }, participants.size, policy.poolId, now);
        if (!eligibility.allowed) throw new ValidationError('resultRelease', eligibility.reasonCodes.join(','));
        for (const pid of tdoc.pids) {
            const evidence = await resolveProblemEvidence(db, options.domainId, pid);
            if (evidence.problemRevisionId !== policy.problemRevisions[pid]) throw new ValidationError('problemRevision', pid);
            if (records.some((record, i) => decisions[i].allowed && record.pid === pid
                && !isScoreWithinFullScore(record.score, evidence.problemFullScore))) throw new ValidationError('invalidScore', pid);
        }
    } else throw new ValidationError('operation');
    if (!await isClassroomBindingCurrent(db, { ...tdoc, ratingPolicy: policy })) throw new ValidationError('classroomBinding');
    await contest.edit(options.domainId, tdoc.docId, { ratingPolicy: policy }, tdoc, [
        'domainId', 'rule', 'rated', 'beginAt', 'endAt', 'pids', 'score', 'duration', 'assign', 'allowTeam',
        'langs', 'content', 'autoHide', 'allowPrint', 'allowViewCode', 'monitorMode', 'lockAt', 'keepScoreboardHidden', 'unlocked',
        'sourceType', 'sourceCourseTid', 'sourceNodeId',
    ]);
    report({ message: `${options.operation}: ${tdoc.docId} (${policy.poolId}); public rankings unchanged` });
    return true;
}

export async function run(options: CertificationOptions, report: (message: any) => void) {
    const lock = db.collection('ratingv2_certification_lock');
    const token = new ObjectId();
    try {
        await lock.insertOne({ _id: 'policy-write', token, createdAt: new Date() });
    } catch (error) {
        if (error.code === 11000) throw new ValidationError('certificationBusy');
        throw error;
    }
    try {
        return await runLocked(options, report);
    } finally {
        await lock.deleteOne({ _id: 'policy-write', token });
    }
}

export const apply = (ctx) => ctx.addScript('rating-v2-certify', description, Schema.object({
    domainId: Schema.string().required(),
    tid: Schema.string().required(),
    operation: Schema.union(['certify', 'release']).required(),
    approvedBy: Schema.number().min(1).required().description('System administrator approving this operation'),
    poolId: Schema.string().description('Explicit certified shadow pool'),
    minParticipants: Schema.number().min(2).description('Minimum distinct eligible participants; required to certify'),
    participantUids: Schema.array(Schema.number().min(1))
        .description('Explicit admitted, enrolled and unlocked student roster; required for classroom certification'),
}), run);
