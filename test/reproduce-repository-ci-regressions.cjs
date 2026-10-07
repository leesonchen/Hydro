// Read-only baseline preload for the production-source regression assertions.
// node --require ./test/reproduce-repository-ci-regressions.cjs --test test/repository-ci-regressions.spec.js
// Expected exit 1: historical audit and long-text defects remain in the baseline.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const original = fs.readFileSync;
const root = path.resolve(__dirname, '..');
const ref = 'f8eb9da8ae3fad9c1dd569d9219dc796abe9471f';
const sources = new Map([
    'packages/url-audit/index.ts',
    'packages/xxwl-review/index.ts',
    'packages/hydrooj/src/builtin/course-management/handler/class.ts',
    'packages/ai-assistant/index.ts',
    'packages/hydrooj/bin/hydro-maintenance.js',
].map((file) => [path.join(root, file).toLowerCase(), file]));
fs.readFileSync = function (file, ...args) {
    const source = typeof file === 'string' && sources.get(file.toLowerCase());
    if (source) return execFileSync('git', ['show', ref + ':' + source], { cwd: root, encoding: 'utf8' });
    return original.call(this, file, ...args);
};
