export interface MermaidRenderer {
  render: (
    id: string,
    source: string,
    container?: Element,
  ) => Promise<{ svg: string, bindFunctions?: (element: Element) => void }>;
}

export interface MermaidRenderOptions {
  errorMessage?: string;
  onError?: (error: unknown) => void;
}

let diagramSequence = 0;

function isMermaidCode(code: Element) {
  return Array.from(code.classList).some((name) => name.toLowerCase() === 'language-mermaid');
}

function getCodeBlockHost(pre: HTMLPreElement) {
  const parent = pre.parentElement;
  return parent?.classList.contains('code-toolbar') ? parent : pre;
}

/** Render Mermaid fenced code blocks inside a course lecture container. */
export async function renderMermaidBlocks(
  root: ParentNode,
  mermaid: MermaidRenderer,
  options: MermaidRenderOptions = {},
) {
  const blocks = Array.from(root.querySelectorAll('pre > code'))
    .filter(isMermaidCode)
    .filter((code) => !code.parentElement?.hasAttribute('data-mermaid-rendering'));
  if (!blocks.length) return;

  const document = blocks[0].ownerDocument;
  const staging = document.createElement('div');
  staging.setAttribute('aria-hidden', 'true');
  Object.assign(staging.style, {
    position: 'fixed',
    left: '-10000px',
    top: '-10000px',
    width: '1920px',
    visibility: 'hidden',
  });
  document.body.appendChild(staging);

  try {
    // Mermaid uses shared internal state, so render diagrams sequentially.
    for (const code of blocks) {
      const pre = code.parentElement as HTMLPreElement;
      pre.setAttribute('data-mermaid-rendering', '');
      const source = code.textContent || '';
      const id = `course-mermaid-${Date.now()}-${diagramSequence++}`;
      try {
        const { svg, bindFunctions } = await mermaid.render(id, source, staging);
        const diagram = document.createElement('div');
        diagram.className = 'course-mermaid';
        diagram.innerHTML = svg;
        diagram.querySelector('svg')?.removeAttribute('height');
        getCodeBlockHost(pre).replaceWith(diagram);
        bindFunctions?.(diagram);
      } catch (error) {
        pre.setAttribute('data-mermaid-error', '');
        const message = document.createElement('p');
        message.className = 'course-mermaid__error';
        message.textContent = options.errorMessage
          || 'Mermaid diagram could not be rendered. Source code is shown below.';
        getCodeBlockHost(pre).before(message);
        options.onError?.(error);
      }
    }
  } finally {
    staging.remove();
  }
}
