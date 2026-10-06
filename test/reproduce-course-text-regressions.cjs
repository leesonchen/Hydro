// Read the pre-fix commit only; terminate pathological matchers before they hang the runner.
const { Worker } = require('node:worker_threads');
const ref = process.argv[2] || '6ecad262c152ba00300a411461f85380bc8107ae';
const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { execFileSync } = require('node:child_process');
    const vm = require('node:vm');
    const ts = require('typescript');
    const read = (file) => execFileSync('git', ['show', workerData.ref + ':' + file], { cwd: workerData.root, encoding: 'utf8' });
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(read('packages/ui-default/backendlib/lecture-markdown.ts'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS }
    }).outputText, { module, exports: module.exports });
    const source = read('packages/ui-default/components/highlighter/prismjs.js');
    const start = source.indexOf('function getSampleInputCode(');
    const end = source.indexOf('function createSampleInputButton(', start);
    if (start < 0 || end < 0) throw new Error('Choose a baseline with the original sample matcher');
    const sample = vm.runInNewContext(source.slice(start, end) + '; getSampleInputCode');
    parentPort.postMessage('ready');
    parentPort.once('message', () => {
        const at = Date.now();
        if (workerData.kind === 'lecture') module.exports.normalizeLectureMarkdown('\\x60\\x60\\x60markdown\\n# Heading\\n\\x60\\x60\\x60mermaid\\ngraph TD\\nA-->B\\n\\x60\\x60\\x60\\n\\x60\\x60\\x60' + ' '.repeat(100000) + 'X');
        else sample({ code: 'input', element: { className: '', parentElement: { previousElementSibling: { textContent: 'Sample input' + ' '.repeat(100000) + 'X' } } } });
        parentPort.postMessage({ kind: workerData.kind, milliseconds: Date.now() - at });
    });
`;
(async () => {
    for (const kind of ['lecture', 'sample']) {
        const worker = new Worker(workerCode, { eval: true, workerData: { root: process.cwd(), ref, kind } });
        let timer;
        try {
            await new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Baseline worker did not start')), 15000);
                worker.on('error', reject);
                worker.on('message', (message) => {
                    clearTimeout(timer);
                    if (message === 'ready') {
                        worker.postMessage('run');
                        timer = setTimeout(() => { console.log(JSON.stringify({ ref, kind, exceededMilliseconds: 2000 })); resolve(); }, 2000);
                    } else { console.log(JSON.stringify({ ref, ...message })); resolve(); }
                });
            });
        } finally { clearTimeout(timer); await worker.terminate(); }
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
