import type { OAuthCredentials } from "@mariozechner/pi-ai";
import crypto from "node:crypto";
import http from "node:http";

// Claude Code's public OAuth client and endpoints (same client id pi-ai uses
// for the paste flow; here we drive a localhost callback instead so the redirect
// can be tunnelled back from a laptop to the deploy host).
export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const ANTHROPIC_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";
const CALLBACK_PATH = "/callback";
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function callbackRedirectUri(port: number): string {
  return `http://localhost:${port}${CALLBACK_PATH}`;
}

export function buildAnthropicAuthorizeUrl(params: {
  challenge: string;
  state: string;
  redirectUri: string;
}): string {
  const query = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_CLIENT_ID,
    response_type: "code",
    redirect_uri: params.redirectUri,
    scope: ANTHROPIC_OAUTH_SCOPES,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    state: params.state,
  });
  return `${ANTHROPIC_AUTHORIZE_URL}?${query.toString()}`;
}

export async function exchangeAnthropicCode(params: {
  code: string;
  verifier: string;
  state: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthCredentials> {
  const doFetch = params.fetchImpl ?? fetch;
  const response = await doFetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_CLIENT_ID,
      code: params.code,
      state: params.state,
      redirect_uri: params.redirectUri,
      code_verifier: params.verifier,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }
  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    // Match pi-ai: subtract a 5 min buffer so refreshes fire before hard expiry.
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

// Run a one-shot localhost HTTP server that captures the OAuth redirect
// (`/callback?code=...&state=...`) and resolves with the code. Binds `localhost`
// by default; pass a bindHost of "0.0.0.0" when the redirect must reach the
// server through a bind-mount/container boundary. onReady fires once the server
// is listening so callers only advertise the auth URL after the port is live.
export function captureAuthCode(params: {
  port: number;
  bindHost?: string;
  expectedState: string;
  timeoutMs?: number;
  onReady?: (port: number) => void;
}): Promise<string> {
  const bindHost = params.bindHost ?? "localhost";
  const timeoutMs = params.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end("Not found.");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const fail = (status: number, message: string) => {
        res
          .writeHead(status, { "Content-Type": "text/html" })
          .end(`<!doctype html><h1>Authorization failed</h1><p>${message}</p>`);
        finish();
        reject(new Error(message));
      };
      if (error) {
        fail(400, `Authorization failed (${error}).`);
        return;
      }
      if (!code) {
        res.writeHead(400).end("Missing authorization code.");
        return;
      }
      if (state !== params.expectedState) {
        fail(400, "OAuth state mismatch (possible CSRF).");
        return;
      }
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          "<!doctype html><h1>Authorization complete</h1><p>You can close this tab and return to your terminal.</p>",
        );
      finish();
      resolve(code);
    });
    const finish = () => {
      if (timer) {
        clearTimeout(timer);
      }
      server.close();
    };
    server.once("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(err);
    });
    server.listen(params.port, bindHost, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : params.port;
      timer = setTimeout(() => {
        finish();
        reject(new Error("Timed out waiting for the OAuth callback."));
      }, timeoutMs);
      params.onReady?.(actualPort);
    });
  });
}

// Full localhost-callback login: start the capture server, advertise the auth
// URL once it is listening, wait for the redirect, then exchange the code.
export async function loginAnthropicViaCallback(
  params: {
    callbackPort: number;
    bindHost?: string;
    onAuthUrl: (url: string) => void;
    timeoutMs?: number;
  },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<OAuthCredentials> {
  const { verifier, challenge } = generatePkce();
  const state = base64url(crypto.randomBytes(16));
  const redirectUri = callbackRedirectUri(params.callbackPort);
  const code = await captureAuthCode({
    port: params.callbackPort,
    bindHost: params.bindHost,
    expectedState: state,
    timeoutMs: params.timeoutMs,
    onReady: () => {
      params.onAuthUrl(buildAnthropicAuthorizeUrl({ challenge, state, redirectUri }));
    },
  });
  return exchangeAnthropicCode({ code, verifier, state, redirectUri, fetchImpl: deps.fetchImpl });
}
