import http from "node:http";
import type { RouterRuntime } from "./router.js";

/**
 * Container proxy server. Agent containers run without direct Discord access, so
 * they POST here (the router shares the host network, loopback only) to send and
 * read Discord messages on their behalf. The router injects the actual send/read
 * implementations.
 */

const PROXY_PORT = 18800;

export type DiscordSendFn = (channelId: string, content: string) => Promise<{ messageId?: string }>;
export type OpenDMChannelFn = (userId: string) => Promise<string | null>;
export type DiscordSendEmbedFn = (
  channelId: string,
  embed: { title: string; description: string; color?: number },
) => Promise<void>;
/** Route a message through the same pipeline as user DMs. */
export type RouteMessageFn = (userId: string, channelId: string, message: string) => Promise<void>;

export function startContainerProxyServer(opts: {
  runtime: RouterRuntime;
  /**
   * Resolved Discord bot token owned by the router. Used for the direct REST
   * calls (`/discord/embed`, `/discord/read`) that don't go through an injected
   * helper. Falls back to `DISCORD_BOT_TOKEN` only when not provided so callers
   * that resolve the token via config (e.g. `OPENCLAW_DISCORD_TOKEN`) keep working.
   */
  discordToken?: string;
  /** Send a message to a Discord channel. Injected by the router. */
  discordSend?: DiscordSendFn;
  /** Open a DM channel with a user. Injected by the router. */
  openDMChannel?: OpenDMChannelFn;
  /** Send an embed to a Discord channel. Injected by the router. */
  discordSendEmbed?: DiscordSendEmbedFn;
  /** Route a message through the standard DM pipeline. Injected by the router. */
  routeMessage?: RouteMessageFn;
  /** Listen port; defaults to the fixed proxy port. Tests pass 0 for ephemeral. */
  port?: number;
}): { server: http.Server } {
  const { runtime } = opts;
  // Prefer the router-resolved token; fall back to the env var for compatibility.
  const resolvedToken = opts.discordToken || process.env.DISCORD_BOT_TOKEN || "";

  const server = http.createServer(async (req, res) => {
    // No CORS headers on purpose. These endpoints are unauthenticated and act
    // through the router's bot token; the only intended callers are the agent
    // containers (server-side, same-host loopback), which do not need CORS. A
    // wildcard Access-Control-Allow-Origin would let any webpage in a user's
    // browser reach 127.0.0.1 and drive the proxy cross-origin, so we omit it
    // to keep the surface non-browser-accessible.

    // Require application/json on POST routes. This blocks browser-originated
    // cross-origin "simple request" writes: a page can send a cross-origin POST
    // with a text/plain body without a preflight, but it cannot set
    // Content-Type: application/json without triggering a preflight, which the
    // browser then blocks (we return no CORS headers). Legitimate container
    // callers always send JSON, so this closes the write path without needing
    // per-request auth.
    if (req.method === "POST") {
      const contentType = req.headers["content-type"] ?? "";
      // Tolerate charset/parameters, e.g. "application/json; charset=utf-8".
      if (!contentType.split(";")[0].trim().toLowerCase().startsWith("application/json")) {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "content-type must be application/json" }));
        return;
      }
    }

    // Discord send proxy — containers POST here to send messages via the router.
    if (req.method === "POST" && req.url === "/discord/send") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body) as {
            userId?: string;
            text?: string;
            mediaUrl?: string;
            replyToId?: string;
          };
          if (!data.userId || !data.text) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "userId and text are required" }));
            return;
          }
          if (!opts.discordSend || !opts.openDMChannel) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "discord send not available" }));
            return;
          }

          const channelId = await opts.openDMChannel(data.userId);
          if (!channelId) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "could not open DM channel" }));
            return;
          }

          let content = data.text;
          // Attach media URL as a separate line if present
          if (data.mediaUrl) {
            content = content ? `${content}\n${data.mediaUrl}` : data.mediaUrl;
          }

          const result = await opts.discordSend(channelId, content);
          runtime.log(`[proxy] sent message to ${data.userId} via channel ${channelId}`);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              messageId: result.messageId ?? "unknown",
              channelId,
            }),
          );
        } catch (err) {
          runtime.error(`[proxy] send error: ${String(err)}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "send failed" }));
        }
      });
      return;
    }

    // System message — send embed + route through the same pipeline as user DMs
    if (req.method === "POST" && req.url === "/discord/system") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body) as {
            userId?: string;
            message?: string;
          };
          if (!data.userId || !data.message) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "userId and message required" }));
            return;
          }
          if (!opts.openDMChannel || !opts.discordSendEmbed || !opts.routeMessage) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "not available" }));
            return;
          }

          const channelId = await opts.openDMChannel(data.userId);
          if (!channelId) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "could not open DM channel" }));
            return;
          }

          // 1. Send embed showing the system message
          await opts.discordSendEmbed(channelId, {
            title: "System",
            description: data.message,
            color: 0x808080,
          });

          // 2. Route through the same pipeline as user messages
          void opts.routeMessage(data.userId, channelId, `[System: ${data.message}]`);

          runtime.log(
            `[system] sent system message to ${data.userId}: ${data.message.slice(0, 60)}`,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, channelId }));
        } catch (err) {
          runtime.error(`[system] error: ${String(err)}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    // Discord embed proxy — send an embed message to a user's DM
    if (req.method === "POST" && req.url === "/discord/embed") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body) as {
            userId?: string;
            title?: string;
            description?: string;
            color?: number;
          };
          if (!data.userId || !data.description) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "userId and description required" }));
            return;
          }
          if (!opts.openDMChannel) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "discord not available" }));
            return;
          }

          const channelId = await opts.openDMChannel(data.userId);
          if (!channelId) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "could not open DM channel" }));
            return;
          }

          // Send embed via Discord REST API directly
          const embedResp = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages`,
            {
              method: "POST",
              headers: {
                Authorization: `Bot ${resolvedToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                embeds: [
                  {
                    title: data.title ?? "System",
                    description: data.description,
                    color: data.color ?? 0x808080,
                  },
                ],
              }),
            },
          );
          // Surface a non-2xx Discord response instead of reporting success.
          if (!embedResp.ok) {
            runtime.error(`[proxy] embed failed: discord API ${embedResp.status}`);
            res.writeHead(embedResp.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "discord API error" }));
            return;
          }
          runtime.log(`[proxy] sent embed to ${data.userId}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, channelId }));
        } catch (err) {
          runtime.error(`[proxy] embed error: ${String(err)}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "embed failed" }));
        }
      });
      return;
    }

    // Discord read proxy — read messages from a user's DM
    if (req.method === "GET" && req.url?.startsWith("/discord/read")) {
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      const userId = url.searchParams.get("userId") ?? "";
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "10"), 50);

      if (!userId || !opts.openDMChannel) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "userId required" }));
        return;
      }

      try {
        const channelId = await opts.openDMChannel(userId);
        if (!channelId) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "could not open DM channel" }));
          return;
        }

        const msgsResp = await fetch(
          `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`,
          { headers: { Authorization: `Bot ${resolvedToken}` } },
        );
        if (!msgsResp.ok) {
          res.writeHead(msgsResp.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "discord API error" }));
          return;
        }

        const msgs = (await msgsResp.json()) as Array<{
          id: string;
          author: { username: string; bot?: boolean };
          content: string;
          timestamp: string;
          attachments?: Array<{ filename: string; content_type?: string }>;
          embeds?: Array<{ title?: string; description?: string }>;
        }>;

        // Format for easy reading
        const formatted = msgs.toReversed().map((m) => ({
          time: m.timestamp.slice(0, 19),
          author: m.author.username,
          bot: m.author.bot ?? false,
          content: m.content.slice(0, 300),
          attachments: (m.attachments ?? []).map((a) => a.filename),
          embeds: (m.embeds ?? []).map((e) => e.title ?? e.description?.slice(0, 80) ?? ""),
        }));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages: formatted }));
      } catch (err) {
        runtime.error(`[proxy] read error: ${String(err)}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "read failed" }));
      }
      return;
    }

    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  // Loopback-only by design: these endpoints are unauthenticated and act through
  // the router's bot token. Containers run with `network_mode host`, so they reach
  // the proxy over loopback and never need a public bind. We deliberately do NOT
  // honor the legacy `OPENCLAW_OAUTH_HOST` override (from the removed OAuth server),
  // which could otherwise expose these endpoints on a public interface.
  const proxyHost = "127.0.0.1";
  server.on("error", (err) => {
    runtime.error(`[proxy] server error: ${String(err)}`);
  });
  const port = opts.port ?? PROXY_PORT;
  server.listen(port, proxyHost, () => {
    const actual = (server.address() as { port?: number } | null)?.port ?? port;
    runtime.log(`[proxy] container proxy server listening on ${proxyHost}:${actual}`);
  });

  return { server };
}
