import { ObjectId } from 'mongodb';
import { Worker } from 'node:worker_threads';
import { capturePracticeInput, RatingDatabase } from './adapter';
import { extractPracticeEpisodes, TrainingObservation } from './episodes';
import { JointFit } from './model';
import { ActiveScope, COLLECTIONS, EpisodeSnapshot, PracticeRatingStore } from './store';

export interface RunOptions {
    domainId: string;
    asOf?: number;
    excludedUids?: number[];
    write?: boolean;
}

const running = new Set<string>();

/** Keep CPU fitting out of Hydro's HTTP/judgement event loop. */
export function fitPracticeRatingAsync(observations: TrainingObservation[], scope: string): Promise<JointFit> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const { parentPort, workerData } = require('node:worker_threads');
            const localRequire = require('node:module').createRequire(workerData.modulePath);
            localRequire('@hydrooj/register');
            parentPort.postMessage(localRequire(workerData.modulePath).fitPracticeRating(workerData.observations, workerData.scope));
        `, { eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 },
            workerData: { modulePath: require.resolve('./model'), observations, scope } });
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

export async function runPracticeRating(database: RatingDatabase, options: RunOptions) {
    if (!options.domainId) throw new Error('An explicit domainId is required');
    if (running.has(options.domainId)) throw new Error('Practice rating is already running for this domain');
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
        const extraction = extractPracticeEpisodes(input.records, input.asOf, input.activities);
        const fit = await fitPracticeRatingAsync(extraction.observations, input.scope);
        if (fit.status === 'numerical_failure') throw new Error('Joint fit did not converge; previous active run is preserved');
        const records = new Map(input.records.map((r) => [r.id, r]));
        const observations = new Map(extraction.observations.map((o) => [o.episodeKey, o]));
        const snapshots: EpisodeSnapshot[] = extraction.episodes.map((episode) => ({
            episode, observation: observations.get(episode.key) ?? null, evidence: episode.recordIds.map((id) => records.get(id)),
        }));
        const { excluded, metadataUnavailable, resultTimeMissing, ...counts } = extraction.diagnostics;
        const excludedByReason: Record<string, number> = {};
        for (const item of excluded) excludedByReason[item.reason] = (excludedByReason[item.reason] || 0) + 1;
        const diagnostics = { ...counts, excludedByReason, metadataUnavailable: metadataUnavailable.length,
            resultTimeMissing: resultTimeMissing.length, scannedRecords: input.records.length, trainingObservations: extraction.observations.length };
        const runId = new ObjectId().toHexString();
        const summary = { runId: options.write ? runId : null, scope: input.scope, asOf: input.asOf,
            modelVersion: fit.modelVersion, status: fit.status, iterations: fit.iterations, components: fit.components,
            users: fit.users.length, problems: fit.problems.length, diagnostics, write: !!options.write };
        if (options.write) {
            await store.save({ runId, scope: input.scope, asOf: input.asOf, capturedAt: input.capturedAt, fit,
                episodes: snapshots, diagnostics }, lease);
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
