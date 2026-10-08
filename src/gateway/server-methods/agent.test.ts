import fs from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  resolveSandboxContext: vi.fn(async () => null as unknown),
  // Records every `docker` spawn (argv + stdin) and lets a test control the exit
  // code, standing in for the real child_process.spawn used by the stdin exec.
  spawnCalls: [] as Array<{ args: string[]; stdin: string }>,
  spawnExitCode: 0,
  spawnStderr: "",
  spawn: vi.fn(),
}));

mocks.spawn.mockImplementation((_cmd: string, args: string[]) => {
  const call = { args, stdin: "" };
  mocks.spawnCalls.push(call);
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const child = {
    stdin: {
      end: (data: string) => {
        call.stdin = data;
        // Fire close on the next tick, mimicking an async process exit.
        queueMicrotask(() => {
          for (const fn of listeners.close ?? []) {
            fn(mocks.spawnExitCode);
          }
        });
      },
    },
    stderr: {
      on: (event: string, fn: (...a: unknown[]) => void) => {
        if (event === "data" && mocks.spawnStderr) {
          fn(Buffer.from(mocks.spawnStderr));
        }
      },
    },
    on: (event: string, fn: (...a: unknown[]) => void) => {
      (listeners[event] ??= []).push(fn);
    },
  };
  return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
});

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("../../agents/sandbox/context.js", () => ({
  resolveSandboxContext: mocks.resolveSandboxContext,
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
    logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }) as unknown as GatewayRequestContext;

// Reset the shared docker-spawn mock state between every test so no test depends
// on another's cleanup (the sandbox-failure tests mutate spawnExitCode/stderr).
afterEach(() => {
  mocks.spawnCalls.length = 0;
  mocks.spawnExitCode = 0;
  mocks.spawnStderr = "";
  mocks.resolveSandboxContext.mockReset();
  mocks.resolveSandboxContext.mockResolvedValue(null);
});

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

  it("fails the turn closed when secret delivery fails (no agentCommand dispatch)", async () => {
    mocks.agentCommand.mockClear();
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "existing-session-id", updatedAt: Date.now() },
      canonicalKey: "agent:main:main",
    });
    mocks.updateSessionStore.mockResolvedValue(undefined);
    // Sandbox delivery blows up (e.g. container gone) -> write throws.
    mocks.resolveSandboxContext.mockResolvedValueOnce({ containerName: "sbx-fail" });
    mocks.spawnExitCode = 1;
    mocks.spawnStderr = "boom";

    const respond = vi.fn();
    await agentHandlers.agent({
      params: {
        message: "A secret is available...",
        agentId: "main",
        sessionKey: "agent:main:discord:default:channel:c1",
        idempotencyKey: "test-secret-fail",
        secret: { name: "tok", value: "super-secret" },
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "sec-1", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    // Responded with an error and never dispatched the turn.
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
    expect(mocks.agentCommand).not.toHaveBeenCalled();
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

describe("writeAgentSecret sandbox delivery", () => {
  it("pipes the value into the session's container as the sandbox user via stdin", async () => {
    mocks.resolveSandboxContext.mockResolvedValueOnce({
      containerName: "openclaw-sbx-c1",
      docker: { user: "1000:1000" },
    });

    const name = `sbx-${Math.random().toString(36).slice(2, 10)}`;
    const path = await writeAgentSecret({
      name,
      value: "super-secret",
      sessionKey: "agent:main:discord:default:channel:c1",
    });

    expect(path).toBe(`${AGENT_SECRETS_DIR}/${name}`);
    expect(mocks.spawnCalls).toHaveLength(1);
    const { args, stdin } = mocks.spawnCalls[0];
    // docker exec -i --user 1000:1000 <container> sh -c '<script>'
    expect(args[0]).toBe("exec");
    expect(args).toContain("-i");
    expect(args[args.indexOf("--user") + 1]).toBe("1000:1000");
    expect(args).toContain("openclaw-sbx-c1");
    expect(args[args.length - 2]).toBe("-c");
    // The script creates the dir, writes via cat (stdin), and chmods 0600.
    expect(args[args.length - 1]).toContain(`cat > ${path}`);
    expect(args[args.length - 1]).toContain(`chmod 600 ${path}`);
    // The value travels on stdin, never as an argument (no ps leak).
    expect(stdin).toBe("super-secret");
    for (const arg of args) {
      expect(arg).not.toContain("super-secret");
    }
    // No host staging file is created at all.
    const leftovers = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("openclaw-secret-"));
    expect(leftovers).toEqual([]);
  });

  it("omits --user when the sandbox has no configured user", async () => {
    mocks.resolveSandboxContext.mockResolvedValueOnce({ containerName: "openclaw-sbx-c2" });
    await writeAgentSecret({ name: "nouser", value: "v", sessionKey: "agent:x:channel:c2" });
    expect(mocks.spawnCalls[0].args).not.toContain("--user");
  });

  it("fails (rejects) when delivery into the container errors", async () => {
    mocks.resolveSandboxContext.mockResolvedValueOnce({ containerName: "openclaw-sbx-c3" });
    mocks.spawnExitCode = 1;
    mocks.spawnStderr = "No such container";
    await expect(
      writeAgentSecret({ name: "boom", value: "v", sessionKey: "agent:x:channel:c3" }),
    ).rejects.toThrow(/No such container/);
  });

  it("fails closed (rejects) when sandbox resolution throws, never falling back to the host", async () => {
    const name = `sbx-fail-${Math.random().toString(36).slice(2, 10)}`;
    const hostPath = `${AGENT_SECRETS_DIR}/${name}`;
    mocks.resolveSandboxContext.mockRejectedValueOnce(new Error("container start failed"));
    await expect(
      writeAgentSecret({ name, value: "v", sessionKey: "agent:main:discord:default:channel:c4" }),
    ).rejects.toThrow(/container start failed/);
    // Must not silently fall back to a host write outside the isolation boundary.
    expect(fs.existsSync(hostPath)).toBe(false);
    expect(mocks.spawnCalls).toHaveLength(0);
  });
});

describe("writeAgentSecret (direct mode / main session)", () => {
  // These exercise the direct (non-sandboxed) host path. The main session key is
  // never sandboxed (sandbox mode default is off and main is excluded from
  // non-main mode), so no Docker container is resolved and the host path is used.
  const MAIN = "agent:main:main";

  it("writes the value to /tmp/secrets/<name> with mode 0600 and overwrites in place", async () => {
    const name = `test-${Math.random().toString(36).slice(2, 10)}`;
    const target = `${AGENT_SECRETS_DIR}/${name}`;
    try {
      const path = await writeAgentSecret({ name, value: "first-value", sessionKey: MAIN });
      expect(path).toBe(target);
      expect(fs.readFileSync(target, "utf-8")).toBe("first-value");
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      // Re-writing the same name overwrites in place and keeps 0600.
      await writeAgentSecret({ name, value: "second-value", sessionKey: MAIN });
      expect(fs.readFileSync(target, "utf-8")).toBe("second-value");
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(target, { force: true });
    }
  });

  it("rejects names that could escape the secrets directory", async () => {
    for (const bad of ["", "../escape", "a/b", "a\\b", ".."]) {
      await expect(writeAgentSecret({ name: bad, value: "v", sessionKey: MAIN })).rejects.toThrow(
        /invalid secret name/,
      );
    }
  });

  it("fails closed when the existing secrets dir is group/world-writable", async () => {
    // `/tmp` is world-writable, so a pre-existing attacker-controlled
    // /tmp/secrets must be rejected rather than written into (its owner could
    // swap the target out after the write).
    fs.mkdirSync(AGENT_SECRETS_DIR, { recursive: true, mode: 0o700 });
    const original = fs.statSync(AGENT_SECRETS_DIR).mode & 0o777;
    fs.chmodSync(AGENT_SECRETS_DIR, 0o777);
    try {
      await expect(writeAgentSecret({ name: "x", value: "v", sessionKey: MAIN })).rejects.toThrow(
        /group\/world-writable/,
      );
    } finally {
      fs.chmodSync(AGENT_SECRETS_DIR, original);
    }
  });

  it("refuses to follow a pre-planted symlink at the target path (no redirect)", async () => {
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
      await expect(
        writeAgentSecret({ name, value: "attacker-controlled", sessionKey: MAIN }),
      ).rejects.toThrow();
      // The decoy target was never overwritten.
      expect(fs.readFileSync(decoy, "utf-8")).toBe("untouched");
    } finally {
      fs.rmSync(target, { force: true });
      fs.rmSync(decoy, { force: true });
    }
  });
});
