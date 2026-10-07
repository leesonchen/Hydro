// Run in the local Hydro container with a synthetic feedback fixture.
// Starts a second MongoDB on loopback; never opens the running Hydro database.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const modules = path.resolve(fs.realpathSync('/usr/local/bin/hydrooj'), '../../..');
const { MongoClient } = require(path.join(modules, 'mongodb'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-feedback-backup-'));
const source = 'hydro_feedback_verify';
const restored = `${source}_restored`;
let client;
let mongod;
let stage = 'start';
(async () => {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    mongod = spawn('/root/.nix-profile/bin/mongod', ['--dbpath', temporary, '--port', String(port), '--bind_ip', '127.0.0.1'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Isolated MongoDB startup timeout')), 30000);
        mongod.once('error', reject);
        mongod.once('exit', () => reject(new Error('Isolated MongoDB exited during startup')));
        mongod.stdout.on('data', (chunk) => {
            if (chunk.toString().includes('Waiting for connections')) { clearTimeout(timeout); resolve(); }
        });
        mongod.stderr.on('data', () => {});
    });
    const uri = (db) => `mongodb://127.0.0.1:${port}/${db}`;
    client = await MongoClient.connect(uri(source));
    stage = 'seed';
    const events = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
    assert(events.length > 0 && events.every((e) => e.source === 'hydro' && e.domainId === 'feedback-browser'));
    for (const e of events) e.recordedAt = new Date(e.recordedAt);
    const coll = client.db(source).collection('classroom.feedback.events');
    await coll.insertMany(events);
    await coll.createIndex({ domainId: 1, targetId: 1, eventType: 1, recordedAt: -1, _id: -1 }, { name: 'feedback_target' });
    const archive = path.join(temporary, 'feedback.archive');
    stage = 'dump';
    execFileSync('/root/.nix-profile/bin/mongodump', ['--uri', uri(source), `--archive=${archive}`, '--gzip'], { stdio: 'pipe' });
    stage = 'restore';
    execFileSync('/root/.nix-profile/bin/mongorestore', ['--uri', uri(''), `--archive=${archive}`, '--gzip',
        `--nsFrom=${source}.*`, `--nsTo=${restored}.*`], { stdio: 'pipe' });
    stage = 'compare';
    const clone = client.db(restored).collection('classroom.feedback.events');
    assert.deepEqual(await clone.find().sort({ _id: 1 }).toArray(), await coll.find().sort({ _id: 1 }).toArray());
    assert((await clone.listIndexes().toArray()).some((i) => i.name === 'feedback_target'));
    const keys = events.map((e) => e.requestId);
    assert.equal(new Set(keys).size, keys.length);
    console.log(JSON.stringify({ node: process.version, events: events.length,
        corrections: events.filter((e) => e.targetId).length, uniqueRequestKeys: keys.length,
        dateTypesPreserved: true, indexesPreserved: true, factsEqual: true, backupBytes: fs.statSync(archive).size }));
})().catch((error) => {
    console.error(`Isolated backup verification failed at ${stage}: ${error.name} (${error.code || error.status || 'no code'}).`);
    process.exitCode = 1;
}).finally(async () => {
    await client?.close();
    if (mongod && mongod.exitCode === null) {
        const stopped = new Promise((resolve) => mongod.once('exit', resolve));
        mongod.kill('SIGTERM');
        await stopped;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
});
