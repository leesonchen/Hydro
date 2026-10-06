/**
 * A pasted whole lecture sometimes includes the answer's outer Markdown fence.
 * Only unwrap a complete wrapper containing both a heading and a Mermaid fence;
 * ordinary Markdown examples and other code fences keep their original meaning.
 * This affects presentation only, never the stored lecture or editor value.
 */
export function normalizeLectureMarkdown(source: string): string {
  const wrapped = source.trim();
  const firstBreak = wrapped.indexOf('\n');
  const lastBreak = wrapped.lastIndexOf('\n');
  if (firstBreak < 0 || lastBreak === firstBreak) return source;
  const opening = wrapped.slice(0, firstBreak).replace(/\r$/, '')
    .match(/^(`{3,}|~{3,})(?:markdown|md)[ \t]*$/i);
  if (!opening || wrapped.slice(lastBreak + 1) !== opening[1]) return source;
  const bodyEnd = wrapped[lastBreak - 1] === '\r' ? lastBreak - 1 : lastBreak;
  const body = wrapped.slice(firstBreak + 1, bodyEnd);
  if (!/^#{1,6} /m.test(body) || !/^[ \t]*(?:`{3,}|~{3,})mermaid[ \t]*\r?$/im.test(body)) return source;
  return body;
}
