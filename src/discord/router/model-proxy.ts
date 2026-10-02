import http from "node:http";
import path from "node:path";
import type { RouterRuntime } from "./types.js";
import { resolveApiKeyForProfile } from "../../agents/auth-profiles/oauth.js";
import { ensureAuthProfileStore } from "../../agents/auth-profiles/store.js";

/**
 * Credential-injecting reverse proxy for the Anthropic Messages API.
 *
 * Agent containers run token-free: they point their provider baseUrl at this
 * proxy (loopback) and send only a placeholder bearer. The proxy strips the
 * client auth, injects the real (refreshed) OAuth access token owned by the
 * router, and streams the upstream response straight back. The real credential
 * never leaves the router, so a compromised agent box has no token to steal.
 */

const MODEL_PROXY_PORT = 18801;
const ANTHROPIC_BASE = "https://api.anthropic.com";
const ANTHROPIC_SUBSCRIPTION_PROVIDER = "anthropic-subscription";

/** Resolve a fresh access token to inject. Throws when none is available. */
export type ResolveAccessToken = () => Promise<string>;

export function startModelProxyServer(opts: {
  runtime: RouterRuntime;
  /** Returns a valid (refreshed) access token to inject as the bearer. */
  resolveAccessToken: ResolveAccessToken;
  /** Upstream base URL. Defaults to the Anthropic API. */
  upstreamBase?: string;
  /** Injected fetch for the upstream call (tests stub this). */
  fetchImpl?: typeof fetch;
  /** Listen port; defaults to the fixed proxy port. Tests pass 0 for ephemeral. */
  port?: number;
}): { server: http.Server } {
  const { runtime } = opts;
  const upstreamBase = opts.upstreamBase ?? ANTHROPIC_BASE;
  const doFetch = opts.fetchImpl ?? fetch;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Only the Anthropic API surface is proxied. Everything else is rejected so
    // the proxy can never be turned into an open relay to arbitrary hosts.
    if (req.method !== "POST" || !req.url?.startsWith("/v1/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        let token: string;
        try {
          token = await opts.resolveAccessToken();
        } catch (err) {
          runtime.error(`[model-proxy] token resolve failed: ${String(err)}`);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "upstream auth unavailable" }));
          return;
        }

        // Forward every client header except the auth material (we replace it)
        // and hop-by-hop headers the upstream must set itself. The stealth
        // headers (anthropic-beta, anthropic-version, user-agent) ride along so
        // subscription billing shaping is preserved.
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value !== "string") {
            continue;
          }
          const lower = key.toLowerCase();
          if (
            lower === "authorization" ||
            lower === "x-api-key" ||
            lower === "host" ||
            lower === "content-length" ||
            lower === "connection"
          ) {
            continue;
          }
          headers[key] = value;
        }
        headers.authorization = `Bearer ${token}`;

        try {
          const upstream = await doFetch(`${upstreamBase}${req.url}`, {
            method: "POST",
            headers,
            body: Buffer.concat(chunks),
          });

          res.writeHead(upstream.status, {
            "Content-Type": upstream.headers.get("content-type") ?? "application/json",
          });
          if (upstream.body) {
            const reader = upstream.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              res.write(value);
            }
          }
          res.end();
        } catch (err) {
          runtime.error(`[model-proxy] forward failed: ${String(err)}`);
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "upstream request failed" }));
        }
      })();
    });
  });

  // Loopback-only by design: the proxy acts through the router-owned OAuth token
  // and is reachable by host-networked agent containers over 127.0.0.1. It must
  // never bind a public interface.
  const proxyHost = "127.0.0.1";
  server.on("error", (err) => {
    runtime.error(`[model-proxy] server error: ${String(err)}`);
  });
  const port = opts.port ?? MODEL_PROXY_PORT;
  server.listen(port, proxyHost, () => {
    const actual = (server.address() as { port?: number } | null)?.port ?? port;
    runtime.log(`[model-proxy] listening on ${proxyHost}:${actual}`);
  });

  return { server };
}

/**
 * Build a token resolver backed by the shared auth store the agent containers
 * used to mount. Picks the anthropic-subscription OAuth profile and resolves it
 * (refreshing under the store lock when expired) via the same path the agents
 * use, so refresh ownership moves cleanly to the router.
 */
export function createSharedAuthTokenResolver(instancesDir: string): ResolveAccessToken {
  const sharedAuthDir = path.join(instancesDir, "shared", "auth");
  return async () => {
    const store = ensureAuthProfileStore(sharedAuthDir);
    const profileId = Object.keys(store.profiles).find((id) => {
      const profile = store.profiles[id];
      return profile?.type === "oauth" && profile.provider === ANTHROPIC_SUBSCRIPTION_PROVIDER;
    });
    if (!profileId) {
      throw new Error(`No ${ANTHROPIC_SUBSCRIPTION_PROVIDER} OAuth profile in shared auth store at ${sharedAuthDir}`);
    }
    const resolved = await resolveApiKeyForProfile({
      store,
      profileId,
      agentDir: sharedAuthDir,
    });
    if (!resolved?.apiKey) {
      throw new Error(`Failed to resolve ${ANTHROPIC_SUBSCRIPTION_PROVIDER} access token`);
    }
    return resolved.apiKey;
  };
}
