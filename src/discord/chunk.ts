import { chunkMarkdownTextWithMode, type ChunkMode } from "../auto-reply/chunk.js";
import { parseFenceSpans } from "../markdown/fences.js";
import { isStructuralBoundary } from "../markdown/structural.js";

export type ChunkDiscordTextOpts = {
  /** Max characters per Discord message. Default: 2000. */
  maxChars?: number;
  /**
   * Soft max line count per message. Disabled by default (no line-based
   * splitting). Set explicitly to enable line-based chunking.
   */
  maxLines?: number;
};

type OpenFence = {
  indent: string;
  markerChar: string;
  markerLen: number;
  openLine: string;
};

const DEFAULT_MAX_CHARS = 2000;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function countLines(text: string) {
  if (!text) {
    return 0;
  }
  return text.split("\n").length;
}

function parseFenceLine(line: string): OpenFence | null {
  const match = line.match(FENCE_RE);
  if (!match) {
    return null;
  }
  const indent = match[1] ?? "";
  const marker = match[2] ?? "";
  return {
    indent,
    markerChar: marker[0] ?? "`",
    markerLen: marker.length,
    openLine: line,
  };
}

function closeFenceLine(openFence: OpenFence) {
  return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}

function closeFenceIfNeeded(text: string, openFence: OpenFence | null) {
  if (!openFence) {
    return text;
  }
  const closeLine = closeFenceLine(openFence);
  if (!text) {
    return closeLine;
  }
  if (!text.endsWith("\n")) {
    return `${text}\n${closeLine}`;
  }
  return `${text}${closeLine}`;
}

function splitLongLine(
  line: string,
  maxChars: number,
  opts: { preserveWhitespace: boolean },
): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  if (line.length <= limit) {
    return [line];
  }
  const out: string[] = [];
  let remaining = line;
  while (remaining.length > limit) {
    if (opts.preserveWhitespace) {
      out.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
      continue;
    }
    const window = remaining.slice(0, limit);
    let breakIdx = -1;
    for (let i = window.length - 1; i >= 0; i--) {
      if (/\s/.test(window[i])) {
        breakIdx = i;
        break;
      }
    }
    if (breakIdx <= 0) {
      breakIdx = limit;
    }
    out.push(remaining.slice(0, breakIdx));
    // Keep the separator for the next segment so words don't get glued together.
    remaining = remaining.slice(breakIdx);
  }
  if (remaining.length) {
    out.push(remaining);
  }
  return out;
}

/**
 * Chunks outbound Discord text by both character count and (soft) line count,
 * while keeping fenced code blocks balanced across chunks.
 */
export function chunkDiscordText(text: string, opts: ChunkDiscordTextOpts = {}): string[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS));
  const maxLines = opts.maxLines != null ? Math.max(1, Math.floor(opts.maxLines)) : Infinity;

  const body = text ?? "";
  if (!body) {
    return [];
  }

  const alreadyOk = body.length <= maxChars && countLines(body) <= maxLines;
  if (alreadyOk) {
    return [body];
  }

  const lines = body.split("\n");
  const chunks: string[] = [];

  let current = "";
  let currentLines = 0;
  let openFence: OpenFence | null = null;

  // Position in `current` right after the last blank line (paragraph
  // boundary) that was added outside a fenced code block. Used to
  // prefer paragraph-level splits over mid-paragraph line splits.
  let lastParaBreakEnd = -1;

  // Position in `current` right before the last structural boundary
  // (list item, heading) outside a fenced code block. Used to prefer
  // splitting between list items or before headings over arbitrary
  // line breaks.
  let lastStructuralBoundary = -1;

  const flush = () => {
    if (!current) {
      return;
    }

    // When outside fenced blocks and a paragraph boundary exists at a
    // reasonable position, split there so messages never break
    // mid-paragraph (e.g. splitting "data in one" / "round trip").
    if (!openFence && lastParaBreakEnd >= maxChars * 0.3) {
      const chunkContent = current.slice(0, lastParaBreakEnd).trimEnd();
      const remainder = current.slice(lastParaBreakEnd).replace(/^\n+/, "");

      if (chunkContent.trim().length) {
        chunks.push(chunkContent);
      }

      current = remainder;
      currentLines = remainder ? countLines(remainder) : 0;
      lastParaBreakEnd = -1;
      lastStructuralBoundary = -1;
      return;
    }

    // Fall back to structural boundary (before a list item or
    // heading) so we don't split mid-list-item or mid-sentence.
    if (!openFence && lastStructuralBoundary >= maxChars * 0.2) {
      const chunkContent = current.slice(0, lastStructuralBoundary).trimEnd();
      const remainder = current.slice(lastStructuralBoundary).replace(/^\n+/, "");

      if (chunkContent.trim().length) {
        chunks.push(chunkContent);
      }

      current = remainder;
      currentLines = remainder ? countLines(remainder) : 0;
      lastParaBreakEnd = -1;
      lastStructuralBoundary = -1;
      return;
    }

    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) {
      chunks.push(payload);
    }
    current = "";
    currentLines = 0;
    if (openFence) {
      current = openFence.openLine;
      currentLines = 1;
    }
    lastParaBreakEnd = -1;
    lastStructuralBoundary = -1;
  };

  for (const originalLine of lines) {
    const fenceInfo = parseFenceLine(originalLine);
    const wasInsideFence = openFence !== null;
    let nextOpenFence: OpenFence | null = openFence;
    if (fenceInfo) {
      if (!openFence) {
        nextOpenFence = fenceInfo;
      } else if (
        openFence.markerChar === fenceInfo.markerChar &&
        fenceInfo.markerLen >= openFence.markerLen
      ) {
        nextOpenFence = null;
      }
    }

    const reserveChars = nextOpenFence ? closeFenceLine(nextOpenFence).length + 1 : 0;
    const reserveLines = nextOpenFence ? 1 : 0;
    const effectiveMaxChars = maxChars - reserveChars;
    const effectiveMaxLines = maxLines - reserveLines;
    const charLimit = effectiveMaxChars > 0 ? effectiveMaxChars : maxChars;
    const lineLimit = effectiveMaxLines > 0 ? effectiveMaxLines : maxLines;
    const prefixLen = current.length > 0 ? current.length + 1 : 0;
    // Inside fenced code blocks, split based on remaining space to
    // account for closing fence reserve. Outside fences, keep lines
    // whole to prevent mid-sentence breaks; only split lines that
    // genuinely exceed the full chunk limit.
    const segments =
      wasInsideFence || originalLine.length > charLimit
        ? splitLongLine(originalLine, Math.max(1, charLimit - prefixLen), {
            preserveWhitespace: wasInsideFence,
          })
        : [originalLine];

    for (let segIndex = 0; segIndex < segments.length; segIndex++) {
      const segment = segments[segIndex];
      const isLineContinuation = segIndex > 0;
      const delimiter = isLineContinuation ? "" : current.length > 0 ? "\n" : "";
      const addition = `${delimiter}${segment}`;
      const nextLen = current.length + addition.length;
      const nextLines = currentLines + (isLineContinuation ? 0 : 1);

      const wouldExceedChars = nextLen > charLimit;
      const wouldExceedLines = nextLines > lineLimit;

      if ((wouldExceedChars || wouldExceedLines) && current.length > 0) {
        flush();
      }

      if (current.length > 0) {
        current += addition;
        if (!isLineContinuation) {
          currentLines += 1;
        }
      } else {
        current = segment;
        currentLines = 1;
      }
    }

    // Track paragraph boundaries (blank lines outside fenced blocks)
    // so we can prefer splitting there over mid-paragraph breaks.
    if (!wasInsideFence && originalLine.trim() === "" && current.length > 0) {
      lastParaBreakEnd = current.length;
    }

    // Track structural boundaries (list items, headings) outside
    // fenced blocks so we can prefer splitting between structural
    // elements over mid-list-item or mid-sentence breaks.
    if (!wasInsideFence && current.length > 0 && isStructuralBoundary(originalLine)) {
      // Position right before the newline that precedes this line.
      const posBeforeLine = current.length - originalLine.length - 1;
      if (posBeforeLine > 0) {
        lastStructuralBoundary = posBeforeLine;
      }
    }

    openFence = nextOpenFence;
  }

  if (current.length) {
    const payload = closeFenceIfNeeded(current, openFence);
    if (payload.trim().length) {
      chunks.push(payload);
    }
  }

  const withItalics = rebalanceReasoningItalics(text, chunks);
  return rebalanceInlineFormatting(withItalics);
}

export function chunkDiscordTextWithMode(
  text: string,
  opts: ChunkDiscordTextOpts & { chunkMode?: ChunkMode },
): string[] {
  const chunkMode = opts.chunkMode ?? "length";
  if (chunkMode !== "newline") {
    return chunkDiscordText(text, opts);
  }
  const lineChunks = chunkMarkdownTextWithMode(
    text,
    Math.max(1, Math.floor(opts.maxChars ?? DEFAULT_MAX_CHARS)),
    "newline",
  );
  const chunks: string[] = [];
  for (const line of lineChunks) {
    const nested = chunkDiscordText(line, opts);
    if (!nested.length && line) {
      chunks.push(line);
      continue;
    }
    chunks.push(...nested);
  }
  // Rebalance inline formatting across paragraph-level splits.
  return rebalanceInlineFormatting(chunks);
}

// Keep italics intact for reasoning payloads that are wrapped once with `_…_`.
// When Discord chunking splits the message, we close italics at the end of
// each chunk and reopen at the start of the next so every chunk renders
// consistently.
function rebalanceReasoningItalics(source: string, chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const opensWithReasoningItalics =
    source.startsWith("Reasoning:\n_") && source.trimEnd().endsWith("_");
  if (!opensWithReasoningItalics) {
    return chunks;
  }

  const adjusted = [...chunks];
  for (let i = 0; i < adjusted.length; i++) {
    const isLast = i === adjusted.length - 1;
    const current = adjusted[i];

    // Ensure current chunk closes italics so Discord renders it italicized.
    const needsClosing = !current.trimEnd().endsWith("_");
    if (needsClosing) {
      adjusted[i] = `${current}_`;
    }

    if (isLast) {
      break;
    }

    // Re-open italics on the next chunk if needed.
    const next = adjusted[i + 1];
    const leadingWhitespaceLen = next.length - next.trimStart().length;
    const leadingWhitespace = next.slice(0, leadingWhitespaceLen);
    const nextBody = next.slice(leadingWhitespaceLen);
    if (!nextBody.startsWith("_")) {
      adjusted[i + 1] = `${leadingWhitespace}_${nextBody}`;
    }
  }

  return adjusted;
}

// 2-char inline markers that Discord renders as formatting toggles.
const INLINE_MARKERS = ["**", "__", "~~", "||"] as const;
type InlineMarker = (typeof INLINE_MARKERS)[number];

/**
 * Scan text and return which 2-char inline formatting markers are left
 * unclosed (odd parity). Skips fenced code blocks and inline code spans
 * so markers inside code are not counted.
 */
export function findUnclosedMarkers(text: string): InlineMarker[] {
  const parity: Record<string, number> = {};
  for (const m of INLINE_MARKERS) {
    parity[m] = 0;
  }

  const fenceSpans = parseFenceSpans(text);
  let inInlineCode = false;
  let i = 0;

  while (i < text.length) {
    // Skip fenced code block regions.
    if (!inInlineCode) {
      const fence = fenceSpans.find((s) => i >= s.start && i < s.end);
      if (fence) {
        i = fence.end;
        continue;
      }
    }

    const ch = text[i];

    // Toggle inline code.
    if (ch === "`") {
      inInlineCode = !inInlineCode;
      i++;
      continue;
    }
    if (inInlineCode) {
      i++;
      continue;
    }

    // Check 2-char markers (greedy so ** is not counted as two *).
    if (i + 1 < text.length) {
      const pair = `${text[i]}${text[i + 1]}`;
      if ((INLINE_MARKERS as readonly string[]).includes(pair)) {
        parity[pair]++;
        i += 2;
        continue;
      }
    }

    i++;
  }

  return INLINE_MARKERS.filter((m) => parity[m] % 2 !== 0);
}

// Close unclosed inline formatting markers at chunk boundaries so
// Discord renders each chunk independently. Instead of blindly
// reopening markers at the next chunk's start (which can pair with
// the wrong marker and garble formatting), we close in the current
// chunk and strip the orphaned closing marker from the next chunk
// when its parity confirms it has one.
function rebalanceInlineFormatting(chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }

  const adjusted = [...chunks];

  for (let i = 0; i < adjusted.length; i++) {
    const unclosed = findUnclosedMarkers(adjusted[i]);
    if (unclosed.length === 0) {
      continue;
    }

    // Close unclosed markers at end of chunk. Append before any
    // trailing fence closer so markers don't leak into code blocks.
    const closeMarkers = [...unclosed].reverse().join("");
    const closerInsertPos = findTrailingFenceCloserPos(adjusted[i]);
    if (closerInsertPos >= 0) {
      adjusted[i] =
        adjusted[i].slice(0, closerInsertPos) + closeMarkers + adjusted[i].slice(closerInsertPos);
    } else {
      adjusted[i] += closeMarkers;
    }

    // Strip orphaned closing markers from subsequent chunks. The
    // orphaned closer may be in the immediately next chunk or further
    // ahead (when a span crosses 3+ chunks). Don't gate on parity —
    // a chunk can have BOTH an orphaned closer and its own unclosed
    // opener, which cancel to even parity and would be missed.
    for (const marker of unclosed) {
      for (let j = i + 1; j < adjusted.length; j++) {
        const stripped = stripOrphanedMarkerOutsideCode(adjusted[j], marker);
        if (stripped !== adjusted[j]) {
          adjusted[j] = stripped;
          break;
        }
      }
    }
  }

  return adjusted;
}

// Find all positions of a 2-char marker outside fenced code blocks
// and inline code spans. Returns an array of character offsets where
// each occurrence starts.
function findAllMarkerPositionsOutsideCode(text: string, marker: string): number[] {
  const positions: number[] = [];
  const fenceSpans = parseFenceSpans(text);
  let inInlineCode = false;
  let i = 0;

  while (i < text.length) {
    if (!inInlineCode) {
      const fence = fenceSpans.find((s) => i >= s.start && i < s.end);
      if (fence) {
        i = fence.end;
        continue;
      }
    }

    const ch = text[i];
    if (ch === "`") {
      inInlineCode = !inInlineCode;
      i++;
      continue;
    }
    if (inInlineCode) {
      i++;
      continue;
    }

    if (i + 1 < text.length && text[i] === marker[0] && text[i + 1] === marker[1]) {
      positions.push(i);
      i += 2;
      continue;
    }

    i++;
  }

  return positions;
}

// Strip the orphaned occurrence of a 2-char marker from a chunk.
// Identifies self-contained bold pairs (**term**) by checking that
// the opener is followed by a non-whitespace character and the
// closer is preceded by one. The first marker not part of such a
// pair is the orphan and gets stripped. Returns the text unchanged
// if no orphan can be identified.
export function stripOrphanedMarkerOutsideCode(text: string, marker: string): string {
  const positions = findAllMarkerPositionsOutsideCode(text, marker);
  if (positions.length === 0) {
    return text;
  }

  // Identify self-contained pairs: consecutive markers on the same
  // line with short span where the opener is followed by a word
  // character and the closer is preceded by one (e.g. **Bold Term**).
  const paired = new Set<number>();
  for (let idx = 0; idx < positions.length; idx++) {
    if (paired.has(idx)) continue;

    let next = idx + 1;
    while (next < positions.length && paired.has(next)) next++;
    if (next >= positions.length) break;

    if (isValidBoldPair(text, positions[idx], positions[next], marker.length)) {
      paired.add(idx);
      paired.add(next);
    }
  }

  // The first unpaired marker is the orphan.
  for (let idx = 0; idx < positions.length; idx++) {
    if (!paired.has(idx)) {
      const pos = positions[idx];
      return text.slice(0, pos) + text.slice(pos + marker.length);
    }
  }

  // All markers appear paired — no orphan found in this chunk.
  return text;
}

// Check whether two marker positions form a valid self-contained
// bold pair like **Term**. The opener must be followed by a
// non-whitespace character and the closer must be preceded by one.
// This distinguishes orphaned closers (e.g. "text**") from real
// openers (e.g. "**Bold").
function isValidBoldPair(
  text: string,
  openPos: number,
  closePos: number,
  markerLen: number,
): boolean {
  const span = text.slice(openPos + markerLen, closePos);
  if (span.includes("\n") || span.length === 0 || span.length >= 200) {
    return false;
  }

  // Opener must be followed by non-whitespace.
  const afterOpen = text[openPos + markerLen];
  if (!afterOpen || /\s/.test(afterOpen)) {
    return false;
  }

  // Closer must be preceded by non-whitespace.
  const beforeClose = text[closePos - 1];
  if (!beforeClose || /\s/.test(beforeClose)) {
    return false;
  }

  return true;
}

// Find the position of a trailing fence closer line (e.g. ```) at
// the end of a chunk, so we can insert closing markers before it
// rather than after. Returns -1 if the chunk doesn't end with a
// fence closer.
function findTrailingFenceCloserPos(text: string): number {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    return -1;
  }
  const lastLine = text.slice(lastNewline + 1);
  if (!FENCE_RE.test(lastLine)) {
    return -1;
  }
  // Verify this is actually a closer (not an opener) by checking
  // that the fence spans show a span ending at or near the end.
  const spans = parseFenceSpans(text);
  const endsAtFence = spans.some((s) => s.end >= lastNewline + 1 && s.end <= text.length);
  return endsAtFence ? lastNewline : -1;
}
