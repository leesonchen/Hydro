import MarkdownIt from 'markdown-it';
import Anchor from 'markdown-it-anchor';
import Footnote from 'markdown-it-footnote';
import Mark from 'markdown-it-mark';
import TOC from 'markdown-it-table-of-contents';
import { normalizeLectureMarkdown } from '../../backendlib/lecture-markdown';
import Imsize from '../../backendlib/markdown-it-imsize';
import katex from '../../backendlib/markdown-it-katex';
import { Media } from '../../backendlib/markdown-it-media';
import { xssProtector } from '../../backendlib/markdown-it-xss';

// Keep untrusted Markdown under the same sanitizer as the existing editor.
export function createPreviewRenderer() {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true });
  for (const tld of ['.py', '.zip', '.mov']) md.linkify.tlds(tld, false);
  md.use(Media).use(Footnote).use(Mark).use(Imsize).use(Anchor).use(TOC).use(xssProtector).use(katex);
  return (source: string, filePrefix?: string, lecture = false) => {
    let text = lecture ? normalizeLectureMarkdown(source) : source;
    if (filePrefix) text = text.replace(/file:\/\//g, () => filePrefix);
    return md.render(text);
  };
}
