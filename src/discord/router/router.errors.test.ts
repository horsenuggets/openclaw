import { describe, expect, it } from "vitest";
import { classifyRouterError, isConversationalBot, isLifecycleBanner } from "./router-filters.js";

describe("isConversationalBot", () => {
  const allow = new Set(["111", "222"]);

  it("allows an allowlisted bot that is not the router itself", () => {
    expect(isConversationalBot("111", "999", allow)).toBe(true);
  });

  it("rejects a bot that is not on the allowlist", () => {
    expect(isConversationalBot("333", "999", allow)).toBe(false);
  });

  it("rejects the router's own bot id even when it is accidentally allowlisted", () => {
    // Guard against the self-loop: our own replies must never route back in.
    const withSelf = new Set(["111", "999"]);
    expect(isConversationalBot("999", "999", withSelf)).toBe(false);
  });

  it("rejects a missing author id", () => {
    expect(isConversationalBot(undefined, "999", allow)).toBe(false);
  });
});

describe("classifyRouterError", () => {
  // The exact error the prod router logged for an instance provisioned without
  // credentials: it must be treated as an admin auth/config problem, not a
  // generic "try again" echoed to the user.
  it("classifies a missing API key (FailoverError) as auth", () => {
    const err =
      'Error: FailoverError: No API key found for provider "anthropic-subscription". ' +
      "Auth store: /root/.openclaw/agents/main/agent/auth-profiles.json (agentDir: " +
      "/root/.openclaw/agents/main/agent). Configure auth for this agent.";
    expect(classifyRouterError(err)).toBe("auth");
  });

  // The exact error after a rotated/expired OAuth refresh token (invalid_grant).
  it("classifies an expired/rotated OAuth refresh token as auth", () => {
    const err =
      "Error: FailoverError: OAuth token refresh failed for anthropic-subscription: " +
      'Anthropic token refresh failed: {"error": "invalid_grant", "error_description": ' +
      '"Refresh token not found or invalid"}. Please try again or re-authenticate.';
    expect(classifyRouterError(err)).toBe("auth");
  });

  it("keeps the existing auth signals (unauthorized, token_mismatch, pairing)", () => {
    expect(classifyRouterError("unauthorized")).toBe("auth");
    expect(classifyRouterError("token_mismatch")).toBe("auth");
    expect(classifyRouterError("pairing required")).toBe("auth");
  });

  it("classifies a refused container connection as connection-refused", () => {
    expect(classifyRouterError("connect ECONNREFUSED 127.0.0.1:18796")).toBe("connection-refused");
  });

  it("classifies timeouts", () => {
    expect(classifyRouterError("agent timeout after 60000ms")).toBe("timeout");
    expect(classifyRouterError("ETIMEDOUT")).toBe("timeout");
  });

  it("falls back to generic for unrecognized errors", () => {
    expect(classifyRouterError("TypeError: cannot read property 'x' of undefined")).toBe("generic");
  });
});

describe("isLifecycleBanner", () => {
  it("matches only the genuine sidecar lifecycle banners", () => {
    expect(isLifecycleBanner("*Back online.*")).toBe(true);
    expect(isLifecycleBanner("  *Shutting down...*  ")).toBe(true);
  });

  it("does NOT treat error replies as lifecycle banners", () => {
    // This is the crux of the retry-loop bug: error replies are italic too, but
    // they are replies to the user, not lifecycle noise, so recovery must see
    // them as "already handled".
    expect(
      isLifecycleBanner("*Something went wrong processing your message. Please try again.*"),
    ).toBe(false);
    expect(
      isLifecycleBanner(
        "*Your agent is not running. Please contact the admin to start your instance.*",
      ),
    ).toBe(false);
    expect(
      isLifecycleBanner("*Your agent is taking too long to respond. Please try again later.*"),
    ).toBe(false);
  });

  it("does not match plain user text or empty content", () => {
    expect(isLifecycleBanner("hi")).toBe(false);
    expect(isLifecycleBanner(undefined)).toBe(false);
    expect(isLifecycleBanner("")).toBe(false);
  });
});
