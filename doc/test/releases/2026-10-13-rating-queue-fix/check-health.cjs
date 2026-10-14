const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const phase = process.argv[2];
if (!['before', 'after', 'final', 'stopped', 'installed'].includes(phase)) throw Error('Use before, installed, after, final or stopped');
const originalInstallation = ['before', 'stopped'].includes(phase);
const expected = originalInstallation ? ['5.0.7-dev.6', '4.58.5-dev.7'] : ['5.0.7-dev.7', '4.58.5-dev.8'];
async function main() {
    const code = `const fs=require('fs'),{spawnSync}=require('child_process'),crypto=require('crypto');
        const active=fs.readFileSync('/root/.hydro/dev-releases/active','utf8').trim();
        const pm2=fs.readFileSync('/proc/1/cmdline','utf8').split('\\0').find(p=>p.endsWith('/pm2/bin/pm2'));
        if(!pm2)throw Error('PM2 executable unavailable');
        const result=spawnSync(process.execPath,[pm2,'jlist'],{encoding:'utf8'});
        if(result.status!==0)throw Error('PM2 health command failed');
        const services=JSON.parse(result.stdout).map(p=>({name:p.name,status:p.pm2_env.status,restarts:p.pm2_env.restart_time,pid:p.pid,
            title:p.name==='hydrooj'?fs.readFileSync('/proc/'+p.pid+'/cmdline','utf8').split('\\0')[0]:undefined}));
        const files=['hydrooj/src/model/rating-publication.ts','@hydrooj/ui-default/templates/partials/contest_time_history.html'];
        const hashes=Object.fromEntries(files.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(active+'/node_modules/'+file)).digest('hex')]));
        console.log(JSON.stringify({active,hydrooj:JSON.parse(fs.readFileSync(active+'/node_modules/hydrooj/package.json')).version,
            uiDefault:JSON.parse(fs.readFileSync(active+'/node_modules/@hydrooj/ui-default/package.json')).version,services,hashes}));`;
    const command = spawnSync('docker', ['exec', 'hydro', 'sh', '-lc', 'exec node -e "$1"', 'hydro-approved-release-health', code], { encoding: 'utf8' });
    assert.equal(command.status, 0, 'container health command failed');
    const installed = JSON.parse(command.stdout);
    const response = await fetch('http://127.0.0.1:8082/');
    const login = await fetch('http://127.0.0.1:8082/d/exam/login');
    const health = { phase, checkedAt: new Date().toISOString(), target: 'hydro', ...installed, http: response.status, loginHttp: login.status };
    fs.writeFileSync(path.join(__dirname, 'evidence', `health-${phase}.json`), JSON.stringify(health, null, 2));
    assert.equal(health.hydrooj, expected[0]); assert.equal(health.uiDefault, expected[1]);
    assert.equal(health.http, 200); assert.equal(health.loginHttp, 200);
    assert(health.services.every(p => p.status === 'online'));
    if (phase !== 'installed') assert(health.services.find(p => p.name === 'hydrooj').title.includes('v' + expected[0]));
    if (!originalInstallation) {
        for (const [file, actual] of Object.entries(health.hashes)) {
            const source = path.join(__dirname, '../../../..', 'packages', file.replace(/^@hydrooj\//, ''));
            const hash = require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex');
            assert.equal(actual, hash, 'active package must contain the approved source fix');
        }
    }
    console.log(JSON.stringify(health));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
