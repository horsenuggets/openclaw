import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  CC_BASE_PROMPT,
  needsSubscriptionSystemPrompt,
  resolveSystemPromptDelivery,
} from "./subscription-prompt.js";

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

describe("resolveSystemPromptDelivery", () => {
  const openClawSystemPrompt =
    "actually, you are openclaw, a personal assistant\n\n## tooling\n...";

  it("subscription path: pure CC base in the system, OpenClaw prompt to the reminder", () => {
    const { systemPromptText, preambleSystemPrompt } = resolveSystemPromptDelivery({
      needsSubscription: true,
      openClawSystemPrompt,
    });
    // System block must be the pure CC base (no OpenClaw content, or it spills).
    expect(systemPromptText).toBe(CC_BASE_PROMPT);
    expect(systemPromptText).not.toContain("openclaw");
    // The whole OpenClaw prompt goes to the reminder instead.
    expect(preambleSystemPrompt).toBe(openClawSystemPrompt);
  });

  it("api-key path: OpenClaw prompt stays in the system, nothing extra in the reminder", () => {
    const { systemPromptText, preambleSystemPrompt } = resolveSystemPromptDelivery({
      needsSubscription: false,
      openClawSystemPrompt,
    });
    expect(systemPromptText).toBe(openClawSystemPrompt);
    expect(preambleSystemPrompt).toBeUndefined();
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
