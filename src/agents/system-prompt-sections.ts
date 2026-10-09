/**
 * Parse the human-editable system-prompt source
 * (docs/reference/templates/SYSTEM.md) into header-keyed prose sections that
 * src/agents/system-prompt.ts consumes directly. This is what replaced the old
 * manual "port SYSTEM.md edits into the builder" step (the deleted
 * SYSTEM.port.md): the Markdown is the single source of the prompt's wording,
 * and the builder keeps all the wiring (interpolation tokens, conditional
 * guards, section ordering, the generated tool list, and builder-only sections
 * that SYSTEM.md does not describe).
 *
 * The parse runs at runtime (cached on first use), reading the packaged
 * SYSTEM.md the same way persona-preamble.ts reads PERSONA_FRAMING.md: the agent
 * box and npm package both ship docs/reference/templates next to the binary, so
 * the file resolves in dev, packaged, and bun --compile layouts. Keeping it a
 * runtime read (rather than a committed build artifact) means SYSTEM.md stays
 * the literal, only source of the prose.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

/** One `##`/`###`/`####` block from SYSTEM.md. */
export type PromptSection = {
  /** The heading line verbatim, including its `#` markers (e.g. `## tooling`). */
  heading: string;
  /**
   * The body as individual prompt lines, with `${...}` interpolation tokens and
   * literal `<...>` tags left byte-exact for the builder to fill. The repo's
   * prettier runs with `proseWrap: always`, so a single prompt line may be stored
   * in SYSTEM.md as several wrapped physical lines; those are rejoined here. The
   * boundaries are: a blank line ends a paragraph, and each list item (`-`/`*`),
   * table row (`|`), or lone `${token}` line is its own prompt line.
   */
  lines: string[];
};

export type ParsedSystemPrompt = {
  /** The identity line before the first `##` heading. */
  intro: string;
  /** Sections keyed by their lowercased heading text (e.g. `message tool`). */
  sections: Map<string, PromptSection>;
};

const TEMPLATE_RELATIVE_PATH = path.join("docs", "reference", "templates", "SYSTEM.md");

let cached: ParsedSystemPrompt | undefined;

function stripFrontMatter(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function stripHtmlComments(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->/g, "");
}

function sectionKey(headingText: string): string {
  return headingText.trim().toLowerCase();
}

/**
 * Rejoin prettier's `proseWrap: always` wrapping back into prompt lines. A blank
 * line ends the current paragraph; each list item, table row, or lone `${token}`
 * line is its own prompt line; everything else is a continuation that folds into
 * the current line with a single space.
 */
function reflowBody(physical: string[]): string[] {
  const out: string[] = [];
  let buffer = "";
  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      out.push(trimmed);
    }
    buffer = "";
  };
  for (const raw of physical) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      flush();
      continue;
    }
    const isListItem = /^\s*[-*]\s+/.test(line);
    const isTableRow = /^\s*\|/.test(line);
    const isLoneToken = /^\s*\$\{[^}]+\}\s*$/.test(line);
    if (isTableRow || isLoneToken) {
      flush();
      out.push(line.trim());
      continue;
    }
    if (isListItem) {
      // Start a new prompt line; wrapped continuation folds in below.
      flush();
      buffer = line.trim();
      continue;
    }
    buffer = buffer ? `${buffer} ${line.trim()}` : line.trim();
  }
  flush();
  return out;
}

/**
 * Parse SYSTEM.md content into an intro line plus header-keyed sections. Pure
 * (no I/O) so it can be unit-tested with arbitrary Markdown.
 */
export function parseSystemPromptSections(markdown: string): ParsedSystemPrompt {
  const body = stripHtmlComments(stripFrontMatter(markdown));
  const rawLines = body.split("\n");

  const introPhysical: string[] = [];
  const sections = new Map<string, { heading: string; physical: string[] }>();
  let current: { heading: string; physical: string[] } | undefined;
  let seenTitle = false;

  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\s+$/, "");
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      if (level === 1) {
        // The `# SYSTEM.md » ...` title: skip it and start collecting the intro.
        seenTitle = true;
        current = undefined;
        continue;
      }
      current = { heading: `${headingMatch[1]} ${text}`, physical: [] };
      sections.set(sectionKey(text), current);
      continue;
    }
    if (current) {
      current.physical.push(line);
    } else if (seenTitle) {
      introPhysical.push(line);
    }
  }

  const resolved = new Map<string, PromptSection>();
  for (const [key, value] of sections) {
    resolved.set(key, { heading: value.heading, lines: reflowBody(value.physical) });
  }

  return { intro: reflowBody(introPhysical).join(" ").trim(), sections: resolved };
}

function resolveSystemTemplate(): string {
  // Mirror resolveWorkspaceTemplateDir so SYSTEM.md resolves in dev, npm
  // package, and bun --compile binary layouts (the box ships the templates next
  // to the executable; the package ships them under the package root).
  const packageRoot = resolveOpenClawPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  const candidates = [
    packageRoot ? path.join(packageRoot, TEMPLATE_RELATIVE_PATH) : undefined,
    typeof (globalThis as Record<string, unknown>).Bun !== "undefined"
      ? path.join(path.dirname(process.execPath), TEMPLATE_RELATIVE_PATH)
      : undefined,
    path.resolve(process.cwd(), TEMPLATE_RELATIVE_PATH),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", TEMPLATE_RELATIVE_PATH),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      const text = readFileSync(candidate, "utf-8");
      if (text.trim()) {
        return text;
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `Could not read the system-prompt template (${TEMPLATE_RELATIVE_PATH}); checked: ${candidates.join(", ")}`,
  );
}

/** Load and parse SYSTEM.md once, caching the result for subsequent builds. */
export function loadSystemPromptSections(): ParsedSystemPrompt {
  if (!cached) {
    cached = parseSystemPromptSections(resolveSystemTemplate());
  }
  return cached;
}

/** Clear the cached parse (tests that swap the template on disk use this). */
export function resetSystemPromptSectionsCache() {
  cached = undefined;
}

/**
 * Substitute `${token}` placeholders in a SYSTEM.md prose line. Tokens absent
 * from the map are left verbatim, so callers only pass the ones a given section
 * needs (and literal `${...}` inside tool catalogs stay untouched).
 */
export function applyPromptTokens(line: string, tokens: Record<string, string>): string {
  return line.replace(/\$\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match,
  );
}
