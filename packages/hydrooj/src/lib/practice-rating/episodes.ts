import { NORMAL_STATUS, STATUS } from '@hydrooj/common/status';

export const EPISODE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RECENT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export type ExclusionReason = 'invalid' | 'unsuitable' | 'test_account' | 'service_account' | 'team_aggregate';

/** Trusted facts only; current problem hashes are not historical revision evidence. */
export interface SubmissionMetadata {
    knownAt: number;
    revision?: string;
    revisionConflict?: boolean;
    exclusion?: ExclusionReason;
}

/** Minimal projection of an individual record. All times are UTC epoch milliseconds. */
export interface PracticeSubmission {
    id: string;
    domainId: string;
    pid: number;
    uid: number;
    submittedAt: number;
    status: STATUS;
    judgeAt?: number | null;
    contest?: string | null;
    practiceContest?: string | null;
    metadata?: SubmissionMetadata;
    /** Policy selected for this run, not a claim about facts known at submittedAt. */
    policyExclusion?: ExclusionReason;
}

export interface ActivityMetadata {
    domainId: string;
    id: string;
    rule: string;
    knownAt: number;
}

export interface EpisodeSource {
    kind: 'FREE_PRACTICE' | 'COURSE' | 'HOMEWORK' | 'CONTEST' | 'POST_CONTEST_PRACTICE' | 'UNKNOWN';
    activityId: string | null;
}

export interface PracticeEpisode {
    key: string;
    domainId: string;
    pid: number;
    uid: number;
    revision: string | null;
    revisionStatus: 'known' | 'unknown';
    t0: number;
    windowEnd: number;
    recordIds: string[];
    sources: EpisodeSource[];
    state: 'open' | 'pending' | 'missing' | 'mature';
    y: 0 | 1 | null;
}

export interface TrainingObservation {
    episodeKey: string;
    domainId: string;
    pid: number;
    uid: number;
    revision: string | null;
    windowEnd: number;
    y: 0 | 1;
}

export interface ExtractionDiagnostics {
    excluded: {
        recordId: string;
        reason: ExclusionReason | 'invalid_record' | 'special_record' | 'revision_conflict'
            | 'future_submission' | 'invalid_status' | 'unsupported_status';
    }[];
    metadataUnavailable: string[];
    resultTimeMissing: string[];
    unknownRevisionEpisodes: number;
    openEpisodes: number;
    pendingEpisodes: number;
    missingEpisodes: number;
    outsideRecentWindow: number;
}

const SPECIAL_IDS = new Set(['000000000000000000000000', '000000000000000000000001']);
const PENDING = new Set([STATUS.STATUS_WAITING, STATUS.STATUS_FETCHED, STATUS.STATUS_COMPILING, STATUS.STATUS_JUDGING]);
const UNJUDGEABLE = new Set([STATUS.STATUS_SYSTEM_ERROR, STATUS.STATUS_ETC, STATUS.STATUS_HACKED]);
const INVALID = new Set([STATUS.STATUS_CANCELED, STATUS.STATUS_IGNORED, STATUS.STATUS_FORMAT_ERROR]);
const NORMAL = new Set(NORMAL_STATUS);
const compare = (a: string, b: string) => (a < b ? -1 : Number(a > b));
const validTime = (time: number) => Number.isSafeInteger(time) && time >= 0;

function sourceFor(record: PracticeSubmission, activities: ReadonlyMap<string, string>): EpisodeSource {
    if (record.practiceContest) return { kind: 'POST_CONTEST_PRACTICE', activityId: record.practiceContest };
    if (!record.contest) return { kind: 'FREE_PRACTICE', activityId: null };
    const rule = activities.get(JSON.stringify([record.domainId, record.contest]));
    const kind = rule === 'course' ? 'COURSE' : rule === 'homework' ? 'HOMEWORK' : rule ? 'CONTEST' : 'UNKNOWN';
    return { kind, activityId: record.contest };
}

/**
 * Supply the full available history, not a 90-day submission query. Recent filtering
 * happens after finding t0. Results after asOf remain pending; no historical result
 * is reconstructed from today's status. This function neither reads nor writes DBs.
 */
export function extractPracticeEpisodes(
    records: readonly PracticeSubmission[],
    asOf: number,
    activityMetadata: readonly ActivityMetadata[] = [],
): { episodes: PracticeEpisode[], observations: TrainingObservation[], diagnostics: ExtractionDiagnostics } {
    if (!validTime(asOf)) throw new RangeError('asOf must be UTC epoch milliseconds');
    const diagnostics: ExtractionDiagnostics = {
        excluded: [],
        metadataUnavailable: [],
        resultTimeMissing: [],
        unknownRevisionEpisodes: 0,
        openEpisodes: 0,
        pendingEpisodes: 0,
        missingEpisodes: 0,
        outsideRecentWindow: 0,
    };
    const activities = new Map<string, string>();
    for (const activity of activityMetadata) {
        if (validTime(activity.knownAt) && activity.knownAt <= asOf) {
            activities.set(JSON.stringify([activity.domainId, activity.id]), activity.rule);
        }
    }
    const groups = new Map<string, { episode: PracticeEpisode, pending: boolean, normal: boolean, accepted: boolean }>();
    const sorted = [...records].sort((a, b) => a.submittedAt - b.submittedAt || compare(a.id, b.id));
    for (const record of sorted) {
        const exclude = (reason: ExtractionDiagnostics['excluded'][number]['reason']) => {
            diagnostics.excluded.push({ recordId: record.id, reason });
        };
        if (!/^[a-f\d]{24}$/.test(record.id) || !record.domainId
            || !Number.isSafeInteger(record.pid) || record.pid <= 0
            || !Number.isSafeInteger(record.uid) || record.uid <= 0
            || !validTime(record.submittedAt)
            || (record.judgeAt != null && (!validTime(record.judgeAt) || record.judgeAt < record.submittedAt))) {
            exclude('invalid_record');
            continue;
        }
        if (record.submittedAt > asOf) {
            exclude('future_submission');
            continue;
        }
        if (SPECIAL_IDS.has(record.id) || SPECIAL_IDS.has(record.contest) || SPECIAL_IDS.has(record.practiceContest)) {
            exclude('special_record');
            continue;
        }
        if (record.policyExclusion) {
            exclude(record.policyExclusion);
            continue;
        }
        const metadata = record.metadata && validTime(record.metadata.knownAt) && record.metadata.knownAt <= asOf
            ? record.metadata : undefined;
        if (record.metadata && !metadata) diagnostics.metadataUnavailable.push(record.id);
        if (metadata?.revisionConflict || metadata?.exclusion) {
            exclude(metadata.revisionConflict ? 'revision_conflict' : metadata.exclusion);
            continue;
        }
        // A later rejudge can even cancel a record: do not use its later status at an earlier cutoff.
        const futureResult = record.judgeAt != null && record.judgeAt > asOf;
        if (!futureResult && (INVALID.has(record.status) || (!NORMAL.has(record.status)
            && !PENDING.has(record.status) && !UNJUDGEABLE.has(record.status)))) {
            exclude(INVALID.has(record.status) ? 'invalid_status' : 'unsupported_status');
            continue;
        }
        const revision = metadata?.revision || null;
        const key = JSON.stringify([record.domainId, record.pid, revision, record.uid]);
        if (!groups.has(key)) {
            groups.set(key, {
                episode: {
                    key,
                    domainId: record.domainId,
                    pid: record.pid,
                    uid: record.uid,
                    revision,
                    revisionStatus: revision === null ? 'unknown' : 'known',
                    t0: record.submittedAt,
                    windowEnd: record.submittedAt + EPISODE_WINDOW_MS,
                    recordIds: [],
                    sources: [],
                    state: 'open',
                    y: null,
                },
                pending: false,
                normal: false,
                accepted: false,
            });
        }
        const group = groups.get(key);
        const { episode } = group;
        if (record.submittedAt >= episode.windowEnd) continue;
        episode.recordIds.push(record.id);
        const source = sourceFor(record, activities);
        if (!episode.sources.some((s) => s.kind === source.kind && s.activityId === source.activityId)) episode.sources.push(source);
        const resultTimeMissing = !PENDING.has(record.status) && record.judgeAt == null;
        if (resultTimeMissing) diagnostics.resultTimeMissing.push(record.id);
        group.pending ||= futureResult || PENDING.has(record.status) || resultTimeMissing;
        if (!futureResult && !resultTimeMissing && NORMAL.has(record.status)) {
            group.normal = true;
            group.accepted ||= record.status === STATUS.STATUS_ACCEPTED;
        }
    }
    const episodes: PracticeEpisode[] = [];
    const observations: TrainingObservation[] = [];
    for (const [key, group] of [...groups].sort(([a], [b]) => compare(a, b))) {
        const { episode } = group;
        if (episode.revisionStatus === 'unknown') diagnostics.unknownRevisionEpisodes++;
        if (episode.windowEnd > asOf) {
            diagnostics.openEpisodes++;
        } else if (group.pending) {
            episode.state = 'pending';
            diagnostics.pendingEpisodes++;
        } else if (!group.normal) {
            episode.state = 'missing';
            diagnostics.missingEpisodes++;
        } else {
            episode.state = 'mature';
            episode.y = group.accepted ? 1 : 0;
            if (episode.windowEnd >= asOf - RECENT_WINDOW_MS) {
                observations.push({
                    episodeKey: key,
                    domainId: episode.domainId,
                    pid: episode.pid,
                    uid: episode.uid,
                    revision: episode.revision,
                    windowEnd: episode.windowEnd,
                    y: episode.y,
                });
            } else diagnostics.outsideRecentWindow++;
        }
        episodes.push(episode);
    }
    return { episodes, observations, diagnostics };
}
