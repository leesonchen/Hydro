/// <reference lib="webworker" />
import { createPreviewRenderer } from './preview-renderer';

const render = createPreviewRenderer();
self.onmessage = ({ data: { revision, source, filePrefix, lecture } }) => {
  try {
    const html = render(source, filePrefix, lecture);
    // Bound the DOM work on the UI thread, even for adversarial formula output.
    if (html.length > 2_000_000) throw new Error('Preview too large');
    self.postMessage({ revision, html });
  } catch {
    self.postMessage({ revision, error: true });
  }
};
