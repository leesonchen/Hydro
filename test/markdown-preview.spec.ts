import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { normalizeLectureMarkdown } from '../packages/ui-default/backendlib/lecture-markdown';
import { AsyncPreview } from '../packages/ui-default/components/editor/async-preview';
import { createPreviewRenderer } from '../packages/ui-default/components/editor/preview-renderer';

test('wrapped CRLF lecture renders headings and Mermaid without altering normal code examples', () => {
    const body = '# 计算机\r\n\r\n```mermaid\r\ngraph TD\r\nA-->B\r\n```';
    const wrapped = `\x60\x60\x60markdown\r\n${body}\r\n\x60\x60\x60`;
    assert.equal(normalizeLectureMarkdown(wrapped), body);
    const render = createPreviewRenderer();
    const html = render(wrapped, '../file/', true);
    assert.match(html, /<h1/);
    assert.match(html, /language-mermaid/);
    const example = '```markdown\n# Heading example\n```';
    assert.equal(normalizeLectureMarkdown(example), example);
    assert.equal(normalizeLectureMarkdown(body), body);
});

test('worker renderer keeps formulas, links, code and XSS protection on long input', () => {
    const render = createPreviewRenderer();
    const source = '# Heading\n\nParagraph **bold** $a+b$\n\n'.repeat(600)
        + '![attachment](file://figure.png)\n<script>alert(1)</script><img src=x onerror=alert(2)>';
    assert(source.length > 10000);
    const html = render(source, '../file/');
    assert.match(html, /katex/);
    assert.match(html, /src="\.\.\/file\/figure.png"/);
    assert.doesNotMatch(html, /<script|\sonerror=/);
});

class FakeWorker {
    onmessage: any;
    onerror: any;
    sent: any[] = [];
    terminated = false;
    postMessage(message: any) { this.sent.push(message); }
    terminate() { this.terminated = true; }
    reply(index: number, html: string) {
        this.onmessage({ data: { revision: this.sent[index].revision, html } });
    }
}

test('preview coalesces typing, discards stale results, and renders only the latest draft', async () => {
    const worker = new FakeWorker();
    let updates = 0;
    const preview = new AsyncPreview(() => worker, () => { updates++; }, { errorHtml: 'error', delay: 1 });
    try {
        preview.render('first');
        await delay(10);
        for (let i = 0; i < 100; i++) preview.render(`draft ${i}`);
        await delay(10);
        assert.equal(worker.sent.length, 1);
        worker.reply(0, 'stale');
        assert.equal(updates, 0);
        assert.equal(worker.sent.length, 2);
        assert.equal(worker.sent[1].source, 'draft 99');
        worker.reply(1, '<p>latest</p>');
        assert.equal(updates, 1);
        assert.equal(preview.render('draft 99'), '<p>latest</p>');
        await delay(10);
        assert.equal(worker.sent.length, 2, 'rerender must not schedule an infinite render loop');
    } finally {
        preview.dispose();
    }
    assert(worker.terminated);
});

test('a hung parser is terminated; a new draft can recover', async () => {
    const workers: FakeWorker[] = [];
    let updates = 0;
    const preview = new AsyncPreview(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
    }, () => { updates++; }, { errorHtml: 'timeout', delay: 1, timeout: 20 });
    try {
        preview.render('slow');
        await delay(50);
        assert(workers[0].terminated);
        assert.equal(preview.render('slow'), 'timeout');
        assert.equal(updates, 1);
        preview.render('recovered');
        await delay(5);
        workers[1].reply(0, 'ok');
        assert.equal(preview.render('recovered'), 'ok');
    } finally {
        preview.dispose();
    }
});
