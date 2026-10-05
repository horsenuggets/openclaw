import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { CC_BASE_PROMPT, needsSubscriptionSystemPrompt } from "./subscription-prompt.js";

describe("needsSubscriptionSystemPrompt", () => {
  it("is true for the anthropic-subscription provider", () => {
    expect(needsSubscriptionSystemPrompt("anthropic-subscription")).toBe(true);
  });

  it("is true for any provider configured with oauth auth", () => {
    const config = {
      models: { providers: { "my-proxy": { auth: "oauth" } } },
    } as unknown as OpenClawConfig;
    expect(needsSubscriptionSystemPrompt("my-proxy", config)).toBe(true);
  });

  it("is false for a plain api-key provider and when config is absent", () => {
    const config = {
      models: { providers: { anthropic: { auth: "api-key" } } },
    } as unknown as OpenClawConfig;
    expect(needsSubscriptionSystemPrompt("anthropic", config)).toBe(false);
    expect(needsSubscriptionSystemPrompt("anthropic")).toBe(false);
  });
});

describe("CC_BASE_PROMPT", () => {
  it("is a pure Claude Code base with no OpenClaw-specific content", () => {
    // The subscription path puts only this in the system block; anything
    // OpenClaw-specific here would spill the request into paid extra usage.
    expect(CC_BASE_PROMPT).toContain("software engineering tasks");
    expect(CC_BASE_PROMPT.toLowerCase()).not.toContain("openclaw");
    expect(CC_BASE_PROMPT.toLowerCase()).not.toContain("heartbeat");
    expect(CC_BASE_PROMPT).not.toContain("SOUL.md");
  });
});
