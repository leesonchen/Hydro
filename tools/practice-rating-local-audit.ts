/* eslint-disable no-await-in-loop */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MongoClient } from 'mongodb';
import { capturePracticeInput, MAX_RECORDS } from '../packages/hydrooj/src/lib/practice-rating/adapter';
import { completionProbability, problemKey } from '../packages/hydrooj/src/lib/practice-rating/model';
import { preparePracticeRun } from '../packages/hydrooj/src/lib/practice-rating/runner';
import { ActiveScope, COLLECTIONS } from '../packages/hydrooj/src/lib/practice-rating/store';

const container = process.argv[2] || 'hydro';
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
const mongoUrlScript = `
const c = require('/root/.hydro/config.json');
process.stdout.write(c.url || c.uri || '');
`;
const connection = spawnSync('docker', ['exec', container, '/root/.nix-profile/bin/node', '-e', mongoUrlScript], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
});
if (connection.status !== 0 || !connection.stdout) throw new Error('Could not read local test MongoDB connection');
const uri = connection.stdout.trim();
const dbName = new URL(uri).pathname.slice(1) || 'hydro';
const client = new MongoClient(uri, { monitorCommands: true, serverSelectionTimeoutMS: 5000 });
const writes: string[] = [];
const mutating = new Set(['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'drop', 'dropDatabase', 'aggregateOut']);
client.on('commandStarted', (event) => { if (mutating.has(event.commandName)) writes.push(event.commandName); });

function alias(scope: string, uid: number) {
    return createHash('sha256').update(`${scope}:${uid}`).digest('hex').slice(0, 10);
}

async function main() {
    await client.connect();
    try {
        const db = client.db(dbName);
        const asOf = Date.now();
        const domains = await db.collection<{ _id: string }>('domain').find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray();
        const report: any = { container, asOf, commit: revision.status === 0 ? revision.stdout.trim() : null,
            domains: [], writes: [] };
        for (const { _id: scope } of domains) {
            const started = performance.now();
            const records = await db.collection('record').countDocuments({ domainId: scope }, { maxTimeMS: 120000 });
            const configured = await db.collection<ActiveScope>(COLLECTIONS.active).findOne({ _id: scope });
            const excludedUids = configured?.excludedUids ?? [];
            const result: any = { scope, records, excludedConfigured: excludedUids.length };
            try {
                const input = await capturePracticeInput(db, scope, excludedUids, asOf);
                const { fit, snapshots, diagnostics } = preparePracticeRun(input);
                result.status = fit.status;
                result.diagnostics = diagnostics;
                result.training = snapshots.length;
                result.trainingSuccesses = snapshots.reduce((sum, row) => sum + row.observation.y, 0);
                result.users = { total: fit.users.length, estimated: fit.users.filter((u) => u.status === 'estimated').length };
                result.problems = { total: fit.problems.length, estimated: fit.problems.filter((p) => p.status === 'estimated').length };
                result.components = fit.components;
                result.iterations = fit.iterations;
                if (fit.status === 'ok' && snapshots.length) {
                    const byProblem = new Map(fit.problems.map((p) => [problemKey(p.pid, p.revision), p]));
                    const byUser = new Map(fit.users.map((u) => [u.uid, u]));
                    const byUid = new Map<number, typeof snapshots>();
                    const byPid = new Map<string, typeof snapshots>();
                    for (const row of snapshots) {
                        const uid = row.observation.uid;
                        const pid = problemKey(row.observation.pid, row.observation.revision);
                        if (!byUid.has(uid)) byUid.set(uid, []);
                        if (!byPid.has(pid)) byPid.set(pid, []);
                        byUid.get(uid).push(row);
                        byPid.get(pid).push(row);
                    }
                    const users = fit.users.filter((u) => u.samples >= 10 && u.value !== null)
                        .sort((a, b) => b.samples - a.samples).slice(0, 3);
                    const problems = fit.problems.filter((p) => p.samples >= 20 && p.value !== null)
                        .sort((a, b) => b.samples - a.samples).slice(0, 3);
                    const problemDocs = await db.collection('document').find({ domainId: scope, docType: 10,
                        docId: { $in: problems.map((p) => p.pid) } }, { projection: { docId: 1, title: 1, difficulty: 1, hidden: 1 } }).toArray();
                    const problemInfo = new Map(problemDocs.map((doc) => [doc.docId, doc]));
                    result.userSamples = users.map((u) => {
                        const rows = byUid.get(u.uid) ?? [];
                        const meanDifficulty = rows.reduce((sum, row) => sum
                            + byProblem.get(problemKey(row.observation.pid, row.observation.revision)).value, 0) / rows.length;
                        const meanProbability = rows.reduce((sum, row) => sum + completionProbability(u.value,
                            byProblem.get(problemKey(row.observation.pid, row.observation.revision)).value), 0) / rows.length;
                        const handGradient = (u.value - 1500) / 600 ** 2 + rows.reduce((sum, row) => {
                            const d = byProblem.get(problemKey(row.observation.pid, row.observation.revision)).value;
                            const p = 1 / (1 + 10 ** ((d - u.value) / 400));
                            return sum + Math.log(10) / 400 * (p - row.observation.y);
                        }, 0);
                        return { alias: alias(scope, u.uid), R: u.value, status: u.status, samples: u.samples, successes: u.successes,
                            observedRate: u.successes / u.samples, meanD: meanDifficulty, meanPredicted: meanProbability,
                            handGradient };
                    });
                    result.problemSamples = problems.map((p) => {
                        const rows = byPid.get(problemKey(p.pid, p.revision)) ?? [];
                        const meanAbility = rows.reduce((sum, row) => sum + byUser.get(row.observation.uid).value, 0) / rows.length;
                        const meanProbability = rows.reduce((sum, row) => sum + completionProbability(
                            byUser.get(row.observation.uid).value, p.value), 0) / rows.length;
                        const handGradient = (p.value - 1500) / 600 ** 2 - rows.reduce((sum, row) => {
                            const r = byUser.get(row.observation.uid).value;
                            const probability = 1 / (1 + 10 ** ((p.value - r) / 400));
                            return sum + Math.log(10) / 400 * (probability - row.observation.y);
                        }, 0);
                        return { pid: p.pid, revision: p.revision, D: p.value, status: p.status,
                            samples: p.samples, successes: p.successes, observedRate: p.successes / p.samples,
                            meanR: meanAbility, meanPredicted: meanProbability, handGradient,
                            title: problemInfo.get(p.pid)?.hidden ? null : problemInfo.get(p.pid)?.title ?? null,
                            legacyDifficulty: problemInfo.get(p.pid)?.difficulty ?? null };
                    });
                }
            } catch (error) {
                result.status = records > MAX_RECORDS ? 'record_limit' : 'failed';
                result.error = error.message;
            }
            result.elapsedMs = Math.round(performance.now() - started);
            report.domains.push(result);
        }
        if (writes.length) throw new Error(`Read-only audit sent MongoDB write commands: ${writes.join(',')}`);
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } finally {
        await client.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
