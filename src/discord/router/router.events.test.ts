import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const proxyServerClose = vi.fn((cb?: (err?: Error) => void) => cb?.());
vi.mock("./container-proxy.js", () => ({
  startContainerProxyServer: () => ({
    server: { close: proxyServerClose },
  }),
}));

const { startRouter } = await import("./router.js");

const CHANNEL = "123456789012345678";
const GUILD = "999999999999999999";
const OWNER = "111111111111111111";

function makeInstance(instanceDir = "/tmp/nope"): InstanceConfig {
  return {
    channelId: CHANNEL,
    port: 18795,
    token: "tok",
    preferences: {},
    configPath: path.join(instanceDir, "openclaw.json"),
    instanceDir,
  };
}

function makeConfig(instanceDir?: string): RouterConfig {
  return {
    discordToken: "test-token",
    instances: new Map([[CHANNEL, makeInstance(instanceDir)]]),
    instancesDir: "/tmp/does-not-matter",
    agentTimeoutMs: 1000,
  };
}

/** Extract the posted message payload from a captured fetch init (JSON or multipart). */
function payloadOf(init: RequestInit): {
  embeds?: { description?: string }[];
  message_reference?: { message_id?: string };
  allowed_mentions?: { parse?: string[]; replied_user?: boolean };
} {
  if (init.body instanceof FormData) {
    return JSON.parse(init.body.get("payload_json") as string);
  }
  return JSON.parse(init.body as string);
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
    proxyServerClose.mockClear();
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
    // Pin the registration epoch so the unregister-confirmation nonce is
    // deterministic (`e-<generation>`); production leaves it random.
    process.env.OPENCLAW_REGISTRATION_EPOCH = "e";

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
    delete process.env.OPENCLAW_REGISTRATION_EPOCH;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const start = (instanceDir?: string) => {
    const p = startRouter(makeConfig(instanceDir), runtime);
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

  it("routes messages from trusted bots in guild channels", async () => {
    vi.stubEnv("OPENCLAW_MOCK_USER_BOT_ID", "trusted-bot");
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("MESSAGE_CREATE", {
      id: "bot-msg-1",
      author: { id: "trusted-bot", bot: true },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "run the test",
      attachments: [],
    });
    // The queue debounces before running the turn, so advance past that window.
    await vi.advanceTimersByTimeAsync(600);

    expect(logs.some((l) => l.includes("routing message from trusted-bot"))).toBe(true);
    expect(logs.some((l) => l.includes("denied message from trusted-bot"))).toBe(false);
  });

  it("redacts a pasted /connections token from the MESSAGE_CREATE log", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("MESSAGE_CREATE", {
      id: "connect-msg-1",
      author: { id: "444444444444444444" },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "/connections add github ghp_SUPERSECRETVALUE",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    // The generic MESSAGE_CREATE log must never carry the token; logs persist.
    expect(logs.some((l) => l.includes("ghp_SUPERSECRETVALUE"))).toBe(false);
    expect(logs.some((l) => l.includes("content=/connections add <redacted>"))).toBe(true);
  });

  it("logs only the sanitized subcommand label for any /debug command", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    // A credential pasted as an unknown /debug subcommand (or a secrettest value)
    // must never land in the persistent log: only the sanitized label is kept.
    ws.dispatch("MESSAGE_CREATE", {
      id: "debug-log-msg-1",
      author: { id: "444444444444444444" },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "/debug sk-SUPERSECRETCREDENTIAL",
      attachments: [],
    });
    ws.dispatch("MESSAGE_CREATE", {
      id: "debug-log-msg-2",
      author: { id: "444444444444444444" },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "/debug secrettest sk-ANOTHERSECRET my-name",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(logs.some((l) => l.includes("sk-SUPERSECRETCREDENTIAL"))).toBe(false);
    expect(logs.some((l) => l.includes("sk-ANOTHERSECRET"))).toBe(false);
    expect(logs.some((l) => l.includes("content=/debug (unknown)"))).toBe(true);
    expect(logs.some((l) => l.includes("content=/debug secrettest"))).toBe(true);
  });

  it("detects, redacts, and scrubs a token command sent as a reply", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("MESSAGE_CREATE", {
      id: "connect-reply-msg-1",
      author: { id: "444444444444444444" },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "/connections add ghp_REPLYSECRET",
      referenced_message: { author: { username: "owner" }, content: "Link GitHub" },
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(logs.some((l) => l.includes("ghp_REPLYSECRET"))).toBe(false);
    expect(logs.some((l) => l.includes("content=/connections add <redacted>"))).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/channels/${CHANNEL}/messages/connect-reply-msg-1`),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("denies a text /connections in an unregistered guild channel instead of the not-registered hint", async () => {
    // The text-command equivalent of the slash owner gate: an unregistered guild
    // channel has no owner, so a non-owner's `/conn list` must get the standard
    // unauthorized notice, never the "not registered yet" hint that would leak the
    // channel's registration state. UNREG is absent from the instances map.
    const UNREG = "000000000000000000";
    const STRANGER = "444444444444444444";
    const posts: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (
          typeof url === "string" &&
          url.includes(`/channels/${UNREG}/messages`) &&
          init?.method === "POST"
        ) {
          posts.push(init);
          return new Response(JSON.stringify({ id: "notice-1" }), { status: 200 });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "app-123" }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    );

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("MESSAGE_CREATE", {
      id: "unreg-conn-msg",
      author: { id: STRANGER },
      guild_id: GUILD,
      channel_id: UNREG,
      content: "/conn list",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(logs.some((l) => l.includes(`denied /connections from ${STRANGER}`))).toBe(true);
    expect(posts).toHaveLength(1);
    const payload = payloadOf(posts[0]);
    expect(payload.embeds?.[0].description).toContain("not authorized");
    expect(payload.embeds?.[0].description).not.toContain("not registered");
    expect(payload.message_reference?.message_id).toBe("unreg-conn-msg");
  });

  it("subjects an owner-gated bot to the ownership denial instead of bypassing it", async () => {
    // OPENCLAW_ROUTER_OWNER_GATED_BOT_IDS lets an E2E driver bot exercise the
    // unauthorized-access denial: unlike a trusted conversational bot it does not
    // bypass the ownership gate, and unlike an untrusted bot it is not dropped by
    // the bot filter — it is treated like a human non-owner and denied.
    //
    // The real mirror driver is trusted too (it is OPENCLAW_MOCK_USER_BOT_ID), so
    // mark the same id trusted here. That covers the deployed combination and proves
    // owner-gating overrides the trusted-bot bypass: with only the gate env set the
    // test would still pass even if the override were removed (botAllowed is false),
    // but with the bot also trusted the denial can only fire because owner-gating
    // wins over the bypass.
    vi.stubEnv("OPENCLAW_MOCK_USER_BOT_ID", "gated-bot");
    vi.stubEnv("OPENCLAW_ROUTER_OWNER_GATED_BOT_IDS", "gated-bot");
    const posts: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (
          typeof url === "string" &&
          url.includes(`/channels/${CHANNEL}/messages`) &&
          init?.method === "POST"
        ) {
          posts.push(init);
          return new Response(JSON.stringify({ id: "notice-1" }), { status: 200 });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "app-123" }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    );

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("MESSAGE_CREATE", {
      id: "gated-msg",
      author: { id: "gated-bot", bot: true },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "let me in",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(logs.some((l) => l.includes("denied message from gated-bot"))).toBe(true);
    // Not silently dropped as an untrusted bot would be.
    expect(logs.some((l) => l.includes("dropped message from gated-bot"))).toBe(false);
    // Gets the real "not authorized" notice embed, threaded under its message.
    expect(posts).toHaveLength(1);
    const payload = payloadOf(posts[0]);
    expect(payload.embeds?.[0].description).toContain("not authorized");
    expect(payload.message_reference?.message_id).toBe("gated-msg");
  });

  it("routes an owner-gated bot when it is the channel owner", async () => {
    // The gate is ownership, not an outright block: when the owner-gated bot owns
    // the channel it converses normally, so the same bot can both own a channel
    // and be denied in one it does not own.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-gated-"));
    fs.writeFileSync(path.join(dir, ".onboarding.json"), JSON.stringify({ ownerId: "gated-bot" }));
    vi.stubEnv("OPENCLAW_ROUTER_OWNER_GATED_BOT_IDS", "gated-bot");
    try {
      void start(dir);
      await vi.advanceTimersByTimeAsync(0);
      const ws = FakeWebSocket.instances[0];
      ws.emit("open");
      ws.hello();
      ws.ready();

      ws.dispatch("MESSAGE_CREATE", {
        id: "gated-owner-msg",
        author: { id: "gated-bot", bot: true },
        guild_id: GUILD,
        channel_id: CHANNEL,
        content: "hello from the owner",
        attachments: [],
      });
      // The queue debounces before running the turn, so advance past that window.
      await vi.advanceTimersByTimeAsync(600);

      expect(logs.some((l) => l.includes("routing message from gated-bot"))).toBe(true);
      expect(logs.some((l) => l.includes("denied message from gated-bot"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs a reasoned drop for an untrusted bot in a registered channel", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    // An untrusted bot (not the allowlisted mock-user bot) messaging a
    // registered channel used to drop silently, which looked like a hang.
    ws.dispatch("MESSAGE_CREATE", {
      id: "bot-msg-untrusted",
      author: { id: "untrusted-bot", bot: true },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "please reply",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(
      logs.some(
        (l) =>
          l.includes(`dropped message from untrusted-bot in channel ${CHANNEL}`) &&
          l.includes("untrusted bot"),
      ),
    ).toBe(true);
  });

  it("does not log a drop for an untrusted bot in an unregistered channel", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    // Unregistered channels are routine and high-volume; they must not spam
    // the drop log.
    ws.dispatch("MESSAGE_CREATE", {
      id: "bot-msg-unreg",
      author: { id: "untrusted-bot", bot: true },
      guild_id: GUILD,
      channel_id: "000000000000000000",
      content: "please reply",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(logs.some((l) => l.includes("dropped message from"))).toBe(false);
  });

  it("drops the router's own echoed message before logging or parsing it", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    // Discord echoes the bot's own replies as MESSAGE_CREATE. The self guard drops
    // them before the MESSAGE_CREATE log and the pre-bot command parsers, so an
    // echoed secret (e.g. from `/debug echo <credential>`) never lands in the log,
    // an echoed command-looking reply is not re-parsed, and there is no bogus
    // "untrusted bot" drop line.
    ws.dispatch("MESSAGE_CREATE", {
      id: "self-msg",
      author: { id: "app-123", bot: true },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "/debug echo sk-echoed-secret",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(logs.some((l) => l.includes("dropped message from"))).toBe(false);
    // The echo is never logged (the guard returns before the MESSAGE_CREATE log)...
    expect(logs.some((l) => l.includes("sk-echoed-secret"))).toBe(false);
    expect(logs.some((l) => l.includes("MESSAGE_CREATE: author=app-123"))).toBe(false);
    // ...and the echoed `/debug` is not re-parsed and handled a second time.
    expect(logs.some((l) => l.includes("/debug (text) from app-123"))).toBe(false);
  });

  it("logs a reasoned drop for a message with no author id in a registered channel", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("MESSAGE_CREATE", {
      id: "no-author-msg",
      author: {},
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "hello",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(
      logs.some((l) => l.includes(`in channel ${CHANNEL}`) && l.includes("missing author id")),
    ).toBe(true);
  });

  it("logs a reasoned drop for a whitespace-only message in a registered channel", async () => {
    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("MESSAGE_CREATE", {
      id: "empty-msg",
      author: { id: "555555555555555555", bot: false },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "   ",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(
      logs.some(
        (l) =>
          l.includes(`dropped message from 555555555555555555 in channel ${CHANNEL}`) &&
          l.includes("empty message"),
      ),
    ).toBe(true);
  });

  it("replies to an unauthorized user with a persistent notice embed and no delete", async () => {
    const posts: RequestInit[] = [];
    let deletes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes(`/channels/${CHANNEL}/messages`)) {
          if (init?.method === "POST") {
            posts.push(init);
            return new Response(JSON.stringify({ id: "notice-1" }), { status: 200 });
          }
          if (init?.method === "DELETE") {
            deletes += 1;
            return new Response(null, { status: 204 });
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "app-123" }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    );

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    // A non-owner human in a registered guild channel: owner is unknown (no
    // .onboarding.json on disk), so the gate fails closed and denies.
    ws.dispatch("MESSAGE_CREATE", {
      id: "msg-unauth",
      author: { id: "444444444444444444", bot: false },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "let me in",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    // Let any (unwanted) auto-delete timer fire — there should be none.
    await vi.advanceTimersByTimeAsync(15_000);

    expect(logs.some((l) => l.includes("denied message from 444444444444444444"))).toBe(true);
    expect(posts).toHaveLength(1);
    const payload = payloadOf(posts[0]);
    // The notice is a Log embed (not a plain message) threaded under the
    // offending message, with pings suppressed, and is never deleted.
    expect(payload.embeds?.[0].description).toContain("not authorized");
    expect(payload.embeds?.[0].description).toContain(`<#${CHANNEL}>`);
    expect(payload.message_reference?.message_id).toBe("msg-unauth");
    expect(payload.allowed_mentions).toEqual({ parse: [], replied_user: false });
    expect(deletes).toBe(0);
  });

  it("names the channel owner in the notice when ownership is known", async () => {
    // Write an .onboarding.json so describeInstance resolves a real owner.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-notice-"));
    fs.writeFileSync(path.join(dir, ".onboarding.json"), JSON.stringify({ ownerId: OWNER }));
    const posts: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (
          typeof url === "string" &&
          url.includes(`/channels/${CHANNEL}/messages`) &&
          init?.method === "POST"
        ) {
          posts.push(init);
          return new Response(JSON.stringify({ id: "notice-1" }), { status: 200 });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "app-123" }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    );

    try {
      void start(dir);
      await vi.advanceTimersByTimeAsync(0);
      const ws = FakeWebSocket.instances[0];
      ws.emit("open");
      ws.hello();
      ws.ready();

      ws.dispatch("MESSAGE_CREATE", {
        id: "msg-unauth",
        author: { id: "444444444444444444", bot: false },
        guild_id: GUILD,
        channel_id: CHANNEL,
        content: "let me in",
        attachments: [],
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(posts).toHaveLength(1);
      expect(payloadOf(posts[0]).embeds?.[0].description).toContain(`<@${OWNER}>`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies silently when OPENCLAW_ROUTER_UNAUTHORIZED_NOTICE is disabled", async () => {
    vi.stubEnv("OPENCLAW_ROUTER_UNAUTHORIZED_NOTICE", "0");
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (
          typeof url === "string" &&
          url.endsWith(`/channels/${CHANNEL}/messages`) &&
          init?.method === "POST"
        ) {
          posts.push(url);
          return new Response(JSON.stringify({ id: "notice-1" }), { status: 200 });
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "app-123" }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    );

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("MESSAGE_CREATE", {
      id: "msg-unauth",
      author: { id: "444444444444444444", bot: false },
      guild_id: GUILD,
      channel_id: CHANNEL,
      content: "let me in",
      attachments: [],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(logs.some((l) => l.includes("denied message from 444444444444444444"))).toBe(true);
    expect(posts).toHaveLength(0);
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

  it("recovers trusted bot messages in guild channels", async () => {
    vi.stubEnv("OPENCLAW_MOCK_USER_BOT_ID", "trusted-bot");
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
              {
                id: "bot-msg-2",
                author: { id: "trusted-bot", bot: true },
                content: "recover this test",
              },
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
    expect(logs.some((l) => l.includes("skipping recovery in guild channel"))).toBe(false);
  });

  // Recovery fetch mock: a guild channel whose only recent message is from
  // "gated-bot". No .onboarding.json on disk, so the owner is unknown and the
  // gate fails closed.
  const stubGatedRecoveryFetch = () =>
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
              {
                id: "gated-recover",
                author: { id: "gated-bot", bot: true },
                content: "recover me",
              },
            ],
          };
        }
        return { ok: true, status: 200, json: async () => ({ id: "app-123" }) };
      }) as unknown as typeof fetch,
    );

  it("subjects a trusted owner-gated bot to the owner gate during recovery", async () => {
    // The deployed mirror bot is both trusted (OPENCLAW_MOCK_USER_BOT_ID) and
    // owner-gated. A plain trusted bot bypasses the owner check on reconnect, so
    // this pins the override: here !lastUserMsgIsTrustedBot is false, so only
    // `|| lastUserMsgIsOwnerGated` forces the owner check. With no owner recorded
    // the gate fails closed, so the message is skipped, not recovered — the test
    // would fail if that override were removed.
    vi.stubEnv("OPENCLAW_MOCK_USER_BOT_ID", "gated-bot");
    vi.stubEnv("OPENCLAW_ROUTER_OWNER_GATED_BOT_IDS", "gated-bot");
    stubGatedRecoveryFetch();

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(logs.some((l) => l.includes("skipping recovery in guild channel"))).toBe(true);
    expect(logs.some((l) => l.includes("recovering unanswered message"))).toBe(false);
  });

  it("keeps an owner-gated bot recoverable during recovery even when not allowlisted", async () => {
    // Owner-gated but NOT trusted (OPENCLAW_MOCK_USER_BOT_ID unset). The bot must
    // still be picked up as a recoverable author rather than dropped as an
    // untrusted bot, then face the owner check. If it were dropped before the
    // check, neither the skip nor the recover log would appear, so asserting the
    // skip log pins that it reached the owner gate.
    vi.stubEnv("OPENCLAW_ROUTER_OWNER_GATED_BOT_IDS", "gated-bot");
    stubGatedRecoveryFetch();

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(logs.some((l) => l.includes("skipping recovery in guild channel"))).toBe(true);
    expect(logs.some((l) => l.includes("recovering unanswered message"))).toBe(false);
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

  it("skips recovery of any /debug command without logging or routing its arguments", async () => {
    // A credential pasted as an unknown subcommand (or an echo arg) is just as
    // log-sensitive as a secrettest value, so recovery must skip every /debug.
    const testSecret = "sk-credential-in-recovery";
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
              {
                id: "debug-recovery",
                author: { id: OWNER, bot: false },
                content: `/debug echo ${testSecret}`,
              },
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

    expect(logs.some((l) => l.includes("skipping recovery") && l.includes("/debug command"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes(testSecret))).toBe(false);
    expect(logs.some((l) => l.includes("recovering unanswered message"))).toBe(false);
    expect(logs.some((l) => l.includes("routing message from"))).toBe(false);
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

  it("recovers an unanswered message at most once, even across reconnects", async () => {
    // Auth/config failures post no reply, so the user's message stays the newest
    // message. Without a per-process guard, recovery would re-select and silently
    // re-run it on every reconnect (a silent version of the storm). It must be
    // attempted only once.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.endsWith(`/channels/${CHANNEL}`)) {
          return { ok: true, status: 200, json: async () => ({}) };
        }
        if (typeof url === "string" && url.includes(`/channels/${CHANNEL}/messages`)) {
          // No bot reply ever appears (agent keeps failing silently).
          return {
            ok: true,
            status: 200,
            json: async () => [{ id: "u1", author: { id: OWNER, bot: false }, content: "hi" }],
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

    // Simulate a second gateway reconnect (another READY) — recovery runs again.
    ws.ready();
    await vi.advanceTimersByTimeAsync(10_000);

    const recoveries = logs.filter((l) => l.includes("recovering unanswered message")).length;
    expect(recoveries).toBe(1);
  });

  it("treats a user message that looks like a banner as recoverable", async () => {
    // Lifecycle-banner skipping must apply only to bot-authored messages; a user
    // literally typing "*Back online.*" is a real message to recover.
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
              { id: "u1", author: { id: OWNER, bot: false }, content: "*Back online.*" },
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

  it("unregisters via the confirm button and edits the original message", async () => {
    // ownerId is unknown on disk here, so authorize the clicker via the admin
    // role instead (member lookup returns the admin role id).
    process.env.OPENCLAW_AUTH_GUILD_ID = GUILD;
    process.env.OPENCLAW_ADMIN_ROLE_ID = "ADMIN";
    const callbacks: {
      type: number;
      data?: { content?: string; components?: unknown; embeds?: { description?: string }[] };
    }[] = [];
    const patches: { components?: unknown; embeds?: { description?: string }[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("/unregister")) {
          const body = JSON.parse((init?.body as string) ?? "{}");
          unregisterCalls.push(body.channelId);
          return { ok: true, status: 200, json: async () => ({ ok: true, message: "removed" }) };
        }
        if (typeof url === "string" && url.includes("/members/")) {
          return { ok: true, status: 200, json: async () => ({ roles: ["ADMIN"] }) };
        }
        if (typeof url === "string" && url.includes("/callback")) {
          callbacks.push(JSON.parse((init?.body as string) ?? "{}"));
          return { ok: true, status: 200, json: async () => ({}) };
        }
        if (typeof url === "string" && url.includes("/messages/@original")) {
          // The edit uploads the footer icon as multipart on a cold cache, so
          // read the embed JSON from `payload_json` when the body is form-data.
          const body = init?.body;
          const json =
            body instanceof FormData
              ? JSON.parse(body.get("payload_json") as string)
              : JSON.parse((body as string) ?? "{}");
          patches.push(json);
          return { ok: true, status: 200, json: async () => ({ attachments: [] }) };
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

    ws.dispatch("INTERACTION_CREATE", {
      id: "int-btn",
      type: 3,
      token: "tok",
      channel_id: CHANNEL,
      guild_id: GUILD,
      data: { custom_id: `chan-unreg:${CHANNEL}:${OWNER}:e-1` },
      member: { user: { id: OWNER } },
    });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }

    // A confirm click is acknowledged up front with an INSTANT type-7
    // UPDATE_MESSAGE that drops the buttons (components: []) and shows a generic
    // "processing" state, BEFORE the async authorization, so a slow role lookup
    // cannot blow Discord's ~3s deadline and the buttons vanish immediately. The
    // message is then edited (via @original) to the owner-named interim
    // "unregistering..." state and finally to the result after teardown.
    const ack = callbacks.find((c) => c.type === 7);
    expect(ack).toBeDefined();
    expect(ack?.data?.components).toEqual([]);
    expect(ack?.data?.embeds?.[0]?.description).toContain("Processing the unregister request");
    const interim = patches.find((p) =>
      p.embeds?.[0]?.description?.includes("Unregistering channel"),
    );
    expect(interim?.components).toEqual([]);
    expect(unregisterCalls).toEqual([CHANNEL]);
    const patch = patches.at(-1);
    expect(patch?.components).toEqual([]);
    expect(patch?.embeds?.[0]?.description).toContain("has been unregistered");

    delete process.env.OPENCLAW_AUTH_GUILD_ID;
    delete process.env.OPENCLAW_ADMIN_ROLE_ID;
  });

  it("does not tear down when Discord rejects the confirm acknowledgement", async () => {
    process.env.OPENCLAW_AUTH_GUILD_ID = GUILD;
    process.env.OPENCLAW_ADMIN_ROLE_ID = "ADMIN";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("/unregister")) {
          const body = JSON.parse((init?.body as string) ?? "{}");
          unregisterCalls.push(body.channelId);
          return { ok: true, status: 200, json: async () => ({ ok: true, message: "removed" }) };
        }
        if (typeof url === "string" && url.includes("/members/")) {
          return { ok: true, status: 200, json: async () => ({ roles: ["ADMIN"] }) };
        }
        if (typeof url === "string" && url.includes("/callback")) {
          // Discord rejects the interaction ack (e.g. interaction expired).
          return { ok: false, status: 404, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ attachments: [], id: "app-123" }) };
      }) as unknown as typeof fetch,
    );

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    ws.dispatch("INTERACTION_CREATE", {
      id: "int-btn",
      type: 3,
      token: "tok",
      channel_id: CHANNEL,
      guild_id: GUILD,
      data: { custom_id: `chan-unreg:${CHANNEL}:${OWNER}:e-1` },
      member: { user: { id: OWNER } },
    });
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    // The ack was rejected, so teardown must NOT run.
    expect(unregisterCalls).toEqual([]);

    delete process.env.OPENCLAW_AUTH_GUILD_ID;
    delete process.env.OPENCLAW_ADMIN_ROLE_ID;
  });

  it("runs teardown once when the confirm button is double-clicked", async () => {
    // Authorize via the owner path (the initiator owns the channel on disk is not
    // available, so use the admin role like the single-click test).
    process.env.OPENCLAW_AUTH_GUILD_ID = GUILD;
    process.env.OPENCLAW_ADMIN_ROLE_ID = "ADMIN";
    const callbacks: { type: number }[] = [];
    // Hold the first /unregister in-flight so the second click lands while the
    // in-flight guard is set, exercising the double-click barrier.
    let releaseUnregister: (() => void) | undefined;
    const unregisterGate = new Promise<void>((resolve) => {
      releaseUnregister = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("/unregister")) {
          const body = JSON.parse((init?.body as string) ?? "{}");
          unregisterCalls.push(body.channelId);
          await unregisterGate;
          return { ok: true, status: 200, json: async () => ({ ok: true, message: "removed" }) };
        }
        if (typeof url === "string" && url.includes("/members/")) {
          return { ok: true, status: 200, json: async () => ({ roles: ["ADMIN"] }) };
        }
        if (typeof url === "string" && url.includes("/callback")) {
          callbacks.push(JSON.parse((init?.body as string) ?? "{}"));
          return { ok: true, status: 200, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => ({ attachments: [], id: "app-123" }) };
      }) as unknown as typeof fetch,
    );

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    const click = () =>
      ws.dispatch("INTERACTION_CREATE", {
        id: "int-btn",
        type: 3,
        token: "tok",
        channel_id: CHANNEL,
        guild_id: GUILD,
        data: { custom_id: `chan-unreg:${CHANNEL}:${OWNER}:e-1` },
        member: { user: { id: OWNER } },
      });
    // First click starts teardown (now blocked on the gate). Second click arrives
    // while the first is in-flight and must be a no-op for provisioning.
    click();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    click();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    // Only one teardown ran despite two clicks.
    expect(unregisterCalls).toEqual([CHANNEL]);
    // The first (claiming) confirm sends the instant type-7 processing update; the
    // second (ignored, already-in-flight) confirm uses a message-neutral type-6 ack
    // so it cannot overwrite the terminal result, yet still acks so it never
    // expires. One type-7 and one type-6, two acks total.
    expect(callbacks.filter((c) => c.type === 7).length).toBe(1);
    expect(callbacks.filter((c) => c.type === 6).length).toBe(1);

    releaseUnregister?.();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    // Still exactly one teardown after the first completes.
    expect(unregisterCalls).toEqual([CHANNEL]);

    delete process.env.OPENCLAW_AUTH_GUILD_ID;
    delete process.env.OPENCLAW_ADMIN_ROLE_ID;
  });

  it("ignores a Cancel click that arrives while a teardown is in flight", async () => {
    process.env.OPENCLAW_AUTH_GUILD_ID = GUILD;
    process.env.OPENCLAW_ADMIN_ROLE_ID = "ADMIN";
    const patches: { embeds?: { description?: string }[] }[] = [];
    let releaseUnregister: (() => void) | undefined;
    const unregisterGate = new Promise<void>((resolve) => {
      releaseUnregister = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("/unregister")) {
          const body = JSON.parse((init?.body as string) ?? "{}");
          unregisterCalls.push(body.channelId);
          await unregisterGate;
          return { ok: true, status: 200, json: async () => ({ ok: true, message: "removed" }) };
        }
        if (typeof url === "string" && url.includes("/members/")) {
          return { ok: true, status: 200, json: async () => ({ roles: ["ADMIN"] }) };
        }
        if (typeof url === "string" && url.includes("/messages/@original")) {
          const body = init?.body;
          const json =
            body instanceof FormData
              ? JSON.parse(body.get("payload_json") as string)
              : JSON.parse((body as string) ?? "{}");
          patches.push(json);
          return { ok: true, status: 200, json: async () => ({ attachments: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({ attachments: [], id: "app-123" }) };
      }) as unknown as typeof fetch,
    );

    void start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();

    // Confirm click starts teardown (blocked on the gate), then a Cancel click for
    // the same channel arrives mid-teardown. The Cancel must be ignored, not edit
    // the message to "cancelled".
    ws.dispatch("INTERACTION_CREATE", {
      id: "int-confirm",
      type: 3,
      token: "tok",
      channel_id: CHANNEL,
      guild_id: GUILD,
      data: { custom_id: `chan-unreg:${CHANNEL}:${OWNER}:e-1` },
      member: { user: { id: OWNER } },
    });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    ws.dispatch("INTERACTION_CREATE", {
      id: "int-cancel",
      type: 3,
      token: "tok",
      channel_id: CHANNEL,
      guild_id: GUILD,
      data: { custom_id: `chan-unreg-cancel:${CHANNEL}:${OWNER}:e-1` },
      member: { user: { id: OWNER } },
    });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    // No "cancelled" message was edited in while teardown runs.
    expect(patches.some((p) => p.embeds?.[0]?.description?.includes("cancelled"))).toBe(false);

    releaseUnregister?.();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    // Teardown completed exactly once, and the final message is the success result
    // (never overwritten by a stale cancellation).
    expect(unregisterCalls).toEqual([CHANNEL]);
    expect(patches.at(-1)?.embeds?.[0]?.description).toContain("has been unregistered");

    delete process.env.OPENCLAW_AUTH_GUILD_ID;
    delete process.env.OPENCLAW_ADMIN_ROLE_ID;
  });

  it("rejects a confirm button click from someone other than the initiator", async () => {
    const callbacks: { type: number; data?: { content?: string; flags?: number } }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("/unregister")) {
          const body = JSON.parse((init?.body as string) ?? "{}");
          unregisterCalls.push(body.channelId);
          return { ok: true, status: 200, json: async () => ({ ok: true, message: "removed" }) };
        }
        if (typeof url === "string" && url.includes("/callback")) {
          callbacks.push(JSON.parse((init?.body as string) ?? "{}"));
          return { ok: true, status: 200, json: async () => ({}) };
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

    ws.dispatch("INTERACTION_CREATE", {
      id: "int-btn2",
      type: 3,
      token: "tok",
      channel_id: CHANNEL,
      guild_id: GUILD,
      // custom_id names OWNER as initiator, but a different user clicks.
      data: { custom_id: `chan-unreg:${CHANNEL}:${OWNER}:e-1` },
      member: { user: { id: "444444444444444444" } },
    });
    await vi.advanceTimersByTimeAsync(0);

    // Ephemeral "not for you" (type 4, flags 64); nothing was unregistered.
    const ephemeral = callbacks.find((c) => c.type === 4);
    expect(ephemeral?.data?.content).toContain("isn't for you");
    expect(ephemeral?.data?.flags).toBe(64);
    expect(unregisterCalls).toEqual([]);
  });

  it("forwards the on-disk registration token as expectedRegToken on unregister", async () => {
    // A real instance dir with a persisted .reg-token: the router hydrates it on
    // reloadInstances and must carry it to the provisioner so the host can refuse a
    // stale purge. Covers the post-restart case (hostRegTokens starts empty).
    process.env.OPENCLAW_AUTH_GUILD_ID = GUILD;
    process.env.OPENCLAW_ADMIN_ROLE_ID = "ADMIN";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-regtok-"));
    fs.writeFileSync(path.join(dir, ".reg-token"), "host-tok-xyz");
    let unregBody: { channelId?: string; expectedRegToken?: string } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.includes("/unregister")) {
          unregBody = JSON.parse((init?.body as string) ?? "{}");
          return { ok: true, status: 200, json: async () => ({ ok: true, message: "removed" }) };
        }
        if (typeof url === "string" && url.includes("/members/")) {
          return { ok: true, status: 200, json: async () => ({ roles: ["ADMIN"] }) };
        }
        if (typeof url === "string" && url.includes("/callback")) {
          return { ok: true, status: 200, json: async () => ({}) };
        }
        if (typeof url === "string" && url.includes("/messages/@original")) {
          return { ok: true, status: 200, json: async () => ({ attachments: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({ attachments: [], id: "app-123" }) };
      }) as unknown as typeof fetch,
    );

    void start(dir);
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0];
    ws.emit("open");
    ws.hello();
    ws.ready();
    // Force a reload so the router hydrates the on-disk token into hostRegTokens.
    ws.dispatch("INTERACTION_CREATE", {
      id: "int-btn",
      type: 3,
      token: "tok",
      channel_id: CHANNEL,
      guild_id: GUILD,
      data: { custom_id: `chan-unreg:${CHANNEL}:${OWNER}:host-tok-xyz` },
      member: { user: { id: OWNER } },
    });
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(unregBody?.expectedRegToken).toBe("host-tok-xyz");

    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENCLAW_AUTH_GUILD_ID;
    delete process.env.OPENCLAW_ADMIN_ROLE_ID;
  });

  describe("owner gate on agent-facing slash commands", () => {
    const STRANGER = "444444444444444444";
    type Callback = { type: number; data?: { content?: string; flags?: number } };

    // Drive one interaction through the router and return what the user saw.
    const runInteraction = async (params: {
      command: "lifecycle" | "secret" | "connections";
      userId: string;
      guild: boolean;
      dmType?: number | null;
      ownerKnown: boolean;
      // Whether the channel has a registered instance. Defaults to true; set false
      // to exercise the ownerless (unregistered) channel path, which must still deny
      // a non-owner rather than falling through to a "not registered" reply.
      registered?: boolean;
    }) => {
      const registered = params.registered ?? true;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-gate-"));
      if (params.ownerKnown) {
        fs.writeFileSync(path.join(dir, ".onboarding.json"), JSON.stringify({ ownerId: OWNER }));
      }
      const callbacks: Callback[] = [];
      const patches: { embeds?: { description?: string }[] }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (typeof url === "string" && url.includes("/callback")) {
            callbacks.push(JSON.parse((init?.body as string) ?? "{}"));
            return { ok: true, status: 200, json: async () => ({}) };
          }
          if (typeof url === "string" && url.includes("/messages/@original")) {
            patches.push(payloadOf(init as RequestInit));
            return { ok: true, status: 200, json: async () => ({ attachments: [] }) };
          }
          return { ok: true, status: 200, json: async () => ({ id: "app-123" }) };
        }) as unknown as typeof fetch,
      );
      try {
        // An unregistered channel has an empty instances map, so instanceKey and
        // describeInstance resolve to nothing and the owner gate must fail closed.
        const config = registered
          ? makeConfig(dir)
          : {
              discordToken: "test-token",
              instances: new Map<string, InstanceConfig>(),
              instancesDir: "/tmp/does-not-matter",
              agentTimeoutMs: 1000,
            };
        const started = startRouter(config, runtime);
        startedRouters.push(started);
        void started;
        await vi.advanceTimersByTimeAsync(0);
        const ws = FakeWebSocket.instances[0];
        ws.emit("open");
        ws.hello();
        ws.ready();
        ws.dispatch("INTERACTION_CREATE", {
          id: "int-gate",
          type: 2,
          token: "tok",
          channel_id: CHANNEL,
          ...(params.guild ? { guild_id: GUILD, member: { user: { id: params.userId } } } : {}),
          ...(params.guild ? {} : { user: { id: params.userId } }),
          // A 1:1 DM by default; null drops the channel object entirely.
          ...(params.guild || params.dmType === null
            ? {}
            : { channel: { type: params.dmType ?? 1 } }),
          data: { name: params.command },
        });
        for (let i = 0; i < 5; i++) {
          await vi.advanceTimersByTimeAsync(0);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { callbacks, patches };
    };

    // Truth table over command x caller x surface x whether the owner is recorded.
    const cases = (["lifecycle", "secret", "connections"] as const).flatMap((command) =>
      [true, false].flatMap((guild) =>
        [OWNER, STRANGER].flatMap((userId) =>
          [true, false].map((ownerKnown) => ({ command, guild, userId, ownerKnown })),
        ),
      ),
    );

    for (const c of cases) {
      // Only a guild channel is gated, and only the recorded owner passes.
      const denied = c.guild && !(c.ownerKnown && c.userId === OWNER);
      const label = `${c.command} in ${c.guild ? "a guild channel" : "a DM"} by ${
        c.userId === OWNER ? "the owner" : "a stranger"
      } (owner ${c.ownerKnown ? "recorded" : "unknown"}) is ${denied ? "denied" : "allowed"}`;
      it(label, async () => {
        const { callbacks, patches } = await runInteraction(c);
        const deferred = callbacks.find((cb) => cb.type === 5);
        const notice = patches.find((patch) =>
          patch.embeds?.[0]?.description?.includes("not authorized"),
        );
        if (denied) {
          // Ephemeral deferred ack, then the standard notice edited in.
          expect(deferred?.data?.flags).toBe(64);
          expect(notice?.embeds?.[0]?.description).toContain(`<#${CHANNEL}>`);
          if (c.ownerKnown) {
            expect(notice?.embeds?.[0]?.description).toContain(`<@${OWNER}>`);
          }
          // Nothing else ran: no secret modal opened.
          expect(callbacks.some((cb) => cb.type === 9)).toBe(false);
        } else {
          expect(notice).toBeUndefined();
          const proceeded =
            c.command === "secret"
              ? callbacks.some((cb) => cb.type === 9)
              : deferred?.data?.flags === 64;
          expect(proceeded).toBe(true);
        }
      });
    }

    // Unregistered channel: no owner exists, so the gate fails closed. Every caller
    // in a guild is denied with the standard unauthorized notice, never the
    // "not registered" hint (the bug this gate fixes). Both a stranger and the
    // would-be owner are denied, since an unregistered channel has no owner at all.
    for (const command of ["lifecycle", "secret", "connections"] as const) {
      for (const userId of [STRANGER, OWNER]) {
        it(`denies ${userId === OWNER ? "the owner" : "a stranger"} running ${command} in an unregistered guild channel`, async () => {
          const { callbacks, patches } = await runInteraction({
            command,
            userId,
            guild: true,
            ownerKnown: true,
            registered: false,
          });
          // No secret modal opened and no command dispatched.
          expect(callbacks.some((cb) => cb.type === 9)).toBe(false);
          const notice = patches.find((patch) =>
            patch.embeds?.[0]?.description?.includes("not authorized"),
          );
          expect(notice).toBeDefined();
          // The "not registered" hint must never leak to a denied caller.
          expect(
            patches.some((patch) => patch.embeds?.[0]?.description?.includes("not registered")),
          ).toBe(false);
        });
      }
    }

    for (const command of ["lifecycle", "secret", "connections"] as const) {
      it(`denies a stranger running ${command} in a group DM`, async () => {
        const { callbacks, patches } = await runInteraction({
          command,
          userId: STRANGER,
          guild: false,
          dmType: 3,
          ownerKnown: true,
        });
        expect(callbacks.some((cb) => cb.type === 9)).toBe(false);
        expect(patches[0]?.embeds?.[0]?.description).toContain("not authorized");
      });

      it(`denies a stranger running ${command} when the channel metadata is missing`, async () => {
        const { callbacks, patches } = await runInteraction({
          command,
          userId: STRANGER,
          guild: false,
          dmType: null,
          ownerKnown: true,
        });
        expect(callbacks.some((cb) => cb.type === 9)).toBe(false);
        expect(patches[0]?.embeds?.[0]?.description).toContain("not authorized");
      });
    }

    it("answers a stranger's secret modal submit with the standard notice, ephemerally", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-gate-"));
      fs.writeFileSync(path.join(dir, ".onboarding.json"), JSON.stringify({ ownerId: OWNER }));
      const callbacks: Callback[] = [];
      const patches: { embeds?: { description?: string }[] }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (typeof url === "string" && url.includes("/callback")) {
            callbacks.push(JSON.parse((init?.body as string) ?? "{}"));
          } else if (typeof url === "string" && url.includes("/messages/@original")) {
            patches.push(payloadOf(init as RequestInit));
          }
          return { ok: true, status: 200, json: async () => ({ id: "app-123", attachments: [] }) };
        }) as unknown as typeof fetch,
      );
      try {
        void start(dir);
        await vi.advanceTimersByTimeAsync(0);
        const ws = FakeWebSocket.instances[0];
        ws.emit("open");
        ws.hello();
        ws.ready();
        ws.dispatch("INTERACTION_CREATE", {
          id: "int-modal",
          type: 5,
          token: "tok",
          channel_id: CHANNEL,
          guild_id: GUILD,
          member: { user: { id: STRANGER } },
          data: {
            custom_id: "secret-modal",
            components: [{ components: [{ custom_id: "secret-value", value: "hunter2" }] }],
          },
        });
        for (let i = 0; i < 5; i++) {
          await vi.advanceTimersByTimeAsync(0);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      expect(callbacks.find((cb) => cb.type === 5)?.data?.flags).toBe(64);
      expect(patches[0]?.embeds?.[0]?.description).toContain(`<@${OWNER}>`);
      expect(patches[0]?.embeds?.[0]?.description).toContain("not authorized");
    });

    it("sends the same wording for an unauthorized plain message and a slash command", async () => {
      const { buildUnauthorizedNoticeText } = await import("./unauthorized-notice.js");
      const { patches } = await runInteraction({
        command: "lifecycle",
        userId: STRANGER,
        guild: true,
        ownerKnown: true,
      });
      expect(patches[0]?.embeds?.[0]?.description).toBe(
        buildUnauthorizedNoticeText(CHANNEL, OWNER),
      );
    });
  });

  describe("/debug admin gate", () => {
    const ADMIN = "222222222222222222";
    const NON_ADMIN = "333333333333333333";
    type DebugCallback = { type: number; data?: { flags?: number } };
    type DebugPatch = {
      content?: string;
      embeds?: Array<{ title?: string; description?: string; footer?: { text?: string } }>;
    };

    // Parse an @original PATCH body whether it was sent as JSON (content edit) or
    // multipart (embed edit uploading the footer icon).
    const parsePatch = (init: RequestInit): DebugPatch => {
      const raw =
        init.body instanceof FormData
          ? (init.body.get("payload_json") as string)
          : (init.body as string);
      return JSON.parse(raw);
    };

    // Drive one /debug interaction. `admin` grants the caller admin via the
    // override-id env (no auth-guild lookup, so no network), matching how a real
    // admin is recognized without touching Discord's role API.
    const runDebug = async (params: { userId: string; admin: boolean; command?: string }) => {
      if (params.admin) {
        vi.stubEnv("OPENCLAW_ADMIN_OVERRIDE_IDS", params.userId);
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-debug-"));
      const callbacks: DebugCallback[] = [];
      const patches: DebugPatch[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (typeof url === "string" && url.includes("/callback")) {
            callbacks.push(JSON.parse((init?.body as string) ?? "{}"));
            return { ok: true, status: 200, json: async () => ({}) };
          }
          if (typeof url === "string" && url.includes("/messages/@original")) {
            patches.push(parsePatch(init as RequestInit));
            return { ok: true, status: 200, json: async () => ({ attachments: [] }) };
          }
          return { ok: true, status: 200, json: async () => ({ id: "app-123" }) };
        }) as unknown as typeof fetch,
      );
      try {
        void start(dir);
        await vi.advanceTimersByTimeAsync(0);
        const ws = FakeWebSocket.instances[0];
        ws.emit("open");
        ws.hello();
        ws.ready();
        ws.dispatch("INTERACTION_CREATE", {
          id: "int-debug",
          type: 2,
          token: "tok",
          channel_id: CHANNEL,
          guild_id: GUILD,
          member: { user: { id: params.userId } },
          data: {
            name: "debug",
            options:
              params.command !== undefined ? [{ name: "command", value: params.command }] : [],
          },
        });
        for (let i = 0; i < 6; i++) {
          await vi.advanceTimersByTimeAsync(0);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return { callbacks, patches };
    };

    it("defers ephemerally and denies a non-admin with the permission embed", async () => {
      const { callbacks, patches } = await runDebug({ userId: NON_ADMIN, admin: false });
      // Ephemeral deferred ack (type 5, flags 64), then the shared permission
      // embed (no bespoke plain-text denial).
      expect(callbacks.find((cb) => cb.type === 5)?.data?.flags).toBe(64);
      expect(patches[0]?.content).toBeUndefined();
      expect(patches[0]?.embeds?.[0]?.description).toContain("necessary permissions");
      expect(patches[0]?.embeds?.[0]?.description).toContain("`/debug`");
      // No help embed was rendered to a non-admin.
      expect(patches.some((p) => p.embeds?.[0]?.title === "Debug Subcommands")).toBe(false);
    });

    it("never dispatches a subcommand for a non-admin (admin is checked first)", async () => {
      // Even with a real subcommand, the denial lands and nothing is echoed.
      const { patches } = await runDebug({
        userId: NON_ADMIN,
        admin: false,
        command: "echo pwned",
      });
      expect(patches[0]?.embeds?.[0]?.description).toContain("necessary permissions");
      expect(patches.some((p) => p.content === "pwned")).toBe(false);
    });

    it("renders the help embed for an admin (empty input)", async () => {
      const { callbacks, patches } = await runDebug({ userId: ADMIN, admin: true });
      expect(callbacks.find((cb) => cb.type === 5)?.data?.flags).toBe(64);
      const help = patches.find((p) => p.embeds?.[0]?.title === "Debug Subcommands");
      expect(help?.embeds?.[0]?.footer?.text).toBe("Debug");
    });

    it("echoes raw content for an admin", async () => {
      const { patches } = await runDebug({
        userId: ADMIN,
        admin: true,
        command: 'echo "hello world"',
      });
      const echoed = patches.find((p) => p.content === "hello world");
      expect(echoed).toBeDefined();
      // The content edit clears any prior embeds (sends an empty array).
      expect(echoed?.embeds).toEqual([]);
    });

    it("delivers a secrettest secret via the slash branch and acks with the test embed", async () => {
      // Covers the interaction-specific wiring (deliverDebugSecret + the ephemeral
      // embed edit) that the plain-message path does not exercise. CHANNEL is
      // registered in the harness, so the secret is enqueued and acked.
      const { patches } = await runDebug({
        userId: ADMIN,
        admin: true,
        command: "secrettest slash-secret-value my-name",
      });
      const ack = patches.find((p) => p.embeds?.[0]?.title === "Send Test Secret");
      expect(ack).toBeDefined();
      expect(ack?.embeds?.[0]?.description).toContain("`my-name`");
    });
  });

  // The text-command path lets a tester/automation bot (which cannot invoke slash
  // commands) drive /debug as a plain message. Admin-gated the same way, but its
  // replies land in-channel because a bot cannot send a true ephemeral.
  describe("/debug text path", () => {
    const ADMIN_BOT = "444444444444444444";
    const NON_ADMIN_BOT = "555555555555555555";
    type TextReply = { content?: string; embeds?: Array<{ title?: string; description?: string }> };

    const runDebugText = async (params: { authorId: string; admin: boolean; content: string }) => {
      if (params.admin) {
        vi.stubEnv("OPENCLAW_ADMIN_OVERRIDE_IDS", params.authorId);
      }
      const posts: RequestInit[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            typeof url === "string" &&
            url.includes(`/channels/${CHANNEL}/messages`) &&
            init?.method === "POST"
          ) {
            posts.push(init);
            return new Response(JSON.stringify({ id: "debug-reply-1" }), { status: 200 });
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "app-123" }),
          } as unknown as Response;
        }) as unknown as typeof fetch,
      );

      void start();
      await vi.advanceTimersByTimeAsync(0);
      const ws = FakeWebSocket.instances[0];
      ws.emit("open");
      ws.hello();
      ws.ready();
      ws.dispatch("MESSAGE_CREATE", {
        id: "debug-text-msg",
        author: { id: params.authorId, bot: true },
        guild_id: GUILD,
        channel_id: CHANNEL,
        content: params.content,
        attachments: [],
      });
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      return { posts: posts.map((p) => payloadOf(p) as TextReply) };
    };

    it("lets an admin bot drive /debug echo via text, replying in-channel", async () => {
      const { posts } = await runDebugText({
        authorId: ADMIN_BOT,
        admin: true,
        content: "/debug echo hi-there",
      });
      expect(posts.some((p) => p.content === "hi-there")).toBe(true);
    });

    it("denies a non-admin bot's /debug text with the shared permission embed", async () => {
      const { posts } = await runDebugText({
        authorId: NON_ADMIN_BOT,
        admin: false,
        content: "/debug echo pwned",
      });
      expect(posts.some((p) => p.embeds?.[0]?.description?.includes("necessary permissions"))).toBe(
        true,
      );
      // The subcommand never ran, so the echoed text was never posted.
      expect(posts.some((p) => p.content === "pwned")).toBe(false);
    });

    it("delivers a secrettest secret and acks with the plaintext-test embed", async () => {
      const { posts } = await runDebugText({
        authorId: ADMIN_BOT,
        admin: true,
        content: "/debug secrettest test-value my-name",
      });
      const ack = posts.find((p) => p.embeds?.[0]?.title === "Send Test Secret");
      expect(ack).toBeDefined();
      expect(ack?.embeds?.[0]?.description).toContain("`my-name`");
    });

    it("still recognizes /debug when sent as a reply (parses the original body)", async () => {
      vi.stubEnv("OPENCLAW_ADMIN_OVERRIDE_IDS", ADMIN_BOT);
      const posts: RequestInit[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (
            typeof url === "string" &&
            url.includes(`/channels/${CHANNEL}/messages`) &&
            init?.method === "POST"
          ) {
            posts.push(init);
            return new Response(JSON.stringify({ id: "debug-reply-2" }), { status: 200 });
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ id: "app-123" }),
          } as unknown as Response;
        }) as unknown as typeof fetch,
      );
      void start();
      await vi.advanceTimersByTimeAsync(0);
      const ws = FakeWebSocket.instances[0];
      ws.emit("open");
      ws.hello();
      ws.ready();
      // A reply prefixes `content` with "[Replying to ...]"; the command must still
      // be parsed from the original body, not missed and routed to the agent.
      ws.dispatch("MESSAGE_CREATE", {
        id: "debug-reply-msg",
        author: { id: ADMIN_BOT, bot: true },
        guild_id: GUILD,
        channel_id: CHANNEL,
        content: "/debug echo from-a-reply",
        referenced_message: { author: { username: "someone" }, content: "earlier message" },
        attachments: [],
      });
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(
        posts.map((p) => payloadOf(p) as TextReply).some((p) => p.content === "from-a-reply"),
      ).toBe(true);
    });
  });

  describe("secret modal submit responses", () => {
    // Capture the deferred callback (type 5) and the @original PATCH payload so we
    // can assert the defer-then-edit Secrets embed path for both a success and a
    // notice branch of handleModalSubmit.
    type DeferCallback = { type: number; data?: { flags?: number } };
    type EmbedPatch = {
      embeds?: Array<{ title?: string; color?: number; footer?: { text?: string } }>;
    };

    const runModalSubmit = async (data: Record<string, unknown>) => {
      const callbacks: DeferCallback[] = [];
      const patches: EmbedPatch[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (typeof url === "string" && url.includes("/callback")) {
            callbacks.push(JSON.parse((init?.body as string) ?? "{}"));
            return { ok: true, status: 200, json: async () => ({}) };
          }
          if (typeof url === "string" && url.includes("/messages/@original")) {
            patches.push(payloadOf(init as RequestInit) as EmbedPatch);
            return { ok: true, status: 200, json: async () => ({ attachments: [] }) };
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
      // A 1:1 DM (channel type 1) on the registered channel skips the owner gate,
      // so the success/notice branches run without onboarding setup.
      ws.dispatch("INTERACTION_CREATE", {
        type: 5,
        id: "int-modal",
        token: "tok",
        channel_id: CHANNEL,
        channel: { type: 1 },
        user: { id: OWNER },
        data,
      });
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }
      return { callbacks, patches };
    };

    it("acks a submitted secret with a deferred ephemeral Secrets embed", async () => {
      const { callbacks, patches } = await runModalSubmit({
        custom_id: "secret-modal",
        components: [{ components: [{ custom_id: "secret-value", value: "tok" }] }],
      });
      // Deferred ephemerally (type 5, flag 64), then the Secrets embed edited in.
      expect(callbacks.find((cb) => cb.type === 5)?.data?.flags).toBe(64);
      const embed = patches[0]?.embeds?.[0];
      expect(embed?.title).toBe("Send Secret");
      expect(embed?.footer?.text).toBe("Secrets");
      expect(embed?.color).toBe(0x404cf2);
    });

    it("acks a missing value with a deferred ephemeral Secrets notice embed", async () => {
      const { callbacks, patches } = await runModalSubmit({
        custom_id: "secret-modal",
        components: [{ components: [{ custom_id: "secret-value", value: "" }] }],
      });
      expect(callbacks.find((cb) => cb.type === 5)?.data?.flags).toBe(64);
      expect(patches[0]?.embeds?.[0]?.title).toBe("Send Secret");
      expect(patches[0]?.embeds?.[0]?.footer?.text).toBe("Secrets");
    });
  });
});
