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

  it("does not split inside a markdown table row sequence", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 40,
      maxChars: 200,
      breakPreference: "paragraph",
    });

    const text = [
      "Intro text here.",
      "",
      "| Feature | REST | GraphQL | gRPC |",
      "| --- | --- | --- | --- |",
      "| Protocol | HTTP/1.1 | HTTP/1.1 | HTTP/2 |",
      "| Data Format | JSON | JSON | Protobuf |",
      "| Schema | OpenAPI | GraphQL SDL | .proto |",
      "",
      "After table.",
    ].join("\n");

    chunker.append(text);

    const chunks: string[] = [];
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    // The table rows must all stay in one chunk. Splitting inside
    // the table would cause the second half to lose its header.
    const tableChunk = chunks.find((c) => c.includes("| Feature |"));
    expect(tableChunk).toBeDefined();
    expect(tableChunk).toContain("| Schema |");
  });

  it("avoids mid-sentence continuation lines in wrapped paragraphs", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 40,
      maxChars: 120,
      breakPreference: "paragraph",
    });

    // Simulates AI wrapping a long bullet at ~80 chars.
    const text = [
      "- **Language agnostic** with",
      "official support for 10+ programming languages",
      "- **Deadline/timeout support** built into the protocol",
    ].join("\n");

    chunker.append(text);

    const chunks: string[] = [];
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    // "official support..." should stay with "Language agnostic"
    // and not be orphaned in a separate chunk.
    const langChunk = chunks.find((c) => c.includes("Language agnostic"));
    expect(langChunk).toBeDefined();
    expect(langChunk).toContain("official support");
  });

  it("falls back to table-internal newline when table exceeds maxChars", () => {
    const chunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 100,
      breakPreference: "paragraph",
    });

    // A table that exceeds maxChars. The chunker must eventually
    // split even though all newlines are inside the table.
    const rows = Array.from(
      { length: 10 },
      (_, i) => `| Row ${i + 1} | Value A${i} | Value B${i} |`,
    );
    const text = rows.join("\n");

    chunker.append(text);

    const chunks: string[] = [];
    chunker.drain({ force: true, emit: (chunk) => chunks.push(chunk) });

    // Should split (forced) even inside the table since it exceeds
    // maxChars. Just verify it doesn't hang or crash.
    expect(chunks.length).toBeGreaterThan(1);
    const all = chunks.join("\n");
    expect(all).toContain("| Row 1 |");
    expect(all).toContain("| Row 10 |");
  });

  it("does not introduce mid-sentence splits in real-world AI output", () => {
    // Regression test: long paragraphs with wrapped continuation
    // lines should not be split mid-sentence. The overflow mechanism
    // lets the buffer grow up to 2x maxChars to find a clean break.
    const text = [
      "## REST (Representational State Transfer)",
      "",
      "REST is an architectural style for designing networked applications " +
        "that relies on a stateless, client-server communication protocol, " +
        "typically HTTP. REST has been the dominant API paradigm for web " +
        "services since the early 2000s, emphasizing stateless interactions " +
        "between client and server. REST treats server-side resources as " +
        "objects that can be created, read, updated, or deleted using " +
        "standard HTTP methods, making systems easier to scale",
      "horizontally.",
      "",
      "- **Widespread adoption** across the development community",
      "- **Simple to understand** with minimal learning curve",
      "- **Excellent caching** through HTTP caching mechanisms",
      "- **Stateless architecture** enables better scalability",
      "- **Flexible data formats** supporting JSON, XML, and more",
      "- **Built on standard HTTP** works with existing infrastructure",
      "- **Easy testing** using simple tools like curl or Postman",
      "- **Good separation** between client and server concerns",
      "",
      "## GraphQL",
      "",
      "GraphQL is a query language and runtime for APIs developed " +
        "by Facebook in 2012 and open-sourced in 2015. It provides " +
        "a complete description of the data in your API through a " +
        "strongly typed schema, giving clients the power to ask for " +
        "exactly what they need and nothing more without additional",
      "technologies.",
      "",
      "- **Precise data fetching** allows clients to request exactly " + "the data they need",
      "- **Single endpoint** for all queries reduces API surface area",
      "- **Strong typing** with schema validation on every request",
      "- **Built-in introspection** enables automatic documentation",
    ].join("\n");

    const chunker = new EmbeddedBlockChunker({
      minChars: 800,
      maxChars: 1200,
      breakPreference: "paragraph",
    });

    const blocks: string[] = [];
    const step = 80;
    for (let i = 0; i < text.length; i += step) {
      chunker.append(text.slice(i, i + step));
      chunker.drain({ force: false, emit: (b) => blocks.push(b) });
    }
    chunker.drain({ force: true, emit: (b) => blocks.push(b) });

    const reassembled = blocks.join("\n\n");

    // Continuation lines should not be split from their paragraph.
    expect(reassembled).not.toContain("easier to scale\n\nhorizontally");
    expect(reassembled).not.toContain("without additional\n\ntechnologies");

    // Every bullet should appear intact.
    const bulletLines = text.split("\n").filter((l) => /^- \*\*/.test(l.trim()));
    for (const bullet of bulletLines) {
      expect(reassembled).toContain(bullet);
    }
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
