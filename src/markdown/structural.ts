// Lines that represent structural boundaries — splitting before
// these is preferred over splitting mid-paragraph.
export const STRUCTURAL_RE = /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/;

export function isStructuralBoundary(line: string): boolean {
  return STRUCTURAL_RE.test(line);
}
