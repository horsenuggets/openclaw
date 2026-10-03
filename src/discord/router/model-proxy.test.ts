import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterRuntime } from "./types.js";
import { ANTHROPIC_SUBSCRIPTION_PROFILE_ID } from "../../agents/auth-profiles/constants.js";
import { createSharedAuthTokenResolver, startModelProxyServer } from "./model-proxy.js";

const runtime: RouterRuntime = { log: vi.fn(), error: vi.fn() };
const FUTURE = 4102444800000;

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

  it("rejects an oversized request body with 413 and never forwards", async () => {
    const fetchImpl = vi.fn();
    const started = await startTestProxy({
      resolveAccessToken: async () => "REAL-TOKEN",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxBodyBytes: 16,
    });
    close = started.close;

    const res = await fetch(`${started.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(64),
    }).catch((err) => err as Error);

    if (res instanceof Error) {
      // Some runtimes surface the mid-upload reset as a fetch error instead of a
      // 413 response; either way the key guarantee is that we never forwarded.
      expect(fetchImpl).not.toHaveBeenCalled();
    } else {
      expect(res.status).toBe(413);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("survives an upstream stream failure after headers are sent (no router crash)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      pull(controller) {
        controller.error(new Error("stream broke"));
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as typeof fetch;

    const started = await startTestProxy({
      resolveAccessToken: async () => "REAL-TOKEN",
      fetchImpl,
    });
    close = started.close;

    // The streamed request fails mid-body; swallow whatever the client observes.
    await fetch(`${started.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then((r) => r.text())
      .catch(() => undefined);

    // The server must still be alive and serving (it did not crash on the
    // ERR_HTTP_HEADERS_SENT path).
    const health = await fetch(`${started.baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  it("rejects a non-JSON content-type with 415 before resolving auth or forwarding", async () => {
    const resolveAccessToken = vi.fn(async () => "REAL-TOKEN");
    const fetchImpl = vi.fn();
    const started = await startTestProxy({
      resolveAccessToken,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    close = started.close;

    const res = await fetch(`${started.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });

    expect(res.status).toBe(415);
    expect(resolveAccessToken).not.toHaveBeenCalled();
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

  it("binds loopback by default", async () => {
    const { server } = startModelProxyServer({
      runtime,
      resolveAccessToken: async () => "REAL-TOKEN",
      port: 0,
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    close = () => new Promise<void>((done) => server.close(() => done()));
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("honors an explicitly provided bindHost (prod passes the bridge gateway IP)", async () => {
    // Bind a loopback address distinct from the 127.0.0.1 default so the test fails
    // if bindHost were ignored. ::1 stands in for the private bridge gateway here (a
    // real gateway IP is not bindable in CI); wildcard/public values are rejected
    // upstream by resolveProxyBindHost.
    const { server } = startModelProxyServer({
      runtime,
      resolveAccessToken: async () => "REAL-TOKEN",
      port: 0,
      bindHost: "::1",
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    close = () => new Promise<void>((done) => server.close(() => done()));
    expect((server.address() as AddressInfo).address).toBe("::1");
  });
});

describe("createSharedAuthTokenResolver", () => {
  async function seedSharedStore(profiles: Record<string, unknown>): Promise<string> {
    const instancesDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shared-auth-"));
    const authDir = path.join(instancesDir, "shared", "auth");
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(
      path.join(authDir, "auth-profiles.json"),
      JSON.stringify({ version: 1, profiles }, null, 2),
    );
    return instancesDir;
  }

  it("throws when the shared store has no anthropic-subscription OAuth profile", async () => {
    const instancesDir = await seedSharedStore({});
    const resolver = createSharedAuthTokenResolver(instancesDir);
    await expect(resolver()).rejects.toThrow(/No anthropic-subscription OAuth profile/);
  });

  it("resolves the access token from the canonical anthropic-subscription profile", async () => {
    const instancesDir = await seedSharedStore({
      [ANTHROPIC_SUBSCRIPTION_PROFILE_ID]: {
        type: "oauth",
        provider: "anthropic-subscription",
        access: "sk-ant-oat01-REAL-ACCESS",
        refresh: "refresh-token",
        expires: FUTURE,
      },
    });
    const resolver = createSharedAuthTokenResolver(instancesDir);
    await expect(resolver()).resolves.toBe("sk-ant-oat01-REAL-ACCESS");
  });

  it("does not resolve a profile stored under a non-canonical id", async () => {
    const instancesDir = await seedSharedStore({
      "anthropic-subscription": {
        type: "oauth",
        provider: "anthropic-subscription",
        access: "legacy-id-token",
        refresh: "",
        expires: FUTURE,
      },
    });
    const resolver = createSharedAuthTokenResolver(instancesDir);
    await expect(resolver()).rejects.toThrow(/No anthropic-subscription OAuth profile/);
  });

  it("ignores OAuth profiles for other providers", async () => {
    const instancesDir = await seedSharedStore({
      [ANTHROPIC_SUBSCRIPTION_PROFILE_ID]: {
        type: "oauth",
        provider: "openai",
        access: "oai-access",
        refresh: "oai-refresh",
        expires: FUTURE,
      },
    });
    const resolver = createSharedAuthTokenResolver(instancesDir);
    await expect(resolver()).rejects.toThrow(/No anthropic-subscription OAuth profile/);
  });

  it("reads only the shared store and never the router's main-agent store", async () => {
    // Populate a main-agent store (what ensureAuthProfileStore would cross-merge).
    const prev = process.env.OPENCLAW_STATE_DIR;
    const mainState = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-state-"));
    const mainAgentDir = path.join(mainState, "agents", "main", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.writeFile(
      path.join(mainAgentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          [ANTHROPIC_SUBSCRIPTION_PROFILE_ID]: {
            type: "oauth",
            provider: "anthropic-subscription",
            access: "MAIN-ACCOUNT-TOKEN",
            refresh: "",
            expires: FUTURE,
          },
        },
      }),
    );
    process.env.OPENCLAW_STATE_DIR = mainState;
    try {
      // Shared store is empty: a correct resolver must NOT fall back to main.
      const instancesDir = await seedSharedStore({});
      const resolver = createSharedAuthTokenResolver(instancesDir);
      await expect(resolver()).rejects.toThrow(/No anthropic-subscription OAuth profile/);
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prev;
      }
    }
  });
});
