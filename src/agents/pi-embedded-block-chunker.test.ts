import { describe, expect, it } from "vitest";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";

describe("EmbeddedBlockChunker", () => {
  it("breaks at paragraph boundary right after fence close", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 40,
      breakPreference: "paragraph",
    });

    const text = [
      "Intro",
      "```js",
      "console.log('x')",
      "```",
      "",
      "After first line",
      "After second line",
    ].join("\n");

    chunker.append(text);

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("console.log");
    expect(chunks[0]).toMatch(/```\n?$/);
    expect(chunks[0]).not.toContain("After");
    expect(chunker.bufferedText).toMatch(/^After/);
  });

  it("flushes paragraph boundaries before minChars when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 100,
      maxChars: 200,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("First paragraph.\n\nSecond paragraph.");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["First paragraph."]);
    expect(chunker.bufferedText).toBe("Second paragraph.");
  });

  it("treats blank lines with whitespace as paragraph boundaries when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 100,
      maxChars: 200,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("First paragraph.\n \nSecond paragraph.");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["First paragraph."]);
    expect(chunker.bufferedText).toBe("Second paragraph.");
  });

  it("falls back to maxChars when flushOnParagraph is set and no paragraph break exists", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 10,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("abcdefghijKLMNOP");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["abcdefghij"]);
    expect(chunker.bufferedText).toBe("KLMNOP");
  });

  it("clamps long paragraphs to maxChars when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 10,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    chunker.append("abcdefghijk\n\nRest");

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(chunks).toEqual(["abcdefghij", "k"]);
    expect(chunker.bufferedText).toBe("Rest");
  });

  it("prefers breaking before a list item over mid-bullet continuation", () => {
    // With maxChars=120, the buffer exceeds the limit inside the
    // second bullet's continuation text. The chunker should break
    // before "- **Second**" rather than after "continuation text".
    const chunker = new EmbeddedBlockChunker({
      minChars: 40,
      maxChars: 120,
      breakPreference: "paragraph",
    });

    const text = [
      "- **First** is a bullet with some description text",
      "that wraps onto a continuation line here",
      "- **Second** is another bullet with text",
    ].join("\n");

    chunker.append(text);

    const chunks: string[] = [];
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain("continuation line");
    expect(chunks[1]).toMatch(/^- \*\*Second\*\*/);
  });

  it("falls back to non-structural newline when no structural break exists", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 70,
      breakPreference: "paragraph",
    });

    const text = [
      "First line of plain text here",
      "Second line of plain text here",
      "Third line of plain text here",
    ].join("\n");

    chunker.append(text);

    const chunks: string[] = [];
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    // Should still break at a newline, just not a structural one.
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain("Second line");
    expect(chunks[1]).toContain("Third line");
  });

  it("still respects paragraph breaks as highest priority over structural breaks", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 20,
      maxChars: 70,
      breakPreference: "paragraph",
    });

    const text = [
      "- **First** bullet with text",
      "",
      "- **Second** bullet with text",
      "- **Third** bullet with text",
    ].join("\n");

    chunker.append(text);

    const chunks: string[] = [];
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    // Paragraph break (\n\n) should win over structural newline:
    // chunk 0 ends at the blank line, not at a structural boundary.
    expect(chunks[0]).toBe("- **First** bullet with text");
    expect(chunks.some((c) => c.includes("- **Second**"))).toBe(true);
    expect(chunks.some((c) => c.includes("- **Third**"))).toBe(true);
  });

  it("ignores paragraph breaks inside fences when flushOnParagraph is set", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 100,
      maxChars: 200,
      breakPreference: "paragraph",
      flushOnParagraph: true,
    });

    const text = [
      "Intro",
      "```js",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "After fence",
    ].join("\n");

    chunker.append(text);

    const chunks: string[] = [];
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks).toEqual(["Intro\n```js\nconst a = 1;\n\nconst b = 2;\n```"]);
    expect(chunker.bufferedText).toBe("After fence");
  });
});
