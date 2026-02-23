import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { ProactiveService, type ProactiveServiceDeps } from "./service.js";

// Mock the session store and route-reply modules
vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(() => "/tmp/test-sessions.json5"),
  updateSessionStore: vi.fn(
    async (_path: string, mutator: (s: Record<string, SessionEntry>) => void) => {
      mutator({});
    },
  ),
}));

vi.mock("../auto-reply/reply/route-reply.js", () => ({
  isRoutableChannel: vi.fn(() => true),
}));

vi.mock("../agents/date-time.js", () => ({
  resolveUserTimezone: vi.fn(() => "America/New_York"),
  resolveUserTimeFormat: vi.fn(() => "12"),
  formatUserTime: vi.fn(() => "Sunday, Feb 22 at 2:00 PM EST"),
}));

// Access mocked modules
const { loadSessionStore } = await import("../config/sessions.js");
const mockedLoadSessionStore = vi.mocked(loadSessionStore);

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "test-id",
    updatedAt: Date.now(),
    chatType: "direct",
    lastChannel: "discord",
    lastTo: "user-123",
    lastUserMessageAt: Date.now() - 3 * 60 * 60_000,
    lastAgentResponseAt: Date.now() - 3 * 60 * 60_000,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    proactive: { enabled: true },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ProactiveServiceDeps> = {}): ProactiveServiceDeps {
  return {
    loadConfig: () => makeConfig(),
    runAgentCommand: vi.fn(async () => ({ payloads: [{ text: "Good morning!" }] })),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

describe("ProactiveService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Set to 2pm ET on a Sunday (outside quiet hours, good for testing)
    vi.setSystemTime(new Date("2026-02-22T19:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not start if disabled", () => {
    const deps = makeDeps({
      loadConfig: () => makeConfig({ proactive: { enabled: false } }),
    });
    const service = new ProactiveService(deps);
    service.start();
    expect(deps.log.info).toHaveBeenCalledWith("proactive: disabled by config");
    service.stop();
  });

  it("starts and runs periodic checks", async () => {
    const runAgent = vi.fn(async () => ({ payloads: [{ text: "Hello!" }] }));
    mockedLoadSessionStore.mockReturnValue({
      "discord:user-123": makeEntry(),
    });

    const deps = makeDeps({
      loadConfig: () => makeConfig({ proactive: { enabled: true, checkIntervalMinutes: 1 } }),
      runAgentCommand: runAgent,
    });
    const service = new ProactiveService(deps);
    service.start();

    // Advance by 1 minute to trigger the check
    await vi.advanceTimersByTimeAsync(60_000);

    expect(runAgent).toHaveBeenCalled();

    service.stop();
  });

  it("skips non-direct sessions", async () => {
    const runAgent = vi.fn(async () => ({ payloads: [] }));
    mockedLoadSessionStore.mockReturnValue({
      "discord:group-123": makeEntry({ chatType: "group" }),
    });

    const deps = makeDeps({ runAgentCommand: runAgent });
    const service = new ProactiveService(deps);
    await service.checkNow();

    expect(runAgent).not.toHaveBeenCalled();
    service.stop();
  });

  it("skips sessions without delivery route", async () => {
    const runAgent = vi.fn(async () => ({ payloads: [] }));
    mockedLoadSessionStore.mockReturnValue({
      "discord:user-123": makeEntry({
        lastChannel: undefined,
        lastTo: undefined,
      }),
    });

    const deps = makeDeps({ runAgentCommand: runAgent });
    const service = new ProactiveService(deps);
    await service.checkNow();

    expect(runAgent).not.toHaveBeenCalled();
    service.stop();
  });

  it("passes correct params to agentCommand", async () => {
    const runAgent = vi.fn(async () => ({ payloads: [{ text: "Hi there!" }] }));
    mockedLoadSessionStore.mockReturnValue({
      "discord:user-123": makeEntry(),
    });

    const deps = makeDeps({ runAgentCommand: runAgent });
    const service = new ProactiveService(deps);
    await service.checkNow();

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "discord:user-123",
        deliver: true,
        bestEffortDeliver: true,
        thinking: "low",
        lane: "proactive",
      }),
    );

    // The message should contain the proactive prompt
    const callArgs = runAgent.mock.calls[0][0];
    expect(callArgs.message).toContain("Proactive messaging opportunity");

    service.stop();
  });

  it("does not count silent replies as sent messages", async () => {
    const runAgent = vi.fn(async () => ({ payloads: [{ text: "NO_REPLY" }] }));
    mockedLoadSessionStore.mockReturnValue({
      "discord:user-123": makeEntry(),
    });

    const deps = makeDeps({ runAgentCommand: runAgent });
    const service = new ProactiveService(deps);
    await service.checkNow();

    // The agent was called but returned NO_REPLY, so info should
    // show 0 triggered
    expect(deps.log.info).toHaveBeenCalledWith(expect.stringContaining("triggered 0"));

    service.stop();
  });

  it("prevents concurrent runs", async () => {
    let resolveAgent: (() => void) | undefined;
    const runAgent = vi.fn(
      () =>
        new Promise<{ payloads: Array<{ text: string }> }>((resolve) => {
          resolveAgent = () => resolve({ payloads: [{ text: "Hello" }] });
        }),
    );
    mockedLoadSessionStore.mockReturnValue({
      "discord:user-123": makeEntry(),
    });

    const deps = makeDeps({ runAgentCommand: runAgent });
    const service = new ProactiveService(deps);

    // Start first check (will block on agent)
    const first = service.checkNow();
    // Flush microtasks so the first checkNow reaches the agent call
    await vi.advanceTimersByTimeAsync(0);

    // Try second check while first is still running
    const second = service.checkNow();

    // Only one agent call should be made
    expect(runAgent).toHaveBeenCalledTimes(1);

    // Resolve and clean up
    resolveAgent?.();
    await first;
    await second;

    service.stop();
  });

  it("handles agent errors gracefully", async () => {
    const runAgent = vi.fn(async () => {
      throw new Error("agent exploded");
    });
    mockedLoadSessionStore.mockReturnValue({
      "discord:user-123": makeEntry(),
    });

    const deps = makeDeps({ runAgentCommand: runAgent });
    const service = new ProactiveService(deps);
    await service.checkNow();

    expect(deps.log.warn).toHaveBeenCalledWith(expect.stringContaining("agent run failed"));

    service.stop();
  });

  it("supports startup greeting with relaxed idle threshold", async () => {
    const now = new Date("2026-02-22T19:00:00Z").getTime();
    const runAgent = vi.fn(async () => ({ payloads: [{ text: "Good morning!" }] }));
    // Session idle for 45 min (under default 60 min, above startup 30 min)
    mockedLoadSessionStore.mockReturnValue({
      "discord:user-123": makeEntry({
        lastUserMessageAt: now - 45 * 60_000,
        lastAgentResponseAt: now - 45 * 60_000,
      }),
    });

    const deps = makeDeps({ runAgentCommand: runAgent, nowMs: () => now });
    const service = new ProactiveService(deps);
    await service.checkNow({ isStartup: true });

    expect(runAgent).toHaveBeenCalled();

    service.stop();
  });

  it("does not trigger on startup without startup flag for short idle", async () => {
    const now = new Date("2026-02-22T19:00:00Z").getTime();
    const runAgent = vi.fn(async () => ({ payloads: [{ text: "Hello" }] }));
    // Session idle for 45 min (under default 60 min)
    mockedLoadSessionStore.mockReturnValue({
      "discord:user-123": makeEntry({
        lastUserMessageAt: now - 45 * 60_000,
        lastAgentResponseAt: now - 45 * 60_000,
      }),
    });

    const deps = makeDeps({ runAgentCommand: runAgent, nowMs: () => now });
    const service = new ProactiveService(deps);
    await service.checkNow();

    expect(runAgent).not.toHaveBeenCalled();

    service.stop();
  });

  it("stops cleanly", () => {
    const deps = makeDeps();
    const service = new ProactiveService(deps);
    service.start();
    service.stop();
    // Should not throw on double stop
    service.stop();
  });
});
