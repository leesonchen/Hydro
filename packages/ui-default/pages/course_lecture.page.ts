import $ from 'jquery';
import { renderMermaidBlocks } from 'vj/components/mermaid/render';
import { NamedPage } from 'vj/misc/Page';
import { getTheme, i18n } from 'vj/utils';

const lectureRootSelector = '#lecture-main, .md-editor-preview';
let mermaidPromise: Promise<typeof import('mermaid').default>;

function getMermaid() {
  mermaidPromise ||= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: getTheme() === 'dark' ? 'dark' : 'default',
      // Keep labels readable when a diagram is wider than the article. The
      // wrapper provides horizontal scrolling instead of shrinking the whole
      // SVG to fit the content column.
      flowchart: {
        useMaxWidth: false,
      },
      themeVariables: {
        fontSize: '18px',
      },
      // Mermaid measures HTML labels before moving the SVG into the article.
      // Keep .typo / editor paragraph padding and line-height from changing
      // those measurements afterwards and clipping text in foreignObject.
      // Mermaid scopes themeCSS to this SVG, including the measurement stage.
      themeCSS: `
        foreignObject p {
          margin: 0;
          padding: 0;
          line-height: inherit;
        }
      `,
    });
    return mermaid;
  });
  return mermaidPromise;
}

function findLectureRoots(target: ParentNode) {
  const roots: Element[] = [];
  if (target instanceof Element && target.matches(lectureRootSelector)) roots.push(target);
  roots.push(...Array.from(target.querySelectorAll(lectureRootSelector)));
  return roots;
}

async function renderLectureMermaid(target: ParentNode) {
  const roots = findLectureRoots(target)
    .filter((root) => root.querySelector('pre > code.language-mermaid'));
  if (!roots.length) return;
  const mermaid = await getMermaid();
  for (const root of roots) await renderMermaidBlocks(root, mermaid, {
    errorMessage: i18n('Mermaid diagram could not be rendered. Source code is shown below.'),
    onError: (error) => console.warn('Failed to render Mermaid diagram', error),
  });
}

function wrapLectureTables(target: ParentNode) {
  const roots: Element[] = [];
  if (target instanceof Element && target.id === 'lecture-main') roots.push(target);
  roots.push(...Array.from(target.querySelectorAll('#lecture-main')));
  for (const root of roots) {
    root.querySelectorAll(':scope > table').forEach((table) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'course-lecture-table-scroll';
      table.replaceWith(wrapper);
      wrapper.append(table);
    });
  }
}

export default new NamedPage(['course_lecture', 'contest_manage'], async () => {
  if (!document.querySelector('#lecture-main, textarea[name="lecture"]')) return;
  wrapLectureTables(document);
  const render = (target: ParentNode) => renderLectureMermaid(target)
    .catch((error) => console.warn('Failed to load Mermaid renderer', error));
  $(document).on('vjContentNew.courseMermaid', (event) => {
    wrapLectureTables(event.target as ParentNode);
    void render(event.target as ParentNode);
  });
  await render(document);
});
