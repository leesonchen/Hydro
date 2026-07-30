import assert from 'assert';
import MarkdownIt from 'markdown-it';
import {
    describe, it,
} from 'node:test';
import { Media } from '../packages/ui-default/backendlib/markdown-it-media';

function renderInline(source: string) {
    (global as any).Hydro = { module: { richmedia: {} } };
    const md = new MarkdownIt();
    md.use(Media);
    return md.renderInline(source);
}

describe('markdown rich media', () => {
    it('does not turn a media service name into event attributes', () => {
        const output = renderInline('@[x onmouseover=alert(1)](safe)');
        assert.doesNotMatch(output, /\sonmouseover=/i);
        assert.match(output, /data-xonmouseoveralert1/);
    });

    it('blocks unsafe PDF URL schemes', () => {
        for (const source of ['@[pdf](javascript:alert)', '@[pdf](//attacker.example/file.pdf)']) {
            assert.equal(renderInline(source), '<p>Embedding this PDF URL is not supported.</p>');
        }
    });

    it('combines existing PDF and viewer fragments', () => {
        const output = renderInline('@[pdf](manual.pdf#page=2)');
        assert.match(output, /manual\.pdf\?noDisposition=1#page=2&amp;toolbar=1&amp;navpanes=0&amp;view=FitH/);
        assert.doesNotMatch(output, /#page=2#toolbar=/);
    });
});
