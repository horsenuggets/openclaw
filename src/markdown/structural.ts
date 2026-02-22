// Lines that represent structural boundaries — splitting before
// these is preferred over splitting mid-paragraph.
export const STRUCTURAL_RE = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/;
export const TABLE_ROW_RE = /^\s*\|/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

export function isStructuralBoundary(line: string): boolean {
  return STRUCTURAL_RE.test(line);
}

export function isTableRow(line: string): boolean {
  return TABLE_ROW_RE.test(line);
}

export function isFenceOpener(line: string): boolean {
  return FENCE_OPEN_RE.test(line);
}
