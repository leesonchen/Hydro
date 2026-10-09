/* eslint-disable no-await-in-loop */
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { ExclusionPolicy, RatingDatabase, RECORD_INDEX } from './adapter';
import { EPISODE_WINDOW_MS, PracticeEpisode, RECENT_WINDOW_MS, TrainingObservation } from './episodes';
import { completionProbability, JointFit, ProblemEstimate, UserEstimate } from './model';

export const COLLECTIONS = Object.freeze({
    runs: 'practice_rating_runs', episodes: 'practice_rating_episodes', users: 'practice_rating_users',
    problems: 'practice_rating_problems', active: 'practice_rating_active',
});
const LEASE_MS = 30 * 60 * 1000;

export interface EpisodeSnapshot {
    episode: Pick<PracticeEpisode, 'key' | 'uid' | 'pid' | 'revision' | 't0' | 'windowEnd' | 'y'>;
    observation: TrainingObservation;
}

export interface RunSnapshot {
    runId: string;
    scope: string;
    asOf: number;
    capturedAt: number;
    fit: JointFit;
    episodes: EpisodeSnapshot[];
    diagnostics: Record<string, unknown>;
    exclusionPolicy?: ExclusionPolicy;
}

export interface ActiveScope {
    _id: string;
    runId?: string;
    asOf?: number;
    enabled?: boolean;
    teacherTrial?: boolean;
    excludedUids?: number[];
    exclusionConfigVersion?: string;
    lock?: { token: string, expiresAt: number };
}

function canonical(value: any): any {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
    return value;
}
export const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function probabilityForRun(runId: string, scope: string, user: StoredUser | null, problem: StoredProblem | null) {
    if ((user && (user.runId !== runId || user.scope !== scope)) || (problem && (problem.runId !== runId || problem.scope !== scope))) {
        throw new Error('Mixed run or scope estimates are not allowed');
    }
    if (user?.value == null || problem?.value == null || user.component !== problem.component) return null;
    return completionProbability(user.value, problem.value);
}

export class PracticeRatingStore {
    constructor(private database: RatingDatabase) { }

    async ensureIndexes() {
        await this.database.collection(COLLECTIONS.runs).createIndex({ scope: 1, asOf: -1 });
        await this.database.collection(COLLECTIONS.runs).createIndex({ scope: 1, capturedAt: -1, _id: -1 });
        await this.database.collection('record').createIndex(RECORD_INDEX, { name: 'practiceRatingScan' });
        await this.database.collection(COLLECTIONS.users).createIndex({ scope: 1, runId: 1, uid: 1 });
        await this.database.collection(COLLECTIONS.problems).createIndex({ scope: 1, runId: 1, pid: 1, revision: 1 });
        for (const name of [COLLECTIONS.users, COLLECTIONS.problems]) {
            await this.database.collection(name).createIndex({ scope: 1, runId: 1 });
        }
    }

    async acquire(scope: string) {
        const token = randomUUID();
        const now = Date.now();
        try {
            const active = await this.database.collection<ActiveScope>(COLLECTIONS.active).findOneAndUpdate({
                _id: scope, $or: [{ lock: { $exists: false } }, { 'lock.expiresAt': { $lte: now } }],
            }, { $set: { lock: { token, expiresAt: now + LEASE_MS } } }, { upsert: true, returnDocument: 'after' });
            return { token, previousRunId: active.runId ?? null };
        } catch (error) {
            if (error.code === 11000) throw new Error('Practice rating is already running for this domain');
            throw error;
        }
    }

    async release(scope: string, token: string) {
        await this.database.collection<ActiveScope>(COLLECTIONS.active).updateOne({ _id: scope, 'lock.token': token }, { $unset: { lock: '' } });
    }

    private async renew(scope: string, token: string) {
        const now = Date.now();
        const res = await this.database.collection<ActiveScope>(COLLECTIONS.active).updateOne(
            { _id: scope, 'lock.token': token, 'lock.expiresAt': { $gt: now } }, { $set: { 'lock.expiresAt': now + LEASE_MS } },
        );
        if (!res.matchedCount) throw new Error('Practice rating lease expired or was replaced');
    }

    async save(snapshot: RunSnapshot, lease: { token: string, previousRunId: string | null }) {
        const { scope, runId, episodes, fit, asOf } = snapshot;
        if (fit.scope !== scope || fit.status === 'numerical_failure') throw new Error('Invalid fit cannot replace an active run');
        const inputChunks: string[] = [];
        const outputChunks: string[] = [];
        // Bounded serialization/hashing and readback; unchanged training chunks are reused.
        // Only actual training rows are persisted, never all historical/open processes.
        const chunkSize = 256;
        const run = {
            _id: runId, scope, asOf, capturedAt: snapshot.capturedAt, modelVersion: fit.modelVersion, sampleVersion: 'practice-episodes-7d-v1',
            parameters: { ...fit.parameters, episodeWindowMs: EPISODE_WINDOW_MS, recentWindowMs: RECENT_WINDOW_MS },
            status: 'writing', snapshotVersion: 2, counts: { episodes: episodes.length, users: fit.users.length, problems: fit.problems.length },
            fitStatus: fit.status, iterations: fit.iterations, objective: fit.objective, components: fit.components,
            diagnostics: snapshot.diagnostics,
            exclusionPolicy: snapshot.exclusionPolicy ?? null,
            exclusionPolicyVersion: checksum(snapshot.exclusionPolicy ?? null),
        };
        const runs = this.database.collection<any>(COLLECTIONS.runs);
        await runs.insertOne(run);
        try {
            for (let i = 0; i < episodes.length; i += chunkSize) {
                await setImmediate();
                await this.renew(scope, lease.token);
                const rows = episodes.slice(i, i + chunkSize);
                const id = checksum({ scope, rows });
                await this.database.collection<any>(COLLECTIONS.episodes).updateOne({ _id: id }, {
                    $setOnInsert: { scope, rows },
                }, { upsert: true });
                const saved = await this.database.collection<any>(COLLECTIONS.episodes).findOne({ _id: id, scope });
                if (!saved || checksum({ scope, rows: saved.rows }) !== id) throw new Error('Input chunk checksum validation failed');
                inputChunks.push(id);
            }
            for (const [name, estimates] of [[COLLECTIONS.users, fit.users], [COLLECTIONS.problems, fit.problems]] as const) {
                for (let i = 0; i < estimates.length; i += chunkSize) {
                    await setImmediate();
                    await this.renew(scope, lease.token);
                    const batch = estimates.slice(i, i + chunkSize).map((e, index) => ({
                        _id: JSON.stringify([runId, i + index]), scope, runId, ...e,
                    }));
                    await this.database.collection<any>(name).insertMany(batch);
                    const saved = await this.database.collection<any>(name).find({
                        scope, runId, _id: { $in: batch.map((d) => d._id) },
                    }).toArray();
                    const byId = new Map(saved.map((d) => [d._id, d]));
                    const hash = checksum(batch);
                    if (saved.length !== batch.length || checksum(batch.map((d) => byId.get(d._id))) !== hash) {
                        throw new Error('Estimate count or checksum validation failed');
                    }
                    // Hash estimates without runId so identical fits have identical outputHash.
                    outputChunks.push(checksum(estimates.slice(i, i + chunkSize)));
                }
            }
            const inputHash = checksum(inputChunks);
            const outputHash = checksum(outputChunks);
            await this.renew(scope, lease.token);
            await runs.updateOne({ _id: runId, status: 'writing' }, { $set: {
                status: fit.status === 'insufficient' ? 'insufficient' : 'complete',
                completedAt: Date.now(), inputChunks, inputHash, outputHash,
            } });
            if (fit.status === 'insufficient') return { runId, inputHash, outputHash, activated: false };
            const switched = await this.database.collection<ActiveScope>(COLLECTIONS.active).updateOne({
                _id: scope, 'lock.token': lease.token, 'lock.expiresAt': { $gt: Date.now() },
                runId: lease.previousRunId, $or: [{ asOf: { $exists: false } }, { asOf: { $lte: asOf } }],
            }, { $set: { runId, asOf }, $unset: { lock: '' } });
            if (!switched.matchedCount) throw new Error('Active run changed or candidate cutoff is older; candidate was not activated');
        } catch (error) {
            // MongoDB may have committed the compare-and-set while the client
            // lost the response. Reconcile the pointer before marking a run
            // failed, otherwise a valid active snapshot becomes unreadable.
            const active = await this.database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope, runId });
            if (active?.runId === runId) return { runId, activated: true };
            await runs.updateOne({ _id: runId }, { $set: { status: 'failed', error: error.message } });
            throw error;
        }
        return { runId, activated: true };
    }

    async trainingInput(runId: string, scope: string): Promise<EpisodeSnapshot[]> {
        const run = await this.database.collection<any>(COLLECTIONS.runs).findOne({ _id: runId, scope, status: 'complete' });
        if (!run) throw new Error('Unknown complete run');
        if (run.snapshotVersion !== 2) {
            // Read existing v1 snapshots without migrating or rewriting them.
            const rows = await this.database.collection<any>(COLLECTIONS.episodes).find({ scope, runId }).toArray();
            return rows.filter((row) => row.observation).map(({ episode, observation }) => ({ episode, observation }));
        }
        if (checksum(run.inputChunks) !== run.inputHash) throw new Error('Input manifest checksum validation failed');
        const rows: EpisodeSnapshot[] = [];
        for (const id of run.inputChunks) {
            const chunk = await this.database.collection<any>(COLLECTIONS.episodes).findOne({ _id: id, scope });
            if (!chunk || checksum({ scope, rows: chunk.rows }) !== id) throw new Error('Input chunk checksum validation failed');
            rows.push(...chunk.rows);
        }
        return rows;
    }

    async activeRun(scope: string) {
        const active = await this.database.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope });
        if (!active?.runId) return null;
        const run = await this.database.collection<any>(COLLECTIONS.runs).findOne({ _id: active.runId, scope, status: 'complete' });
        if (!run) throw new Error('Active run is incomplete or belongs to another scope');
        return run;
    }

    async read(scope: string, uid?: number, pid?: number, revision: string | null = null) {
        const run = await this.activeRun(scope);
        const attempt = await this.database.collection<any>(COLLECTIONS.runs).find({ scope }).sort({ capturedAt: -1, _id: -1 }).limit(1).next();
        const latestAttempt = attempt ? { runId: attempt._id, asOf: attempt.asOf, status: attempt.status } : null;
        if (!run) return { scope, status: 'insufficient', runId: null, latestAttempt, user: null, problem: null, probability: null };
        const [user, problem] = await Promise.all([
            uid === undefined ? null : this.database.collection<StoredUser>(COLLECTIONS.users).findOne({ scope, runId: run._id, uid }),
            pid === undefined ? null : this.database.collection<StoredProblem>(COLLECTIONS.problems).findOne({
                scope, runId: run._id, pid, revision,
            }),
        ]);
        const probability = probabilityForRun(run._id, scope, user, problem);
        // Deliberately omit source evidence/record IDs from the administrator report.
        const publicEstimate = (e: EstimateLike) => e && ({ value: e.value, status: e.status, samples: e.samples,
            successes: e.successes, conditionalSe: e.conditionalSe, component: e.component });
        return { scope, status: run.fitStatus, latestAttempt, runId: run._id, asOf: run.asOf, modelVersion: run.modelVersion,
            user: publicEstimate(user), problem: publicEstimate(problem), probability };
    }
}

type EstimateLike = UserEstimate | ProblemEstimate | null;
type StoredUser = UserEstimate & { runId: string, scope: string };
type StoredProblem = ProblemEstimate & { runId: string, scope: string };
