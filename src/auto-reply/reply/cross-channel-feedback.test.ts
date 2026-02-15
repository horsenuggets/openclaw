import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import type { AgentStreamEvent, GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

// ---------------------------------------------------------------------------
// Mocks (same pattern as dispatch-from-config.test.ts)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async () => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn(async () => ({
    handled: false,
    aborted: false,
  })),
}));
const diagnosticMocks = vi.hoisted(() => ({
  logMessageQueued: vi.fn(),
  logMessageProcessed: vi.fn(),
  logSessionStateChange: vi.fn(),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageReceived: vi.fn(async () => {}),
  },
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      ["telegram", "slack", "discord", "signal", "imessage", "whatsapp"].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./abort.js", () => ({
  tryFastAbortFromMessage: mocks.tryFastAbortFromMessage,
  formatAbortReplyText: (stoppedSubagents?: number) => {
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return "⚙️ Agent was aborted.";
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.`;
  },
}));

vi.mock("../../logging/diagnostic.js", () => ({
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
const { resetInboundDedupe } = await import("./inbound-dedupe.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ReplyResolver = (
  ctx: MsgContext,
  opts: GetReplyOptions | undefined,
  cfg: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
  };
}

type ConversationResult = {
  finalReplies: ReplyPayload[];
  blockReplies: ReplyPayload[];
  toolResults: ReplyPayload[];
  streamEvents: AgentStreamEvent[];
};

async function simulateConversation(params: {
  message: string;
  channel: string;
  chatType?: "direct" | "group";
  ctxOverrides?: Partial<MsgContext>;
  replyResolver: ReplyResolver;
  toolFeedback?: boolean;
}): Promise<ConversationResult> {
  const ctx = buildTestCtx({
    Body: params.message,
    CommandBody: params.message,
    Provider: params.channel,
    Surface: params.channel,
    ChatType: params.chatType ?? "direct",
    From: `${params.channel}:+1000`,
    To: `${params.channel}:+2000`,
    ...params.ctxOverrides,
  });
  const cfg = {} as OpenClawConfig;
  const dispatcher = createDispatcher();
  const streamEvents: AgentStreamEvent[] = [];

  await dispatchReplyFromConfig({
    ctx,
    cfg,
    dispatcher,
    replyOptions: {
      toolFeedback: params.toolFeedback ?? true,
      onStreamEvent: (event: AgentStreamEvent) => {
        streamEvents.push(event);
      },
    },
    replyResolver: params.replyResolver,
  });

  const blockReplyCalls = (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mock.calls;
  const finalReplyCalls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
  const toolResultCalls = (dispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock.calls;

  return {
    blockReplies: blockReplyCalls.map((call) => call[0] as ReplyPayload),
    finalReplies: finalReplyCalls.map((call) => call[0] as ReplyPayload),
    toolResults: toolResultCalls.map((call) => call[0] as ReplyPayload),
    streamEvents,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const CHANNELS = ["discord", "telegram", "slack", "signal", "imessage", "whatsapp"] as const;

describe("cross-channel tool feedback", () => {
  beforeEach(() => {
    resetInboundDedupe();
    mocks.tryFastAbortFromMessage.mockResolvedValue({ handled: false, aborted: false });
    mocks.routeReply.mockClear();
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageReceived.mockReset();
  });

  for (const channel of CHANNELS) {
    it(`sends italic tool feedback as block replies on ${channel}`, async () => {
      const result = await simulateConversation({
        message: "find files on my machine",
        channel,
        replyResolver: async (_ctx, opts) => {
          await opts?.onToolStatus?.({
            toolName: "Bash",
            toolCallId: "c1",
            input: { command: "ls -la" },
          });
          return { text: "Found 3 files." };
        },
      });

      expect(result.blockReplies.length).toBeGreaterThanOrEqual(1);
      const toolBlock = result.blockReplies[0];
      expect(toolBlock.text).toMatch(/^\*.+\*$/);
      expect(toolBlock.text).toContain("Bash");
      expect(result.finalReplies).toHaveLength(1);
      expect(result.finalReplies[0].text).toBe("Found 3 files.");
    });
  }

  it("sends multiple tool statuses as separate block replies", async () => {
    const result = await simulateConversation({
      message: "search the web and read a file",
      channel: "telegram",
      replyResolver: async (_ctx, opts) => {
        await opts?.onToolStatus?.({
          toolName: "web_search",
          toolCallId: "c1",
        });
        await opts?.onToolStatus?.({
          toolName: "Read",
          toolCallId: "c2",
          input: { file_path: "/etc/hosts" },
        });
        await opts?.onToolStatus?.({
          toolName: "Bash",
          toolCallId: "c3",
          input: { command: "cat /tmp/data.txt" },
        });
        return { text: "Done." };
      },
    });

    expect(result.blockReplies).toHaveLength(3);
    expect(result.blockReplies[0].text).toContain("Web Search");
    expect(result.blockReplies[1].text).toContain("Read");
    expect(result.blockReplies[2].text).toContain("Bash");
  });

  it("sends tool results via dispatcher in DM sessions", async () => {
    const result = await simulateConversation({
      message: "run a tool",
      channel: "slack",
      chatType: "direct",
      replyResolver: async (_ctx, opts) => {
        await opts?.onToolResult?.({ text: "🔧 exec output" });
        return { text: "done" };
      },
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].text).toBe("🔧 exec output");
  });

  it("does not send tool results in group sessions", async () => {
    const result = await simulateConversation({
      message: "run a tool",
      channel: "signal",
      chatType: "group",
      replyResolver: async (_ctx, opts) => {
        expect(opts?.onToolResult).toBeUndefined();
        return { text: "done" };
      },
    });

    expect(result.toolResults).toHaveLength(0);
  });

  it("forwards stream events when onStreamEvent is provided", async () => {
    const result = await simulateConversation({
      message: "do something",
      channel: "discord",
      replyResolver: async (_ctx, opts) => {
        opts?.onStreamEvent?.({ type: "tool_start", toolName: "Bash", toolCallId: "c1" });
        opts?.onStreamEvent?.({ type: "text", text: "thinking..." });
        opts?.onStreamEvent?.({
          type: "tool_result",
          toolCallId: "c1",
          toolName: "Bash",
          isError: false,
        });
        return { text: "done" };
      },
    });

    expect(result.streamEvents).toHaveLength(3);
    expect(result.streamEvents[0]).toEqual({
      type: "tool_start",
      toolName: "Bash",
      toolCallId: "c1",
    });
    expect(result.streamEvents[1]).toEqual({ type: "text", text: "thinking..." });
    expect(result.streamEvents[2]).toEqual({
      type: "tool_result",
      toolCallId: "c1",
      toolName: "Bash",
      isError: false,
    });
  });

  it("does not provide onToolStatus when toolFeedback is disabled", async () => {
    const result = await simulateConversation({
      message: "hello",
      channel: "telegram",
      toolFeedback: false,
      replyResolver: async (_ctx, opts) => {
        expect(opts?.onToolStatus).toBeUndefined();
        return { text: "hi" };
      },
    });

    expect(result.blockReplies).toHaveLength(0);
    expect(result.finalReplies).toHaveLength(1);
  });

  it("wraps tool display in markdown italic", async () => {
    const result = await simulateConversation({
      message: "read a file",
      channel: "imessage",
      replyResolver: async (_ctx, opts) => {
        await opts?.onToolStatus?.({
          toolName: "Read",
          toolCallId: "c1",
          input: { file_path: "/home/user/notes.txt" },
        });
        return { text: "contents" };
      },
    });

    expect(result.blockReplies).toHaveLength(1);
    const text = result.blockReplies[0].text!;
    expect(text.startsWith("*")).toBe(true);
    expect(text.endsWith("*")).toBe(true);
    expect(text).toContain("📖");
    expect(text).toContain("Read");
  });

  it("handles resolver returning multiple payloads", async () => {
    const result = await simulateConversation({
      message: "multi response",
      channel: "whatsapp",
      replyResolver: async () => {
        return [{ text: "part 1" }, { text: "part 2" }];
      },
    });

    expect(result.finalReplies).toHaveLength(2);
    expect(result.finalReplies[0].text).toBe("part 1");
    expect(result.finalReplies[1].text).toBe("part 2");
  });

  it("handles resolver returning undefined (suppressed reply)", async () => {
    const result = await simulateConversation({
      message: "suppress",
      channel: "slack",
      replyResolver: async () => undefined,
    });

    expect(result.finalReplies).toHaveLength(0);
  });
});
