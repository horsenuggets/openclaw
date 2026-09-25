import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterRuntime } from "./router.js";
import { startContainerProxyServer } from "./container-proxy.js";

const runtime: RouterRuntime = { log: () => {}, error: () => {} };

/**
 * Spy on global fetch but only intercept Discord REST calls; requests to the
 * local proxy (the test's own client calls) fall through to the real fetch so
 * the server still receives them.
 */
function mockDiscordFetch(handler: (url: string, init?: RequestInit) => Response) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://discord.com/")) {
      return Promise.resolve(handler(url, init));
    }
    return realFetch(input, init);
  });
}

describe("container proxy server", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
    vi.restoreAllMocks();
  });

  /** Start the proxy on an ephemeral port and return its base URL. */
  function start(opts: Parameters<typeof startContainerProxyServer>[0]): Promise<string> {
    const { server } = startContainerProxyServer({ ...opts, port: 0 });
    close = () => new Promise((resolve) => server.close(() => resolve()));
    return new Promise((resolve) => {
      server.on("listening", () => {
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  it("opens a DM and sends a message for /discord/send", async () => {
    const openDMChannel = vi.fn(async () => "chan-1");
    const discordSend = vi.fn(async () => ({ messageId: "m-1" }));
    const base = await start({ runtime, openDMChannel, discordSend });

    const resp = await fetch(`${base}/discord/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u-1", text: "hi", mediaUrl: "http://x/img.png" }),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ ok: true, messageId: "m-1", channelId: "chan-1" });
    expect(openDMChannel).toHaveBeenCalledWith("u-1");
    // The media URL is appended on its own line.
    expect(discordSend).toHaveBeenCalledWith("chan-1", "hi\nhttp://x/img.png");
  });

  it("rejects /discord/send without required fields", async () => {
    const base = await start({ runtime, openDMChannel: vi.fn(), discordSend: vi.fn() });
    const resp = await fetch(`${base}/discord/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u-1" }),
    });
    expect(resp.status).toBe(400);
  });

  it("returns 503 when the send dependency is not wired", async () => {
    const base = await start({ runtime });
    const resp = await fetch(`${base}/discord/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u-1", text: "hi" }),
    });
    expect(resp.status).toBe(503);
  });

  it("answers the health check", async () => {
    const base = await start({ runtime });
    const resp = await fetch(`${base}/health`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });

  it("posts an embed via the router-resolved token for /discord/embed", async () => {
    const openDMChannel = vi.fn(async () => "chan-9");
    // Mock the Discord REST call the embed handler makes directly.
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mockDiscordFetch((url, init) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    });
    const base = await start({ runtime, openDMChannel, discordToken: "router-tok" });

    const resp = await fetch(`${base}/discord/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "u-9", title: "Hi", description: "body" }),
    });

    expect(resp.status).toBe(200);
    expect(openDMChannel).toHaveBeenCalledWith("u-9");
    // The Discord REST call must use the injected router token, not DISCORD_BOT_TOKEN.
    expect(calls[0].url).toContain("/channels/chan-9/messages");
    const headers = calls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bot router-tok");
  });

  it("reads messages via the router-resolved token for /discord/read", async () => {
    const openDMChannel = vi.fn(async () => "chan-7");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mockDiscordFetch((url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify([
          {
            id: "1",
            author: { username: "alice", bot: false },
            content: "hello",
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ]),
        { status: 200 },
      );
    });
    const base = await start({ runtime, openDMChannel, discordToken: "router-tok" });

    const resp = await fetch(`${base}/discord/read?userId=u-7&limit=5`);

    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({
      messages: [{ author: "alice", content: "hello" }],
    });
    const headers = calls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bot router-tok");
  });

  it("surfaces Discord API failures from /discord/read", async () => {
    const openDMChannel = vi.fn(async () => "chan-7");
    mockDiscordFetch(() => new Response("nope", { status: 403 }));
    const base = await start({ runtime, openDMChannel, discordToken: "router-tok" });

    const resp = await fetch(`${base}/discord/read?userId=u-7`);
    expect(resp.status).toBe(403);
  });
});
