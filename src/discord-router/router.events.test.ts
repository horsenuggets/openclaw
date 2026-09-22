import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceConfig, RouterConfig } from "./config.js";

// Reuse the FakeWebSocket driving pattern from router.reconnect.test.ts to
// exercise the CHANNEL_DELETE / GUILD_DELETE gateway wiring end to end.
type Handler = (...args: unknown[]) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  handlers = new Map<string, Handler[]>();
  sent: unknown[] = [];
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  on(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) {
      cb(...args);
    }
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    setTimeout(() => this.emit("close", 1000), 0);
  }
  hello(): void {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } })),
    );
  }
  ready(): void {
    this.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          op: 0,
          t: "READY",
          s: 1,
          d: { session_id: "s1", resume_gateway_url: "wss://x", user: { id: "bot-1" } },
        }),
      ),
    );
  }
  dispatch(t: string, d: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify({ op: 0, t, s: 2, d })));
  }
}

vi.mock("ws", () => ({ default: FakeWebSocket }));
const oauthServerClose = vi.fn((cb?: (err?: Error) => void) => cb?.());
vi.mock("./oauth-callback.js", () => ({
  startOAuthCallbackServer: () => ({
    server: { close: oauthServerClose },
    requestAuth: () => ({
      authUrl: "http://example.test",
      waitForCode: () => Promise.resolve("c"),
    }),
  }),
}));

const { startRouter } = await import("./router.js");

const CHANNEL = "123456789012345678";
const GUILD = "999999999999999999";
const OWNER = "111111111111111111";

function makeInstance(): InstanceConfig {
  return {
    channelId: CHANNEL,
    port: 18795,
    token: "tok",
    preferences: {},
    configPath: "/tmp/nope/openclaw.json",
    instanceDir: "/tmp/nope",
  };
}

function makeConfig(): RouterConfig {
  return {
    discordToken: "test-token",
    instances: new Map([[CHANNEL, makeInstance()]]),
    instancesDir: "/tmp/does-not-matter",
    agentTimeoutMs: 1000,
  };
}

describe("discord router channel-delete cleanup", () => {
  let startedRouters: Promise<void>[];
  let signalHandlers: Map<"SIGINT" | "SIGTERM", () => void>;
  let unregisterCalls: string[];
  let logs: string[];
  const runtime = {
    log: (...a: unknown[]) => logs.push(a.join(" ")),
    error: (...a: unknown[]) => logs.push(a.join(" ")),
  };

  const shutdown = () => {
    signalHandlers.get("SIGTERM")?.();
    signalHandlers.get("SIGINT")?.();
    signalHandlers.clear();
  };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    oauthServerClose.mockClear();
    startedRouters = [];
    signalHandlers = new Map();
    unregisterCalls = [];
    logs = [];
    vi.useFakeTimers();

    // App id + slash command registration go through fetch; the provisioner
    // /unregister call does too — capture its channelId. describeInstance reads
    // .onboarding.json from disk, which won't exist, so ownerId is undefined and
    // status is derived from the in-memory instance map (registered => truthy).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("/unregister")) {
          const body = JSON.parse((init?.body as string) ?? "{}");
          unregisterCalls.push(body.channelId);
          return { ok: true, status: 200, json: async () => ({ ok: true, message: "removed" }) };
        }
        return { ok: true, status: 200, json: async () => ({ id: "app-123" }) };
      }) as unknown as typeof fetch,
    );

    // Provisioner env so the router builds a real daemon client (not the stub).
    process.env.OPENCLAW_PROVISIONER_PORT = "18810";
    process.env.OPENCLAW_PROVISIONER_TOKEN = "secret";

    const realOnce = process.once.bind(process);
    vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers.set(event, listener);
        return process;
      }
      return realOnce(event as never, listener as never);
    }) as typeof process.once);
  });

  afterEach(async () => {
    if (startedRouters.length > 0) {
      await vi.advanceTimersByTimeAsync(0);
      shutdown();
    }
    await Promise.allSettled(startedRouters);
    delete process.env.OPENCLAW_PROVISIONER_PORT;
    delete process.env.OPENCLAW_PROVISIONER_TOKEN;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const start = () => {
    const p = startRouter(makeConfig(), runtime);
    startedRouters.push(p);
    return p;
  };

  it("unregisters the instance when its channel is deleted", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("CHANNEL_DELETE", { id: CHANNEL, guild_id: GUILD });
    await vi.advanceTimersByTimeAsync(0);

    expect(unregisterCalls).toEqual([CHANNEL]);
  });

  it("ignores deletion of a channel with no registered instance", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("CHANNEL_DELETE", { id: "000000000000000000", guild_id: GUILD });
    await vi.advanceTimersByTimeAsync(0);

    expect(unregisterCalls).toEqual([]);
  });

  it("tears down a guild's learned channels on GUILD_DELETE", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    // A message teaches the router which guild this channel lives in.
    ws.dispatch("MESSAGE_CREATE", {
      id: "msg-1",
      author: { id: OWNER, bot: false },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "hi",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    ws.dispatch("GUILD_DELETE", { id: GUILD, unavailable: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(unregisterCalls).toEqual([CHANNEL]);
  });

  it("ignores a transient GUILD_DELETE outage (unavailable=true)", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("MESSAGE_CREATE", {
      id: "msg-1",
      author: { id: OWNER, bot: false },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "hi",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    ws.dispatch("GUILD_DELETE", { id: GUILD, unavailable: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(unregisterCalls).toEqual([]);
  });

  it("learns a channel's guild from interactions so GUILD_DELETE still cleans up", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    // A slash-command interaction (not a message) teaches the guild mapping —
    // e.g. `/channel register` on a channel that never sees a plain message.
    ws.dispatch("INTERACTION_CREATE", {
      id: "int-1",
      type: 2,
      token: "tok",
      channel_id: CHANNEL,
      guild_id: GUILD,
      data: { name: "channel", options: [{ name: "status" }] },
      member: { user: { id: OWNER } },
    });
    await vi.advanceTimersByTimeAsync(0);

    ws.dispatch("GUILD_DELETE", { id: GUILD, unavailable: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(unregisterCalls).toEqual([CHANNEL]);
  });

  it("skips recovery of an unauthorized user's message in a guild channel", async () => {
    // Recovery fetches the channel object (guild_id => guild channel) and the
    // recent messages, then applies the same owner/admin gate as live messages.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.endsWith(`/channels/${CHANNEL}`)) {
          return { ok: true, status: 200, json: async () => ({ guild_id: GUILD }) };
        }
        if (typeof url === "string" && url.includes(`/channels/${CHANNEL}/messages`)) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { id: "m1", author: { id: "444444444444444444", bot: false }, content: "hi" },
            ],
          };
        }
        return { ok: true, status: 200, json: async () => ({ id: "app-123" }) };
      }) as unknown as typeof fetch,
    );

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    // Recovery runs 10s after READY; whitelist is unconfigured and the message
    // author is not the owner, so the gate fails closed and skips recovery.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(logs.some((l) => l.includes("skipping recovery in guild channel"))).toBe(true);
  });

  it("does not re-recover a message that already got an error reply", async () => {
    // Retry-loop repro: the last user message is followed by the router's own
    // italic error reply. Recovery must treat that reply as "already handled"
    // and NOT re-run "hi" — otherwise every reconnect re-attempts the same
    // failing message forever (the observed all-night error storm).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.endsWith(`/channels/${CHANNEL}`)) {
          // No guild_id => DM => no whitelist gate.
          return { ok: true, status: 200, json: async () => ({}) };
        }
        if (typeof url === "string" && url.includes(`/channels/${CHANNEL}/messages`)) {
          return {
            ok: true,
            status: 200,
            // Newest first: the bot's error reply, then the user's "hi".
            json: async () => [
              {
                id: "e1",
                author: { id: "app-123", bot: true },
                content: "*Something went wrong processing your message. Please try again.*",
              },
              { id: "u1", author: { id: OWNER, bot: false }, content: "hi" },
            ],
          };
        }
        return { ok: true, status: 200, json: async () => ({ id: "app-123" }) };
      }) as unknown as typeof fetch,
    );

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(logs.some((l) => l.includes("recovering unanswered message"))).toBe(false);
  });

  it("still recovers a message left beneath a genuine lifecycle banner", async () => {
    // Guard against over-fixing: a real "*Back online.*" banner is NOT a reply,
    // so a user message beneath it is genuinely unanswered and must be recovered.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.endsWith(`/channels/${CHANNEL}`)) {
          return { ok: true, status: 200, json: async () => ({}) };
        }
        if (typeof url === "string" && url.includes(`/channels/${CHANNEL}/messages`)) {
          return {
            ok: true,
            status: 200,
            json: async () => [
              { id: "b1", author: { id: "app-123", bot: true }, content: "*Back online.*" },
              { id: "u1", author: { id: OWNER, bot: false }, content: "hi" },
            ],
          };
        }
        return { ok: true, status: 200, json: async () => ({ id: "app-123" }) };
      }) as unknown as typeof fetch,
    );

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(logs.some((l) => l.includes("recovering unanswered message"))).toBe(true);
  });

  it("fails closed and skips recovery when the channel lookup errors", async () => {
    // A transient channel-lookup failure must not be treated as a DM (which
    // would recover unguarded); the channel is skipped entirely.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.endsWith(`/channels/${CHANNEL}`)) {
          return { ok: false, status: 500, json: async () => ({}) };
        }
        if (typeof url === "string" && url.includes(`/channels/${CHANNEL}/messages`)) {
          return {
            ok: true,
            status: 200,
            json: async () => [{ id: "m1", author: { id: OWNER, bot: false }, content: "hi" }],
          };
        }
        return { ok: true, status: 200, json: async () => ({ id: "app-123" }) };
      }) as unknown as typeof fetch,
    );

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(logs.some((l) => l.includes("channel lookup failed"))).toBe(true);
    expect(logs.some((l) => l.includes("recovering unanswered message"))).toBe(false);
  });
});
