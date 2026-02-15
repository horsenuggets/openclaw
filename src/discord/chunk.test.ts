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
  it("splits tall messages even when under 2000 chars", () => {
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
