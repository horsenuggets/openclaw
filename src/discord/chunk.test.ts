import { describe, expect, it } from "vitest";
import { chunkDiscordText, chunkDiscordTextWithMode } from "./chunk.js";

function countLines(text: string) {
  return text.split("\n").length;
}

function hasBalancedFences(chunk: string) {
  let open: { markerChar: string; markerLen: number } | null = null;
  for (const line of chunk.split("\n")) {
    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (!match) {
      continue;
    }
    const marker = match[2];
    if (!open) {
      open = { markerChar: marker[0], markerLen: marker.length };
      continue;
    }
    if (open.markerChar === marker[0] && marker.length >= open.markerLen) {
      open = null;
    }
  }
  return open === null;
}

describe("chunkDiscordText", () => {
  it("does not split tall messages under 2000 chars by default", () => {
    const text = Array.from({ length: 45 }, (_, i) => `line-${i + 1}`).join("\n");
    expect(text.length).toBeLessThan(2000);

    const chunks = chunkDiscordText(text, { maxChars: 2000 });
    expect(chunks).toHaveLength(1);
  });

  it("prefers paragraph boundaries over mid-paragraph line splits", () => {
    // Build a text with two paragraphs separated by a blank line.
    // The split should happen at the paragraph boundary, not
    // mid-paragraph (e.g. splitting "data in one" / "round trip").
    const para1Lines = Array.from(
      { length: 10 },
      (_, i) => `First paragraph line ${i + 1} with some padding text here.`,
    );
    const para2Lines = Array.from(
      { length: 10 },
      (_, i) => `Second paragraph line ${i + 1} with some padding text here.`,
    );
    const text = [...para1Lines, "", ...para2Lines].join("\n");

    const chunks = chunkDiscordText(text, { maxChars: 400 });
    expect(chunks.length).toBeGreaterThan(1);

    // First chunk should end with content from paragraph 1 (not
    // bleed into paragraph 2).
    expect(chunks[0]).toContain("First paragraph");
    expect(chunks[0]).not.toContain("Second paragraph");
  });

  it("prefers splitting between list items over mid-item", () => {
    // A long list without blank lines. The chunker should split
    // between list items, not in the middle of a list item's text.
    const items = [
      "- **Universal compatibility**: Works everywhere HTTP works",
      "- **Simple to understand**: Intuitive resource-based model",
      "- **HTTP caching**: Leverage browser and CDN caching out of the box",
      "- **Stateless**: Easy to scale horizontally",
      "- **Tooling**: Excellent debugging tools (browser DevTools, Postman, curl)",
      "- **Documentation standards**: OpenAPI/Swagger for standardized docs",
    ];
    const text = items.join("\n");

    const chunks = chunkDiscordText(text, { maxChars: 200, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    // Each chunk should start with a list item marker, not a
    // continuation line.
    for (const chunk of chunks) {
      const firstLine = chunk.trimStart().split("\n")[0];
      expect(firstLine).toMatch(/^- /);
    }
  });

  it("prefers splitting before headings", () => {
    const text = [
      "### REST",
      "REST is a simple architecture.",
      "It uses HTTP methods.",
      "Very popular for web APIs.",
      "",
      "### GraphQL",
      "GraphQL lets clients request exactly what they need.",
      "Reduces over-fetching.",
    ].join("\n");

    const chunks = chunkDiscordText(text, { maxChars: 130, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    // The split should happen at or before the "### GraphQL" heading.
    expect(chunks[0]).toContain("### REST");
    expect(chunks[0]).not.toContain("### GraphQL");
  });

  it("falls back to line split when no paragraph boundary exists", () => {
    // One massive paragraph with no blank lines.
    const text = Array.from(
      { length: 20 },
      (_, i) => `Continuous line ${i + 1} without any paragraph break.`,
    ).join("\n");

    const chunks = chunkDiscordText(text, { maxChars: 300 });
    expect(chunks.length).toBeGreaterThan(1);

    // All content should be present across chunks.
    const joined = chunks.join("\n");
    expect(joined).toContain("Continuous line 1");
    expect(joined).toContain("Continuous line 20");
  });

  it("splits tall messages when maxLines is explicitly set", () => {
    const text = Array.from({ length: 45 }, (_, i) => `line-${i + 1}`).join("\n");
    expect(text.length).toBeLessThan(2000);

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countLines(chunk)).toBeLessThanOrEqual(20);
    }
  });

  it("keeps fenced code blocks balanced across chunks", () => {
    const body = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `Here is code:\n\n\`\`\`js\n${body}\n\`\`\`\n\nDone.`;

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 10 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }

    expect(chunks[0]).toContain("```js");
    expect(chunks.at(-1)).toContain("Done.");
  });

  it("keeps fenced blocks intact when chunkMode is newline", () => {
    const text = "```js\nconst a = 1;\nconst b = 2;\n```\nAfter";
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars: 2000,
      maxLines: 50,
      chunkMode: "newline",
    });
    expect(chunks).toEqual([text]);
  });

  it("reserves space for closing fences when chunking", () => {
    const body = "a".repeat(120);
    const text = `\`\`\`txt\n${body}\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 50, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("preserves whitespace when splitting long lines", () => {
    const text = Array.from({ length: 40 }, () => "word").join(" ");
    const chunks = chunkDiscordText(text, { maxChars: 20, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("preserves mixed whitespace across chunk boundaries", () => {
    const text = "alpha  beta\tgamma   delta epsilon  zeta";
    const chunks = chunkDiscordText(text, { maxChars: 12, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps leading whitespace when splitting long lines", () => {
    const text = "    indented line with words that force splits";
    const chunks = chunkDiscordText(text, { maxChars: 14, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps reasoning italics balanced across chunks", () => {
    const body = Array.from({ length: 25 }, (_, i) => `${i + 1}. line`).join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      // Each chunk should have balanced italics markers (even count).
      const count = (chunk.match(/_/g) || []).length;
      expect(count % 2).toBe(0);
    }

    // Ensure italics reopen on subsequent chunks
    expect(chunks[0]).toContain("_1. line");
    // Second chunk should reopen italics at the start
    expect(chunks[1].trimStart().startsWith("_")).toBe(true);
  });

  it("keeps reasoning italics balanced when chunks split by char limit", () => {
    const longLine = "This is a very long reasoning line that forces char splits.";
    const body = Array.from({ length: 5 }, () => longLine).join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxChars: 80, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const underscoreCount = (chunk.match(/_/g) || []).length;
      expect(underscoreCount % 2).toBe(0);
    }
  });

  it("closes and reopens bold across chunk boundaries", () => {
    const lines = [
      "Here is some text.",
      "",
      "**You're not broken. This is just how",
      "OCD works.**",
      "",
      "More text follows here.",
      "And another line.",
      "Keep going.",
      "Still more.",
      "Almost there.",
      "Final line.",
    ];
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxLines: 5, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const boldCount = (chunk.match(/\*\*/g) || []).length;
      expect(boldCount % 2).toBe(0);
    }
  });

  it("closes and reopens strikethrough across chunk boundaries", () => {
    const lines = [
      "Before text.",
      "~~This strikethrough spans",
      "multiple lines and should",
      "be balanced.~~",
      "After text.",
      "Line 6.",
      "Line 7.",
      "Line 8.",
      "Line 9.",
      "Line 10.",
    ];
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxLines: 4, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const strikeCount = (chunk.match(/~~/g) || []).length;
      expect(strikeCount % 2).toBe(0);
    }
  });

  it("closes and reopens spoiler markers across chunk boundaries", () => {
    const lines = [
      "Normal text.",
      "||This is a spoiler that spans",
      "across multiple lines and should",
      "stay hidden.||",
      "Visible again.",
      "Extra line 1.",
      "Extra line 2.",
      "Extra line 3.",
    ];
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxLines: 4, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const spoilerCount = (chunk.match(/\|\|/g) || []).length;
      expect(spoilerCount % 2).toBe(0);
    }
  });

  it("handles multiple unclosed markers across a single boundary", () => {
    const lines = [
      "**Bold and ~~strikethrough",
      "spanning multiple",
      "lines together.~~**",
      "Normal text.",
      "Line 5.",
      "Line 6.",
      "Line 7.",
      "Line 8.",
    ];
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxLines: 3, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const boldCount = (chunk.match(/\*\*/g) || []).length;
      const strikeCount = (chunk.match(/~~/g) || []).length;
      expect(boldCount % 2).toBe(0);
      expect(strikeCount % 2).toBe(0);
    }
  });

  it("does not touch markers inside code fences", () => {
    const lines = [
      "```js",
      "const x = '**not bold**';",
      "const y = '~~not strike~~';",
      "```",
      "Normal text.",
      "More text.",
    ];
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 50 });
    // Should fit in one chunk, so no rebalancing needed.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("does not touch markers inside inline code", () => {
    const lines = Array.from(
      { length: 25 },
      (_, i) => `Line ${i + 1}: text \`**not bold**\` more text`,
    );
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    // The ** inside backticks should not cause rebalancing artifacts.
    for (const chunk of chunks) {
      // Count ** outside of inline code.
      const withoutCode = chunk.replace(/`[^`]*`/g, "");
      const boldCount = (withoutCode.match(/\*\*/g) || []).length;
      expect(boldCount % 2).toBe(0);
    }
  });

  it("propagates bold across three chunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => {
      if (i === 2) return "**Bold starts here.";
      if (i === 28) return "Bold ends here.**";
      return `Line ${i + 1} of content.`;
    });
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    for (const chunk of chunks) {
      const boldCount = (chunk.match(/\*\*/g) || []).length;
      expect(boldCount % 2).toBe(0);
    }
  });

  it("does not garble bold in list items after cross-boundary close", () => {
    // When bold opens in one chunk and the next chunk has its own
    // independent bold list items (- **term**: description), the
    // rebalancer must not prepend ** that pairs with the wrong
    // marker, garbling formatting.
    const lines = [
      "- **Universal compatibility**: Works everywhere",
      "- **Simple to understand**: Intuitive model",
      "- **HTTP caching**: Leverage browser caching",
      "- **Stateless**: Easy to scale",
      "- **Tooling**: Excellent debugging tools",
      "- **Documentation standards**: OpenAPI",
      "",
      "### Disadvantages",
      "- **Over-fetching**: Fixed endpoints return more data",
      "- **Under-fetching**: Multiple requests needed",
      "- **Versioning**: Breaking changes require new versions",
    ];
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxChars: 250, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    // No chunk should have literal ** visible (all markers balanced).
    for (const chunk of chunks) {
      const withoutCode = chunk.replace(/`[^`]*`/g, "");
      const boldCount = (withoutCode.match(/\*\*/g) || []).length;
      expect(boldCount % 2).toBe(0);
    }

    // Each list item's bold term should remain intact (not garbled).
    const all = chunks.join("\n");
    expect(all).toContain("**Universal compatibility**");
    expect(all).toContain("**Simple to understand**");
  });

  it("does not prepend markers before fence openers at chunk start", () => {
    // Bold spans across a chunk boundary where the next chunk
    // starts with a code fence. Markers must be inserted after
    // the fenced block, not before the opener.
    const lines = [
      "**Bold text that starts here",
      "and continues for several lines.",
      "More bold content padding here.",
      "",
      "```graphql",
      "query { user { name } }",
      "```",
      "",
      "Still bold text.**",
    ];
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxChars: 80, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    // No chunk should start with ** immediately followed by ```.
    for (const chunk of chunks) {
      const firstLine = chunk.split("\n")[0];
      expect(firstLine).not.toMatch(/^\*\*`{3}/);
    }

    // Every chunk that starts with a fence should have the fence as
    // the actual first line (not preceded by formatting markers).
    for (const chunk of chunks) {
      const firstLine = chunk.split("\n")[0];
      if (firstLine.includes("```")) {
        expect(firstLine).toMatch(/^`{3}/);
      }
    }
  });

  it("strips orphaned closer after self-contained bold pairs", () => {
    // When bold opens in chunk N and the closer lands after
    // independent **term**: desc pairs in chunk N+1, the rebalancer
    // must strip the orphaned closer, not the opener of a
    // self-contained pair.
    const lines = [
      "Some text **bold that spans across",
      "- **File uploads**: Not natively supported",
      "- **Real-time streaming**: Requires workarounds",
      "the chunk boundary**",
      "Normal text.",
      "Extra padding.",
      "More padding.",
    ];
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxChars: 120, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const boldCount = (chunk.match(/\*\*/g) || []).length;
      expect(boldCount % 2).toBe(0);
    }

    // The self-contained bold pairs should survive intact.
    const all = chunks.join("\n");
    expect(all).toContain("**File uploads**");
    expect(all).toContain("**Real-time streaming**");
  });

  it("strips orphaned closer before self-contained bold pairs", () => {
    // Orphaned closer at the start of the chunk, followed by
    // independent bold pairs. Strip-first should still work here.
    const lines = [
      "**Bold that spans across",
      "boundary text**. Then:",
      "- **Over-engineering**: overkill for simple APIs",
      "- **Backend complexity**: resolvers and N+1 queries",
      "More text.",
      "Extra padding.",
      "More padding.",
    ];
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxChars: 100, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const boldCount = (chunk.match(/\*\*/g) || []).length;
      expect(boldCount % 2).toBe(0);
    }

    const all = chunks.join("\n");
    expect(all).toContain("**Over-engineering**");
    expect(all).toContain("**Backend complexity**");
  });

  it("strips orphaned closer between self-contained bold pairs", () => {
    // Orphan sits between two independent bold pairs.
    const lines = [
      "**Bold span that opens here",
      "- **Term A**: description of A",
      "the orphan closer lands here**",
      "- **Term B**: description of B",
      "More padding text for length.",
      "Extra padding.",
      "More padding.",
    ];
    const text = lines.join("\n");

    const chunks = chunkDiscordText(text, { maxChars: 120, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const boldCount = (chunk.match(/\*\*/g) || []).length;
      expect(boldCount % 2).toBe(0);
    }

    const all = chunks.join("\n");
    expect(all).toContain("**Term A**");
    expect(all).toContain("**Term B**");
  });

  it("reopens italics while preserving leading whitespace on following chunk", () => {
    const body = [
      "1. line",
      "2. line",
      "3. line",
      "4. line",
      "5. line",
      "6. line",
      "7. line",
      "8. line",
      "9. line",
      "10. line",
      "  11. indented line",
      "12. line",
    ].join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    const second = chunks[1];
    expect(second.startsWith("_")).toBe(true);
    expect(second).toContain("  11. indented line");
  });
});
