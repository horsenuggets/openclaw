import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterRuntime } from "./router.js";
import { startContainerProxyServer } from "./container-proxy.js";

const runtime: RouterRuntime = { log: () => {}, error: () => {} };

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
});
