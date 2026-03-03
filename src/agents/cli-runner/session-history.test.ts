import { describe, expect, it } from "vitest";
import type { SessionTurn } from "./session-history.js";
import { formatHistoryForPrompt, stripSelfTalk } from "./session-history.js";

describe("stripSelfTalk", () => {
  it("returns clean text unchanged", () => {
    const text = "This is a normal response with no self-talk.";
    expect(stripSelfTalk(text)).toBe(text);
  });

  it("strips legacy [User] continuation", () => {
    const text =
      "Here is my response about the topic.\n\n[User]\n[Discord user] Thanks!\n\n[Assistant]You're welcome!";
    expect(stripSelfTalk(text)).toBe("Here is my response about the topic.");
  });

  it("strips [Assistant] continuation", () => {
    const text = "My answer.\n[Assistant]Some extra text";
    expect(stripSelfTalk(text)).toBe("My answer.");
  });

  it("strips XML <user> continuation", () => {
    const text = "My response here.\n<user>\nSome fabricated user message\n</user>";
    expect(stripSelfTalk(text)).toBe("My response here.");
  });

  it("strips XML <assistant> continuation", () => {
    const text = "My response.\n<assistant>\nFabricated assistant reply\n</assistant>";
    expect(stripSelfTalk(text)).toBe("My response.");
  });

  it("truncates at the earliest self-talk marker", () => {
    const text =
      "Real response.\n<user>\nFake user\n</user>\n<assistant>\nFake assistant\n</assistant>";
    expect(stripSelfTalk(text)).toBe("Real response.");
  });

  it("handles multi-turn fabricated continuation", () => {
    const text = [
      "This is really well structured. Here's what I see:",
      "",
      "**10 properties**, each with a clear description.",
      "",
      "[User]",
      "[Discord horsenuggets user id:123 +6m 2026-03-02 15:15 PST] Thanks so much!!!",
      "[message_id: 1478169156590501988]",
      "",
      "[Assistant]Of course! Keep filling it out.",
      "",
      "[User]",
      "[Discord horsenuggets user id:123 +5m 2026-03-02 15:20 PST] That sounds cool",
    ].join("\n");
    expect(stripSelfTalk(text)).toBe(
      "This is really well structured. Here's what I see:\n\n**10 properties**, each with a clear description.",
    );
  });

  it("preserves [User] in the middle of a sentence (not a continuation)", () => {
    // [User] at the start of the string or after non-newline is fine
    const text = "The [User] role is important in this system.";
    expect(stripSelfTalk(text)).toBe(text);
  });

  it("handles empty string", () => {
    expect(stripSelfTalk("")).toBe("");
  });

  it("handles text with only whitespace before self-talk", () => {
    const text = "  \n[User]\nfake message";
    expect(stripSelfTalk(text)).toBe("");
  });
});

describe("formatHistoryForPrompt", () => {
  it("returns undefined for empty turns", () => {
    expect(formatHistoryForPrompt([])).toBeUndefined();
  });

  it("uses XML tags instead of bracket labels", () => {
    const turns: SessionTurn[] = [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there!" },
    ];
    const result = formatHistoryForPrompt(turns)!;
    expect(result).toContain("<user>");
    expect(result).toContain("</user>");
    expect(result).toContain("<assistant>");
    expect(result).toContain("</assistant>");
    expect(result).toContain("<conversation_history>");
    expect(result).toContain("</conversation_history>");
    expect(result).not.toContain("[User]");
    expect(result).not.toContain("[Assistant]");
  });

  it("includes anti-continuation instruction", () => {
    const turns: SessionTurn[] = [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi!" },
    ];
    const result = formatHistoryForPrompt(turns)!;
    expect(result).toContain("Do not extend or continue this history");
    expect(result).toContain("Do not");
    expect(result).toContain("generate <user> or <assistant> tags");
  });

  it("respects turn limit", () => {
    const turns: SessionTurn[] = [
      { role: "user", text: "First" },
      { role: "assistant", text: "Reply 1" },
      { role: "user", text: "Second" },
      { role: "assistant", text: "Reply 2" },
      { role: "user", text: "Third" },
      { role: "assistant", text: "Reply 3" },
    ];
    const result = formatHistoryForPrompt(turns, 2)!;
    expect(result).not.toContain("First");
    expect(result).toContain("Second");
    expect(result).toContain("Third");
  });
});
