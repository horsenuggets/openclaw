import { describe, expect, it } from "vitest";
import { stripStrayLeadingSpaces } from "./reply-delivery.js";

describe("stripStrayLeadingSpaces", () => {
  it("strips a single leading space from paragraph lines", () => {
    const input = [
      "You have to sit in the chaos.",
      "",
      " Sail through it. For 15-20 minutes.",
      "",
      "Does this make sense?",
    ].join("\n");
    const result = stripStrayLeadingSpaces(input);
    expect(result).toBe(
      [
        "You have to sit in the chaos.",
        "",
        "Sail through it. For 15-20 minutes.",
        "",
        "Does this make sense?",
      ].join("\n"),
    );
  });

  it("strips multiple leading spaces from paragraph lines", () => {
    const input = "   Indented paragraph text.";
    expect(stripStrayLeadingSpaces(input)).toBe("Indented paragraph text.");
  });

  it("preserves content inside fenced code blocks", () => {
    const input = [
      "Some text",
      "```js",
      "  const x = 1;",
      "    if (x) {",
      "      return;",
      "    }",
      "```",
      " After code.",
    ].join("\n");
    const result = stripStrayLeadingSpaces(input);
    expect(result).toBe(
      [
        "Some text",
        "```js",
        "  const x = 1;",
        "    if (x) {",
        "      return;",
        "    }",
        "```",
        "After code.",
      ].join("\n"),
    );
  });

  it("preserves indentation on nested list items", () => {
    const input = [
      "- Top-level item",
      "  - Nested item",
      "    - Deeply nested",
      " Some paragraph text.",
    ].join("\n");
    const result = stripStrayLeadingSpaces(input);
    expect(result).toBe(
      ["- Top-level item", "  - Nested item", "    - Deeply nested", "Some paragraph text."].join(
        "\n",
      ),
    );
  });

  it("preserves indentation on numbered list items", () => {
    const input = ["1. First", "  2. Nested second", "  3) Nested third"].join("\n");
    expect(stripStrayLeadingSpaces(input)).toBe(input);
  });

  it("strips leading spaces from headings", () => {
    const input = " ## Section Title";
    expect(stripStrayLeadingSpaces(input)).toBe("## Section Title");
  });

  it("strips leading spaces from blockquotes", () => {
    const input = " > A quote";
    expect(stripStrayLeadingSpaces(input)).toBe("> A quote");
  });

  it("handles text with no leading spaces unchanged", () => {
    const input = "No leading spaces here.\nOr here either.";
    expect(stripStrayLeadingSpaces(input)).toBe(input);
  });

  it("handles empty text", () => {
    expect(stripStrayLeadingSpaces("")).toBe("");
  });

  it("handles tilde fenced code blocks", () => {
    const input = ["~~~", "  indented code", "~~~", " Paragraph."].join("\n");
    const result = stripStrayLeadingSpaces(input);
    expect(result).toBe(["~~~", "  indented code", "~~~", "Paragraph."].join("\n"));
  });

  it("handles unclosed code fences", () => {
    const input = ["```", "  code line", "  more code"].join("\n");
    // All lines after the unclosed fence are inside the block.
    expect(stripStrayLeadingSpaces(input)).toBe(input);
  });

  it("handles tabs as leading whitespace", () => {
    const input = "\tTabbed paragraph.";
    expect(stripStrayLeadingSpaces(input)).toBe("Tabbed paragraph.");
  });

  it("preserves asterisk and plus list item indentation", () => {
    const input = ["* Top item", "  * Nested item", "  + Another nested"].join("\n");
    expect(stripStrayLeadingSpaces(input)).toBe(input);
  });
});
