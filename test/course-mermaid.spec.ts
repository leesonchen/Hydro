import assert from 'assert';
import { JSDOM } from 'jsdom';
import {
    describe, it,
} from 'node:test';
import fs from 'node:fs';
import { renderMermaidBlocks } from '../packages/ui-default/components/mermaid/render';

describe('course lecture Mermaid rendering', () => {
    it('keeps the diagram at native width so labels are not scaled down', () => {
        const style = fs.readFileSync('packages/ui-default/pages/course_lecture.page.styl', 'utf8');
        const page = fs.readFileSync('packages/ui-default/pages/course_lecture.page.ts', 'utf8');
        assert.match(style, /max-width:\s+none/);
        assert.match(style, /overflow-x:\s+auto/);
        assert.match(page, /fontSize:\s+'18px'/, 'Mermaid font size is configured in course_lecture.page.ts');
    });

    it('renders Mermaid code blocks and leaves other code blocks unchanged', async () => {
        const dom = new JSDOM(`
            <main id="lecture-main">
                <div class="code-toolbar">
                    <pre><code class="language-mermaid">graph TD\nA--&gt;B</code></pre>
                    <div class="toolbar"></div>
                </div>
                <pre><code class="language-js">const answer = 42;</code></pre>
            </main>
        `);
        const root = dom.window.document.querySelector('#lecture-main');
        assert(root);
        let boundElement: Element;
        await renderMermaidBlocks(root, {
            async render(_id, source, container) {
                assert.equal(source, 'graph TD\nA-->B');
                assert(container?.isConnected);
                return {
                    svg: '<svg height="120" viewBox="0 0 100 120"><text>diagram</text></svg>',
                    bindFunctions: (element) => { boundElement = element; },
                };
            },
        });

        const diagram = root.querySelector('.course-mermaid');
        assert(diagram);
        assert.equal(boundElement, diagram);
        assert.equal(diagram.querySelector('svg')?.hasAttribute('height'), false);
        assert.equal(root.querySelector('.code-toolbar'), null);
        assert.equal(root.querySelector('code.language-js')?.textContent, 'const answer = 42;');
        assert.equal(dom.window.document.querySelector('[aria-hidden="true"]'), null);
    });

    it('keeps source code visible when Mermaid rejects invalid syntax', async () => {
        const dom = new JSDOM(`
            <main id="lecture-main">
                <pre><code class="language-mermaid">not valid</code></pre>
            </main>
        `);
        const root = dom.window.document.querySelector('#lecture-main');
        assert(root);
        const expectedError = new Error('invalid diagram');
        let reportedError: unknown;
        await renderMermaidBlocks(root, {
            async render() { throw expectedError; },
        }, {
            errorMessage: 'Diagram error',
            onError: (error) => { reportedError = error; },
        });

        assert.equal(reportedError, expectedError);
        assert.equal(root.querySelector('code.language-mermaid')?.textContent, 'not valid');
        assert(root.querySelector('pre')?.hasAttribute('data-mermaid-error'));
        assert.equal(root.querySelector('.course-mermaid__error')?.textContent, 'Diagram error');
    });
});
