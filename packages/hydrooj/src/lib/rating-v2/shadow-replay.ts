/* eslint-disable no-await-in-loop */
// rating-v2 shadow replay orchestration. The database handle is injected so this
// module stays free of hydrooj runtime imports and can be executed standalone
// (bundled shadow runs). Read-only on source collections; writes only to
// ratingv2_shadow.* when options.write is enabled.

import { ObjectId } from 'mongodb';
import { resolveProblemEvidence } from '../submission-provenance';
import { achievementUnits } from './achievement';
import { calibratedProbability, evaluateCalibration, fitSolveCalibration } from './calibration';
import { averageRanks, updateContest } from './cf-local';
import { isClassroomBindingCurrent, resolveClassroomBinding } from './classroom';
import { compositeScore, publicRating, tierForRating } from './composite';
import { fitDifficulty } from './difficulty';
import {
    blocksCertifiedResult, EligibilityReason, isAchievementEligible, isFinalJudgement, isOfficialRecordEligible,
    isRatingContestEligible, isScoreWithinFullScore, RatingContestInput,
} from './eligibility';

const DOC_TYPE_PROBLEM = 10;
const DOC_TYPE_CONTEST = 30;
const STATUS_ACCEPTED = 1;
const INITIAL_MU = 1500;
const ACM_WRONG_PENALTY = 20;

function effectiveSubmissionTime(record: any): { time: number, precise: boolean } {
    if (record.submittedAt instanceof Date && Number.isFinite(record.submittedAt.getTime())) {
        return { time: record.submittedAt.getTime(), precise: true };
    }
    return { time: record._id?.getTimestamp?.().getTime(), precise: false };
}

export interface ShadowOptions {
    eligibilityMode?: 'trial' | 'certified';
    /** Opt-in: add genuine course-bound classroom tests to trial replays only. */
    includeClassroomAssessments?: boolean;
    rules?: string[];
    minParticipants?: number;
    includeDuration?: boolean;
    includeAssign?: boolean;
    provisionalEvents?: number;
    maxDelta?: number;
    difficultyMinPriorEvents?: number;
    difficultyMinStudents?: number;
    difficultyMaxSe?: number;
    priorMean?: number;
    priorSd?: number;
    refDomain?: string;
    write?: boolean;
    poolId?: string;
    domainId?: string;
    asOf?: number;
}

export interface DbHandle {
    collection(name: string): any;
}

type Report = (message: any) => void;

interface ContestDoc extends RatingContestInput {
    _id: any;
    domainId: string;
    rule: string;
    beginAt: Date;
    endAt: Date;
    duration: number;
    hasAssign: boolean;
    excludedClassroomTeachers?: number[];
}

interface Standing {
    uid: number;
    solved: number;
    penalty: number;
    total: number;
}

/** Build standings (best first) plus per-user full-solve sets for one contest. */
function buildStandings(
    rule: string, records: any[], beginAt: Date, certified = false,
    fullScores = new Map<number, number>(), weights: Record<number, number> = {},
): { standings: Standing[], fullSolve: Map<number, Set<number>> } {
    const isAcm = rule === 'acm';
    const byUser = new Map<number, Map<number, {
        lastScore: number; lastStatus: number; ac: boolean; acTime: number; wrong: number;
    }>>();
    for (const r of records) {
        if (!r.pid || !r.uid || r.uid <= 0) continue;
        let m = byUser.get(r.uid);
        if (!m) {
            m = new Map();
            byUser.set(r.uid, m);
        }
        let p = m.get(r.pid);
        if (!p) {
            p = { lastScore: 0, lastStatus: 0, ac: false, acTime: 0, wrong: 0 };
            m.set(r.pid, p);
        }
        p.lastScore = r.score || 0;
        p.lastStatus = r.status;
        if (r.status === STATUS_ACCEPTED) {
            if (!p.ac) {
                p.ac = true;
                p.acTime = certified ? r.submittedAt.getTime() : effectiveSubmissionTime(r).time;
            }
        } else if (!p.ac && r.status !== 7) {
            p.wrong++;
        }
    }
    const fullSolve = new Map<number, Set<number>>();
    const standings: Standing[] = [];
    for (const [uid, m] of byUser) {
        let solved = 0;
        let penalty = 0;
        let total = 0;
        const solvedSet = new Set<number>();
        for (const [pid, p] of m) {
            if (isAcm) {
                if (p.ac) {
                    solved++;
                    solvedSet.add(pid);
                    penalty += Math.max(0, p.acTime - beginAt.getTime()) / 60000 + ACM_WRONG_PENALTY * p.wrong;
                }
            } else {
                // OI family: the final scoring result is the last in-window submission.
                total += p.lastScore * (certified ? (weights[pid] || 100) / 100 : 1);
                if (certified ? p.lastStatus === STATUS_ACCEPTED && p.lastScore >= fullScores.get(pid)
                    : p.lastScore >= 100) solvedSet.add(pid);
            }
        }
        if (!isAcm) solved = solvedSet.size;
        standings.push({ uid, solved, penalty, total });
        fullSolve.set(uid, solvedSet);
    }
    standings.sort((x, y) => (isAcm
        ? (y.solved - x.solved) || (x.penalty - y.penalty) || (x.uid - y.uid)
        : (y.total - x.total) || (x.uid - y.uid)));
    return { standings, fullSolve };
}

function observe(
    observations: Map<string | number, { mu: number, solved: boolean }[]>,
    raw: { uid: number, pid: string | number, mu: number, solved: boolean, contestId: any }[],
    seen: Set<string>, uid: number, pid: string | number, mu: number, solved: boolean, contestId: any,
) {
    const key = `${uid}:${pid}`;
    if (seen.has(key)) return;
    seen.add(key);
    let list = observations.get(pid);
    if (!list) {
        list = [];
        observations.set(pid, list);
    }
    list.push({ mu, solved });
    raw.push({ uid, pid, mu: Math.round(mu * 100) / 100, solved, contestId });
}

export async function runShadowReplay(
    dbh: DbHandle, options: ShadowOptions = {}, report: Report = () => {}, onResults?: (docs: any[]) => void,
): Promise<any> {
    const eligibilityMode = options.eligibilityMode ?? 'trial';
    if (!['trial', 'certified'].includes(eligibilityMode)) throw new Error('Invalid rating eligibility mode');
    const certified = eligibilityMode === 'certified';
    const cutoff = options.asOf ?? Date.now();
    const asOf = new Date(cutoff);
    const exclusions: Record<string, number> = {};
    const exclude = (reasons: EligibilityReason[]) => {
        for (const reason of reasons) exclusions[reason] = (exclusions[reason] || 0) + 1;
    };
    const rules = options.rules ?? ['acm', 'oi', 'ioi', 'strictioi'];
    const minParticipants = options.minParticipants ?? 1;
    const includeDuration = options.includeDuration ?? true;
    const includeAssign = options.includeAssign ?? true;
    const provisionalEvents = options.provisionalEvents ?? 5;
    const maxDelta = options.maxDelta ?? 200;
    const difficultyMinPriorEvents = options.difficultyMinPriorEvents ?? 5;
    const difficultyMinStudents = options.difficultyMinStudents ?? 20;
    const difficultyMaxSe = options.difficultyMaxSe ?? 150;
    const priorMean = options.priorMean ?? 1500;
    const priorSd = options.priorSd ?? 600;
    const poolId = options.poolId ?? 'default';
    const refDomain = options.refDomain ?? 'cpptrain';
    const docColl = dbh.collection('document');
    const recordColl = dbh.collection('record');
    const statusColl = dbh.collection('document.status');

    // 1. candidates ------------------------------------------------------------
    const tdocs = await docColl.find(
        { docType: DOC_TYPE_CONTEST, rule: { $in: rules }, ...(options.domainId ? { domainId: options.domainId } : {}), beginAt: { $lte: asOf }, endAt: { $lte: asOf }, ...(certified ? {
            $or: [{ rated: true }, { sourceType: 'course_assessment', 'ratingPolicy.enabled': true }],
        } : options.includeClassroomAssessments
            ? { $or: [{ rated: true }, { sourceType: 'course_assessment' }] }
            : { rated: true }) },
        { projection: {
            docId: 1, rated: 1, pids: 1, beginAt: 1, endAt: 1, duration: 1, assign: 1,
            allowTeam: 1, domainId: 1, rule: 1, ratingPolicy: 1, keepScoreboardHidden: 1, score: 1,
            langs: 1, content: 1, autoHide: 1, allowPrint: 1, allowViewCode: 1, monitorMode: 1, lockAt: 1, unlocked: 1,
            sourceType: 1, sourceCourseTid: 1, sourceNodeId: 1,
        } },
    ).toArray() as any[];
    const contests: ContestDoc[] = [];
    let teamExcluded = 0;
    let teamFlagMismatch = 0;
    let classroomExcluded = 0;
    for (const t of tdocs) {
        if (!(t.beginAt instanceof Date) || !(t.endAt instanceof Date) || t.beginAt.getTime() > cutoff || t.endAt.getTime() > cutoff) continue;
        if (t.allowTeam) {
            teamExcluded++;
            if (certified) exclude(['TEAM_CONTEST']);
            continue;
        }
        const teamStatus = await statusColl.findOne({
            domainId: t.domainId,
            docType: DOC_TYPE_CONTEST,
            docId: t._id,
            attend: { $gt: 0 },
            'members.0': { $exists: true },
        }, { projection: { _id: 1 } });
        if (teamStatus) {
            teamExcluded++;
            teamFlagMismatch++;
            if (certified) exclude(['TEAM_CONTEST']);
            report(`[replay] contest ${t._id} excluded: team status exists while allowTeam is false`);
            continue;
        }
        let excludedClassroomTeachers: number[] = [];
        if (!certified && t.sourceType === 'course_assessment') {
            // A tag is not sufficient. Bind to the current real course/lesson and
            // never include a test whose results are intentionally still hidden.
            const binding = options.includeClassroomAssessments && !t.keepScoreboardHidden
                && (!t.lockAt || t.unlocked) ? await resolveClassroomBinding(dbh, { ...t, docId: t.docId || t._id }) : null;
            if (!binding) { classroomExcluded++; continue; }
            excludedClassroomTeachers = [binding.course.owner, ...(binding.course.maintainer || [])];
        }
        contests.push({
            ...(excludedClassroomTeachers.length ? { excludedClassroomTeachers } : {}),
            ...t,
            docId: t.docId || t._id,
            _id: t._id,
            domainId: t.domainId,
            rule: t.rule,
            beginAt: t.beginAt,
            endAt: t.endAt,
            duration: t.duration || 0,
            hasAssign: !!(t.assign && t.assign.length),
        });
    }
    contests.sort((a, b) => (a.beginAt.getTime() - b.beginAt.getTime())
        || (a._id.toString().localeCompare(b._id.toString())));
    const certifiedContests = certified ? contests.filter((c) => c.ratingPolicy?.enabled && c.ratingPolicy.poolId === poolId) : [];
    const poolDomains = new Set(certifiedContests.map((c) => c.domainId));
    if (poolDomains.size > 1) throw new Error('Certified pool cannot mix domains');
    const overlaps = new Set<string>();
    let previous: ContestDoc;
    for (const current of certifiedContests) {
        if (previous && current.beginAt < previous.endAt) {
            overlaps.add(String(previous.docId));
            overlaps.add(String(current.docId));
        }
        if (!previous || current.endAt > previous.endAt) previous = current;
    }
    report(`[replay] ${contests.length} rated contests loaded; team-excluded=${teamExcluded}`);

    // 2. sequential replay -----------------------------------------------------
    const states = new Map<number, { mu: number, events: number }>();
    const stateOf = (uid: number) => {
        let s = states.get(uid);
        if (!s) {
            s = { mu: INITIAL_MU, events: 0 };
            states.set(uid, s);
        }
        return s;
    };
    const observationSeen = new Set<string>();
    const observationRaw: { uid: number, pid: string | number, mu: number, solved: boolean, contestId: any }[] = [];
    const observations = new Map<string | number, { mu: number, solved: boolean }[]>();
    let processed = 0;
    let ratedProcessed = 0;
    let classroomProcessed = 0;
    let skipped = 0;
    let frozenContests = 0;
    let failedContests = 0;
    let precisionFallbacks = 0;
    const personalDurationExcluded = { missingStart: 0, invalidStart: 0, outsideWindow: 0 };
    for (const contest of contests) {
        if (overlaps.has(String(contest.docId))) {
            exclude(['OVERLAPPING_CONTESTS']);
            skipped++;
            continue;
        }
        if (!certified && !includeDuration && contest.duration) {
            skipped++;
            continue;
        }
        if (!includeAssign && contest.hasAssign) {
            skipped++;
            continue;
        }
        if (certified && !await isClassroomBindingCurrent(dbh, contest)) {
            exclude(['CLASSROOM_BINDING_CHANGED']);
            skipped++;
            continue;
        }
        const statusByUid = new Map<number, any>();
        if (contest.duration || (!certified && contest.sourceType === 'course_assessment')) {
            const attendance = await statusColl.find({ domainId: contest.domainId, docType: DOC_TYPE_CONTEST,
                docId: contest._id, $or: [{ attend: true }, { attend: { $gt: 0 } }],
            }, { projection: { uid: 1, startAt: 1, endAt: 1 } }).toArray();
            for (const a of attendance) statusByUid.set(a.uid, a);
        }
        let records = await recordColl.find(
            {
                contest: contest.docId, uid: { $gt: 0 }, domainId: contest.domainId,
                ...(certified ? {} : { $or: [
                    { _id: {
                        $gte: ObjectId.createFromTime(Math.floor(contest.beginAt.getTime() / 1000)),
                        $lt: ObjectId.createFromTime(Math.ceil(contest.endAt.getTime() / 1000)),
                    } },
                    { submittedAt: { $type: 'date', $gte: contest.beginAt, $lt: contest.endAt, $lte: asOf } },
                ] }),
            },
            { projection: {
                pid: 1, uid: 1, status: 1, score: 1, _id: 1, domainId: 1, contest: 1, submittedAt: 1,
                practiceContest: 1, participationMode: 1, submissionKind: 1,
                ...(certified ? {
                    contest: 1, practiceContest: 1, submittedAt: 1, submissionKind: 1, participationMode: 1,
                    problemRevisionId: 1, ingressVersion: 1, judgeAt: 1, submissionContext: 1, classroomSession: 1,
                } : {}),
            } },
        ).toArray();
        const beginMs = contest.beginAt.getTime();
        const endMs = contest.endAt.getTime();
        const fallbackBegin = Math.floor(beginMs / 1000) * 1000;
        const fallbackEnd = Math.floor(endMs / 1000) * 1000;
        const fallbackCutoff = Math.floor(cutoff / 1000) * 1000;
        records = records.filter((r) => {
            if (r.domainId !== contest.domainId || String(r.contest) !== String(contest.docId)) return false;
            if (certified) return (!(r.submittedAt instanceof Date) || r.submittedAt.getTime() <= cutoff)
                && (!(r.judgeAt instanceof Date) || r.judgeAt.getTime() <= cutoff);
            if (!Number.isInteger(r.pid) || !(contest.pids || []).includes(r.pid)) return false;
            // Historic ordinary records may lack provenance; explicitly marked practice,
            // virtual or non-normal submissions must never affect timed trial rankings.
            if (r.practiceContest || r.participationMode === 'practice'
                || (r.submissionKind && r.submissionKind !== 'normal')) return false;
            if (contest.sourceType === 'course_assessment'
                && (!statusByUid.has(r.uid) || contest.excludedClassroomTeachers?.includes(r.uid))) return false;
            const effective = effectiveSubmissionTime(r);
            const at = effective.time;
            if (!Number.isFinite(at)) return false;
            if (effective.precise) {
                if (at < beginMs || at >= endMs || at > cutoff) return false;
            } else {
                precisionFallbacks++;
                if (at < fallbackBegin || at >= fallbackEnd || at > fallbackCutoff) return false;
            }
            if (!Number.isFinite(r.score) || r.score < 0 || !Number.isInteger(r.status) || r.status < 1 || r.status > 7) return false;
            if (contest.duration) {
                const attendance = statusByUid.get(r.uid);
                const start = attendance?.startAt;
                if (!start) { personalDurationExcluded.missingStart++; return false; }
                if (!(start instanceof Date) || !Number.isFinite(start.getTime()) || !Number.isFinite(contest.duration) || contest.duration <= 0
                    || start.getTime() < beginMs || start.getTime() >= endMs
                    || (attendance.endAt !== undefined && (!(attendance.endAt instanceof Date) || !Number.isFinite(attendance.endAt.getTime())))) {
                    personalDurationExcluded.invalidStart++;
                    return false;
                }
                const personalEnd = Math.min(endMs, start.getTime() + contest.duration * 3600000,
                    attendance.endAt instanceof Date ? attendance.endAt.getTime() : endMs);
                const personalStartBoundary = effective.precise ? start.getTime() : Math.floor(start.getTime() / 1000) * 1000;
                const personalEndBoundary = effective.precise ? personalEnd : Math.floor(personalEnd / 1000) * 1000;
                if (at < personalStartBoundary || at >= personalEndBoundary) { personalDurationExcluded.outsideWindow++; return false; }
            }
            return true;
        });
        if (!certified) records.sort((a, b) => effectiveSubmissionTime(a).time - effectiveSubmissionTime(b).time
            || String(a._id).localeCompare(String(b._id)));
        const problemKeys = new Map<number, string>();
        const fullScores = new Map<number, number>();
        if (certified) {
            let unfinished = false;
            records = records.filter((record) => {
                const eligibility = isOfficialRecordEligible(contest, record);
                if (!eligibility.allowed) exclude(eligibility.reasonCodes);
                if (blocksCertifiedResult(eligibility.reasonCodes)) unfinished = true;
                return eligibility.allowed;
            }).sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime()
                || String(a._id).localeCompare(String(b._id)));
            if (unfinished) {
                skipped++;
                continue;
            }
            const eligibility = isRatingContestEligible(contest, new Set(records.map((r) => r.uid)).size, poolId, asOf, rules);
            if (!eligibility.allowed) {
                exclude(eligibility.reasonCodes);
                skipped++;
                continue;
            }
            for (const pid of contest.pids) {
                const evidence = await resolveProblemEvidence(dbh, contest.domainId, pid);
                if (!evidence.canonicalProblemKey || evidence.problemRevisionId !== contest.ratingPolicy.problemRevisions[pid]) {
                    exclude(['PROBLEM_REVISION_MISMATCH']);
                    break;
                }
                problemKeys.set(pid, `${evidence.canonicalProblemKey}@${evidence.problemRevisionId}`);
                fullScores.set(pid, evidence.problemFullScore);
            }
            if (problemKeys.size !== contest.pids.length) {
                skipped++;
                continue;
            }
        }
        // Compare judged scores against the re-resolved, revision-verified full score.
        // Do not trust the historical record.problemFullScore field: older ingress
        // versions may contain stale normalization evidence.
        if (certified && records.some((record) => !isScoreWithinFullScore(record.score, fullScores.get(record.pid)))) {
            exclude(['INVALID_SCORE']);
            skipped++;
            continue;
        }
        const participants = new Set(records.map((r) => r.uid));
        if (participants.size < Math.max(2, minParticipants)) {
            skipped++;
            continue;
        }
        const tdoc = certified ? contest : await docColl.findOne({ _id: contest._id }, { projection: { pids: 1 } });
        const pids: number[] = tdoc?.pids?.length ? tdoc.pids : [...new Set(records.map((r) => r.pid))];
        const { standings, fullSolve } = buildStandings(contest.rule, records, contest.beginAt, certified, fullScores, contest.score);
        if (standings.length < 2) {
            skipped++;
            continue;
        }
        const tied = contest.rule === 'acm'
            ? (a: Standing, b: Standing) => a.solved === b.solved && a.penalty === b.penalty
            : (a: Standing, b: Standing) => a.total === b.total;
        const ranks = averageRanks(standings, tied);
        const entries = standings.map((s) => {
            const st = stateOf(s.uid);
            return { uid: s.uid, mu: st.mu, ratedEvents: st.events };
        });
        const result = updateContest(entries, ranks, { maxDelta, provisionalEvents });
        if (!result.ok) {
            failedContests++;
            report(`[replay] contest ${contest._id} rejected: ${result.reason}`);
            continue;
        }
        // difficulty observations consume pre-contest maturity (plan §8.2):
        // every contest problem is an answering opportunity for every valid participant.
        for (let i = 0; i < standings.length; i++) {
            const st = entries[i];
            if (st.ratedEvents < difficultyMinPriorEvents) continue;
            const solvedSet = fullSolve.get(standings[i].uid) ?? new Set<number>();
            for (const pid of pids) {
                observe(observations, observationRaw, observationSeen, st.uid,
                    certified ? problemKeys.get(pid) : pid, st.mu, solvedSet.has(pid), contest._id);
            }
        }
        if (!result.frozen) {
            for (const r of result.results) {
                const st = stateOf(r.uid);
                st.mu += r.delta;
                st.events++;
            }
        } else {
            frozenContests++;
            for (const r of result.results) stateOf(r.uid).events++;
        }
        processed++;
        if (contest.sourceType === 'course_assessment') classroomProcessed++;
        else ratedProcessed++;
    }
    report(`[replay] processed=${processed} rated=${ratedProcessed} classroom=${classroomProcessed} skipped=${skipped} frozen=${frozenContests} failed=${failedContests}`);

    // 3. difficulty fits -------------------------------------------------------
    const fits: any[] = [];
    for (const [pid, obs] of observations) {
        const fit = fitDifficulty(obs, { priorMean, priorSd });
        const pos = obs.filter((o) => o.solved).length;
        const neg = obs.length - pos;
        const provisionalLike = fit.status === 'ok'
            && obs.length >= difficultyMinStudents && pos >= 3 && neg >= 3
            && fit.se !== null && fit.se <= difficultyMaxSe;
        fits.push({ pid, students: obs.length, pos, neg, ...fit, provisionalLike });
    }
    fits.sort((x, y) => y.students - x.students);

    // 3b. prediction-layer calibration and M15 residual diagnostics -------------
    // One global slope multiplier keeps ability and difficulty on a single
    // shared scale while flattening the tail overconfidence found by the
    // 2026-09-19 spot check. Split only the slope fit and its diagnostics:
    // difficulty and replayed ability already use all observations. These are
    // conditional calibration diagnostics, NOT independent prediction validation.
    const calibObs: { mu: number, d: number, solved: boolean, slot: number }[] = [];
    for (const [pid, obs] of observations) {
        const fit = fits.find((f) => f.pid === pid);
        if (!fit || fit.status !== 'ok') continue;
        for (const o of obs) {
            calibObs.push({
                mu: o.mu, d: fit.d, solved: o.solved,
                slot: ((o.mu * 73856093) ^ ((typeof pid === 'number' ? pid
                    : [...pid].reduce((hash, ch) => (hash * 31 + ch.charCodeAt(0)) | 0, 0)) * 19349663)) % 2 === 0 ? 0 : 1,
            });
        }
    }
    const halfA = calibObs.filter((o) => o.slot === 0).map(({ mu, d, solved }) => ({ mu, d, solved }));
    const halfB = calibObs.filter((o) => o.slot === 1).map(({ mu, d, solved }) => ({ mu, d, solved }));
    const calibFit = fitSolveCalibration(halfA.length >= halfB.length ? halfA : halfB);
    const evalSet = halfA.length >= halfB.length ? halfB : halfA;
    const rawReport = evaluateCalibration(evalSet, 1);
    const calReport = evaluateCalibration(evalSet, calibFit.slope);
    const m15Anomalies = fits
        .filter((f) => f.status === 'ok' && f.students >= difficultyMinStudents)
        .map((f) => {
            const obs = observations.get(f.pid) ?? [];
            const expected = obs.reduce((s, o) => s + calibratedProbability(o.mu, f.d, calibFit.slope), 0) / obs.length;
            const actual = f.pos / f.students;
            return { pid: f.pid, students: f.students, expected, actual, residual: actual - expected };
        })
        .filter((r) => Math.abs(r.residual) >= 0.25)
        .sort((x, y) => Math.abs(y.residual) - Math.abs(x.residual))
        .slice(0, 10);
    report(`[replay] calibration slope=${calibFit.slope.toFixed(4)} (slope fit n=${calibFit.used}, conditional diagnostic n=${evalSet.length}) `
        + `brier raw=${rawReport.brier.toFixed(4)} -> cal=${calReport.brier.toFixed(4)}; `
        + `m15 anomalies=${m15Anomalies.length}`);

    // 4. achievements ------------------------------------------------------------
    const achievementByUser = new Map<string, { domainId: string, uid: number, a: number, problems: number }>();
    const perUser = new Map<string, Map<string | number, number>>();
    let anomalies = 0;
    const statusCursor = statusColl.find(
        { docType: DOC_TYPE_PROBLEM, rid: { $ne: null }, uid: { $gt: 0 },
            ...(options.domainId ? { domainId: options.domainId } : (certified ? { domainId: { $in: [...poolDomains] } } : {})) },
        { projection: { domainId: 1, uid: 1, docId: 1, score: 1, status: 1, rid: 1 } },
    );
    for await (const s of statusCursor) {
        // Status collections retain only the latest pointer, not a historical snapshot.
        // Do not attribute a post-cutoff latest submission to an earlier as-of replay.
        if (s.rid?.getTimestamp && s.rid.getTimestamp().getTime() > cutoff) continue;
        let units: number;
        let key: number | string = s.docId;
        if (certified) {
            const record = await recordColl.findOne({ _id: s.rid, domainId: s.domainId, uid: s.uid, pid: s.docId });
            const problem = await resolveProblemEvidence(dbh, s.domainId, s.docId);
            const eligibility = isAchievementEligible({
                released: problem.problemReleased, owner: record?.problemOwner, uid: s.uid,
                canonicalProblemKey: record?.canonicalProblemKey, fullScore: problem.problemFullScore,
            });
            if (!record || record.submissionKind !== 'normal' || record.ingressVersion !== 'record-v1'
                || (record.submittedAt instanceof Date && record.submittedAt.getTime() > cutoff)
                || (record.judgeAt instanceof Date && record.judgeAt.getTime() > cutoff)
                || !record.problemRevisionId || !isFinalJudgement(record)
                || record.problemRevisionId !== problem.problemRevisionId
                || record.canonicalProblemKey !== problem.canonicalProblemKey
                || !isScoreWithinFullScore(record.score, problem.problemFullScore)
                || record.submissionContext?.domainId !== s.domainId || record.submissionContext?.uid !== s.uid
                || record.submissionContext?.pid !== s.docId) eligibility.reasonCodes.push('MISSING_PROBLEM_EVIDENCE');
            if (eligibility.reasonCodes.length) {
                exclude([...new Set(eligibility.reasonCodes)]);
                continue;
            }
            key = record.canonicalProblemKey;
            units = achievementUnits({ accepted: record.status === STATUS_ACCEPTED, score: record.score, fullScore: problem.problemFullScore });
        } else if (s.status === STATUS_ACCEPTED) units = 1;
        else if (Number.isFinite(s.score) && s.score > 0) units = 0.5 * Math.min(1, s.score / 100);
        else {
            if (s.score !== undefined && !Number.isFinite(s.score)) anomalies++;
            continue;
        }
        const ukey = `${s.domainId}|${s.uid}`;
        let m = perUser.get(ukey);
        if (!m) {
            m = new Map();
            perUser.set(ukey, m);
        }
        if (!m.has(key) || m.get(key) < units) m.set(key, units);
    }
    for (const [ukey, m] of perUser) {
        const [domainId, uidStr] = ukey.split('|');
        let a = 0;
        for (const u of m.values()) a += u;
        achievementByUser.set(ukey, { domainId, uid: +uidStr, a, problems: m.size });
    }
    report(`[replay] achievement users=${achievementByUser.size} anomalies=${anomalies}`);

    // 5. composite projections ---------------------------------------------------
    const projections: any[] = [];
    const projectionUsers = new Map<string, { domainId: string, uid: number, a: number, problems: number }>();
    for (const ach of achievementByUser.values()) projectionUsers.set(`${ach.domainId}|${ach.uid}`, ach);
    // State users are scoped to the replay domain when one is requested. In unscoped
    // mode achievement rows provide the only safe domain association for projections.
    if (options.domainId) for (const uid of states.keys()) {
        const key = `${options.domainId}|${uid}`;
        if (!projectionUsers.has(key)) projectionUsers.set(key, { domainId: options.domainId, uid, a: 0, problems: 0 });
    }
    for (const ach of projectionUsers.values()) {
        const st = states.get(ach.uid);
        const a = (ach as any).a ?? 0;
        const problems = (ach as any).problems ?? 0;
        const rating = publicRating(st ? st.mu : null);
        const events = st ? st.events : 0;
        const comp = compositeScore(a, rating, events);
        const tier = tierForRating(rating);
        projections.push({
            domainId: ach.domainId,
            uid: ach.uid,
            a: Math.round(a * 100) / 100,
            problems,
            mu: st ? Math.round(st.mu * 100) / 100 : null,
            rating,
            tier: tier ? tier.id : null,
            ratedEvents: events,
            ...comp,
        });
    }

    // 6. rating distribution and old-vs-new comparison ---------------------------
    const rated = [...states.entries()].map(([uid, s]) => ({ uid, ...s })).filter((s) => s.events > 0);
    const mus = rated.map((s) => s.mu).sort((a, b) => a - b);
    const tierHist: Record<string, number> = {};
    for (const s of rated) {
        const t = tierForRating(publicRating(s.mu));
        const k = t ? t.id : 'UNRATED';
        tierHist[k] = (tierHist[k] || 0) + 1;
    }
    const refUsers = await dbh.collection('domain.user').find(
        { domainId: options.domainId ?? refDomain, rp: { $gt: 0 } },
        { projection: { uid: 1, rp: 1, nAccept: 1 } },
    ).toArray() as any[];
    const oldMap = new Map(refUsers.map((u) => [u.uid, u]));
    const cmpRows = projections
        .filter((p) => p.domainId === refDomain && oldMap.has(p.uid))
        .map((p) => ({ uid: p.uid, oldRp: oldMap.get(p.uid).rp || 0, newRp: p.rpCents / 100, a: p.a, rating: p.rating, ratedEvents: p.ratedEvents }));
    cmpRows.sort((x, y) => y.oldRp - x.oldRp);
    const oldRank = new Map(cmpRows.map((r, i) => [r.uid, i + 1]));
    const byNew = [...cmpRows].sort((x, y) => y.newRp - x.newRp);
    const newRank = new Map(byNew.map((r, i) => [r.uid, i + 1]));
    const movers = cmpRows.map((r) => ({
        ...r,
        oldRank: oldRank.get(r.uid),
        newRank: newRank.get(r.uid),
        move: (oldRank.get(r.uid) || 0) - (newRank.get(r.uid) || 0),
    })).sort((x, y) => Math.abs(y.move) - Math.abs(x.move)).slice(0, 10);

    const summary = {
        generatedAt: new Date().toISOString(),
        eligibilityMode,
        exclusions,
        poolId,
        contests: {
            total: contests.length,
            processed,
            ratedProcessed,
            classroomProcessed,
            classroomExcluded,
            skipped,
            frozen: frozenContests,
            failed: failedContests,
            teamExcluded,
            teamFlagMismatch,
            personalDurationExcluded,
            precisionFallbacks,
        },
        ratingUsers: rated.length,
        provisionalUsers: rated.filter((s) => s.events < provisionalEvents).length,
        rating: mus.length ? {
            min: Math.round(mus[0]),
            median: Math.round(mus[Math.floor(mus.length / 2)]),
            p90: Math.round(mus[Math.floor(mus.length * 0.9)]),
            max: Math.round(mus[mus.length - 1]),
        } : null,
        tierHist,
        difficulty: {
            problemsWithObservations: fits.length,
            provisionalLike: fits.filter((f) => f.provisionalLike).length,
            degenerate: fits.filter((f) => f.status === 'degenerate').length,
            nonconverged: fits.filter((f) => f.status === 'nonconverged').length,
            calibrationSlope: Math.round(calibFit.slope * 10000) / 10000,
            calibrationDiagnostic: {
                kind: 'conditional_calibration',
                independentPredictionValidation: false,
                difficultyFit: 'all_observations',
                slopeFitN: calibFit.used,
                observationN: [...observations.values()].reduce((sum, obs) => sum + obs.length, 0),
                unavailableDifficultyN: [...observations.values()].reduce((sum, obs) => sum + obs.length, 0) - calibObs.length,
                n: evalSet.length,
                brierRaw: Math.round(rawReport.brier * 10000) / 10000,
                brierCalibrated: Math.round(calReport.brier * 10000) / 10000,
                meanAbsDevRaw: Math.round(rawReport.meanAbsDeviation * 10000) / 10000,
                meanAbsDevCalibrated: Math.round(calReport.meanAbsDeviation * 10000) / 10000,
                buckets: calReport.buckets,
            },
            m15Anomalies,
            top: fits.slice(0, 5).map((f) => ({
                pid: f.pid, students: f.students, pos: f.pos,
                d: Math.round(f.d), se: f.se === null ? null : Math.round(f.se),
            })),
        },
        achievement: {
            users: achievementByUser.size,
            top: [...achievementByUser.values()].sort((x, y) => y.a - x.a).slice(0, 5)
                .map((x) => ({ domainId: x.domainId, uid: x.uid, a: Math.round(x.a * 10) / 10 })),
        },
        refDomain,
        compareUsers: cmpRows.length,
        movers,
    };

    const docs: any[] = [];
    for (const [uid, s] of states) {
        if (s.events === 0) continue;
        docs.push({ poolId, kind: 'rating_state', uid, ...s, ...(options.domainId ? { domainId: options.domainId } : (certified ? { domainId: [...poolDomains][0] } : {})) });
    }
    for (const f of fits) docs.push({ poolId, kind: 'difficulty', ...f });
    for (const o of observationRaw) docs.push({ poolId, kind: 'observation', ...o });
    for (const p of projections) docs.push({ poolId, kind: 'projection', ...p });
    onResults?.(docs);
    if (options.write) {
        // Shadow collections only; never touch domain.user or existing rp fields.
        const out = dbh.collection('ratingv2_shadow');
        await out.deleteMany({ poolId });
        for (let i = 0; i < docs.length; i += 1000) {
            await out.insertMany(docs.slice(i, i + 1000));
        }
        report(`[replay] wrote ${docs.length} shadow documents to ratingv2_shadow`);
    }
    return summary;
}
