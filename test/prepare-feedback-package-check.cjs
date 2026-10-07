// Pack local copies only. No registry, version bump, publish, or installed app change.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(repo, '.cache/feedback-package-check-'));
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const versions = Object.fromEntries([
    ['@hydrooj/common', 'packages/common'], ['@hydrooj/framework', 'framework/framework'],
    ['@hydrooj/utils', 'framework/utils'], ['@hydrooj/register', 'framework/register'],
].map(([name, directory]) => [name, require(path.join(repo, directory, 'package.json')).version]));
const packages = [];
for (const [name, directory, required] of [
    ['hydrooj', 'packages/hydrooj', ['bin/hydrooj.js', 'src/model/classroomFeedback.ts',
        'src/handler/classroom-feedback.ts', 'src/builtin/course-management/model/structure.ts',
        'src/script/course-feedback-structure.ts']],
    ['@hydrooj/ui-default', 'packages/ui-default', ['templates/classroom_feedback.html',
        'templates/partials/scoreboard.html', 'templates/course_manage.html', 'public/manifest.json']],
]) {
    const source = path.join(root, 'source', name);
    fs.cpSync(path.join(repo, directory), source, {
        recursive: true, filter: (entry) => path.basename(entry) !== 'node_modules',
    });
    const metaFile = path.join(source, 'package.json');
    const meta = JSON.parse(fs.readFileSync(metaFile));
    for (const dependencies of [meta.dependencies, meta.devDependencies, meta.peerDependencies]) {
        for (const dependency in dependencies || {}) {
            if (dependencies[dependency].startsWith('workspace:')) {
                assert(versions[dependency], dependency);
                dependencies[dependency] = versions[dependency];
            }
        }
    }
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    const [packed] = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts',
        '--offline', '--json', '--pack-destination', root], { cwd: source, encoding: 'utf8' }));
    const files = new Set(packed.files.map((file) => file.path));
    assert(![...files].some((file) => /(^|\/)\.env($|\.)|(^|\/)\.cache\/|(^|\/)node_modules\//.test(file)));
    const destination = path.join(root, 'node_modules', name);
    fs.mkdirSync(destination, { recursive: true });
    const archive = path.join(root, packed.filename);
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', destination]);
    if (name === '@hydrooj/ui-default') {
        required.push('public/hydro-' + meta.version + '.js', 'public/theme-' + meta.version + '.css');
        const manifest = JSON.parse(fs.readFileSync(path.join(destination, 'public/manifest.json')));
        // The production build deliberately removes source maps after emitting its manifest.
        for (const asset of Object.values(manifest)) {
            const file = asset.replace(/^\//, '').split('?')[0];
            if (!file.endsWith('.map')) assert(files.has('public/' + file), asset);
        }
    }
    for (const file of required) assert(files.has(file), name + '/' + file);
    let locales = 0;
    const localeDirectory = path.join(destination, 'locales');
    if (fs.existsSync(localeDirectory)) for (const file of fs.readdirSync(localeDirectory).filter((item) => item.endsWith('.yaml'))) {
        yaml.load(fs.readFileSync(path.join(localeDirectory, file), 'utf8'));
        locales++;
    }
    packages.push({ name, version: meta.version, files: files.size, locales, size: packed.size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), required });
}
fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify({ packages, published: false, installed: false }, null, 2));
console.log('FEEDBACK_PACKAGE_ROOT=' + root);
console.log('FEEDBACK_PACKAGE_RESULT=' + JSON.stringify({ packages, published: false, installed: false }));
