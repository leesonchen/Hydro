const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { before, after, describe } = require('node:test');
const { MongoMemoryServer } = require('mongodb-memory-server');

require('@hydrooj/register');
process.env.CI = 'true';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-assessment-test-'));
const homedir = os.homedir;
os.homedir = () => path.join(profile, 'home');
fs.mkdirSync(os.homedir());
process.env.HYDRO_PROFILE = profile;
fs.writeFileSync(path.join(profile, 'config.json'), '{}');
fs.writeFileSync(path.join(profile, 'addon.json'), '[]');
const instances = [];
const create = MongoMemoryServer.create;
MongoMemoryServer.create = async function (...args) {
    const instance = await create.apply(this, args);
    instances.push(instance);
    return instance;
};

describe('Classroom assessment runtime', () => {
    before(async () => {
        const probe = net.createServer();
        await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
        const port = probe.address().port;
        await new Promise((resolve) => probe.close(resolve));
        process.argv.push(`--port=${port}`, '--host=127.0.0.1');
        await new Promise((resolve) => {
            process.send = (value) => { if (value === 'ready') resolve(); return true; };
            require('hydrooj/bin/hydrooj');
        });
    }, { timeout: 180000 });
    require('./classroom-assessment-access.integration').register();
    after(async () => {
        if (global.app?.get('db')) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await global.app.parallel('app/exit');
            await global.app.root.fiber.dispose();
        }
        MongoMemoryServer.create = create;
        await Promise.all(instances.map((instance) => instance.stop()));
        os.homedir = homedir;
        fs.rmSync(profile, { recursive: true, force: true });
        process.stdin.pause();
    });
});
