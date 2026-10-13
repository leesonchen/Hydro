// Run through stdin in the target container. Uses its active installed package.
// Only a new, uniquely named ratingv2_shadow pool may be written.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const release = fs.readFileSync('/root/.hydro/dev-releases/active', 'utf8').trim();
const req = createRequire(path.join(release, 'package.json'));
req('@hydrooj/register');
const pkgPath = req.resolve('hydrooj/package.json');
const root = path.dirname(pkgPath);
const { MongoClient, BSON } = req('mongodb');
const { runShadowReplay } = req(root + '/src/lib/rating-v2/shadow-replay.ts');
const { isRatingContestEligible } = req(root + '/src/lib/rating-v2/eligibility.ts');
const domainId = 'exam';
const sourceNames = ['document', 'record', 'document.status', 'domain.user'];
const stamp = new Date().toISOString().replace(/[^0-9]/g, '');
const config = JSON.parse(fs.readFileSync('/root/.hydro/config.json', 'utf8'));
const uri = config.url || config.uri || `${config.protocol || 'mongodb'}://${config.username
    ? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@` : ''}${config.host}:${config.port}/${config.name}`;
const client = new MongoClient(uri, { monitorCommands: true });
const writes = [];
client.on('commandStarted', (event) => {
    if (['insert', 'delete', 'update', 'findAndModify', 'drop', 'createIndexes'].includes(event.commandName)) {
        writes.push({ command: event.commandName, collection: event.command[event.commandName] });
    }
});

async function fingerprint(db) {
    const result = {};
    for (const name of sourceNames) {
        const hash = crypto.createHash('sha256');
        let count = 0;
        for await (const doc of db.collection(name).find({ domainId }).sort({ _id: 1 })) {
            hash.update(BSON.serialize(doc));
            count++;
        }
        result[name] = { count, sha256: hash.digest('hex') };
    }
    return result;
}

async function main() {
    await client.connect();
    try {
        const db = client.db();
        const report = {
            generatedAt: new Date().toISOString(), container: 'hydro', domainId,
            release, packageVersion: req(pkgPath).version, hashes: {}, runs: [], writes,
        };
        for (const file of fs.readdirSync(root + '/src/lib/rating-v2')) {
            report.hashes[file] = crypto.createHash('sha256')
                .update(fs.readFileSync(root + '/src/lib/rating-v2/' + file)).digest('hex');
        }
        report.before = await fingerprint(db);
        const contests = await db.collection('document').find({ domainId, docType: 30 }).sort({ beginAt: 1, _id: 1 }).toArray();
        report.contests = [];
        for (const contest of contests) {
            if (!contest.rated) continue;
            const records = await db.collection('record').find({ domainId, contest: contest.docId, uid: { $gt: 0 },
                _id: { $gte: BSON.ObjectId.createFromTime(Math.floor(contest.beginAt.getTime() / 1000)),
                    $lt: BSON.ObjectId.createFromTime(Math.ceil(contest.endAt.getTime() / 1000)) } },
            { projection: { _id: 1, uid: 1, pid: 1, score: 1, status: 1 } }).toArray();
            report.contests.push({ id: String(contest.docId), title: contest.title, rule: contest.rule,
                beginAt: contest.beginAt, endAt: contest.endAt, duration: contest.duration || 0, pids: contest.pids,
                participants: new Set(records.map((r) => r.uid)).size,
                certifiedReasons: isRatingContestEligible(contest, new Set(records.map((r) => r.uid)).size,
                    contest.ratingPolicy?.poolId || 'exam-no-certified-policy').reasonCodes,
                records: records.map((r) => ({ id: String(r._id), timestamp: r._id.getTimestamp().toISOString(),
                    uid: r.uid, pid: r.pid, score: r.score, status: r.status })),
            });
        }
        report.achievementInput = await db.collection('document.status').find({ domainId, docType: 10,
            rid: { $ne: null }, uid: { $gt: 0 } },
        { projection: { _id: 0, uid: 1, docId: 1, score: 1, status: 1 } }).toArray();

        const variants = [
            ['trial-default', {}],
            ['trial-prior1', { difficultyMinPriorEvents: 1 }],
            ['trial-no-duration-prior1', { difficultyMinPriorEvents: 1, includeDuration: false }],
            ['certified', { eligibilityMode: 'certified' }],
        ];
        for (const [name, overrides] of variants) {
            const poolId = `exam-v2-validation-${stamp}-${name}`;
            assert.equal(await db.collection('ratingv2_shadow').countDocuments({ poolId }), 0, 'Pool must be new');
            const options = { eligibilityMode: 'trial', refDomain: domainId, poolId, write: true, ...overrides };
            const scoped = { collection(collectionName) {
                const coll = db.collection(collectionName);
                if (collectionName === 'ratingv2_shadow') return {
                    deleteMany(filter) { assert.deepEqual(filter, { poolId }); return coll.deleteMany(filter); },
                    insertMany(docs) { assert(docs.every((d) => d.poolId === poolId)); return coll.insertMany(docs); },
                };
                assert(sourceNames.includes(collectionName), `Unexpected source ${collectionName}`);
                // refDomain controls comparison only. Enforce domain at the database adapter.
                return {
                    find(filter = {}, ...args) { return coll.find({ $and: [filter, { domainId }] }, ...args); },
                    findOne(filter = {}, ...args) { return coll.findOne({ $and: [filter, { domainId }] }, ...args); },
                };
            } };
            const messages = [];
            const dry = await runShadowReplay(scoped, { ...options, write: false });
            const summary = await runShadowReplay(scoped, options, (message) => {
                messages.push(message);
                process.stderr.write(`[${name}] ${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
            });
            const comparable = (s) => { const copy = { ...s }; delete copy.generatedAt; return copy; };
            assert.deepEqual(comparable(dry), comparable(summary), 'Dry run and stored run must match');
            const docs = await db.collection('ratingv2_shadow').find({ poolId }, { projection: { _id: 0 } }).toArray();
            assert(docs.filter((d) => d.kind === 'projection').every((d) => d.domainId === domainId));
            const counts = {};
            for (const doc of docs) counts[doc.kind] = (counts[doc.kind] || 0) + 1;
            report.runs.push({ name, options, summary, messages, counts, docs, dryRunMatches: true });
        }
        report.after = await fingerprint(db);
        assert.deepEqual(report.before, report.after, 'Source fingerprints changed during replay');
        assert(writes.every((w) => w.collection === 'ratingv2_shadow'), 'Unexpected database writes');
        report.sourceUnchanged = true;
        report.onlyShadowWrites = true;
        const pids = [...new Set(report.runs.flatMap((run) => run.docs.filter((d) => d.kind === 'difficulty').map((d) => d.pid)))];
        report.problemTitles = await db.collection('document').find({ domainId, docType: 10, docId: { $in: pids } },
            { projection: { _id: 0, docId: 1, title: 1 } }).toArray();
        console.log(JSON.stringify(report, null, 2));
    } finally {
        await client.close();
    }
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
