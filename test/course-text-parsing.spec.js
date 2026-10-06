const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { Worker } = require('node:worker_threads');
const { JSDOM } = require('jsdom');
require('@hydrooj/register');
const { normalizeLectureMarkdown } = require('../packages/ui-default/backendlib/lecture-markdown');
const { getSampleInputCode } = require('../packages/ui-default/components/highlighter/sample-input');

test('complete lecture wrappers preserve body bytes with LF, CRLF, backticks and tildes', () => {
    for (const newline of ['\n', '\r\n']) for (const fence of ['```', '~~~~']) {
        const body = ['# Heading', '', '```mermaid', 'graph TD', 'A-->B', '```', '', '  trailing body  '].join(newline);
        for (const language of ['md', 'markdown', 'MARKDOWN']) {
            const source = ` \t${newline}${fence}${language}\t${newline}${body}${newline}${fence} \t${newline}`;
            assert.equal(normalizeLectureMarkdown(source), body);
        }
    }
});

test('ordinary examples and incomplete or mismatched lecture wrappers stay unchanged', () => {
    for (const source of [
        '```markdown\n# Heading\n```',
        '```markdown\n```mermaid\nA-->B\n```\n```',
        '````markdown\n# Heading\n```mermaid\nA-->B\n```',
        '```markdown\n# Heading\n```mermaid\nA-->B\n```\n~~~~',
        '```markdown\n# Heading\n```mermaid\nA-->B\n```\n ```',
        '```javascript\n# Heading\n```mermaid\nA-->B\n```\n```',
        '```markdown\n# Heading\n```mermaid\nA-->B\n```\n```\nremaining text',
        '# Heading\n```mermaid\nA-->B\n```',
    ]) assert.equal(normalizeLectureMarkdown(source), source);
});

function sample(input, output, wrapped = false) {
    const dom = new JSDOM('<main></main>');
    const main = dom.window.document.querySelector('main');
    const heading = dom.window.document.createElement('h3');
    heading.textContent = input;
    main.append(heading);
    const pre = dom.window.document.createElement('pre');
    const code = dom.window.document.createElement('code');
    code.textContent = '1 2\n3 4';
    pre.append(code);
    const block = wrapped ? dom.window.document.createElement('div') : pre;
    if (wrapped) { block.className = 'code-toolbar'; block.append(pre); }
    main.append(block);
    const outHeading = dom.window.document.createElement('h3');
    outHeading.textContent = output;
    const outBlock = dom.window.document.createElement('pre');
    main.append(outHeading, outBlock);
    return { element: code, code: code.textContent };
}

test('sample input headings support Chinese, English, optional hashes, whitespace and toolbar wrappers', () => {
    for (const [input, output] of [
        ['输入1', '输出1'], [' input #1 ', ' Output #1 '],
        ['Sample\tinput\t#\t01', 'SAMPLE OUTPUT 01'], ['输入 # 2', 'sample output # 2'],
    ]) for (const wrapped of [false, true]) {
        const env = sample(input, output, wrapped);
        assert.equal(getSampleInputCode(env), env.code);
    }
});

test('sample input recognition retains exact numbering and requires the matching output block', () => {
    for (const [input, output] of [
        ['输入01', '输出1'], ['input 1', 'output 2'], ['input 1X', 'output 1'],
        ['input ##1', 'output 1'], ['example input 1', 'output 1'], ['input #', 'output #'],
    ]) assert.equal(getSampleInputCode(sample(input, output)), null);
    const env = sample('input 1', 'output 1');
    env.element.parentElement.nextElementSibling.nextElementSibling.remove();
    assert.equal(getSampleInputCode(env), null);
});

test('explicit input language classes still work and reject unsafe numeric IDs', () => {
    const env = sample('Other heading', 'Other heading');
    env.element.className = 'language-input1 line-numbers';
    assert.equal(getSampleInputCode(env), env.code);
    env.element.className = 'language-input999999999999999999999';
    assert.equal(getSampleInputCode(env), null);
});

test('long malformed spaces and digits finish in a terminable isolated worker', { timeout: 15000 }, async () => {
    const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const assert = require('node:assert/strict');
        require('@hydrooj/register');
        const normalize = require(workerData.root + '/packages/ui-default/backendlib/lecture-markdown').normalizeLectureMarkdown;
        const sample = require(workerData.root + '/packages/ui-default/components/highlighter/sample-input').getSampleInputCode;
        parentPort.postMessage('ready');
        parentPort.once('message', () => {
            for (const size of [10000, 100000]) {
                const lecture = '\\x60\\x60\\x60markdown\\n# Heading\\n\\x60\\x60\\x60mermaid\\ngraph TD\\nA-->B\\n\\x60\\x60\\x60\\n\\x60\\x60\\x60' + ' '.repeat(size) + 'X';
                assert.equal(normalize(lecture), lecture);
                for (const suffix of [' '.repeat(size) + 'X', '9'.repeat(size) + 'X']) {
                    const pre = { previousElementSibling: { textContent: 'Sample input' + suffix } };
                    assert.equal(sample({ element: { className: '', parentElement: pre }, code: 'input' }), null);
                }
            }
            parentPort.postMessage('done');
        });
    `, { eval: true, workerData: { root: path.resolve(__dirname, '..') } });
    let deadline;
    try {
        await new Promise((resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('Text worker did not start')), 10000);
            worker.on('error', reject);
            worker.on('message', (message) => {
                clearTimeout(deadline);
                if (message === 'ready') {
                    deadline = setTimeout(() => reject(new Error('Text parsing exceeded 2000ms')), 2000);
                    worker.postMessage('run');
                } else resolve();
            });
        });
    } finally {
        clearTimeout(deadline);
        await worker.terminate();
    }
});
