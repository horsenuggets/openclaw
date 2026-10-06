import { describe, expect, it } from "vitest";
import { buildLifecycleMessage } from "../../../discord-health-monitor/lifecycle-message.js";
import { buildLogEmbed } from "./log-embed.js";
import { classifyRouterError, isConversationalBot, isLifecycleBanner } from "./router-filters.js";

/** A representative diagnostics banner string for each event. */
function banner(event: "startup" | "shutdown"): string {
  return buildLifecycleMessage({
    event,
    reason: event === "startup" ? "ROUTER_RESTART" : "SIGTERM",
    pid: 4321,
    uptimeSeconds: 3723,
    downSince: Date.parse("2026-10-05T00:00:00.000Z"),
    now: Date.parse("2026-10-05T00:00:12.000Z"),
    discordApiPingMs: 83,
    memory: { rss: 89_214_976, heapUsed: 23_170_000 },
  });
}

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

  it("detects a lifecycle banner carried in an embed description", () => {
    expect(isLifecycleBanner({ content: "", embeds: [{ description: "*Back online.*" }] })).toBe(
      true,
    );
    expect(
      isLifecycleBanner({ content: "", embeds: [{ description: "  *Shutting down...*  " }] }),
    ).toBe(true);
  });

  it("does NOT treat an error log embed as a lifecycle banner", () => {
    // Error log embeds share the Log category but carry different text, so the
    // exact-phrase match keeps them from being skipped by recovery.
    expect(
      isLifecycleBanner({
        content: "",
        embeds: [{ description: "*Something went wrong processing your message.*" }],
      }),
    ).toBe(false);
  });

  it("matches the legacy exact phrases still in channel history", () => {
    // Older builds posted these verbatim; recovery must still skip them.
    expect(isLifecycleBanner({ embeds: [buildLogEmbed("Back online.").embed] })).toBe(true);
    expect(isLifecycleBanner({ embeds: [buildLogEmbed("Shutting down...").embed] })).toBe(true);
  });

  it("matches current diagnostics banners (lead phrase + JSON payload)", () => {
    // The trailing JSON varies per event, so matching keys off the static lead
    // phrase, but the JSON must be present for it to count as a banner.
    expect(isLifecycleBanner(banner("startup"))).toBe(true);
    expect(isLifecycleBanner(banner("shutdown"))).toBe(true);
  });

  it("does NOT match a bot reply that merely opens with the lead phrase", () => {
    // Guards the recovery-loop regression: an ordinary reply starting with the
    // phrase but without the JSON payload is NOT lifecycle noise, so recovery must
    // treat the user message beneath it as already handled.
    expect(isLifecycleBanner("The agent is starting up failed to reach the gateway.")).toBe(false);
    expect(isLifecycleBanner("The agent is starting up...")).toBe(false);
    expect(
      isLifecycleBanner({ embeds: [{ description: "The agent is shutting down soon." }] }),
    ).toBe(false);
  });

  it("requires the payload to parse as JSON, not just any fenced/brace-led text", () => {
    // A reply that opens with the lead phrase and a fenced block whose body is not a
    // JSON object must NOT be skipped, or recovery would replay the message beneath it.
    expect(isLifecycleBanner("The agent is starting up...\n```text\nfailed\n```")).toBe(false);
    expect(isLifecycleBanner("The agent is shutting down... {not valid json")).toBe(false);
    expect(isLifecycleBanner('The agent is starting up... ["an","array"]')).toBe(false);
  });

  it("requires the fence to span the whole message (no trailing reply after it)", () => {
    // A valid-looking fenced block mid-message must not classify the whole reply as a
    // banner, or recovery would replay the user message beneath an ordinary reply.
    expect(isLifecycleBanner("The agent is starting up...\n```json\n{}\n```\nnormal reply")).toBe(
      false,
    );
    expect(isLifecycleBanner('The agent is shutting down... {"a":1} and then more text')).toBe(
      false,
    );
  });

  it("matches the exact diagnostics embed the sidecar sends (sender/matcher consistency)", () => {
    // buildLifecycleMessage -> buildLogEmbed is the real sidecar path; its output
    // description (lead phrase + fenced JSON) must be what recovery recognizes.
    expect(isLifecycleBanner({ embeds: [buildLogEmbed(banner("startup")).embed] })).toBe(true);
    expect(isLifecycleBanner({ embeds: [buildLogEmbed(banner("shutdown")).embed] })).toBe(true);
  });
});
