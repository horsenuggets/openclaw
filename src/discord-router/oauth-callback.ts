import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { RouterRuntime } from "./router.js";

const CALLBACK_PORT = 18800;

function successPage(title: string, message: string): string {
  const isError = title.toLowerCase().includes("error");
  const color = isError ? "#f04747" : "#43b581";
  const icon = isError ? "&#10007;" : "&#10003;";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenClaw</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0b0b11;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem}.card{background:#1a1a2e;border-radius:12px;padding:2rem;max-width:480px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.4)}h1{font-size:1.4rem;margin-bottom:.5rem;color:${color}}.icon{font-size:2.5rem;margin-bottom:.5rem}.sub{color:#aaa;margin-top:1rem;font-size:.9rem}</style>
</head><body><div class="card"><div class="icon">${icon}</div><h1>${title}</h1><p class="sub">${message}</p></div></body></html>`;
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
export function startOAuthCallbackServer(opts: { instancesDir: string; runtime: RouterRuntime }): {
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
      JSON.stringify({ nonce, host: "98.194.32.22", port: CALLBACK_PORT }),
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
