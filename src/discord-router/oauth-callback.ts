import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { RouterRuntime } from "./router.js";

const CALLBACK_PORT = 18800;

function successPage(title: string, message: string): string {
  const isError = title.toLowerCase().includes("error");
  const color = isError ? "#f04747" : "#43b581";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenClaw</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Lexend:wght@400;500&display=swap" rel="stylesheet">
<style>body{font-family:'Lexend',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#000;color:#fff}
.wrap{text-align:center;max-width:420px;padding:2rem}h1{font-size:1.3rem;font-weight:500;color:${color};margin-bottom:.75rem}p{font-size:.95rem;font-weight:400;color:#aaa;line-height:1.5}</style>
</head><body><div class="wrap"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

type OAuthCredentials = {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
};

type PendingAuth = {
  discordUserId: string;
  email: string;
  nonce: string;
  createdAt: number;
  resolve: (code: string) => void;
};

/**
 * OAuth callback server that receives auth codes from the GitHub Pages relay.
 * Runs on port 18800 and handles Google OAuth token exchange.
 */
export type AuthCompleteCallback = (params: { discordUserId: string; code: string }) => void;

export type DiscordSendFn = (channelId: string, content: string) => Promise<{ messageId?: string }>;
export type OpenDMChannelFn = (userId: string) => Promise<string | null>;

export function startOAuthCallbackServer(opts: {
  instancesDir: string;
  runtime: RouterRuntime;
  onAuthComplete?: AuthCompleteCallback;
  /** Send a message to a Discord channel. Injected by the router. */
  discordSend?: DiscordSendFn;
  /** Open a DM channel with a user. Injected by the router. */
  openDMChannel?: OpenDMChannelFn;
}): {
  server: http.Server;
  requestAuth: (params: { discordUserId: string; email: string }) => {
    authUrl: string;
    waitForCode: () => Promise<string>;
  };
} {
  const { instancesDir, runtime } = opts;
  const pending = new Map<string, PendingAuth>();

  const server = http.createServer(async (req, res) => {
    // CORS headers for the GitHub Pages callback
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/auth/receive") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          // Support both JSON and form-encoded POST
          let code: string;
          let state: string;
          const contentType = req.headers["content-type"] ?? "";
          if (contentType.includes("application/x-www-form-urlencoded")) {
            const params = new URLSearchParams(body);
            code = params.get("code") ?? "";
            state = params.get("state") ?? "";
          } else {
            const data = JSON.parse(body);
            code = data.code as string;
            state = data.state as string;
          }

          if (!code || !state) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(successPage("Error", "Missing authorization code."));
            return;
          }

          // Decode state to find the pending auth request
          let stateData: { nonce: string; host: string; port: number };
          try {
            stateData = JSON.parse(Buffer.from(state, "base64url").toString());
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid state" }));
            return;
          }

          const pendingAuth = pending.get(stateData.nonce);
          if (!pendingAuth) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(
              successPage(
                "Authorization Received",
                "Your Google account has been connected. You can close this tab.",
              ),
            );
            return;
          }

          runtime.log(`[oauth] received code for ${pendingAuth.email}`);
          pending.delete(stateData.nonce);
          pendingAuth.resolve(code);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            successPage(
              "Authorization Complete!",
              "Your Google account has been connected to OpenClaw. You can close this tab.",
            ),
          );
        } catch (err) {
          runtime.error(`[oauth] error processing callback: ${err}`);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(successPage("Error", "Something went wrong. Please try again."));
        }
      });
      return;
    }

    // GET callback — receives code via redirect from GitHub Pages relay
    if (req.method === "GET" && req.url?.startsWith("/auth/receive")) {
      const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";

      if (!code || !state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successPage("Error", "Missing authorization code."));
        return;
      }

      let stateData: { nonce: string; host: string; port: number };
      try {
        stateData = JSON.parse(Buffer.from(state, "base64url").toString());
      } catch {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successPage("Error", "Invalid state parameter."));
        return;
      }

      const pendingAuth = pending.get(stateData.nonce);
      if (pendingAuth) {
        runtime.log(`[oauth] received code for ${pendingAuth.email} via redirect`);
        pending.delete(stateData.nonce);
        pendingAuth.resolve(code);
        opts.onAuthComplete?.({ discordUserId: pendingAuth.discordUserId, code });
      } else {
        runtime.log(`[oauth] received code via redirect (no pending auth, nonce may have expired)`);
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        successPage(
          "Authorization Complete!",
          "Your Google account has been connected to OpenClaw. You can close this tab.",
        ),
      );
      return;
    }

    // Discord send proxy — containers POST here to send messages via the router
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
          runtime.error(`[proxy] send error: ${err}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "send failed" }));
        }
      });
      return;
    }

    // Trigger auth for a user — generates an OAuth URL and sends it to their Discord DM.
    // POST /auth/trigger { userId: "discordUserId" }
    if (req.method === "POST" && req.url === "/auth/trigger") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body) as { userId?: string };
          if (!data.userId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "userId is required" }));
            return;
          }
          if (!opts.discordSend || !opts.openDMChannel) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "discord not available" }));
            return;
          }

          const { authUrl } = requestAuth({ discordUserId: data.userId, email: "user" });
          const channelId = await opts.openDMChannel(data.userId);
          if (!channelId) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "could not open DM channel" }));
            return;
          }

          await opts.discordSend(
            channelId,
            `Would you like to connect your Google account? This lets me help with your calendar, email, files, and more.\n\nClick [here](${authUrl}) to connect your Google account.`,
          );
          runtime.log(`[auth/trigger] sent auth link to ${data.userId}`);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, authUrl }));
        } catch (err) {
          runtime.error(`[auth/trigger] error: ${err}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    // Health check
    if (req.method === "GET" && req.url === "/auth/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, pending: pending.size }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  server.listen(CALLBACK_PORT, "0.0.0.0", () => {
    runtime.log(`[oauth] callback server listening on port ${CALLBACK_PORT}`);
  });

  function requestAuth(params: { discordUserId: string; email: string }) {
    // Load web OAuth credentials
    const credsPath = path.join(
      instancesDir,
      params.discordUserId,
      "gogcli",
      "credentials-web.json",
    );
    let creds: OAuthCredentials;
    try {
      creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
    } catch {
      // Fall back to shared credentials
      const sharedPath = path.join(instancesDir, "credentials-web.json");
      creds = JSON.parse(fs.readFileSync(sharedPath, "utf-8"));
    }

    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const stateData = Buffer.from(
      JSON.stringify({
        nonce,
        host: process.env.OPENCLAW_OAUTH_HOST ?? "127.0.0.1",
        port: CALLBACK_PORT,
      }),
    ).toString("base64url");

    const scopes = [
      "email",
      "openid",
      "profile",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/contacts",
      "https://www.googleapis.com/auth/tasks",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/presentations",
    ].join(" ");

    const authUrl =
      `https://accounts.google.com/o/oauth2/auth?` +
      `access_type=offline&` +
      `client_id=${encodeURIComponent(creds.client_id)}&` +
      `redirect_uri=${encodeURIComponent(creds.redirect_uri)}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `prompt=consent&` +
      `state=${stateData}`;

    let resolveCode: (code: string) => void;
    const codePromise = new Promise<string>((resolve) => {
      resolveCode = resolve;
    });

    pending.set(nonce, {
      discordUserId: params.discordUserId,
      email: params.email,
      nonce,
      createdAt: Date.now(),
      resolve: resolveCode!,
    });

    // Clean up after 10 minutes
    setTimeout(() => {
      if (pending.has(nonce)) {
        pending.delete(nonce);
        runtime.log(`[oauth] auth request expired for ${params.email}`);
      }
    }, 600_000);

    return {
      authUrl,
      waitForCode: () => codePromise,
    };
  }

  return { server, requestAuth };
}
