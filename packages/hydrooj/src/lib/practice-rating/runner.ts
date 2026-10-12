import { ObjectId } from 'mongodb';
import { Worker } from 'node:worker_threads';
import { CapturedInput, capturePracticeInput, RatingDatabase } from './adapter';
import { extractPracticeEpisodes, TrainingObservation } from './episodes';
import { fitPracticeRating, JointFit } from './model';
import { ActiveScope, COLLECTIONS, EpisodeSnapshot, PracticeRatingStore } from './store';

export interface RunOptions {
    domainId: string;
    asOf?: number;
    excludedUids?: number[];
    write?: boolean;
}

const running = new Set<string>();

/** Keep CPU fitting out of Hydro's HTTP/judgement event loop. */
export function workerTask<T>(modulePath: string, method: string, args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const { parentPort, workerData } = require('node:worker_threads');
            const localRequire = require('node:module').createRequire(workerData.modulePath);
            localRequire('@hydrooj/register');
            parentPort.postMessage(localRequire(workerData.modulePath)[workerData.method](...workerData.args));
        `, { eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 },
            workerData: { modulePath, method, args } });
        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error('Practice rating fit exceeded five minutes'));
        }, 5 * 60 * 1000);
        worker.once('message', (fit) => {
            clearTimeout(timer);
            resolve(fit);
        });
        worker.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        worker.once('exit', () => {
            clearTimeout(timer);
            reject(new Error('Practice rating worker exited without a result'));
        });
    });
}

export function fitPracticeRatingAsync(observations: TrainingObservation[], scope: string): Promise<JointFit> {
    return workerTask(require.resolve('./model'), 'fitPracticeRating', [observations, scope]);
}

/** Extraction, grouping and compact snapshot preparation also run off the HTTP thread. */
export function preparePracticeRun(input: CapturedInput) {
    const extraction = extractPracticeEpisodes(input.records, input.asOf, input.activities);
    const fit = fitPracticeRating(extraction.observations, input.scope);
    if (fit.status === 'numerical_failure') throw new Error('Joint fit did not converge; previous active run is preserved');
    const trainingKeys = new Set(extraction.observations.map((o) => o.episodeKey));
    const observations = new Map(extraction.observations.map((o) => [o.episodeKey, o]));
    const snapshots: EpisodeSnapshot[] = extraction.episodes.filter((e) => trainingKeys.has(e.key)).map((e) => ({
        episode: { key: e.key, uid: e.uid, pid: e.pid, revision: e.revision, t0: e.t0, windowEnd: e.windowEnd, y: e.y },
        observation: observations.get(e.key),
    }));
    const { excluded, metadataUnavailable, resultTimeMissing, ...counts } = extraction.diagnostics;
    const excludedByReason: Record<string, number> = {};
    for (const item of excluded) excludedByReason[item.reason] = (excludedByReason[item.reason] || 0) + 1;
    const unknownTraining = extraction.observations.filter((o) => o.revision === null).length;
    const diagnostics = { ...counts, totalEpisodes: extraction.episodes.length,
        unknownRevisionEpisodeRatio: extraction.episodes.length ? counts.unknownRevisionEpisodes / extraction.episodes.length : null,
        unknownRevisionTrainingObservations: unknownTraining,
        unknownRevisionTrainingRatio: extraction.observations.length ? unknownTraining / extraction.observations.length : null,
        excludedByReason, metadataUnavailable: metadataUnavailable.length,
        resultTimeMissing: resultTimeMissing.length, scannedRecords: input.records.length, trainingObservations: extraction.observations.length };
    return { fit, snapshots, diagnostics };
}

export async function runPracticeRating(database: RatingDatabase, options: RunOptions) {
    if (!options.domainId) throw new Error('An explicit domainId is required');
    if (running.size) throw new Error('Practice rating is already running in this process');
    running.add(options.domainId);
    const store = new PracticeRatingStore(database);
    let lease: Awaited<ReturnType<PracticeRatingStore['acquire']>>;
    try {
        if (options.write) {
            await store.ensureIndexes();
            lease = await store.acquire(options.domainId);
        }
        const configured = await database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: options.domainId });
        const excludedUids = [...new Set([...(configured?.excludedUids ?? []), ...(options.excludedUids ?? [])])];
        const input = await capturePracticeInput(database, options.domainId, excludedUids, options.asOf);
        const { fit, snapshots, diagnostics } = await workerTask<ReturnType<typeof preparePracticeRun>>(
            require.resolve('./runner'), 'preparePracticeRun', [input],
        );
        // Release the raw history before persisting compact training rows.
        input.records.length = 0;
        input.activities.length = 0;
        const runId = new ObjectId().toHexString();
        const summary = { runId: options.write ? runId : null, scope: input.scope, asOf: input.asOf,
            modelVersion: fit.modelVersion, status: fit.status, iterations: fit.iterations, components: fit.components,
            users: fit.users.length, problems: fit.problems.length, diagnostics, activated: false, write: !!options.write };
        if (options.write) {
            const saved = await store.save({ runId, scope: input.scope, asOf: input.asOf, capturedAt: input.capturedAt, fit,
                episodes: snapshots, diagnostics, exclusionPolicy: input.exclusionPolicy }, lease);
            summary.activated = saved.activated;
        }
        return summary;
    } finally {
        try {
            if (lease) await store.release(options.domainId, lease.token);
        } finally {
            running.delete(options.domainId);
        }
    }
}
