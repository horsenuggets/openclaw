import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

type StubSession = {
  subscribe: (fn: (evt: unknown) => void) => () => void;
};

type SessionEventHandler = (evt: unknown) => void;

describe("subscribeEmbeddedPiSession", () => {
  it("discards pre-tool block replies when onBlockReplyDiscard is provided", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();
    const onBlockReplyDiscard = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-discard-test",
      onBlockReply,
      onBlockReplyFlush,
      onBlockReplyDiscard,
      blockReplyBreak: "text_end",
      blockReplyChunking: { minChars: 500, maxChars: 1000 },
    });

    handler?.({
      type: "message_start",
      message: { role: "assistant" },
    });

    // Simulate hedging text that's below minChars (stays in chunker buffer)
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "I don't have access to your calendar.",
      },
    });

    // Text_end flushes the chunker to the pipeline
    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_end",
        content: "I don't have access to your calendar.",
      },
    });

    // The text_end flush sends to onBlockReply (pipeline)
    expect(onBlockReply).toHaveBeenCalledTimes(1);

    // Tool execution starts - should discard, not flush
    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-discard-1",
      args: { command: "icalbuddy eventsToday" },
    });

    // onBlockReplyDiscard was called, not onBlockReplyFlush
    expect(onBlockReplyDiscard).toHaveBeenCalledTimes(1);
    expect(onBlockReplyFlush).not.toHaveBeenCalled();

    // The block reply was only called once (from text_end, not from tool start)
    expect(onBlockReply).toHaveBeenCalledTimes(1);
  });

  it("falls back to flush when onBlockReplyDiscard is not provided", () => {
    let handler: SessionEventHandler | undefined;
    const session: StubSession = {
      subscribe: (fn) => {
        handler = fn;
        return () => {};
      },
    };

    const onBlockReply = vi.fn();
    const onBlockReplyFlush = vi.fn();

    subscribeEmbeddedPiSession({
      session: session as unknown as Parameters<typeof subscribeEmbeddedPiSession>[0]["session"],
      runId: "run-fallback-flush",
      onBlockReply,
      onBlockReplyFlush,
      blockReplyBreak: "text_end",
    });

    handler?.({
      type: "message_start",
      message: { role: "assistant" },
    });

    handler?.({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Some text before tool.",
      },
    });

    handler?.({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-fallback-1",
      args: { command: "ls" },
    });

    // Without onBlockReplyDiscard, should fall back to flush
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
  });
});
