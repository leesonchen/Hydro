import { ObjectId } from 'mongodb';
import { CapturedInput, capturePracticeInput, RatingDatabase } from './adapter';
import { EPISODE_WINDOW_MS, extractPracticeEpisodes } from './episodes';
import { workerTask } from './runner';
import { ActiveScope, checksum, COLLECTIONS, PracticeRatingStore, probabilityForRun } from './store';

export const PREDICTION_COLLECTION = 'practice_rating_predictions';
export const VALIDATION_VERSION = 'practice-forward-7d-v1';
export const MAX_PREDICTION_PAIRS = 1000;
export interface PredictionPair { uid: number, pid: number }
export interface FrozenPrediction extends PredictionPair {
    probability: number;
    overallBaseline: number;
    problemBaseline: number;
}

/** Keep history grouping off the HTTP thread and return only the requested cohort. */
export function extractPredictionEpisodes(input: CapturedInput, pairs: PredictionPair[]) {
    const selected = new Set(pairs.map((p) => JSON.stringify([p.uid, p.pid])));
    return extractPracticeEpisodes(input.records, input.asOf, input.activities).episodes
        .filter((e) => selected.has(JSON.stringify([e.uid, e.pid])))
        .map(({ uid, pid, t0, state, y }) => ({ uid, pid, t0, state, y }));
}

async function predictionEpisodes(input: CapturedInput, pairs: PredictionPair[]) {
    return workerTask<ReturnType<typeof extractPredictionEpisodes>>(require.resolve('./validation'), 'extractPredictionEpisodes', [input, pairs]);
}

/** Explicit prospective cohort: only pairs without an eligible attempt at freezing time. */
export async function freezePracticePredictions(database: RatingDatabase, scope: string, pairs: PredictionPair[]) {
    if (!pairs.length || pairs.length > MAX_PREDICTION_PAIRS || pairs.some((p) => !Number.isSafeInteger(p.uid) || p.uid <= 0
        || !Number.isSafeInteger(p.pid) || p.pid <= 0)
    || new Set(pairs.map((p) => JSON.stringify([p.uid, p.pid]))).size !== pairs.length) throw new Error('Invalid prediction pairs');
    const store = new PracticeRatingStore(database);
    const run = await store.activeRun(scope);
    if (!run || run.fitStatus !== 'ok') throw new Error('A complete nonempty practice run is required');
    const config = await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope });
    const input = await capturePracticeInput(database, scope, [...new Set([
        ...(run.exclusionPolicy?.excludedUids ?? []), ...(config?.excludedUids ?? []),
    ])]);
    const selected = await predictionEpisodes(input, pairs);
    const attempted = new Set(selected.map((e) => JSON.stringify([e.uid, e.pid])));
    const excluded = new Set([...input.exclusionPolicy.excludedUids, ...input.exclusionPolicy.virtualUids, 1]);
    const [users, problems, totals] = await Promise.all([
        database.collection<any>(COLLECTIONS.users).find({ scope, runId: run._id, uid: { $in: pairs.map((p) => p.uid) } }).toArray(),
        database.collection<any>(COLLECTIONS.problems).find({ scope, runId: run._id, revision: null,
            pid: { $in: pairs.map((p) => p.pid) } }).toArray(),
        database.collection(COLLECTIONS.users).aggregate([
            { $match: { scope, runId: run._id } },
            { $group: { _id: null, samples: { $sum: '$samples' }, successes: { $sum: '$successes' } } },
        ]).next(),
    ]);
    if (!totals?.samples) throw new Error('Training baseline is unavailable');
    const byUser = new Map(users.map((u) => [u.uid, u]));
    const byProblem = new Map(problems.map((p) => [p.pid, p]));
    const rows: FrozenPrediction[] = [];
    const skipped = { attempted: 0, excluded: 0, unavailable: 0 };
    for (const pair of pairs) {
        if (excluded.has(pair.uid)) {
            skipped.excluded++;
            continue;
        }
        if (attempted.has(JSON.stringify([pair.uid, pair.pid]))) {
            skipped.attempted++;
            continue;
        }
        const user = byUser.get(pair.uid);
        const problem = byProblem.get(pair.pid);
        const probability = probabilityForRun(run._id, scope, user ?? null, problem ?? null);
        if (probability === null) {
            skipped.unavailable++;
            continue;
        }
        rows.push({ ...pair, probability, overallBaseline: totals.successes / totals.samples,
            problemBaseline: problem.successes / problem.samples });
    }
    if (!rows.length) throw new Error('No eligible prospective prediction pairs');
    const predictionId = new ObjectId().toHexString();
    const payload = { scope, runId: run._id, trainingAsOf: run.asOf, modelVersion: run.modelVersion,
        version: VALIDATION_VERSION, episodeWindowMs: EPISODE_WINDOW_MS, rows,
        exclusionPolicy: input.exclusionPolicy, exclusionPolicyVersion: checksum(input.exclusionPolicy) };
    const collection = database.collection<any>(PREDICTION_COLLECTION);
    // One bounded document contains all predictions. Only acknowledged writes can
    // become evaluable, and the observation period starts after that acknowledgement.
    await collection.insertOne({ _id: predictionId, status: 'writing', ...payload, checksum: checksum(payload) });
    const frozenAt = Date.now();
    await collection.updateOne({ _id: predictionId, status: 'writing' }, {
        $set: { status: 'frozen', frozenAt, checksum: checksum({ ...payload, frozenAt }) },
    });
    return { predictionId, scope, runId: run._id, frozenAt, predictions: rows.length, skipped };
}

/** Descriptive calibration only; no threshold claims statistical or educational validity. */
export function summarizePredictions(rows: { prediction: FrozenPrediction, y: 0 | 1 }[]) {
    const bins = Array.from({ length: 10 }, (_, i) => ({ lower: i / 10, upper: (i + 1) / 10, count: 0,
        predicted: 0, completed: 0 }));
    let brier = 0;
    let overallBrier = 0;
    let problemBrier = 0;
    for (const { prediction: p, y } of rows) {
        const bin = bins[Math.min(9, Math.floor(p.probability * 10))];
        bin.count++;
        bin.predicted += p.probability;
        bin.completed += y;
        brier += (p.probability - y) ** 2;
        overallBrier += (p.overallBaseline - y) ** 2;
        problemBrier += (p.problemBaseline - y) ** 2;
    }
    return { conclusion: '尚无结论', samples: rows.length,
        brier: rows.length ? brier / rows.length : null,
        overallBaselineBrier: rows.length ? overallBrier / rows.length : null,
        problemBaselineBrier: rows.length ? problemBrier / rows.length : null,
        bins: bins.map((b) => ({ lower: b.lower, upper: b.upper, samples: b.count,
            predicted: b.count ? b.predicted / b.count : null, actual: b.count ? b.completed / b.count : null })) };
}

export async function evaluatePracticePredictions(database: RatingDatabase, scope: string, predictionId: string, asOf?: number) {
    const frozen = await database.collection<any>(PREDICTION_COLLECTION).findOne({ _id: predictionId, scope, status: 'frozen' });
    if (!frozen) throw new Error('Unknown frozen prediction cohort');
    const { _id, status, frozenAt, checksum: expected, ...payload } = frozen;
    if (checksum({ ...payload, frozenAt }) !== expected) throw new Error('Frozen prediction checksum mismatch');
    const input = await capturePracticeInput(database, scope, frozen.exclusionPolicy.excludedUids, asOf);
    if (input.asOf < frozenAt) throw new Error('Evaluation precedes prediction freeze');
    // Later account configuration/virtual-account changes cannot rewrite cohort eligibility.
    const policy = frozen.exclusionPolicy;
    for (const record of input.records) {
        record.policyExclusion = policy.virtualUids.includes(record.uid) ? 'team_aggregate'
            : policy.serviceUids.includes(record.uid) ? 'service_account'
                : policy.excludedUids.includes(record.uid) ? 'test_account' : undefined;
    }
    const selected = await predictionEpisodes(input, frozen.rows);
    const episodes = new Map(selected.map((e) => [JSON.stringify([e.uid, e.pid]), e]));
    const evaluated: { prediction: FrozenPrediction, y: 0 | 1 }[] = [];
    const counts = { notAttempted: 0, beforeFreeze: 0, open: 0, pending: 0, missing: 0 };
    for (const prediction of frozen.rows as FrozenPrediction[]) {
        const episode = episodes.get(JSON.stringify([prediction.uid, prediction.pid]));
        if (!episode) counts.notAttempted++;
        else if (episode.t0 <= frozenAt) counts.beforeFreeze++;
        else if (episode.state !== 'mature') counts[episode.state]++;
        else evaluated.push({ prediction, y: episode.y });
    }
    return { scope, predictionId, runId: frozen.runId, frozenAt, trainingAsOf: frozen.trainingAsOf,
        asOf: input.asOf, predictions: frozen.rows.length, counts, ...summarizePredictions(evaluated) };
}
