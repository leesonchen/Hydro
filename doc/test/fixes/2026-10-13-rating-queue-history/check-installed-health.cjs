const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
function docker(args) {
    const result = spawnSync('docker', ['exec', 'hydro', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'target container health command failed');
    return JSON.parse(result.stdout);
}
async function main() {
    // The image's PM2 lives in Nix and is not on the exec shell's PATH.
    const code = `const fs=require('fs'),{spawnSync}=require('child_process');
        const active=fs.readFileSync('/root/.hydro/dev-releases/active','utf8').trim();
        const pm2=fs.readFileSync('/proc/1/cmdline','utf8').split('\\0').find(p=>p.endsWith('/pm2/bin/pm2'));
        if(!pm2)throw Error('Cannot locate the target PM2 executable');
        const result=spawnSync(process.execPath,[pm2,'jlist'],{encoding:'utf8'});
        if(result.status!==0)throw Error('PM2 health command failed');
        const services=JSON.parse(result.stdout).map(p=>({name:p.name,status:p.pm2_env.status,restarts:p.pm2_env.restart_time}));
        console.log(JSON.stringify({active,hydrooj:JSON.parse(fs.readFileSync(active+'/node_modules/hydrooj/package.json')).version,uiDefault:JSON.parse(fs.readFileSync(active+'/node_modules/@hydrooj/ui-default/package.json')).version,services}));`;
    const packages = docker(['sh', '-lc', 'exec node -e "$1"', 'hydro-fix-health', code]);
    const { services } = packages;
    const response = await fetch('http://127.0.0.1:8082/');
    const result = { checkedAt: new Date().toISOString(), target: 'hydro', ...packages, services, http: response.status,
        scope: 'Read-only installed baseline health check. The source fixes have not been published or installed.' };
    fs.writeFileSync(path.join(__dirname, 'evidence/installed-health.json'), JSON.stringify(result, null, 2));
    assert.equal(result.hydrooj, '5.0.7-dev.6');
    assert.equal(result.uiDefault, '4.58.5-dev.7');
    assert.equal(result.http, 200);
    assert(services.every(p => p.status === 'online'));
    console.log(JSON.stringify(result));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
