import { completionProbability, fitPracticeRating, JointFit, problemKey } from '../packages/hydrooj/src/lib/practice-rating/model';
import { EpisodeSnapshot } from '../packages/hydrooj/src/lib/practice-rating/store';
import { summarizePredictions } from '../packages/hydrooj/src/lib/practice-rating/validation';

const KIND = 'retrospective-current-state-edge-holdout' as const;

export interface RetrospectiveQualityDiagnostic {
    kind: typeof KIND;
    scope: string;
    splitAt: number | null;
    training: number;
    holdout: number;
    purged: number;
    fitStatus: JointFit['status'];
    components: number;
    trainingProvisional: { users: number, problems: number };
    unknownRevision: { training: number, holdout: number, scored: number };
    skipped: {
        missingUser: number;
        missingProblem: number;
        componentMismatch: number;
        unavailableFitValue: number;
    };
    scoredPositives: number;
    scoredNegatives: number;
    scoredProvisional: { users: number, problems: number };
    scoredProvisionalAny: number;
    scoredEstimatedBoth: number;
    meanPredicted: number | null;
    meanActual: number | null;
    metrics: ReturnType<typeof summarizePredictions>;
}

function result(
    scope: string,
    splitAt: number | null,
    purged: number,
    fit: JointFit,
    training: readonly EpisodeSnapshot[],
    holdout: readonly EpisodeSnapshot[],
): RetrospectiveQualityDiagnostic {
    const observations = training.map((snapshot) => snapshot.observation);
    const byUser = new Map(fit.users.map((estimate) => [estimate.uid, estimate]));
    const byProblem = new Map(fit.problems.map((estimate) => [problemKey(estimate.pid, estimate.revision), estimate]));
    const globalBaseline = observations.length
        ? observations.reduce((sum, observation) => sum + observation.y, 0) / observations.length : null;
    const skipped = { missingUser: 0, missingProblem: 0, componentMismatch: 0, unavailableFitValue: 0 };
    const scored: { prediction: {
        uid: number;
        pid: number;
        probability: number;
        overallBaseline: number;
        problemBaseline: number;
    }; y: 0 | 1; }[] = [];
    const provisionalUsers = new Set<number>();
    const provisionalProblems = new Set<string>();
    let provisionalAny = 0;
    let estimatedBoth = 0;
    let unknownTraining = 0;
    let unknownHoldout = 0;
    let unknownScored = 0;
    for (const snapshot of training) if (snapshot.observation.revision === null) unknownTraining++;
    for (const snapshot of holdout) if (snapshot.observation.revision === null) unknownHoldout++;
    for (const snapshot of fit.status === 'ok' ? holdout : []) {
        const observation = snapshot.observation;
        const user = byUser.get(observation.uid);
        if (!user) {
            skipped.missingUser++;
            continue;
        }
        const problem = byProblem.get(problemKey(observation.pid, observation.revision));
        if (!problem) {
            skipped.missingProblem++;
            continue;
        }
        if (user.component !== problem.component) {
            skipped.componentMismatch++;
            continue;
        }
        if (!Number.isFinite(user.value) || !Number.isFinite(problem.value)
            || globalBaseline === null) {
            skipped.unavailableFitValue++;
            continue;
        }
        if (!problem.samples) {
            skipped.unavailableFitValue++;
            continue;
        }
        scored.push({ prediction: {
            uid: observation.uid, pid: observation.pid,
            probability: completionProbability(user.value, problem.value),
            overallBaseline: globalBaseline,
            problemBaseline: problem.successes / problem.samples,
        }, y: observation.y });
        if (observation.revision === null) unknownScored++;
        if (user.status === 'provisional') provisionalUsers.add(user.uid);
        if (problem.status === 'provisional') provisionalProblems.add(problemKey(problem.pid, problem.revision));
        if (user.status === 'provisional' || problem.status === 'provisional') provisionalAny++;
        if (user.status === 'estimated' && problem.status === 'estimated') estimatedBoth++;
    }
    if (fit.status !== 'ok') skipped.unavailableFitValue = holdout.length;
    const metrics = summarizePredictions(scored);
    const predicted = scored.reduce((sum, row) => sum + row.prediction.probability, 0);
    const actual = scored.reduce((sum, row) => sum + row.y, 0);
    return {
        kind: KIND, scope, splitAt, training: training.length, holdout: holdout.length, purged,
        fitStatus: fit.status, components: fit.components,
        trainingProvisional: {
            users: fit.users.filter((estimate) => estimate.status === 'provisional').length,
            problems: fit.problems.filter((estimate) => estimate.status === 'provisional').length,
        },
        unknownRevision: { training: unknownTraining, holdout: unknownHoldout, scored: unknownScored },
        skipped,
        scoredPositives: actual,
        scoredNegatives: scored.length - actual,
        scoredProvisional: { users: provisionalUsers.size, problems: provisionalProblems.size },
        scoredProvisionalAny: provisionalAny,
        scoredEstimatedBoth: estimatedBoth,
        meanPredicted: scored.length ? predicted / scored.length : null,
        meanActual: scored.length ? actual / scored.length : null,
        metrics,
    };
}

/**
 * This is a current-state edge holdout only: overwritten/rejudged statuses,
 * current exclusions, and unknown revisions cannot reconstruct historical
 * knowledge. Window purging alone does not establish judgeAt <= splitAt, so
 * this is never a true M3 forward or independent external validation.
 */
export function evaluateRetrospectiveQuality(
    scope: string, snapshots: readonly EpisodeSnapshot[],
): RetrospectiveQualityDiagnostic {
    const sorted = [...snapshots].sort((a, b) => a.episode.t0 - b.episode.t0);
    if (!sorted.length) {
        const fit = fitPracticeRating([], scope);
        return result(scope, null, 0, fit, [], []);
    }
    const splitAt = sorted[Math.floor(sorted.length * 0.8)].episode.t0;
    const training: EpisodeSnapshot[] = [];
    const holdout: EpisodeSnapshot[] = [];
    let purged = 0;
    for (const snapshot of sorted) {
        if (snapshot.episode.t0 >= splitAt) holdout.push(snapshot);
        else if (snapshot.observation.windowEnd <= splitAt) training.push(snapshot);
        else purged++;
    }
    const observations = training.map((snapshot) => snapshot.observation);
    const fit = fitPracticeRating(observations, scope);
    return result(scope, splitAt, purged, fit, training, holdout);
}
