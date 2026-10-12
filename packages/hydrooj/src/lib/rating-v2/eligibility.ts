import { createHash } from 'crypto';

export interface ContestRatingPolicy {
    enabled: boolean;
    eventKind: 'timed_individual_contest' | 'classroom_assessment';
    mode: 'synchronous';
    poolId: string;
    ruleVersion: 'hydro-local-cf-v1';
    eligibilityVersion: 'timed-contest-v1' | 'classroom-assessment-v1';
    approvedBy: number;
    approvedAt: Date;
    minParticipants: number;
    resultRelease: 'manual';
    resultsReleasedAt?: Date;
    contestSignature: string;
    problemRevisions: Record<number, string>;
    classroom?: {
        courseId: string; nodeId: number; courseSignature: string;
        sessionId: string; participantUids: number[];
    };
}

export interface RatingContestInput {
    docId?: unknown;
    domainId?: string;
    rated?: boolean;
    rule: string;
    beginAt: Date;
    endAt: Date;
    pids?: number[];
    score?: Record<number, number>;
    duration?: number;
    assign?: string[];
    allowTeam?: boolean;
    keepScoreboardHidden?: boolean;
    langs?: string[];
    content?: string;
    autoHide?: boolean;
    allowPrint?: boolean;
    allowViewCode?: boolean;
    monitorMode?: string;
    lockAt?: Date;
    unlocked?: boolean;
    ratingPolicy?: ContestRatingPolicy;
    sourceType?: 'course_assessment';
    sourceCourseTid?: unknown;
    sourceNodeId?: number;
}

export type EligibilityReason =
    | 'NOT_RATED' | 'NOT_CERTIFIED' | 'UNSUPPORTED_RULE' | 'PERSONAL_START_MODE'
    | 'TEAM_CONTEST' | 'INVALID_WINDOW' | 'POLICY_NOT_FROZEN_BEFORE_START'
    | 'CONTEST_CHANGED' | 'POOL_MISMATCH' | 'RESULTS_NOT_RELEASED' | 'INSUFFICIENT_FIELD'
    | 'MISSING_TIME_EVIDENCE' | 'OUT_OF_WINDOW' | 'NON_OFFICIAL_ENTRY'
    | 'NON_NORMAL_SUBMISSION' | 'CONTEST_MISMATCH' | 'PROBLEM_MISMATCH'
    | 'MISSING_PROBLEM_REVISION' | 'PROBLEM_REVISION_MISMATCH' | 'MISSING_INGRESS_VERSION' | 'UNFINALIZED_JUDGEMENT'
    | 'PRIVATE_NOT_RELEASED' | 'PROBLEM_OWNER' | 'MISSING_PROBLEM_EVIDENCE'
    | 'OVERLAPPING_CONTESTS' | 'INVALID_SCORE' | 'CLASSROOM_BINDING_CHANGED' | 'CLASSROOM_SESSION_MISMATCH';

export interface EligibilityDecision {
    allowed: boolean;
    reasonCodes: EligibilityReason[];
}

const time = (value: Date | undefined) => value instanceof Date ? value.getTime() : NaN;
const decision = (reasonCodes: EligibilityReason[]): EligibilityDecision => ({
    allowed: !reasonCodes.length, reasonCodes: [...new Set(reasonCodes)],
});

/** Freeze the configuration that defines answering opportunities, not presentation. */
export function contestSignature(contest: RatingContestInput): string {
    return createHash('sha256').update(JSON.stringify({
        domainId: contest.domainId, rule: contest.rule, rated: contest.rated,
        beginAt: time(contest.beginAt), endAt: time(contest.endAt),
        pids: contest.pids || [], score: contest.score || {}, duration: contest.duration || 0,
        assign: [...(contest.assign || [])].sort(), allowTeam: !!contest.allowTeam,
        langs: [...(contest.langs || [])].sort(), content: contest.content || '',
        autoHide: !!contest.autoHide, allowPrint: !!contest.allowPrint, allowViewCode: !!contest.allowViewCode,
        monitorMode: contest.monitorMode || 'off', lockAt: Number.isFinite(time(contest.lockAt)) ? time(contest.lockAt) : null,
        ...(contest.sourceType ? {
            sourceType: contest.sourceType, sourceCourseTid: String(contest.sourceCourseTid), sourceNodeId: contest.sourceNodeId,
        } : {}),
    })).digest('hex');
}

export function isRatingContestEligible(
    contest: RatingContestInput, validParticipants: number, poolId: string,
    now = new Date(), allowedRules: readonly string[] = ['acm', 'oi'],
): EligibilityDecision {
    const reasons: EligibilityReason[] = [];
    const policy = contest.ratingPolicy;
    const classroom = contest.sourceType === 'course_assessment';
    if (!contest.rated && !classroom) reasons.push('NOT_RATED');
    if (!['acm', 'oi'].includes(contest.rule) || !allowedRules.includes(contest.rule)) reasons.push('UNSUPPORTED_RULE');
    if (contest.duration) reasons.push('PERSONAL_START_MODE');
    if (contest.allowTeam) reasons.push('TEAM_CONTEST');
    const begin = time(contest.beginAt);
    const end = time(contest.endAt);
    if (!Number.isFinite(begin) || !Number.isFinite(end) || begin >= end) reasons.push('INVALID_WINDOW');
    if (!policy?.enabled || policy.eventKind !== (classroom ? 'classroom_assessment' : 'timed_individual_contest')
        || policy.mode !== 'synchronous' || policy.ruleVersion !== 'hydro-local-cf-v1'
        || policy.eligibilityVersion !== (classroom ? 'classroom-assessment-v1' : 'timed-contest-v1')
        || policy.resultRelease !== 'manual' || !Number.isSafeInteger(policy.approvedBy) || policy.approvedBy <= 0
        || !Number.isSafeInteger(policy.minParticipants) || policy.minParticipants < 2
        || !contest.pids?.length || !contest.pids.every((pid) => !!policy.problemRevisions?.[pid])) {
        reasons.push('NOT_CERTIFIED');
    }
    if (classroom && (contest.rated || !policy?.classroom?.sessionId || !policy.classroom.courseSignature
        || policy.classroom.courseId !== String(contest.sourceCourseTid) || policy.classroom.nodeId !== contest.sourceNodeId
        || !Array.isArray(policy.classroom.participantUids) || policy.classroom.participantUids.length < policy.minParticipants
        || !policy.classroom.participantUids.every((uid) => Number.isSafeInteger(uid) && uid > 0)
        || new Set(policy.classroom.participantUids).size !== policy.classroom.participantUids.length)) reasons.push('NOT_CERTIFIED');
    if (policy) {
        if (!Number.isFinite(time(policy.approvedAt)) || time(policy.approvedAt) >= begin) {
            reasons.push('POLICY_NOT_FROZEN_BEFORE_START');
        }
        if (policy.contestSignature !== contestSignature(contest)) reasons.push('CONTEST_CHANGED');
        if (!policy.poolId || policy.poolId !== poolId) reasons.push('POOL_MISMATCH');
        if (validParticipants < Math.max(2, policy.minParticipants)) reasons.push('INSUFFICIENT_FIELD');
    }
    if (contest.keepScoreboardHidden || (Number.isFinite(time(contest.lockAt)) && !contest.unlocked)
        || !Number.isFinite(time(policy?.resultsReleasedAt))
        || time(policy?.resultsReleasedAt) < end || time(policy?.resultsReleasedAt) > now.getTime() || end > now.getTime()) {
        reasons.push('RESULTS_NOT_RELEASED');
    }
    return decision(reasons);
}

export function isFinalJudgement(record: { status?: number, judgeAt?: Date | null }): boolean {
    // Normal judge verdicts; pending, infrastructure, canceled, hack and AI results are excluded.
    return Number.isFinite(time(record.judgeAt)) && [1, 2, 3, 4, 5, 6, 7].includes(record.status);
}

export function isOfficialRecordEligible(contest: RatingContestInput, record: {
    contest?: unknown; pid?: number; uid?: number; submittedAt?: Date;
    submissionKind?: string; participationMode?: string;
    problemRevisionId?: string; ingressVersion?: string; status?: number; judgeAt?: Date | null; score?: number;
    practiceContest?: unknown;
    domainId?: string;
    submissionContext?: { domainId: string, uid: number, pid: number, contestId?: string };
    classroomSession?: { courseId: string, nodeId: number, sessionId: string };
}): EligibilityDecision {
    const reasons: EligibilityReason[] = [];
    const submittedAt = time(record.submittedAt);
    if (!Number.isFinite(submittedAt)) reasons.push('MISSING_TIME_EVIDENCE');
    else if (submittedAt < time(contest.beginAt) || submittedAt >= time(contest.endAt)) reasons.push('OUT_OF_WINDOW');
    if (record.participationMode !== 'official' || record.practiceContest || !Number.isSafeInteger(record.uid) || record.uid <= 0) {
        reasons.push('NON_OFFICIAL_ENTRY');
    }
    if (record.submissionKind !== 'normal') reasons.push('NON_NORMAL_SUBMISSION');
    if (contest.sourceType === 'course_assessment') {
        const session = contest.ratingPolicy?.classroom;
        if (!session || !session.participantUids?.includes(record.uid)
            || record.classroomSession?.courseId !== session.courseId || record.classroomSession?.nodeId !== session.nodeId
            || record.classroomSession?.sessionId !== session.sessionId) reasons.push('CLASSROOM_SESSION_MISMATCH');
    }
    if (!record.contest || String(record.contest) !== String(contest.docId)) reasons.push('CONTEST_MISMATCH');
    if (!record.submissionContext || record.submissionContext.domainId !== contest.domainId
        || record.submissionContext.uid !== record.uid || record.submissionContext.pid !== record.pid
        || record.submissionContext.contestId !== String(contest.docId)) reasons.push('CONTEST_MISMATCH');
    if (!contest.pids?.includes(record.pid)) reasons.push('PROBLEM_MISMATCH');
    if (!record.problemRevisionId) reasons.push('MISSING_PROBLEM_REVISION');
    else if (record.problemRevisionId !== contest.ratingPolicy?.problemRevisions?.[record.pid]) reasons.push('PROBLEM_REVISION_MISMATCH');
    if (record.ingressVersion !== 'record-v1') reasons.push('MISSING_INGRESS_VERSION');
    if (!isFinalJudgement(record)) reasons.push('UNFINALIZED_JUDGEMENT');
    if (!Number.isFinite(record.score) || record.score < 0) reasons.push('INVALID_SCORE');
    return decision(reasons);
}

/** An otherwise eligible official record must finish judging before replay/release. */
export function blocksCertifiedResult(reasons: EligibilityReason[]): boolean {
    return reasons.length > 0 && reasons.every((reason) => ['UNFINALIZED_JUDGEMENT', 'INVALID_SCORE'].includes(reason));
}

export function isScoreWithinFullScore(score: number, fullScore: number): boolean {
    return Number.isFinite(score) && score >= 0 && Number.isFinite(fullScore) && fullScore > 0 && score <= fullScore;
}

export function isAchievementEligible(input: {
    released?: boolean; owner?: number; uid: number; canonicalProblemKey?: string; fullScore?: number;
}): EligibilityDecision {
    const reasons: EligibilityReason[] = [];
    if (input.released !== true) reasons.push('PRIVATE_NOT_RELEASED');
    if (input.owner === input.uid) reasons.push('PROBLEM_OWNER');
    if (!Number.isSafeInteger(input.owner) || !input.canonicalProblemKey
        || !Number.isFinite(input.fullScore) || input.fullScore <= 0) reasons.push('MISSING_PROBLEM_EVIDENCE');
    return decision(reasons);
}
