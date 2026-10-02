import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterRuntime } from "./types.js";
import { createSharedAuthTokenResolver, startModelProxyServer } from "./model-proxy.js";

const runtime: RouterRuntime = { log: vi.fn(), error: vi.fn() };

type StartedProxy = { baseUrl: string; close: () => Promise<void> };

function startTestProxy(
  opts: Omit<Parameters<typeof startModelProxyServer>[0], "runtime" | "port"> & {
    runtime?: RouterRuntime;
  },
): Promise<StartedProxy> {
  const { server } = startModelProxyServer({ runtime, ...opts, port: 0 });
  return new Promise((resolve) => {
    server.once("listening", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe("startModelProxyServer", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("strips client auth, injects the real bearer, and forwards body + stealth headers", async () => {
    let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
    const fetchImpl = (async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body as Buffer;
      captured = { url: String(url), headers, body: Buffer.from(body).toString() };
      return new Response("upstream-ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;

    const started = await startTestProxy({
      resolveAccessToken: async () => "REAL-TOKEN",
      upstreamBase: "https://upstream.test",
      fetchImpl,
    });
    close = started.close;

    const res = await fetch(`${started.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer PLACEHOLDER",
        "x-api-key": "placeholder",
        "anthropic-beta": "claude-code-20250219",
        "content-type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("upstream-ok");
    expect(captured?.url).toBe("https://upstream.test/v1/messages");
    expect(captured?.headers.authorization).toBe("Bearer REAL-TOKEN");
    expect(captured?.headers["x-api-key"]).toBeUndefined();
    expect(captured?.headers["anthropic-beta"]).toBe("claude-code-20250219");
    expect(captured?.body).toBe(JSON.stringify({ hello: "world" }));
  });

  it("streams the upstream response straight through", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-1,"));
        controller.enqueue(new TextEncoder().encode("chunk-2"));
        controller.close();
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;

    const started = await startTestProxy({
      resolveAccessToken: async () => "REAL-TOKEN",
      fetchImpl,
    });
    close = started.close;

    const res = await fetch(`${started.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe("chunk-1,chunk-2");
  });

  it("returns 502 and never forwards when the token cannot be resolved", async () => {
    const fetchImpl = vi.fn();
    const started = await startTestProxy({
      resolveAccessToken: async () => {
        throw new Error("no token");
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    close = started.close;

    const res = await fetch(`${started.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(502);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serves /health and rejects anything outside the proxied surface", async () => {
    const started = await startTestProxy({
      resolveAccessToken: async () => "REAL-TOKEN",
      fetchImpl: (async () => new Response("", { status: 200 })) as typeof fetch,
    });
    close = started.close;

    const health = await fetch(`${started.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const wrongPath = await fetch(`${started.baseUrl}/admin`, { method: "POST", body: "{}" });
    expect(wrongPath.status).toBe(404);

    const wrongMethod = await fetch(`${started.baseUrl}/v1/messages`);
    expect(wrongMethod.status).toBe(404);
  });
});

describe("createSharedAuthTokenResolver", () => {
  it("throws when the shared store has no anthropic-subscription OAuth profile", async () => {
    const instancesDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shared-auth-"));
    await fs.mkdir(path.join(instancesDir, "shared", "auth"), { recursive: true });
    const resolver = createSharedAuthTokenResolver(instancesDir);
    await expect(resolver()).rejects.toThrow(/No anthropic-subscription OAuth profile/);
  });
});
