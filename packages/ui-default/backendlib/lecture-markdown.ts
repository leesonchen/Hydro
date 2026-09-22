/** A pasted whole lecture sometimes includes the answer's outer Markdown fence.
 * Only unwrap a complete wrapper containing both a heading and a Mermaid fence;
 * ordinary Markdown examples and other code fences keep their original meaning.
 * This affects presentation only, never the stored lecture or editor value.
 */
export function normalizeLectureMarkdown(source: string): string {
  const match = source.match(/^\s*(`{3,}|~{3,})(?:markdown|md)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*\s*$/i);
  if (!match || !/^#{1,6} /m.test(match[2]) || !/^[ \t]*(`{3,}|~{3,})mermaid[ \t]*\r?$/im.test(match[2])) return source;
  return match[2];
}
