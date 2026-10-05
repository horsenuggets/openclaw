import { describe, expect, it } from "vitest";
import {
  autoLinkUrls,
  buildLogEmbed,
  formatJsonBlocks,
  stripSurroundingItalics,
} from "./log-embed.js";

describe("autoLinkUrls", () => {
  it("wraps a bare https URL using the scheme-less label", () => {
    expect(autoLinkUrls("Add more at https://claude.ai/settings/usage and keep going.")).toBe(
      "Add more at [claude.ai/settings/usage](https://claude.ai/settings/usage) and keep going.",
    );
  });

  it("keeps trailing sentence punctuation outside the link", () => {
    expect(autoLinkUrls("go to https://example.com.")).toBe(
      "go to [example.com](https://example.com).",
    );
  });

  it("leaves markdown-link targets and angle-bracket URLs alone", () => {
    expect(autoLinkUrls("see [the docs](https://example.com/docs)")).toBe(
      "see [the docs](https://example.com/docs)",
    );
    expect(autoLinkUrls("see <https://example.com> now")).toBe("see <https://example.com> now");
  });

  it("returns text without URLs unchanged", () => {
    expect(autoLinkUrls("just a plain log line")).toBe("just a plain log line");
  });
});

describe("formatJsonBlocks", () => {
  it("pretty-prints an embedded JSON object into a fenced block with surrounding newlines", () => {
    expect(formatJsonBlocks('502 {"error":"upstream auth unavailable"}')).toBe(
      '502\n```json\n{\n  "error": "upstream auth unavailable"\n}\n```',
    );
  });

  it("separates JSON from text on both sides (a{}b)", () => {
    expect(formatJsonBlocks("a{}b")).toBe("a\n```json\n{}\n```\nb");
  });

  it("handles a JSON array", () => {
    expect(formatJsonBlocks("[1,2]")).toBe("```json\n[\n  1,\n  2\n]\n```");
  });

  it("leaves non-JSON braces untouched", () => {
    expect(formatJsonBlocks("not json {oops} here")).toBe("not json {oops} here");
  });

  it("leaves plain text unchanged", () => {
    expect(formatJsonBlocks("Back online.")).toBe("Back online.");
  });
});

describe("buildLogEmbed", () => {
  it("builds a Log-category embed with no title and no forced italics", () => {
    const { embed, attachments } = buildLogEmbed("Back online.");
    expect(embed.title).toBeUndefined();
    expect(embed.color).toBe(0xa0a0a0);
    expect(embed.footer).toEqual({ text: "Log Message", icon_url: "attachment://log-message.png" });
    expect(attachments).toEqual(["log-message.png"]);
    expect(embed.timestamp).toBeDefined();
    expect(embed.description).toBe("Back online.");
  });

  it("formats embedded JSON as a fenced block", () => {
    const { embed } = buildLogEmbed('502 {"error":"upstream auth unavailable"}');
    expect(embed.description).toBe(
      '502\n```json\n{\n  "error": "upstream auth unavailable"\n}\n```',
    );
  });

  it("auto-links URLs outside code blocks", () => {
    const { embed } = buildLogEmbed("see https://example.com now");
    expect(embed.description).toBe("see [example.com](https://example.com) now");
  });

  it("does not mangle URLs inside a JSON code block", () => {
    const { embed } = buildLogEmbed('{"url":"https://example.com"}');
    expect(embed.description).toBe('```json\n{\n  "url": "https://example.com"\n}\n```');
  });

  it("leaves JSON already inside a fenced block alone (no double-fencing)", () => {
    const already = '```json\n{"a":1}\n```';
    expect(buildLogEmbed(already).embed.description).toBe(already);
  });

  it("stays within Discord's 4096-char description limit for huge payloads", () => {
    const huge = `data ${JSON.stringify(Array.from({ length: 3000 }, (_, i) => i))}`;
    const { embed } = buildLogEmbed(huge);
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
  });

  it("renders an agent error reply as a fenced log embed once italics are stripped", () => {
    // What errors.ts emits for a model-proxy 502, as the router would receive it.
    const raw = '*502 {"error":"upstream auth unavailable"}*';
    const { embed } = buildLogEmbed(stripSurroundingItalics(raw));
    expect(embed.description).toBe(
      '502\n```json\n{\n  "error": "upstream auth unavailable"\n}\n```',
    );
    expect(embed.footer?.text).toBe("Log Message");
  });
});

describe("stripSurroundingItalics", () => {
  it("strips a single surrounding *...* wrap", () => {
    expect(stripSurroundingItalics("*502 upstream auth unavailable*")).toBe(
      "502 upstream auth unavailable",
    );
    expect(stripSurroundingItalics("*x*")).toBe("x");
  });

  it("leaves bold (**...**) and unwrapped text untouched", () => {
    expect(stripSurroundingItalics("**bold**")).toBe("**bold**");
    expect(stripSurroundingItalics("no italics here")).toBe("no italics here");
    expect(stripSurroundingItalics("*only one side")).toBe("*only one side");
  });
});
