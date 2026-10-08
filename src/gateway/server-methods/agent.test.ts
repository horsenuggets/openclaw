import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";
import { AGENT_SECRETS_DIR, agentHandlers, writeAgentSecret } from "./agent.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionStore: vi.fn(),
  agentCommand: vi.fn(),
  registerAgentRunContext: vi.fn(),
  queueEmbeddedPiMessage: vi.fn(),
  resolveSendPolicy: vi.fn(() => "allow"),
  loadConfigReturn: {} as Record<string, unknown>,
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: mocks.queueEmbeddedPiMessage,
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: mocks.updateSessionStore,
    resolveAgentIdFromSessionKey: () => "main",
    resolveExplicitAgentSessionKey: () => undefined,
    resolveAgentMainSessionKey: () => "agent:main:main",
  };
});

vi.mock("../../commands/agent.js", () => ({
  agentCommand: mocks.agentCommand,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => mocks.loadConfigReturn,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
}));

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: mocks.registerAgentRunContext,
  onAgentEvent: vi.fn(),
}));

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: mocks.resolveSendPolicy,
}));

vi.mock("../../utils/delivery-context.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/delivery-context.js")>(
    "../../utils/delivery-context.js",
  );
  return {
    ...actual,
    normalizeSessionDeliveryFields: () => ({}),
  };
});

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    addChatRun: vi.fn(),
    logGateway: { info: vi.fn(), error: vi.fn() },
  }) as unknown as GatewayRequestContext;

describe("gateway agent handler", () => {
  it("preserves cliSessionIds from existing session entry", async () => {
    const existingCliSessionIds = { "claude-cli": "abc-123-def" };
    const existingClaudeCliSessionId = "abc-123-def";

    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
        cliSessionIds: existingCliSessionIds,
        claudeCliSessionId: existingClaudeCliSessionId,
      },
      canonicalKey: "agent:main:main",
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {};
      await updater(store);
      capturedEntry = store["agent:main:main"] as Record<string, unknown>;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await agentHandlers.agent({
      params: {
        message: "test",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.cliSessionIds).toEqual(existingCliSessionIds);
    expect(capturedEntry?.claudeCliSessionId).toBe(existingClaudeCliSessionId);
  });

  it("injects a timestamp into the message passed to agentCommand", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-29T01:30:00.000Z")); // Wed Jan 28, 8:30 PM EST
    mocks.agentCommand.mockReset();

    mocks.loadConfigReturn = {
      agents: {
        defaults: {
          userTimezone: "America/New_York",
        },
      },
    };

    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:main",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await agentHandlers.agent({
      params: {
        message: "Is it the weekend?",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-timestamp-inject",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "ts-1", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    // Wait for the async agentCommand call
    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());

    const callArgs = mocks.agentCommand.mock.calls[0][0];
    expect(callArgs.message).toBe("[Wed 2026-01-28 20:30 EST] Is it the weekend?");

    mocks.loadConfigReturn = {};
    vi.useRealTimers();
  });

  it("handles missing cliSessionIds gracefully", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
        // No cliSessionIds or claudeCliSessionId
      },
      canonicalKey: "agent:main:main",
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {};
      await updater(store);
      capturedEntry = store["agent:main:main"] as Record<string, unknown>;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await agentHandlers.agent({
      params: {
        message: "test",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-2",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "2", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry).toBeDefined();
    // Should be undefined, not cause an error
    expect(capturedEntry?.cliSessionIds).toBeUndefined();
    expect(capturedEntry?.claudeCliSessionId).toBeUndefined();
  });
});

describe("gateway agent.steer handler", () => {
  it("injects into the session's active run and reports accepted", async () => {
    mocks.loadSessionEntry.mockReturnValue({ entry: { sessionId: "sess-1" } });
    mocks.queueEmbeddedPiMessage.mockReturnValue(true);

    const respond = vi.fn();
    await agentHandlers["agent.steer"]({
      params: { sessionKey: "agent:main:discord:default:channel:c1", message: "also do X" },
      respond,
      context: makeContext(),
      req: { type: "req", id: "s1", method: "agent.steer" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.queueEmbeddedPiMessage).toHaveBeenCalledWith("sess-1", "also do X", "steer");
    expect(respond).toHaveBeenCalledWith(true, { accepted: true });
  });

  it("reports not accepted when there is no active streaming run", async () => {
    mocks.loadSessionEntry.mockReturnValue({ entry: { sessionId: "sess-1" } });
    mocks.queueEmbeddedPiMessage.mockReturnValue(false);

    const respond = vi.fn();
    await agentHandlers["agent.steer"]({
      params: { sessionKey: "agent:main:discord:default:channel:c1", message: "late" },
      respond,
      context: makeContext(),
      req: { type: "req", id: "s2", method: "agent.steer" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, { accepted: false });
  });

  it("reports not accepted (and never injects) when the session has no sessionId yet", async () => {
    mocks.queueEmbeddedPiMessage.mockReset();
    mocks.loadSessionEntry.mockReturnValue({ entry: undefined });

    const respond = vi.fn();
    await agentHandlers["agent.steer"]({
      params: { sessionKey: "agent:main:discord:default:channel:fresh", message: "hi" },
      respond,
      context: makeContext(),
      req: { type: "req", id: "s3", method: "agent.steer" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.queueEmbeddedPiMessage).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { accepted: false });
  });

  it("rejects invalid params", async () => {
    const respond = vi.fn();
    await agentHandlers["agent.steer"]({
      params: { sessionKey: "", message: "x" },
      respond,
      context: makeContext(),
      req: { type: "req", id: "s4", method: "agent.steer" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
  });

  it("declines (and never injects) when the session send policy denies", async () => {
    mocks.queueEmbeddedPiMessage.mockReset();
    mocks.loadSessionEntry.mockReturnValue({ cfg: {}, entry: { sessionId: "sess-1" } });
    mocks.resolveSendPolicy.mockReturnValueOnce("deny");

    const respond = vi.fn();
    await agentHandlers["agent.steer"]({
      params: { sessionKey: "agent:main:discord:default:channel:c1", message: "blocked" },
      respond,
      context: makeContext(),
      req: { type: "req", id: "s5", method: "agent.steer" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.queueEmbeddedPiMessage).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { accepted: false });
  });
});

describe("writeAgentSecret", () => {
  it("writes the value to /tmp/secrets/<name> with mode 0600 and overwrites in place", () => {
    const name = `test-${Math.random().toString(36).slice(2, 10)}`;
    const target = `${AGENT_SECRETS_DIR}/${name}`;
    try {
      const path = writeAgentSecret(name, "first-value");
      expect(path).toBe(target);
      expect(fs.readFileSync(target, "utf-8")).toBe("first-value");
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      // Re-writing the same name overwrites in place and keeps 0600.
      writeAgentSecret(name, "second-value");
      expect(fs.readFileSync(target, "utf-8")).toBe("second-value");
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it("rejects names that could escape the secrets directory", () => {
    for (const bad of ["", "../escape", "a/b", "a\\b", ".."]) {
      expect(() => writeAgentSecret(bad, "v")).toThrow(/invalid secret name/);
    }
  });

  it("refuses to follow a pre-planted symlink at the target path (no redirect)", () => {
    const name = `sym-${Math.random().toString(36).slice(2, 10)}`;
    const target = `${AGENT_SECRETS_DIR}/${name}`;
    const decoy = `/tmp/decoy-${Math.random().toString(36).slice(2, 10)}`;
    // Make sure the secrets dir exists, then plant a symlink where the secret
    // would be written, pointing at an attacker-controlled path outside it.
    fs.mkdirSync(AGENT_SECRETS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(decoy, "untouched");
    fs.symlinkSync(decoy, target);
    try {
      // O_NOFOLLOW makes the open fail rather than writing through the symlink.
      expect(() => writeAgentSecret(name, "attacker-controlled")).toThrow();
      // The decoy target was never overwritten.
      expect(fs.readFileSync(decoy, "utf-8")).toBe("untouched");
    } finally {
      fs.rmSync(target, { force: true });
      fs.rmSync(decoy, { force: true });
    }
  });
});
