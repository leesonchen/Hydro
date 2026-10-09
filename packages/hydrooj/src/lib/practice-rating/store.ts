/* eslint-disable no-await-in-loop */
import { createHash, randomUUID } from 'node:crypto';
import { BSON } from 'mongodb';
import { RatingDatabase } from './adapter';
import { EPISODE_WINDOW_MS, PracticeEpisode, PracticeSubmission, RECENT_WINDOW_MS, TrainingObservation } from './episodes';
import { completionProbability, JointFit, ProblemEstimate, problemKey, UserEstimate } from './model';

export const COLLECTIONS = Object.freeze({
    runs: 'practice_rating_runs', episodes: 'practice_rating_episodes', users: 'practice_rating_users',
    problems: 'practice_rating_problems', active: 'practice_rating_active',
});
const LEASE_MS = 30 * 60 * 1000;

export interface EpisodeSnapshot {
    episode: PracticeEpisode;
    observation: TrainingObservation | null;
    evidence: PracticeSubmission[];
}

export interface RunSnapshot {
    runId: string;
    scope: string;
    asOf: number;
    capturedAt: number;
    fit: JointFit;
    episodes: EpisodeSnapshot[];
    diagnostics: Record<string, unknown>;
}

export interface ActiveScope {
    _id: string;
    runId?: string;
    asOf?: number;
    enabled?: boolean;
    excludedUids?: number[];
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
        for (const name of [COLLECTIONS.episodes, COLLECTIONS.users, COLLECTIONS.problems]) {
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
        const inputHash = checksum(episodes);
        const outputHash = checksum({ users: fit.users, problems: fit.problems });
        const run = {
            _id: runId, scope, asOf, capturedAt: snapshot.capturedAt, modelVersion: fit.modelVersion, sampleVersion: 'practice-episodes-7d-v1',
            parameters: { ...fit.parameters, episodeWindowMs: EPISODE_WINDOW_MS, recentWindowMs: RECENT_WINDOW_MS },
            status: 'writing', inputHash, outputHash, counts: { episodes: episodes.length, users: fit.users.length, problems: fit.problems.length },
            fitStatus: fit.status, iterations: fit.iterations, objective: fit.objective, components: fit.components,
            diagnostics: snapshot.diagnostics,
        };
        const runs = this.database.collection<any>(COLLECTIONS.runs);
        await runs.insertOne(run);
        try {
            const batches = [
                [COLLECTIONS.episodes, episodes.map((s) => ({
                    _id: JSON.stringify([runId, s.episode.key]), scope, runId, key: s.episode.key, ...s,
                }))],
                [COLLECTIONS.users, fit.users.map((u) => ({ _id: JSON.stringify([runId, u.uid]), scope, runId, ...u }))],
                [COLLECTIONS.problems, fit.problems.map((p) => ({ _id: JSON.stringify([runId, p.pid, p.revision]), scope, runId, ...p }))],
            ] as const;
            for (const [name, docs] of batches) {
                for (let i = 0; i < docs.length; i += 500) {
                    await this.renew(scope, lease.token);
                    const batch = docs.slice(i, i + 500);
                    if (batch.some((doc) => BSON.calculateObjectSize(doc) > 12 * 1024 * 1024)) {
                        throw new Error('Episode snapshot exceeds safe MongoDB document size');
                    }
                    await this.database.collection<any>(name).insertMany(batch);
                }
            }
            const savedEpisodes = await this.database.collection(COLLECTIONS.episodes).find({ scope, runId }).sort({ key: 1 }).toArray();
            const savedUsers = await this.database.collection(COLLECTIONS.users).find({ scope, runId }).sort({ uid: 1 }).toArray();
            const savedProblems = await this.database.collection(COLLECTIONS.problems).find({ scope, runId }).toArray();
            savedEpisodes.sort((a, b) => (a.key < b.key ? -1 : Number(a.key > b.key)));
            savedProblems.sort((a, b) => (problemKey(a.pid, a.revision) < problemKey(b.pid, b.revision) ? -1 : 1));
            const restoredEpisodes = savedEpisodes.map(({ episode, observation, evidence }) => ({ episode, observation, evidence }));
            const restoreEstimate = ({ _id, scope: _, runId: __, ...estimate }) => estimate;
            if (savedEpisodes.length !== episodes.length || savedUsers.length !== fit.users.length || savedProblems.length !== fit.problems.length
                || checksum(restoredEpisodes) !== inputHash
                || checksum({ users: savedUsers.map(restoreEstimate), problems: savedProblems.map(restoreEstimate) }) !== outputHash) {
                throw new Error('Snapshot count or checksum validation failed');
            }
            await this.renew(scope, lease.token);
            await runs.updateOne({ _id: runId, status: 'writing' }, { $set: { status: 'complete', completedAt: Date.now() } });
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
            if (active?.runId === runId) return { runId, inputHash, outputHash };
            await runs.updateOne({ _id: runId }, { $set: { status: 'failed', error: error.message } });
            throw error;
        }
        return { runId, inputHash, outputHash };
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
        if (!run) return { scope, status: 'insufficient', runId: null, user: null, problem: null, probability: null };
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
        return { scope, status: run.fitStatus, runId: run._id, asOf: run.asOf, modelVersion: run.modelVersion,
            user: publicEstimate(user), problem: publicEstimate(problem), probability };
    }
}

type EstimateLike = UserEstimate | ProblemEstimate | null;
type StoredUser = UserEstimate & { runId: string, scope: string };
type StoredProblem = ProblemEstimate & { runId: string, scope: string };
