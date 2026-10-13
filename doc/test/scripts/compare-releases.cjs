#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = Object.fromEntries(process.argv.slice(2).reduce((rows, value, i, all) => {
    if (value.startsWith('--')) rows.push([value.slice(2), all[i + 1]]);
    return rows;
}, []));
if (!args.container || !args.previous || !args.current || !args.out) {
    console.error('Usage: node compare-releases.cjs --container hydro --previous /absolute/release --current /absolute/release --out evidence.json [--export-text /tmp/directory]');
    process.exit(2);
}
const snapshotCode = String.raw`
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const release=process.argv[1];
const packages=['hydrooj','@hydrooj/ui-default','@hydrooj/framework','@hydrooj/common'];
const text=process.argv[2]==='true';
const result={release,packages:{}};
for(const name of packages){
 const root=path.join(release,'node_modules',name);
 if(!fs.existsSync(root))continue;
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const files={};const texts={};
 function walk(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
  if(entry.name==='node_modules'||entry.name==='.git')continue;
  const absolute=path.join(folder,entry.name);const relative=path.relative(root,absolute).split(path.sep).join('/');
  if(entry.isDirectory()){walk(absolute);continue;}if(!entry.isFile())continue;
  const value=fs.readFileSync(absolute);files[relative]={sha256:crypto.createHash('sha256').update(value).digest('hex'),bytes:value.length};
  if(text&&value.length<524288&&/^(src|templates|pages|components|styles|utils|lang|bin|locales|backendlib|misc|theme)\//.test(relative)&&/\.(ts|tsx|js|jsx|json|yaml|yml|njk|html|styl|md)$/.test(relative))texts[relative]=value.toString('utf8');
 }}walk(root);
 result.packages[name]={version:manifest.version,gitHead:manifest.gitHead||null,dependencies:manifest.dependencies||{},files,texts};
}console.log(JSON.stringify(result));`;
function snapshot(release) {
    const result = spawnSync('docker', ['exec', args.container, 'sh', '-lc', 'exec node -e "$1" "$2" "$3"', 'hydro-release-compare', snapshotCode, release, String(!!args['export-text'])], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`Unable to inspect release ${release}: ${(result.stderr || '').slice(0, 300)}`);
    return JSON.parse(result.stdout);
}
const previous = snapshot(args.previous);
const current = snapshot(args.current);
const changes = {};
for (const name of new Set([...Object.keys(previous.packages), ...Object.keys(current.packages)])) {
    const before = previous.packages[name] || { files: {}, dependencies: {} };
    const after = current.packages[name] || { files: {}, dependencies: {} };
    const changed = [];
    for (const file of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
        if (before.files[file]?.sha256 === after.files[file]?.sha256) continue;
        changed.push({ file, kind: !before.files[file] ? 'added' : !after.files[file] ? 'removed' : 'modified', before: before.files[file] || null, after: after.files[file] || null });
        if (args['export-text']) {
            for (const [label, info] of [['previous', before], ['current', after]]) {
                if (!Object.hasOwn(info.texts || {}, file)) continue;
                const target = path.join(args['export-text'], label, name, file);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, info.texts[file]);
            }
        }
    }
    const dependencies = [];
    for (const dep of new Set([...Object.keys(before.dependencies), ...Object.keys(after.dependencies)])) {
        if (before.dependencies[dep] !== after.dependencies[dep]) dependencies.push({ name: dep, before: before.dependencies[dep] || null, after: after.dependencies[dep] || null });
    }
    changes[name] = { previous: before.version || null, current: after.version || null, dependencies, files: changed.sort((a, b) => a.file.localeCompare(b.file)) };
    delete previous.packages[name]?.texts;
    delete current.packages[name]?.texts;
}
const output = { capturedAt: new Date().toISOString(), container: args.container, previous, current, changes };
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(changes).map(([name, info]) => [name, { previous: info.previous, current: info.current, files: info.files.length, added: info.files.filter(f => f.kind === 'added').length, removed: info.files.filter(f => f.kind === 'removed').length, dependencies: info.dependencies }]))));
