import type { MarkdownTableMode } from "../config/types.base.js";
import { markdownToIRWithMeta } from "./ir.js";
import { renderMarkdownWithMarkers } from "./render.js";
import { TABLE_ROW_RE } from "./structural.js";

const MARKDOWN_STYLE_MARKERS = {
  bold: { open: "**", close: "**" },
  italic: { open: "_", close: "_" },
  strikethrough: { open: "~~", close: "~~" },
  code: { open: "`", close: "`" },
  code_block: { open: "```\n", close: "```" },
} as const;

export function convertMarkdownTables(markdown: string, mode: MarkdownTableMode): string {
  if (!markdown || mode === "off") {
    return markdown;
  }
  const { ir, hasTables } = markdownToIRWithMeta(markdown, {
    linkify: false,
    autolink: false,
    headingStyle: "atx",
    bulletPrefix: "- ",
    blockquotePrefix: "",
    tableMode: mode,
  });
  if (!hasTables) {
    // Even when no complete table was found, orphaned table rows
    // (from streaming splits) should be wrapped in code fences so
    // they render as monospace rather than raw pipe text.
    if (mode === "code") {
      return wrapOrphanedTableRows(markdown);
    }
    return markdown;
  }
  return renderMarkdownWithMarkers(ir, {
    styleMarkers: MARKDOWN_STYLE_MARKERS,
    escapeText: (text) => text,
    buildLink: (link, text) => {
      const href = link.href.trim();
      if (!href) {
        return null;
      }
      const label = text.slice(link.start, link.end);
      if (!label) {
        return null;
      }
      return { start: link.start, end: link.end, open: "[", close: `](${href})` };
    },
  });
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Wrap runs of orphaned table rows (lines starting with `|` that
 * are outside fenced code blocks) in triple-backtick code fences
 * so they render as monospace text. This handles table rows that
 * lost their header due to block streaming splits.
 */
export function wrapOrphanedTableRows(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let inOrphanFence = false;

  for (const line of lines) {
    // Track real fences (not our inserted ones).
    if (!inOrphanFence && FENCE_OPEN_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    const isRow = TABLE_ROW_RE.test(line);

    if (isRow && !inOrphanFence) {
      out.push("```");
      inOrphanFence = true;
    } else if (!isRow && inOrphanFence) {
      out.push("```");
      inOrphanFence = false;
    }

    out.push(line);
  }

  if (inOrphanFence) {
    out.push("```");
  }

  return out.join("\n");
}
