/**
 * Auth flows. How a connector authenticates is the real axis of variation (not the
 * service), so each flow is its own small class and every connector composes the one
 * it needs (see connectors.ts). The command handler stays flow-agnostic: it calls
 * `begin()` to show the user how to start linking and `complete(input, pending)` to
 * verify and capture the credential, never switching on the flow type.
 *
 * A flow is described by two independent axes so a renderer can present it without
 * branching on the provider:
 *   - `authKind` — the nature of the auth: a hosted `oauth` dance, a `direct`
 *     credential handoff (the user already has a token), or a local `cli` login.
 *   - `delivery` — how the credential comes back: `paste` (the user sends it via
 *     `/secret`) or `server-redirect` (a hosted callback completes it server-side).
 * `outgoing` (how we tell the user to START — an authorize `link` vs. custom
 * `instructions`) follows from `authKind`, but is declared explicitly so the embed
 * layer can read it directly.
 *
 * Ships `DirectAuth` (Todoist, Notion, GitHub; paste a personal token) and
 * `OAuthPkceAuth` (the standard OAuth authorization-code + PKCE flow, paste-based).
 * `CliAuth` (Google via gog) is present but not yet linkable.
 */

import crypto from "node:crypto";

/** The nature of a connector's auth. */
export type AuthKind = "oauth" | "direct" | "cli";

/** How the flow tells the user to START linking. */
export type OutgoingMode = "link" | "instructions";

/** How the credential comes BACK from the user. */
export type DeliveryMode = "paste" | "server-redirect";

/** What to show the user to begin linking. */
export type AuthPrompt = {
  /** Instructions for obtaining the credential. */
  howto?: string;
  /** A URL the user opens (a token-creation page, or an OAuth authorize URL). */
  url?: string;
  /**
   * Opaque flow state that must be persisted between `begin()` and `complete()` and
   * handed back to `complete()` (for PKCE: the code verifier + CSRF state). Flows that
   * carry no between-step state omit it. NOTE: the command handler does not yet persist
   * or round-trip this — that wiring (and thus a live OAuth flow) is a follow-up; today
   * only the flow's own tests exercise the round-trip. A flow treats it as opaque.
   */
  pending?: string;
};

/** Structured OAuth credential captured by an OAuth flow. */
export type OAuthCredential = {
  accessToken: string;
  refreshToken?: string;
  /** Unix epoch milliseconds when the access token expires, if the provider said so. */
  expiresAt?: number;
  /** Space-separated scopes the provider actually granted, if returned. */
  scope?: string;
};

/**
 * Outcome of verifying the user's input. On success `token` is the primary secret to
 * store (an access token, for OAuth); `oauth` carries the full structured credential
 * (refresh token, expiry) for the materialization layer to persist once it grows past
 * a single-token store.
 */
export type AuthResult =
  | { ok: true; token?: string; accountLabel?: string; oauth?: OAuthCredential }
  | { ok: false; message: string };

/** A pluggable authentication flow for a connector. */
export interface AuthFlow {
  readonly authKind: AuthKind;
  readonly outgoing: OutgoingMode;
  readonly delivery: DeliveryMode;
  /** What to show the user to start linking. */
  begin(): AuthPrompt;
  /**
   * Verify the user's input (a pasted token, a redirect URL, or nothing for CLI
   * flows) and return the credential to persist. `pending` is whatever `begin()` put
   * in {@link AuthPrompt.pending}; the caller is expected to round-trip it (not yet
   * wired — see the note there). Implementations must not throw for expected failures;
   * return `{ ok: false, message }` instead.
   */
  complete(input: string | undefined, pending?: string): Promise<AuthResult>;
}

/**
 * Link by handing over a credential the user already has (a personal API token from
 * the service's settings). No authorize dance: the flow shows instructions, the user
 * pastes the token via `/secret`. The service-specific `validate` closure performs
 * the "who am I" network call; this class owns the input guard, the network-error
 * safety net, and defaulting the stored token to the pasted value.
 */
export class DirectAuth implements AuthFlow {
  readonly authKind = "direct" as const;
  readonly outgoing = "instructions" as const;
  readonly delivery = "paste" as const;

  constructor(
    private readonly spec: {
      /** Page where the user creates the token. */
      url: string;
      /** Human instructions for creating the token. */
      howto: string;
      /** Service call that confirms the token and optionally names the account. */
      validate: (token: string) => Promise<AuthResult>;
    },
  ) {}

  begin(): AuthPrompt {
    return { howto: this.spec.howto, url: this.spec.url };
  }

  async complete(input: string | undefined): Promise<AuthResult> {
    if (!input) {
      return { ok: false, message: "No token provided" };
    }
    try {
      const result = await this.spec.validate(input);
      // Default the persisted credential to the pasted token unless the validator
      // returned a different one (e.g. an exchanged credential).
      if (result.ok && result.token === undefined) {
        return { ...result, token: input };
      }
      return result;
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "network error" };
    }
  }
}

/** Base64url-encode without padding (RFC 7636 §A). */
function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The PKCE values a `begin()` mints and a `complete()` needs back. */
type PkcePending = { verifier: string; state: string };

/**
 * Link through the OAuth 2.0 authorization-code flow with PKCE (RFC 7636). The user
 * opens the authorize URL, approves, and the provider redirects to a loopback URI
 * (nothing needs to listen — the code sits in the URL's query string); the user pastes
 * that redirect URL (or the bare code) via `/secret`, and `complete()` exchanges it,
 * proving possession of the original code verifier. No client secret is used, so this
 * suits a public client; a provider that requires a secret needs the plain-OAuth flow.
 *
 * Between-step state (the verifier + a CSRF `state`) is returned from `begin()` in
 * {@link AuthPrompt.pending} and handed back to `complete()`, because the two calls
 * are separate commands against a shared, stateless connector singleton.
 *
 * `clientId` is read at call time (not construction) so the real id can come from the
 * environment at runtime and stay out of the repo.
 */
export class OAuthPkceAuth implements AuthFlow {
  readonly authKind = "oauth" as const;
  readonly outgoing = "link" as const;
  readonly delivery = "paste" as const;

  constructor(
    private readonly spec: {
      /** Provider authorize endpoint (public constant). */
      authorizeEndpoint: string;
      /** Provider token endpoint (public constant). */
      tokenEndpoint: string;
      /** OAuth client id, read at call time so it can come from the environment. */
      clientId: () => string | undefined;
      /** Loopback redirect URI registered on the OAuth app (e.g. http://127.0.0.1). */
      redirectUri: string;
      /** Scopes to request. */
      scopes: readonly string[];
      /** Extra authorize-URL params a provider needs (e.g. access_type=offline). */
      extraAuthParams?: Readonly<Record<string, string>>;
      /** Human instructions shown alongside the authorize link. */
      howto?: string;
      /** Optional "who am I" call naming the account from the access token. */
      identify?: (accessToken: string) => Promise<string | undefined>;
      /**
       * POST a form-encoded body and return the parsed JSON. Injected so tests run
       * network-free; defaults to a `fetch`-based implementation.
       */
      postForm?: (
        url: string,
        form: Record<string, string>,
      ) => Promise<{ ok: boolean; status: number; body: unknown }>;
      /** Random-bytes source, injectable for deterministic tests. */
      randomBytes?: (size: number) => Buffer;
      /** Clock, injectable for deterministic expiry math. */
      now?: () => number;
    },
  ) {}

  begin(): AuthPrompt {
    const clientId = this.spec.clientId();
    if (!clientId) {
      // A missing client id is a configuration error; surface it rather than minting
      // an authorize link with an empty client_id that only fails later at the provider.
      return { howto: "This connector is not configured yet (missing OAuth client id)." };
    }
    const random = this.spec.randomBytes ?? crypto.randomBytes;
    const verifier = base64url(random(32));
    const state = base64url(random(16));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    // Build on the endpoint's own URL so any query it already carries (e.g. an
    // `audience`) is preserved, then apply provider extras, then set the mandatory
    // protocol params last so an extra can never overwrite state / code_challenge /
    // redirect_uri and silently weaken the PKCE and CSRF guarantees.
    const url = new URL(this.spec.authorizeEndpoint);
    for (const [key, value] of Object.entries(this.spec.extraAuthParams ?? {})) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", this.spec.redirectUri);
    url.searchParams.set("scope", this.spec.scopes.join(" "));
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    const pending: PkcePending = { verifier, state };
    return {
      howto: this.spec.howto,
      url: url.toString(),
      pending: base64url(Buffer.from(JSON.stringify(pending), "utf8")),
    };
  }

  async complete(input: string | undefined, pending?: string): Promise<AuthResult> {
    if (!input) {
      return { ok: false, message: "No authorization code provided" };
    }
    // Resolve the lazy client id ONCE for this completion so the guard and the exchange
    // can never disagree if configuration changes between the two reads.
    const clientId = this.spec.clientId();
    if (!clientId) {
      return {
        ok: false,
        message: "This connector is not configured yet (missing OAuth client id).",
      };
    }
    const flowState = this.parsePending(pending);
    if (!flowState) {
      return { ok: false, message: "Missing or invalid authorization state; start the link again" };
    }
    const parsed = this.parseInput(input);
    if (!parsed.code) {
      return { ok: false, message: "Could not find an authorization code in what you pasted" };
    }
    // A redirect URL carries the CSRF state and must match exactly. Only a bare pasted
    // code (no URL structure) may omit it, since some providers surface just the code.
    if (parsed.structured) {
      if (parsed.state !== flowState.state) {
        return { ok: false, message: "Authorization state did not match; start the link again" };
      }
    }
    try {
      return await this.exchange(parsed.code, flowState.verifier, clientId);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "network error" };
    }
  }

  private parsePending(pending: string | undefined): PkcePending | null {
    if (!pending) {
      return null;
    }
    try {
      const json: unknown = JSON.parse(Buffer.from(pending, "base64").toString("utf8"));
      if (
        json &&
        typeof json === "object" &&
        typeof (json as PkcePending).verifier === "string" &&
        typeof (json as PkcePending).state === "string"
      ) {
        return json as PkcePending;
      }
    } catch {
      // fall through to null
    }
    return null;
  }

  /**
   * Pull the code (and state) out of a pasted callback, or keep an opaque bare code
   * whole. A callback is recognized ONLY as the real redirect URL we sent the user to
   * (it starts with the configured `redirectUri`) or the explicitly supported bare
   * query that carries both `code` and `state` (`code=...&state=...`, with or without a
   * leading `?`). Authorization codes are opaque and may themselves contain `://` or
   * `code=`, so anything else is preserved verbatim as the code. `structured` is true
   * only for a recognized callback, which must carry a verifiable state; a bare code
   * (false) is the only input allowed to omit the state check.
   */
  private parseInput(input: string): { code?: string; state?: string; structured: boolean } {
    const trimmed = input.trim();
    const isRedirectUrl = trimmed.startsWith(this.spec.redirectUri);
    const hasCode = /(^|[?&])code=/.test(trimmed);
    const hasState = /(^|[?&])state=/.test(trimmed);
    const isBareQuery = !trimmed.includes("://") && hasCode && hasState;
    if (isRedirectUrl || isBareQuery) {
      try {
        // Normalize a scheme-less bare query (`code=c&state=s`) against a loopback base
        // so it parses as a query rather than a path.
        const toParse = trimmed.includes("://")
          ? trimmed
          : trimmed.startsWith("?")
            ? trimmed
            : `?${trimmed}`;
        const url = new URL(toParse, "http://127.0.0.1");
        return {
          code: url.searchParams.get("code") ?? undefined,
          state: url.searchParams.get("state") ?? undefined,
          structured: true,
        };
      } catch {
        return { structured: true };
      }
    }
    return { code: trimmed, structured: false };
  }

  private async exchange(code: string, verifier: string, clientId: string): Promise<AuthResult> {
    const post = this.spec.postForm ?? defaultPostForm;
    const res = await post(this.spec.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: this.spec.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (!res.ok) {
      return { ok: false, message: describeTokenError(res.status, res.body) };
    }
    const body = (res.body ?? {}) as Record<string, unknown>;
    const accessToken = typeof body.access_token === "string" ? body.access_token : undefined;
    if (!accessToken) {
      return { ok: false, message: "Token response did not include an access token" };
    }
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : undefined;
    const scope = typeof body.scope === "string" ? body.scope : undefined;
    const now = this.spec.now ?? Date.now;
    const expiresAt =
      typeof body.expires_in === "number" ? now() + body.expires_in * 1000 : undefined;
    // The account label is a nicety fetched AFTER the code is exchanged and consumed.
    // A failure here must not discard the valid tokens (the code cannot be reused), so
    // treat it as a missing label rather than failing the completed exchange.
    let accountLabel: string | undefined;
    if (this.spec.identify) {
      try {
        accountLabel = await this.spec.identify(accessToken);
      } catch {
        accountLabel = undefined;
      }
    }
    return {
      ok: true,
      token: accessToken,
      accountLabel,
      oauth: { accessToken, refreshToken, expiresAt, scope },
    };
  }
}

/** Hard timeout for the token exchange, matching the direct-token validators. */
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

/** Default token-exchange POST, used when the flow is not given a `postForm`. */
async function defaultPostForm(
  url: string,
  form: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    // Bound the request so an unresponsive token endpoint cannot hang the deferred
    // Discord command for minutes.
    signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // leave body null; the status still drives the outcome
  }
  return { ok: res.ok, status: res.status, body };
}

/** Turn a token-endpoint error body into a user-facing message. */
function describeTokenError(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const error = typeof record.error === "string" ? record.error : undefined;
    const description =
      typeof record.error_description === "string" ? record.error_description : undefined;
    if (error || description) {
      return [error, description].filter(Boolean).join(": ");
    }
  }
  return `Token exchange failed (HTTP ${status})`;
}

/**
 * Link through a local CLI (Google via gog). Not yet reachable: the connector is
 * marked unavailable until the in-container credential path is resolved, so
 * `complete` is a placeholder that keeps the interface total.
 */
export class CliAuth implements AuthFlow {
  readonly authKind = "cli" as const;
  readonly outgoing = "instructions" as const;
  readonly delivery = "paste" as const;

  constructor(private readonly spec: { tool: string; howto?: string }) {}

  begin(): AuthPrompt {
    return this.spec.howto ? { howto: this.spec.howto } : {};
  }

  complete(): Promise<AuthResult> {
    return Promise.resolve({
      ok: false,
      message: `Linking via ${this.spec.tool} is not available yet`,
    });
  }
}
