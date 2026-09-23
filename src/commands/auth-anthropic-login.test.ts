import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_AUTHORIZE_URL,
  ANTHROPIC_CLIENT_ID,
  buildAnthropicAuthorizeUrl,
  callbackRedirectUri,
  captureAuthCode,
  exchangeAnthropicCode,
  generatePkce,
  loginAnthropicViaCallback,
} from "./auth-anthropic-login.js";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

describe("generatePkce", () => {
  it("produces a url-safe verifier and matching S256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const expected = base64url(crypto.createHash("sha256").update(verifier).digest());
    expect(challenge).toBe(expected);
  });
});

describe("callbackRedirectUri", () => {
  it("builds a localhost callback URI for the port", () => {
    expect(callbackRedirectUri(4321)).toBe("http://localhost:4321/callback");
  });
});

describe("buildAnthropicAuthorizeUrl", () => {
  it("includes the PKCE, client, redirect, and state params", () => {
    const url = new URL(
      buildAnthropicAuthorizeUrl({
        challenge: "chal",
        state: "st",
        redirectUri: "http://localhost:9999/callback",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(ANTHROPIC_AUTHORIZE_URL);
    expect(url.searchParams.get("client_id")).toBe(ANTHROPIC_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:9999/callback");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("scope")).toContain("user:inference");
  });
});

describe("endpoint env overrides", () => {
  it("uses OPENCLAW_ANTHROPIC_AUTHORIZE_URL when set", () => {
    const prev = process.env.OPENCLAW_ANTHROPIC_AUTHORIZE_URL;
    process.env.OPENCLAW_ANTHROPIC_AUTHORIZE_URL = "http://localhost:9/mock/authorize";
    try {
      const url = new URL(
        buildAnthropicAuthorizeUrl({
          challenge: "c",
          state: "s",
          redirectUri: "http://localhost:1/callback",
        }),
      );
      expect(`${url.origin}${url.pathname}`).toBe("http://localhost:9/mock/authorize");
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_ANTHROPIC_AUTHORIZE_URL;
      } else {
        process.env.OPENCLAW_ANTHROPIC_AUTHORIZE_URL = prev;
      }
    }
  });

  it("posts to OPENCLAW_ANTHROPIC_TOKEN_URL when set", async () => {
    const prev = process.env.OPENCLAW_ANTHROPIC_TOKEN_URL;
    process.env.OPENCLAW_ANTHROPIC_TOKEN_URL = "http://localhost:9/mock/token";
    let calledUrl = "";
    const fetchImpl = (async (url: string) => {
      calledUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "a", refresh_token: "r", expires_in: 1 }),
      };
    }) as unknown as typeof fetch;
    try {
      await exchangeAnthropicCode({
        code: "c",
        verifier: "v",
        state: "s",
        redirectUri: "http://localhost:1/callback",
        fetchImpl,
      });
      expect(calledUrl).toBe("http://localhost:9/mock/token");
    } finally {
      if (prev === undefined) {
        delete process.env.OPENCLAW_ANTHROPIC_TOKEN_URL;
      } else {
        process.env.OPENCLAW_ANTHROPIC_TOKEN_URL = prev;
      }
    }
  });
});

describe("exchangeAnthropicCode", () => {
  it("posts the code and shapes the credentials", async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init?: { body?: string }) => {
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "acc",
          refresh_token: "ref",
          expires_in: 3600,
        }),
      };
    }) as unknown as typeof fetch;

    const before = Date.now();
    const creds = await exchangeAnthropicCode({
      code: "the-code",
      verifier: "the-verifier",
      state: "the-state",
      redirectUri: "http://localhost:1/callback",
      fetchImpl,
    });

    expect(sentBody).toMatchObject({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_CLIENT_ID,
      code: "the-code",
      state: "the-state",
      redirect_uri: "http://localhost:1/callback",
      code_verifier: "the-verifier",
    });
    expect(creds.access).toBe("acc");
    expect(creds.refresh).toBe("ref");
    // expires ~ now + 1h - 5m buffer.
    expect(creds.expires).toBeGreaterThanOrEqual(before + 3600_000 - 5 * 60_000 - 1000);
    expect(creds.expires).toBeLessThanOrEqual(Date.now() + 3600_000 - 5 * 60_000 + 1000);
  });

  it("throws with the status and body on a non-ok response", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    })) as unknown as typeof fetch;
    await expect(
      exchangeAnthropicCode({
        code: "c",
        verifier: "v",
        state: "s",
        redirectUri: "http://localhost:1/callback",
        fetchImpl,
      }),
    ).rejects.toThrow(/400.*invalid_grant/);
  });
});

describe("captureAuthCode", () => {
  it("resolves the code from a matching-state redirect", async () => {
    const port = await getFreePort();
    const codePromise = captureAuthCode({
      port,
      expectedState: "abc",
      onReady: (actual) => {
        http.get(`http://localhost:${actual}/callback?code=CODE123&state=abc`);
      },
    });
    await expect(codePromise).resolves.toBe("CODE123");
  });

  it("rejects on a state mismatch", async () => {
    const port = await getFreePort();
    const codePromise = captureAuthCode({
      port,
      expectedState: "expected",
      onReady: (actual) => {
        http.get(`http://localhost:${actual}/callback?code=CODE&state=wrong`);
      },
    });
    await expect(codePromise).rejects.toThrow(/state mismatch/i);
  });
});

describe("loginAnthropicViaCallback", () => {
  it("captures the redirect and exchanges the code end to end", async () => {
    const port = await getFreePort();
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "A", refresh_token: "R", expires_in: 3600 }),
    })) as unknown as typeof fetch;

    const creds = await loginAnthropicViaCallback(
      {
        callbackPort: port,
        onAuthUrl: (url) => {
          // Simulate the browser approving and being redirected back.
          const state = new URL(url).searchParams.get("state") ?? "";
          http.get(`http://localhost:${port}/callback?code=browsercode&state=${state}`);
        },
      },
      { fetchImpl },
    );

    expect(creds).toEqual({ access: "A", refresh: "R", expires: expect.any(Number) });
  });
});
