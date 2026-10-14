import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type AuthResult, CliAuth, DirectAuth, OAuthPkceAuth } from "./auth-flow.js";

function directAuth(validate: (token: string) => Promise<AuthResult>) {
  return new DirectAuth({
    url: "https://example.com/token",
    howto: "Grab your token.",
    validate,
  });
}

/** base64url without padding, mirroring the production helper. */
function b64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type TokenCall = { url: string; form: Record<string, string> };

function pkceAuth(overrides?: {
  postForm?: (
    url: string,
    form: Record<string, string>,
  ) => Promise<{ ok: boolean; status: number; body: unknown }>;
  identify?: (accessToken: string) => Promise<string | undefined>;
  clientId?: () => string | undefined;
}) {
  return new OAuthPkceAuth({
    authorizeEndpoint: "https://provider.example/authorize",
    tokenEndpoint: "https://provider.example/token",
    clientId: overrides?.clientId ?? (() => "client-123"),
    redirectUri: "http://127.0.0.1",
    scopes: ["read", "write"],
    extraAuthParams: { access_type: "offline" },
    howto: "Authorize, then paste the URL you land on.",
    identify: overrides?.identify,
    postForm: overrides?.postForm,
    // Deterministic verifier/state: fill with a fixed byte per requested size.
    randomBytes: (size: number) => Buffer.alloc(size, 7),
    now: () => 1_000_000,
  });
}

describe("DirectAuth.begin", () => {
  it("surfaces the howto and url with instructions/paste descriptors", () => {
    const auth = directAuth(async () => ({ ok: true }));
    expect(auth.authKind).toBe("direct");
    expect(auth.outgoing).toBe("instructions");
    expect(auth.delivery).toBe("paste");
    expect(auth.begin()).toEqual({
      howto: "Grab your token.",
      url: "https://example.com/token",
    });
  });
});

describe("DirectAuth.complete", () => {
  it("rejects a missing token without calling validate", async () => {
    const validate = vi.fn(async () => ({ ok: true }) as AuthResult);
    const result = await directAuth(validate).complete(undefined);
    expect(result).toEqual({ ok: false, message: "No token provided" });
    expect(validate).not.toHaveBeenCalled();
  });

  it("defaults the stored token to the pasted value on success", async () => {
    const result = await directAuth(async () => ({ ok: true, accountLabel: "octocat" })).complete(
      "ghp_secret",
    );
    expect(result).toEqual({ ok: true, token: "ghp_secret", accountLabel: "octocat" });
  });

  it("keeps a token the validator returned instead of the pasted one", async () => {
    const result = await directAuth(async () => ({ ok: true, token: "exchanged" })).complete("raw");
    expect(result).toEqual({ ok: true, token: "exchanged" });
  });

  it("passes a validation failure straight through", async () => {
    const result = await directAuth(async () => ({
      ok: false,
      message: "GitHub returned 401",
    })).complete("bad");
    expect(result).toEqual({ ok: false, message: "GitHub returned 401" });
  });

  it("turns a thrown network error into a failure result", async () => {
    const result = await directAuth(async () => {
      throw new Error("connect ETIMEDOUT");
    }).complete("tok");
    expect(result).toEqual({ ok: false, message: "connect ETIMEDOUT" });
  });
});

describe("OAuthPkceAuth.begin", () => {
  it("builds an authorize URL with an S256 challenge derived from the verifier", () => {
    const prompt = pkceAuth().begin();
    expect(prompt.howto).toBe("Authorize, then paste the URL you land on.");
    expect(prompt.pending).toBeTruthy();

    const url = new URL(prompt.url ?? "");
    expect(url.origin + url.pathname).toBe("https://provider.example/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1");
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");

    // pending carries the verifier + state; the URL's challenge is S256(verifier).
    const pending = JSON.parse(Buffer.from(prompt.pending ?? "", "base64").toString("utf8")) as {
      verifier: string;
      state: string;
    };
    expect(url.searchParams.get("state")).toBe(pending.state);
    const expectedChallenge = b64url(crypto.createHash("sha256").update(pending.verifier).digest());
    expect(url.searchParams.get("code_challenge")).toBe(expectedChallenge);
  });

  it("reads the client id lazily at begin time", () => {
    let id: string | undefined = "first-id";
    const auth = pkceAuth({ clientId: () => id });
    expect(new URL(auth.begin().url ?? "").searchParams.get("client_id")).toBe("first-id");
    id = "later-id";
    expect(new URL(auth.begin().url ?? "").searchParams.get("client_id")).toBe("later-id");
  });

  it("refuses to mint a link when the client id is not configured", () => {
    const auth = pkceAuth({ clientId: () => undefined });
    const prompt = auth.begin();
    expect(prompt.url).toBeUndefined();
    expect(prompt.pending).toBeUndefined();
    expect(prompt.howto).toMatch(/not configured/i);
  });

  it("preserves query parameters the authorize endpoint already carries", () => {
    const auth = new OAuthPkceAuth({
      authorizeEndpoint: "https://provider.example/authorize?audience=api",
      tokenEndpoint: "https://provider.example/token",
      clientId: () => "client-123",
      redirectUri: "http://127.0.0.1",
      scopes: ["read"],
      randomBytes: (size: number) => Buffer.alloc(size, 7),
    });
    const url = new URL(auth.begin().url ?? "");
    expect(url.searchParams.get("audience")).toBe("api");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("does not let provider extras override the security parameters", () => {
    const auth = new OAuthPkceAuth({
      authorizeEndpoint: "https://provider.example/authorize",
      tokenEndpoint: "https://provider.example/token",
      clientId: () => "client-123",
      redirectUri: "http://127.0.0.1",
      scopes: ["read"],
      // Hostile extras that try to weaken PKCE/CSRF.
      extraAuthParams: {
        code_challenge_method: "plain",
        state: "attacker",
        code_challenge: "attacker",
        redirect_uri: "https://evil.example",
      },
      randomBytes: (size: number) => Buffer.alloc(size, 7),
    });
    const prompt = auth.begin();
    const url = new URL(prompt.url ?? "");
    const minted = JSON.parse(Buffer.from(prompt.pending ?? "", "base64").toString("utf8")) as {
      state: string;
    };
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(minted.state);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1");
    expect(url.searchParams.get("code_challenge")).not.toBe("attacker");
  });
});

describe("OAuthPkceAuth.complete", () => {
  function okPostForm(calls: TokenCall[]) {
    return async (url: string, form: Record<string, string>) => {
      calls.push({ url, form });
      return {
        ok: true,
        status: 200,
        body: {
          access_token: "at-abc",
          refresh_token: "rt-xyz",
          expires_in: 3600,
          scope: "read write",
        },
      };
    };
  }

  it("exchanges a pasted redirect URL, returning structured credentials", async () => {
    const calls: TokenCall[] = [];
    const auth = pkceAuth({
      postForm: okPostForm(calls),
      identify: async () => "me@example.com",
    });
    const { pending } = auth.begin();
    const flow = JSON.parse(Buffer.from(pending ?? "", "base64").toString("utf8")) as {
      verifier: string;
      state: string;
    };

    const result = await auth.complete(
      `http://127.0.0.1/?code=the-code&state=${flow.state}`,
      pending,
    );

    expect(result).toEqual({
      ok: true,
      token: "at-abc",
      accountLabel: "me@example.com",
      oauth: {
        accessToken: "at-abc",
        refreshToken: "rt-xyz",
        expiresAt: 1_000_000 + 3600 * 1000,
        scope: "read write",
      },
    });
    // The exchange proves possession of the original verifier.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.form).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: flow.verifier,
      client_id: "client-123",
      redirect_uri: "http://127.0.0.1",
    });
  });

  it("accepts a bare pasted code (no state to verify)", async () => {
    const calls: TokenCall[] = [];
    const auth = pkceAuth({ postForm: okPostForm(calls) });
    const { pending } = auth.begin();
    const result = await auth.complete("just-the-code", pending);
    expect(result.ok).toBe(true);
    expect(calls[0]?.form.code).toBe("just-the-code");
  });

  it("keeps an opaque bare code that happens to contain a question mark", async () => {
    const calls: TokenCall[] = [];
    const auth = pkceAuth({ postForm: okPostForm(calls) });
    const { pending } = auth.begin();
    const result = await auth.complete("abc?def", pending);
    expect(result.ok).toBe(true);
    expect(calls[0]?.form.code).toBe("abc?def");
  });

  it("keeps an opaque bare code that contains :// or a lone code= as the code", async () => {
    const calls: TokenCall[] = [];
    const auth = pkceAuth({ postForm: okPostForm(calls) });
    const { pending } = auth.begin();
    // Not the configured redirect URI, and no code+state query pair → treated as the code.
    expect((await auth.complete("weird://opaque-code", pending)).ok).toBe(true);
    expect(calls[0]?.form.code).toBe("weird://opaque-code");
    expect((await auth.complete("xcode=notaquery", pending)).ok).toBe(true);
    expect(calls[1]?.form.code).toBe("xcode=notaquery");
  });

  it("resolves the lazy client id exactly once per completion", async () => {
    const calls: TokenCall[] = [];
    const clientId = vi.fn(() => "client-123");
    const auth = pkceAuth({ postForm: okPostForm(calls), clientId });
    const { pending } = auth.begin();
    clientId.mockClear(); // ignore begin()'s read; count only the completion
    await auth.complete("the-code", pending);
    expect(clientId).toHaveBeenCalledTimes(1);
    expect(calls[0]?.form.client_id).toBe("client-123");
  });

  it("parses a scheme-less callback query string with no leading question mark", async () => {
    const calls: TokenCall[] = [];
    const auth = pkceAuth({ postForm: okPostForm(calls) });
    const { pending } = auth.begin();
    const state = (
      JSON.parse(Buffer.from(pending ?? "", "base64").toString("utf8")) as { state: string }
    ).state;
    const result = await auth.complete(`code=the-code&state=${state}`, pending);
    expect(result.ok).toBe(true);
    expect(calls[0]?.form.code).toBe("the-code");
  });

  it("keeps the tokens when the optional account lookup throws", async () => {
    const auth = pkceAuth({
      postForm: okPostForm([]),
      identify: async () => {
        throw new Error("profile endpoint 500");
      },
    });
    const { pending } = auth.begin();
    const result = await auth.complete("the-code", pending);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toBe("at-abc");
      expect(result.accountLabel).toBeUndefined();
      expect(result.oauth?.refreshToken).toBe("rt-xyz");
    }
  });

  it("rejects a state that does not match what begin minted", async () => {
    const auth = pkceAuth({ postForm: okPostForm([]) });
    const { pending } = auth.begin();
    const result = await auth.complete("http://127.0.0.1/?code=c&state=wrong", pending);
    expect(result).toEqual({
      ok: false,
      message: "Authorization state did not match; start the link again",
    });
  });

  it("rejects a redirect URL that carries no state (no CSRF bypass)", async () => {
    const postForm = vi.fn(okPostForm([]));
    const auth = pkceAuth({ postForm });
    const { pending } = auth.begin();
    const result = await auth.complete("http://127.0.0.1/?code=c", pending);
    expect(result).toEqual({
      ok: false,
      message: "Authorization state did not match; start the link again",
    });
    expect(postForm).not.toHaveBeenCalled();
  });

  it("refuses the exchange when the client id is not configured", async () => {
    const postForm = vi.fn(okPostForm([]));
    const auth = pkceAuth({ postForm, clientId: () => undefined });
    // pending from a configured run, to isolate the client-id guard.
    const { pending } = pkceAuth().begin();
    const result = await auth.complete("the-code", pending);
    expect(result).toEqual({
      ok: false,
      message: "This connector is not configured yet (missing OAuth client id).",
    });
    expect(postForm).not.toHaveBeenCalled();
  });

  it("rejects when the pending state is missing or unparseable", async () => {
    const auth = pkceAuth({ postForm: okPostForm([]) });
    expect(await auth.complete("http://127.0.0.1/?code=c", undefined)).toEqual({
      ok: false,
      message: "Missing or invalid authorization state; start the link again",
    });
    expect(await auth.complete("http://127.0.0.1/?code=c", "not-valid-base64-json")).toEqual({
      ok: false,
      message: "Missing or invalid authorization state; start the link again",
    });
  });

  it("rejects empty input before touching the network", async () => {
    const postForm = vi.fn(okPostForm([]));
    const auth = pkceAuth({ postForm });
    const { pending } = auth.begin();
    expect(await auth.complete(undefined, pending)).toEqual({
      ok: false,
      message: "No authorization code provided",
    });
    expect(postForm).not.toHaveBeenCalled();
  });

  it("reports a provider token error with its description", async () => {
    const auth = pkceAuth({
      postForm: async () => ({
        ok: false,
        status: 400,
        body: { error: "invalid_grant", error_description: "code expired" },
      }),
    });
    const { pending } = auth.begin();
    const result = await auth.complete("code", pending);
    expect(result).toEqual({ ok: false, message: "invalid_grant: code expired" });
  });

  it("fails when the token response has no access token", async () => {
    const auth = pkceAuth({
      postForm: async () => ({ ok: true, status: 200, body: { token_type: "bearer" } }),
    });
    const { pending } = auth.begin();
    const result = await auth.complete("code", pending);
    expect(result).toEqual({
      ok: false,
      message: "Token response did not include an access token",
    });
  });

  it("turns a thrown exchange error into a failure result", async () => {
    const auth = pkceAuth({
      postForm: async () => {
        throw new Error("socket hang up");
      },
    });
    const { pending } = auth.begin();
    const result = await auth.complete("code", pending);
    expect(result).toEqual({ ok: false, message: "socket hang up" });
  });
});

describe("CliAuth", () => {
  it("reports as not yet linkable with instructions/paste descriptors", async () => {
    const auth = new CliAuth({ tool: "gog" });
    expect(auth.authKind).toBe("cli");
    expect(auth.outgoing).toBe("instructions");
    expect(auth.delivery).toBe("paste");
    expect(auth.begin()).toEqual({});
    expect(await auth.complete()).toEqual({
      ok: false,
      message: "Linking via gog is not available yet",
    });
  });
});
