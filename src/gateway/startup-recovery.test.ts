import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";

// Mock the external dependencies before importing the module under test.
vi.mock("../config/sessions.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    loadSessionStore: vi.fn(() => ({})),
    resolveStorePath: vi.fn(() => "/mock/sessions.json"),
  };
});

vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithDispatcher: vi.fn(async () => ({
    queuedFinal: false,
    counts: { block: 0, tool: 0, final: 0, toolStatus: 0 },
  })),
}));

// Suppress verbose logs during tests.
vi.mock("../globals.js", () => ({
  logVerbose: vi.fn(),
}));

const { loadSessionStore } = await import("../config/sessions.js");
const { dispatchInboundMessageWithDispatcher } = await import("../auto-reply/dispatch.js");
const { runStartupRecovery } = await import("./startup-recovery.js");

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "test-session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const baseCfg = {} as Parameters<typeof runStartupRecovery>[0]["cfg"];

afterEach(() => {
  vi.clearAllMocks();
});

describe("runStartupRecovery", () => {
  it("does nothing when there are no sessions", async () => {
    vi.mocked(loadSessionStore).mockReturnValue({});
    const log = makeLog();

    await runStartupRecovery({ cfg: baseCfg, log });

    expect(dispatchInboundMessageWithDispatcher).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it("does nothing when all sessions are answered", async () => {
    const now = Date.now();
    vi.mocked(loadSessionStore).mockReturnValue({
      alice: makeEntry({
        lastUserMessageAt: now - 5000,
        lastAgentResponseAt: now - 3000,
        lastUserMessageText: "hello",
        deliveryContext: { channel: "telegram", to: "123" },
      }),
    });
    const log = makeLog();

    await runStartupRecovery({ cfg: baseCfg, log });

    expect(dispatchInboundMessageWithDispatcher).not.toHaveBeenCalled();
  });

  it("recovers an unanswered session with delivery context", async () => {
    const now = Date.now();
    vi.mocked(loadSessionStore).mockReturnValue({
      alice: makeEntry({
        lastUserMessageAt: now - 5000,
        lastAgentResponseAt: now - 10000,
        lastUserMessageText: "What is the weather?",
        deliveryContext: { channel: "telegram", to: "123" },
        chatType: "direct",
      }),
    });
    const log = makeLog();

    await runStartupRecovery({ cfg: baseCfg, log });

    expect(dispatchInboundMessageWithDispatcher).toHaveBeenCalledOnce();
    const call = vi.mocked(dispatchInboundMessageWithDispatcher).mock.calls[0]!;
    const ctx = call[0].ctx;

    // The body should contain the recovery preamble and original text.
    expect(ctx.Body).toContain("What is the weather?");
    expect(ctx.Body).toContain("interrupted");

    // Originating channel should route the reply to the right place.
    expect(ctx.OriginatingChannel).toBe("telegram");
    expect(ctx.OriginatingTo).toBe("123");
    expect(ctx.SessionKey).toBe("alice");
    expect(ctx.Surface).toBe("recovery");

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("recovered 1 unanswered session"),
    );
  });

  it("skips sessions without lastUserMessageText", async () => {
    const now = Date.now();
    vi.mocked(loadSessionStore).mockReturnValue({
      alice: makeEntry({
        lastUserMessageAt: now - 5000,
        deliveryContext: { channel: "telegram", to: "123" },
      }),
    });
    const log = makeLog();

    await runStartupRecovery({ cfg: baseCfg, log });

    expect(dispatchInboundMessageWithDispatcher).not.toHaveBeenCalled();
  });

  it("skips sessions without delivery route", async () => {
    const now = Date.now();
    vi.mocked(loadSessionStore).mockReturnValue({
      alice: makeEntry({
        lastUserMessageAt: now - 5000,
        lastUserMessageText: "hello",
        // No delivery context.
      }),
    });
    const log = makeLog();

    await runStartupRecovery({ cfg: baseCfg, log });

    expect(dispatchInboundMessageWithDispatcher).not.toHaveBeenCalled();
  });

  it("skips sessions older than the recovery window", async () => {
    const now = Date.now();
    vi.mocked(loadSessionStore).mockReturnValue({
      alice: makeEntry({
        lastUserMessageAt: now - 15 * 60_000, // 15 minutes ago
        lastUserMessageText: "hello",
        deliveryContext: { channel: "telegram", to: "123" },
      }),
    });
    const log = makeLog();

    await runStartupRecovery({ cfg: baseCfg, log });

    expect(dispatchInboundMessageWithDispatcher).not.toHaveBeenCalled();
  });

  it("skips stale sessions (idle timeout expired)", async () => {
    const now = Date.now();
    vi.mocked(loadSessionStore).mockReturnValue({
      alice: makeEntry({
        // Updated long ago, so session is stale.
        updatedAt: now - 2 * 60 * 60_000,
        lastUserMessageAt: now - 5000,
        lastUserMessageText: "hello",
        deliveryContext: { channel: "telegram", to: "123" },
      }),
    });
    const log = makeLog();

    // Use idle mode with a short timeout to make the session stale.
    const cfg = {
      ...baseCfg,
      session: {
        reset: { mode: "idle" as const, idleMinutes: 60 },
      },
    };

    await runStartupRecovery({ cfg, log });

    expect(dispatchInboundMessageWithDispatcher).not.toHaveBeenCalled();
  });

  it("recovers multiple sessions", async () => {
    const now = Date.now();
    vi.mocked(loadSessionStore).mockReturnValue({
      alice: makeEntry({
        lastUserMessageAt: now - 5000,
        lastUserMessageText: "hello from alice",
        deliveryContext: { channel: "telegram", to: "alice-123" },
      }),
      bob: makeEntry({
        lastUserMessageAt: now - 3000,
        lastUserMessageText: "hello from bob",
        deliveryContext: { channel: "discord", to: "bob-456" },
      }),
    });
    const log = makeLog();

    await runStartupRecovery({ cfg: baseCfg, log });

    expect(dispatchInboundMessageWithDispatcher).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("recovered 2 unanswered sessions"),
    );
  });

  it("falls back to lastChannel/lastTo when deliveryContext is missing", async () => {
    const now = Date.now();
    vi.mocked(loadSessionStore).mockReturnValue({
      alice: makeEntry({
        lastUserMessageAt: now - 5000,
        lastUserMessageText: "hello",
        lastChannel: "slack",
        lastTo: "C123",
      }),
    });
    const log = makeLog();

    await runStartupRecovery({ cfg: baseCfg, log });

    expect(dispatchInboundMessageWithDispatcher).toHaveBeenCalledOnce();
    const ctx = vi.mocked(dispatchInboundMessageWithDispatcher).mock.calls[0]![0].ctx;
    expect(ctx.OriginatingChannel).toBe("slack");
    expect(ctx.OriginatingTo).toBe("C123");
  });

  it("logs a warning when dispatch fails for a session", async () => {
    const now = Date.now();
    vi.mocked(loadSessionStore).mockReturnValue({
      alice: makeEntry({
        lastUserMessageAt: now - 5000,
        lastUserMessageText: "hello",
        deliveryContext: { channel: "telegram", to: "123" },
      }),
    });
    vi.mocked(dispatchInboundMessageWithDispatcher).mockRejectedValueOnce(
      new Error("network error"),
    );
    const log = makeLog();

    await runStartupRecovery({ cfg: baseCfg, log });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("failed to recover session"));
  });

  it("skips sessions where lastUserMessageAt equals lastAgentResponseAt", async () => {
    const now = Date.now();
    const ts = now - 5000;
    vi.mocked(loadSessionStore).mockReturnValue({
      alice: makeEntry({
        lastUserMessageAt: ts,
        lastAgentResponseAt: ts,
        lastUserMessageText: "hello",
        deliveryContext: { channel: "telegram", to: "123" },
      }),
    });
    const log = makeLog();

    await runStartupRecovery({ cfg: baseCfg, log });

    expect(dispatchInboundMessageWithDispatcher).not.toHaveBeenCalled();
  });
});
