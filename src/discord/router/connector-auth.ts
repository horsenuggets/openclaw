/**
 * Connector auth strategies. The way a connector authenticates is the real axis
 * of variation (not the service), so each auth *kind* is its own small class and
 * every connector composes the one it needs (see connectors.ts). This keeps the
 * command handler kind-agnostic: it calls `auth.begin()` to show the user how to
 * link and `auth.complete(input)` to verify and capture the credential, without
 * ever switching on the kind.
 *
 * Phase 1 ships `PasteTokenAuth` (Todoist, Notion, GitHub). `CliAuth` (Google via
 * gog) is present but not yet linkable; `OAuthPkceAuth` arrives in Phase 2 as a
 * new class here, with zero branches added to the handler.
 */

export type ConnectorAuthKind = "paste-token" | "oauth-pkce" | "cli";

/** What to show the user to begin linking. */
export type AuthPrompt = {
  kind: ConnectorAuthKind;
  /** Instructions for obtaining the credential. */
  howto?: string;
  /** A URL the user opens (token-creation page, or an OAuth authorize URL). */
  url?: string;
};

/** Outcome of verifying the user's input. On success `token` is what to store. */
export type AuthResult =
  | { ok: true; token?: string; accountLabel?: string }
  | { ok: false; message: string };

/** A pluggable authentication flow for a connector. */
export interface ConnectorAuth {
  readonly kind: ConnectorAuthKind;
  /** What to show the user to start linking. */
  begin(): AuthPrompt;
  /**
   * Verify the user's input (a pasted token, a redirect URL, or nothing for CLI
   * flows) and return the credential to persist. Implementations must not throw
   * for expected failures; return `{ ok: false, message }` instead.
   */
  complete(input: string | undefined): Promise<AuthResult>;
}

/**
 * Link by pasting an API token. The service-specific `validate` closure performs
 * the "who am I" network call; this class owns the input guard, the network-error
 * safety net, and defaulting the stored token to the pasted value.
 */
export class PasteTokenAuth implements ConnectorAuth {
  readonly kind = "paste-token" as const;

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
    return { kind: this.kind, howto: this.spec.howto, url: this.spec.url };
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

/**
 * Link through a local CLI (Google via gog). Not yet reachable in Phase 1: the
 * connector is marked unavailable until the in-container credential path is
 * resolved, so `complete` is a placeholder that keeps the interface total.
 */
export class CliAuth implements ConnectorAuth {
  readonly kind = "cli" as const;

  constructor(private readonly spec: { tool: string; howto?: string }) {}

  begin(): AuthPrompt {
    return { kind: this.kind, ...(this.spec.howto ? { howto: this.spec.howto } : {}) };
  }

  complete(): Promise<AuthResult> {
    return Promise.resolve({
      ok: false,
      message: `Linking via ${this.spec.tool} is not available yet`,
    });
  }
}
