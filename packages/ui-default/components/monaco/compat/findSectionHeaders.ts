interface ISectionHeaderFinderTarget {
  getLineCount(): number;
  getLineContent(lineNumber: number): string;
}

interface FindSectionHeaderOptions {
  foldingRules?: {
    markers?: {
      start: RegExp;
    };
  };
  findRegionSectionHeaders: boolean;
  findMarkSectionHeaders: boolean;
}

interface SectionHeader {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  text: string;
  hasSeparatorLine: boolean;
  shouldBeInComments: boolean;
}

// Keep this Monaco worker module compatible with browsers that do not support
// RegExp match indices (`/d`), such as older Chrome versions.
const markRegex = /\bMARK:\s*(.*)$/;
const trimDashesRegex = /^-+|-+$/g;

export function findSectionHeaders(model: ISectionHeaderFinderTarget, options: FindSectionHeaderOptions): SectionHeader[] {
  let headers: SectionHeader[] = [];
  if (options.findRegionSectionHeaders && options.foldingRules?.markers) {
    headers = headers.concat(collectRegionHeaders(model, options));
  }
  if (options.findMarkSectionHeaders) {
    headers = headers.concat(collectMarkHeaders(model));
  }
  return headers;
}

function collectRegionHeaders(model: ISectionHeaderFinderTarget, options: FindSectionHeaderOptions): SectionHeader[] {
  const regionHeaders: SectionHeader[] = [];
  const endLineNumber = model.getLineCount();
  for (let lineNumber = 1; lineNumber <= endLineNumber; lineNumber++) {
    const lineContent = model.getLineContent(lineNumber);
    const match = lineContent.match(options.foldingRules!.markers!.start);
    if (!match) continue;
    const range = {
      startLineNumber: lineNumber,
      startColumn: match[0].length + 1,
      endLineNumber: lineNumber,
      endColumn: lineContent.length + 1,
    };
    if (range.endColumn <= range.startColumn) continue;
    const sectionHeader = {
      range,
      ...getHeaderText(lineContent.substring(match[0].length)),
      shouldBeInComments: false,
    };
    if (sectionHeader.text || sectionHeader.hasSeparatorLine) regionHeaders.push(sectionHeader);
  }
  return regionHeaders;
}

function collectMarkHeaders(model: ISectionHeaderFinderTarget): SectionHeader[] {
  const markHeaders: SectionHeader[] = [];
  const endLineNumber = model.getLineCount();
  for (let lineNumber = 1; lineNumber <= endLineNumber; lineNumber++) {
    addMarkHeaderIfFound(model.getLineContent(lineNumber), lineNumber, markHeaders);
  }
  return markHeaders;
}

function addMarkHeaderIfFound(lineContent: string, lineNumber: number, sectionHeaders: SectionHeader[]) {
  const match = markRegex.exec(lineContent);
  if (!match) return;
  const headerText = match[1];
  const column = match.index + match[0].length - headerText.length + 1;
  const endColumn = column + headerText.length;
  const range = { startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn };
  if (range.endColumn <= range.startColumn) return;
  const sectionHeader = {
    range,
    ...getHeaderText(headerText),
    shouldBeInComments: true,
  };
  if (sectionHeader.text || sectionHeader.hasSeparatorLine) sectionHeaders.push(sectionHeader);
}

function getHeaderText(text: string): { text: string; hasSeparatorLine: boolean } {
  text = text.trim();
  const hasSeparatorLine = text.startsWith('-');
  text = text.replace(trimDashesRegex, '');
  return { text, hasSeparatorLine };
}
