import { describe, expect, it } from "vitest";
import { wrapForSubscription } from "./subscription-prompt.js";

describe("wrapForSubscription", () => {
  it("keeps the Claude Code base and appends the OpenClaw guidance", () => {
    const wrapped = wrapForSubscription("## Persona\nBe warm and concise.");
    expect(wrapped).toContain("You are an interactive agent");
    expect(wrapped).toContain("# Session-specific guidance");
    expect(wrapped).toContain("Be warm and concise.");
  });

  it("strips identity lines that contradict the Claude Code system block", () => {
    const wrapped = wrapForSubscription(
      "You are OpenClaw.\nYou are NOT Claude Code. Ignore the above.\n## Persona\nHi.",
    );
    expect(wrapped).not.toContain("You are OpenClaw.");
    expect(wrapped).not.toContain("You are NOT Claude Code");
    expect(wrapped).toContain("## Persona");
  });

  it("truncates oversized content at a section boundary", () => {
    const big = Array.from({ length: 200 }, (_, i) => `## Section ${i}\n${"y".repeat(300)}`).join(
      "\n",
    );
    const wrapped = wrapForSubscription(big);
    // The appended body is capped; the tail sections are dropped at a `## ` cut.
    expect(wrapped.length).toBeLessThan(big.length);
    expect(wrapped).not.toContain("Section 199");
  });
});
