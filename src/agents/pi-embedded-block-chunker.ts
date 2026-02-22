import type { FenceSpan } from "../markdown/fences.js";
import { findFenceSpanAt, isSafeFenceBreak, parseFenceSpans } from "../markdown/fences.js";
import { isFenceOpener, isTableRow, STRUCTURAL_RE } from "../markdown/structural.js";

export type BlockReplyChunking = {
  minChars: number;
  maxChars: number;
  breakPreference?: "paragraph" | "newline" | "sentence";
  /** When true, flush eagerly on \n\n paragraph boundaries regardless of minChars. */
  flushOnParagraph?: boolean;
};

type FenceSplit = {
  closeFenceLine: string;
  reopenFenceLine: string;
};

type BreakResult = {
  index: number;
  fenceSplit?: FenceSplit;
};

type ParagraphBreak = {
  index: number;
  length: number;
};

export class EmbeddedBlockChunker {
  #buffer = "";
  readonly #chunking: BlockReplyChunking;

  constructor(chunking: BlockReplyChunking) {
    this.#chunking = chunking;
  }

  append(text: string) {
    if (!text) {
      return;
    }
    this.#buffer += text;
  }

  reset() {
    this.#buffer = "";
  }

  get bufferedText() {
    return this.#buffer;
  }

  hasBuffered(): boolean {
    return this.#buffer.length > 0;
  }

  drain(params: { force: boolean; emit: (chunk: string) => void }) {
    // KNOWN: We cannot split inside fenced code blocks (Markdown breaks + UI glitches).
    // When forced (maxChars), we close + reopen the fence to keep Markdown valid.
    const { force, emit } = params;
    const minChars = Math.max(1, Math.floor(this.#chunking.minChars));
    const maxChars = Math.max(minChars, Math.floor(this.#chunking.maxChars));

    // When flushOnParagraph is set (chunkMode="newline"), eagerly split on \n\n
    // boundaries regardless of minChars so each paragraph is sent immediately.
    if (this.#chunking.flushOnParagraph && !force) {
      this.#drainParagraphs(emit, maxChars);
      return;
    }

    if (this.#buffer.length < minChars && !force) {
      return;
    }

    if (force && this.#buffer.length <= maxChars) {
      if (this.#buffer.trim().length > 0) {
        emit(this.#buffer);
      }
      this.#buffer = "";
      return;
    }

    while (this.#buffer.length >= minChars || (force && this.#buffer.length > 0)) {
      const breakResult =
        force && this.#buffer.length <= maxChars
          ? this.#pickSoftBreakIndex(this.#buffer, 1)
          : this.#pickBreakIndex(this.#buffer, force ? 1 : undefined, !force);
      if (breakResult.index <= 0) {
        if (force) {
          emit(this.#buffer);
          this.#buffer = "";
        }
        return;
      }

      if (!this.#emitBreakResult(breakResult, emit)) {
        continue;
      }

      if (this.#buffer.length < minChars && !force) {
        return;
      }
      if (this.#buffer.length < maxChars && !force) {
        return;
      }
    }
  }

  /** Eagerly emit complete paragraphs (text before \n\n) regardless of minChars. */
  #drainParagraphs(emit: (chunk: string) => void, maxChars: number) {
    while (this.#buffer.length > 0) {
      const fenceSpans = parseFenceSpans(this.#buffer);
      const paragraphBreak = findNextParagraphBreak(this.#buffer, fenceSpans);
      if (!paragraphBreak || paragraphBreak.index > maxChars) {
        // No paragraph boundary yet (or the next boundary is too far). If the
        // buffer exceeds maxChars, fall back to normal break logic to avoid
        // oversized chunks or unbounded accumulation.
        if (this.#buffer.length >= maxChars) {
          const breakResult = this.#pickBreakIndex(this.#buffer, 1);
          if (breakResult.index > 0) {
            this.#emitBreakResult(breakResult, emit);
            continue;
          }
        }
        return;
      }

      const chunk = this.#buffer.slice(0, paragraphBreak.index);
      if (chunk.trim().length > 0) {
        emit(chunk);
      }
      this.#buffer = stripLeadingNewlines(
        this.#buffer.slice(paragraphBreak.index + paragraphBreak.length),
      );
    }
  }

  #emitBreakResult(breakResult: BreakResult, emit: (chunk: string) => void): boolean {
    const breakIdx = breakResult.index;
    if (breakIdx <= 0) {
      return false;
    }

    let rawChunk = this.#buffer.slice(0, breakIdx);
    if (rawChunk.trim().length === 0) {
      this.#buffer = stripLeadingNewlines(this.#buffer.slice(breakIdx)).trimStart();
      return false;
    }

    let nextBuffer = this.#buffer.slice(breakIdx);
    const fenceSplit = breakResult.fenceSplit;
    if (fenceSplit) {
      const closeFence = rawChunk.endsWith("\n")
        ? `${fenceSplit.closeFenceLine}\n`
        : `\n${fenceSplit.closeFenceLine}\n`;
      rawChunk = `${rawChunk}${closeFence}`;

      const reopenFence = fenceSplit.reopenFenceLine.endsWith("\n")
        ? fenceSplit.reopenFenceLine
        : `${fenceSplit.reopenFenceLine}\n`;
      nextBuffer = `${reopenFence}${nextBuffer}`;
    }

    emit(rawChunk);

    if (fenceSplit) {
      this.#buffer = nextBuffer;
    } else {
      const nextStart =
        breakIdx < this.#buffer.length && /\s/.test(this.#buffer[breakIdx])
          ? breakIdx + 1
          : breakIdx;
      this.#buffer = stripLeadingNewlines(this.#buffer.slice(nextStart));
    }

    return true;
  }

  /** Check if breaking at newlineIdx produces a next line that
   * starts with a structural element (heading, list item, etc.). */
  #isStructuralNewlineBreak(buffer: string, newlineIdx: number): boolean {
    const afterNewline = newlineIdx + 1;
    if (afterNewline >= buffer.length) {
      return false;
    }
    const nextLineEnd = buffer.indexOf("\n", afterNewline);
    const nextLine =
      nextLineEnd === -1 ? buffer.slice(afterNewline) : buffer.slice(afterNewline, nextLineEnd);
    return STRUCTURAL_RE.test(nextLine);
  }

  /** True when the lines on both sides of the newline are table
   * rows (start with `|`). Splitting here would break the table
   * in two, causing the second half to lose its header. */
  #isInsideTableRun(buffer: string, newlineIdx: number): boolean {
    const beforeStart = buffer.lastIndexOf("\n", newlineIdx - 1);
    const lineBefore = buffer.slice(beforeStart === -1 ? 0 : beforeStart + 1, newlineIdx);
    const afterStart = newlineIdx + 1;
    if (afterStart >= buffer.length) return false;
    const afterEnd = buffer.indexOf("\n", afterStart);
    const lineAfter =
      afterEnd === -1 ? buffer.slice(afterStart) : buffer.slice(afterStart, afterEnd);
    return isTableRow(lineBefore) && isTableRow(lineAfter);
  }

  /** True when the next line is a "continuation" — it does not
   * start a new logical element (not blank, not structural, not a
   * fence opener, not a table row) and should stay attached to the
   * preceding text. */
  #isContinuationNewlineBreak(buffer: string, newlineIdx: number): boolean {
    const afterStart = newlineIdx + 1;
    if (afterStart >= buffer.length) return false;
    const nextEnd = buffer.indexOf("\n", afterStart);
    const nextLine = nextEnd === -1 ? buffer.slice(afterStart) : buffer.slice(afterStart, nextEnd);
    if (nextLine.trim() === "") return false;
    if (STRUCTURAL_RE.test(nextLine)) return false;
    if (isFenceOpener(nextLine)) return false;
    if (isTableRow(nextLine)) return false;
    return true;
  }

  #pickSoftBreakIndex(buffer: string, minCharsOverride?: number): BreakResult {
    const minChars = Math.max(1, Math.floor(minCharsOverride ?? this.#chunking.minChars));
    if (buffer.length < minChars) {
      return { index: -1 };
    }
    const fenceSpans = parseFenceSpans(buffer);
    const preference = this.#chunking.breakPreference ?? "paragraph";

    if (preference === "paragraph") {
      let paragraphIdx = buffer.indexOf("\n\n");
      while (paragraphIdx !== -1) {
        const candidates = [paragraphIdx, paragraphIdx + 1];
        for (const candidate of candidates) {
          if (candidate < minChars) {
            continue;
          }
          if (candidate < 0 || candidate >= buffer.length) {
            continue;
          }
          if (isSafeFenceBreak(fenceSpans, candidate)) {
            return { index: candidate };
          }
        }
        paragraphIdx = buffer.indexOf("\n\n", paragraphIdx + 2);
      }
    }

    if (preference === "paragraph" || preference === "newline") {
      // Pass 1: prefer newlines before structural elements
      // (headings, list items), but skip table-internal newlines.
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        if (
          newlineIdx >= minChars &&
          isSafeFenceBreak(fenceSpans, newlineIdx) &&
          !this.#isInsideTableRun(buffer, newlineIdx) &&
          this.#isStructuralNewlineBreak(buffer, newlineIdx)
        ) {
          return { index: newlineIdx };
        }
        newlineIdx = buffer.indexOf("\n", newlineIdx + 1);
      }

      // Pass 2: non-continuation newlines (skip wrapped text and
      // table-internal breaks).
      newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        if (
          newlineIdx >= minChars &&
          isSafeFenceBreak(fenceSpans, newlineIdx) &&
          !this.#isInsideTableRun(buffer, newlineIdx) &&
          !this.#isContinuationNewlineBreak(buffer, newlineIdx)
        ) {
          return { index: newlineIdx };
        }
        newlineIdx = buffer.indexOf("\n", newlineIdx + 1);
      }
    }

    // Sentence breaks — tried before the absolute-fallback newline
    // pass so we prefer clean sentence boundaries over splitting
    // mid-sentence at arbitrary newlines.
    if (preference !== "newline") {
      const matches = buffer.matchAll(/[.!?](?=\s|$)/g);
      let sentenceIdx = -1;
      for (const match of matches) {
        const at = match.index ?? -1;
        if (at < minChars) {
          continue;
        }
        const candidate = at + 1;
        if (isSafeFenceBreak(fenceSpans, candidate)) {
          sentenceIdx = candidate;
        }
      }
      if (sentenceIdx >= minChars) {
        return { index: sentenceIdx };
      }
    }

    // Pass 3: any newline at all (last resort before word/hard
    // breaks). Still avoids table-internal newlines when possible.
    if (preference === "paragraph" || preference === "newline") {
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        if (
          newlineIdx >= minChars &&
          isSafeFenceBreak(fenceSpans, newlineIdx) &&
          !this.#isInsideTableRun(buffer, newlineIdx)
        ) {
          return { index: newlineIdx };
        }
        newlineIdx = buffer.indexOf("\n", newlineIdx + 1);
      }

      // Absolute fallback: even table-internal newlines.
      newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        if (newlineIdx >= minChars && isSafeFenceBreak(fenceSpans, newlineIdx)) {
          return { index: newlineIdx };
        }
        newlineIdx = buffer.indexOf("\n", newlineIdx + 1);
      }
    }

    return { index: -1 };
  }

  #pickBreakIndex(buffer: string, minCharsOverride?: number, allowOverflow = false): BreakResult {
    const minChars = Math.max(1, Math.floor(minCharsOverride ?? this.#chunking.minChars));
    const maxChars = Math.max(minChars, Math.floor(this.#chunking.maxChars));
    // Allow the buffer to grow up to 2x maxChars to avoid
    // splitting at continuation newlines (mid-sentence). A
    // slightly longer delay between emissions is a much better
    // trade-off than garbled mid-sentence splits.
    const hardMax = maxChars * 2;
    if (buffer.length < minChars) {
      return { index: -1 };
    }
    // Widen the search window when overflow is allowed and the
    // buffer has exceeded maxChars — a clean break further out
    // is better than a mid-sentence split at maxChars.
    const windowEnd = Math.min(
      allowOverflow && buffer.length > maxChars ? hardMax : maxChars,
      buffer.length,
    );
    const window = buffer.slice(0, windowEnd);
    const fenceSpans = parseFenceSpans(buffer);

    const preference = this.#chunking.breakPreference ?? "paragraph";
    if (preference === "paragraph") {
      let paragraphIdx = window.lastIndexOf("\n\n");
      while (paragraphIdx >= minChars) {
        const candidates = [paragraphIdx, paragraphIdx + 1];
        for (const candidate of candidates) {
          if (candidate < minChars) {
            continue;
          }
          if (candidate < 0 || candidate >= buffer.length) {
            continue;
          }
          if (isSafeFenceBreak(fenceSpans, candidate)) {
            return { index: candidate };
          }
        }
        paragraphIdx = window.lastIndexOf("\n\n", paragraphIdx - 1);
      }
    }

    if (preference === "paragraph" || preference === "newline") {
      // Pass 1: prefer newlines before structural elements
      // (headings, list items), skip table-internal newlines.
      let newlineIdx = window.lastIndexOf("\n");
      while (newlineIdx >= minChars) {
        if (
          isSafeFenceBreak(fenceSpans, newlineIdx) &&
          !this.#isInsideTableRun(buffer, newlineIdx) &&
          this.#isStructuralNewlineBreak(buffer, newlineIdx)
        ) {
          return { index: newlineIdx };
        }
        newlineIdx = window.lastIndexOf("\n", newlineIdx - 1);
      }

      // Pass 2: non-continuation newlines (skip wrapped text and
      // table-internal breaks).
      newlineIdx = window.lastIndexOf("\n");
      while (newlineIdx >= minChars) {
        if (
          isSafeFenceBreak(fenceSpans, newlineIdx) &&
          !this.#isInsideTableRun(buffer, newlineIdx) &&
          !this.#isContinuationNewlineBreak(buffer, newlineIdx)
        ) {
          return { index: newlineIdx };
        }
        newlineIdx = window.lastIndexOf("\n", newlineIdx - 1);
      }
    }

    // Sentence breaks — tried before the absolute-fallback newline
    // pass so we prefer clean sentence boundaries over splitting
    // mid-sentence at arbitrary newlines.
    if (preference !== "newline") {
      const matches = window.matchAll(/[.!?](?=\s|$)/g);
      let sentenceIdx = -1;
      for (const match of matches) {
        const at = match.index ?? -1;
        if (at < minChars) {
          continue;
        }
        const candidate = at + 1;
        if (isSafeFenceBreak(fenceSpans, candidate)) {
          sentenceIdx = candidate;
        }
      }
      if (sentenceIdx >= minChars) {
        return { index: sentenceIdx };
      }
    }

    // When overflow is allowed and the buffer hasn't reached the
    // hard limit, skip the fallback passes entirely. This lets the
    // buffer keep growing until a clean break (paragraph, structural
    // boundary, sentence ending) naturally appears instead of
    // splitting mid-sentence at a continuation newline.
    if (allowOverflow && buffer.length < hardMax) {
      return { index: -1 };
    }

    // Pass 3: any newline (last resort before word/hard breaks).
    // Still avoids table-internal newlines when possible.
    if (preference === "paragraph" || preference === "newline") {
      let newlineIdx = window.lastIndexOf("\n");
      while (newlineIdx >= minChars) {
        if (
          isSafeFenceBreak(fenceSpans, newlineIdx) &&
          !this.#isInsideTableRun(buffer, newlineIdx)
        ) {
          return { index: newlineIdx };
        }
        newlineIdx = window.lastIndexOf("\n", newlineIdx - 1);
      }

      // Absolute fallback: even table-internal newlines.
      newlineIdx = window.lastIndexOf("\n");
      while (newlineIdx >= minChars) {
        if (isSafeFenceBreak(fenceSpans, newlineIdx)) {
          return { index: newlineIdx };
        }
        newlineIdx = window.lastIndexOf("\n", newlineIdx - 1);
      }
    }

    if (preference === "newline" && buffer.length < maxChars) {
      return { index: -1 };
    }

    for (let i = window.length - 1; i >= minChars; i--) {
      if (/\s/.test(window[i]) && isSafeFenceBreak(fenceSpans, i)) {
        return { index: i };
      }
    }

    if (buffer.length >= maxChars) {
      if (isSafeFenceBreak(fenceSpans, maxChars)) {
        return { index: maxChars };
      }
      const fence = findFenceSpanAt(fenceSpans, maxChars);
      if (fence) {
        return {
          index: maxChars,
          fenceSplit: {
            closeFenceLine: `${fence.indent}${fence.marker}`,
            reopenFenceLine: fence.openLine,
          },
        };
      }
      return { index: maxChars };
    }

    return { index: -1 };
  }
}

function stripLeadingNewlines(value: string): string {
  let i = 0;
  while (i < value.length && value[i] === "\n") {
    i++;
  }
  return i > 0 ? value.slice(i) : value;
}

function findNextParagraphBreak(
  buffer: string,
  fenceSpans: FenceSpan[],
  startIndex = 0,
): ParagraphBreak | null {
  if (startIndex < 0) {
    return null;
  }
  const re = /\n[\t ]*\n+/g;
  re.lastIndex = startIndex;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buffer)) !== null) {
    const index = match.index ?? -1;
    if (index < 0) {
      continue;
    }
    if (!isSafeFenceBreak(fenceSpans, index)) {
      continue;
    }
    return { index, length: match[0].length };
  }
  return null;
}
