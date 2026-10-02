import { refreshAnthropicToken } from "@mariozechner/pi-ai";
import http from "node:http";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { AuthProfileStore, OAuthCredential } from "../../agents/auth-profiles/types.js";
import type { RouterRuntime } from "./types.js";
import {
  ANTHROPIC_SUBSCRIPTION_PROFILE_ID,
  ANTHROPIC_SUBSCRIPTION_PROVIDER,
  AUTH_STORE_LOCK_OPTIONS,
} from "../../agents/auth-profiles/constants.js";
import { ensureAuthStoreFile, resolveAuthStorePath } from "../../agents/auth-profiles/paths.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store.js";
import { loadJsonFile } from "../../infra/json-file.js";

/**
 * Credential-injecting reverse proxy for the Anthropic Messages API.
 *
 * Agent containers run token-free: they point their provider baseUrl at this
 * proxy (loopback) and send only a placeholder bearer. The proxy strips the
 * client auth, injects the real (refreshed) OAuth access token owned by the
 * router, and streams the upstream response straight back. The real credential
 * never leaves the router, so a compromised agent box has no token to steal.
 */

// Below the per-agent gateway allocation base (18789) so it never collides with
// agent-derived ports, and clear of the container proxy (18800) and health
// monitor (18801), which share the router container's host network.
const MODEL_PROXY_PORT = 18702;
const ANTHROPIC_BASE = "https://api.anthropic.com";

// Cap the buffered request body. A compromised host-networked box could
// otherwise stream unbounded data and exhaust the shared router's memory,
// taking down every channel. 32 MiB comfortably covers image-bearing requests.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

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
  /** Max buffered request body in bytes (defaults to {@link MAX_BODY_BYTES}). */
  maxBodyBytes?: number;
  /** Listen port; defaults to the fixed proxy port. Tests pass 0 for ephemeral. */
  port?: number;
}): { server: http.Server } {
  const { runtime } = opts;
  const upstreamBase = opts.upstreamBase ?? ANTHROPIC_BASE;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;

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
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) {
        return;
      }
      size += chunk.length;
      if (size > maxBodyBytes) {
        rejected = true;
        chunks.length = 0;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "request body too large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {
      // Client aborted or socket error; nothing left to forward.
      rejected = true;
    });
    req.on("end", () => {
      if (rejected) {
        return;
      }
      const body = Buffer.concat(chunks);
      chunks.length = 0;
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
            body,
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
          if (res.headersSent) {
            // The upstream status/headers were already sent, so a 502 here would
            // throw ERR_HTTP_HEADERS_SENT and reject in this detached async
            // handler, which could take down the shared router. Destroy the
            // socket so the client detects the interrupted stream instead.
            res.destroy();
          } else {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "upstream request failed" }));
          }
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

/** Load ONLY the store file at `authPath`, without the main-agent cross-merge. */
function loadSharedStore(authPath: string): AuthProfileStore {
  const raw = loadJsonFile(authPath);
  return raw && typeof raw === "object" && "profiles" in raw
    ? (raw as AuthProfileStore)
    : { version: 1, profiles: {} };
}

/**
 * Build a token resolver backed by the shared auth store the real OAuth token
 * lives in. Reads only that store (never `ensureAuthProfileStore`, which
 * cross-merges the router's own main-agent profiles and could select the wrong
 * account or make an empty shared store look populated), and refreshes in place
 * under the store lock when the token has expired. Refresh ownership lives here,
 * in the router, so the agent boxes stay token-free.
 */
export function createSharedAuthTokenResolver(instancesDir: string): ResolveAccessToken {
  const sharedAuthDir = path.join(instancesDir, "shared", "auth");
  const authPath = resolveAuthStorePath(sharedAuthDir);
  return async () => {
    const cred = loadSharedStore(authPath).profiles[ANTHROPIC_SUBSCRIPTION_PROFILE_ID];
    if (!cred || cred.type !== "oauth" || cred.provider !== ANTHROPIC_SUBSCRIPTION_PROVIDER) {
      throw new Error(
        `No ${ANTHROPIC_SUBSCRIPTION_PROVIDER} OAuth profile "${ANTHROPIC_SUBSCRIPTION_PROFILE_ID}" ` +
          `in shared auth store at ${sharedAuthDir}`,
      );
    }
    if (Date.now() < cred.expires) {
      return cred.access;
    }
    return refreshSharedToken(authPath, sharedAuthDir);
  };
}

/** Refresh the expired shared token under the store lock, persisting only there. */
async function refreshSharedToken(authPath: string, sharedAuthDir: string): Promise<string> {
  ensureAuthStoreFile(authPath);
  const release = await lockfile.lock(authPath, AUTH_STORE_LOCK_OPTIONS);
  try {
    const store = loadSharedStore(authPath);
    const cred = store.profiles[ANTHROPIC_SUBSCRIPTION_PROFILE_ID];
    if (!cred || cred.type !== "oauth") {
      throw new Error(`No ${ANTHROPIC_SUBSCRIPTION_PROVIDER} OAuth profile to refresh`);
    }
    // Another request may have refreshed while we waited for the lock.
    if (Date.now() < cred.expires) {
      return cred.access;
    }
    const refreshed = await refreshAnthropicToken(cred.refresh);
    const next: OAuthCredential = { ...cred, ...refreshed, type: "oauth" };
    store.profiles[ANTHROPIC_SUBSCRIPTION_PROFILE_ID] = next;
    saveAuthProfileStore(store, sharedAuthDir);
    return refreshed.access;
  } finally {
    await release().catch(() => {});
  }
}
