import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { endsAtBlockReplyBoundary } from "./pi-embedded-subscribe.handlers.messages.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

// Anthropic's native web search returns a cited answer as MANY small `text`
// content blocks — one per cited span, with trailing punctuation (". ") as its
// own block. Each block ends with a `text_end`. The block-reply streamer must
// coalesce them into whole sentences instead of flushing every block tail
// (which produced split sentences and a lone "." message).
describe("subscribeEmbeddedPiSession native web-search citation coalescing", () => {
  function drive(blocks: string[]) {
    let handler: ((evt: unknown) => void) | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };
    const onBlockReply = vi.fn();
    const subscription = subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 1, maxChars: 2000, breakPreference: "paragraph" },
    });

    handler?.({ type: "message_start", message: { role: "assistant" } });
    let full = "";
    for (const block of blocks) {
      full += block;
      // Each Anthropic content block: a text delta, then its own text_end.
      handler?.({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", delta: block },
      });
      handler?.({
        type: "message_update",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_end" },
      });
    }
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: full }],
    } as AssistantMessage;
    handler?.({ type: "message_end", message: assistantMessage });

    return { onBlockReply, subscription };
  }

  it("does not emit a lone punctuation message and keeps sentences intact", () => {
    // Shape mirrors a real native web-search answer: cited span, then the
    // sentence-ending period as a separate block, then the next sentence.
    const { onBlockReply } = drive([
      "The latest Node version is 26.10.0, released September 22, 2026",
      ". ",
      "\n\nThe LTS version is 24.21.0",
      ".",
    ]);

    const messages = onBlockReply.mock.calls.map((c) => c[0].text as string);

    // No message is just punctuation/whitespace (the old lone "." bug).
    for (const m of messages) {
      expect(m.trim()).not.toMatch(/^[.!?,;:]+$/);
    }
    // Each cited sentence is delivered whole, with its trailing period.
    expect(messages).toContain("The latest Node version is 26.10.0, released September 22, 2026.");
    expect(messages).toContain("The LTS version is 24.21.0.");
  });

  it("still flushes a complete pre-tool sentence on its own text block", () => {
    // A single complete sentence (e.g. a pre-tool 'Let me check.') must still
    // flush promptly rather than waiting for later blocks.
    const { onBlockReply } = drive(["Let me check that for you."]);
    const messages = onBlockReply.mock.calls.map((c) => c[0].text as string);
    expect(messages).toEqual(["Let me check that for you."]);
  });
});

describe("endsAtBlockReplyBoundary", () => {
  it("is true at sentence and paragraph boundaries", () => {
    expect(endsAtBlockReplyBoundary("Done.")).toBe(true);
    expect(endsAtBlockReplyBoundary("Really?")).toBe(true);
    expect(endsAtBlockReplyBoundary("Wow!")).toBe(true);
    expect(endsAtBlockReplyBoundary('He said "go."')).toBe(true);
    expect(endsAtBlockReplyBoundary("Paragraph break\n\n")).toBe(true);
  });

  it("is false mid-sentence (so the tail is held to coalesce)", () => {
    expect(endsAtBlockReplyBoundary("released September 22, 2026")).toBe(false);
    expect(endsAtBlockReplyBoundary("the value is 24.21.0")).toBe(false);
    expect(endsAtBlockReplyBoundary("a trailing comma,")).toBe(false);
    expect(endsAtBlockReplyBoundary("   ")).toBe(false);
  });
});
