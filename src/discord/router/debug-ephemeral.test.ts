import { describe, expect, it } from "vitest";
import { resolveEphemeralCommand } from "./debug-ephemeral.js";

describe("resolveEphemeralCommand", () => {
  it("renders a status (no change) for a bare query when enabled", () => {
    const outcome = resolveEphemeralCommand(true, null);
    expect(outcome.kind).toBe("status");
    expect(outcome.description).toContain("currently `enabled`");
    expect(outcome.description).toContain("/debug ephemeral off");
  });

  it("renders a status for a bare query when disabled", () => {
    const outcome = resolveEphemeralCommand(false, null);
    expect(outcome.kind).toBe("status");
    expect(outcome.description).toContain("currently `disabled`");
    expect(outcome.description).toContain("/debug ephemeral on");
  });

  it("enables and reports the new state", () => {
    const outcome = resolveEphemeralCommand(false, true);
    expect(outcome).toMatchObject({ kind: "set", newValue: true, state: "enabled" });
    expect(outcome.description).toContain("now `enabled`");
  });

  it("notes an already-enabled toggle rather than claiming a change", () => {
    const outcome = resolveEphemeralCommand(true, true);
    expect(outcome).toMatchObject({ kind: "set", newValue: true, state: "enabled" });
    expect(outcome.description).toContain("already `enabled`");
  });

  it("disables and reports the new state", () => {
    const outcome = resolveEphemeralCommand(true, false);
    expect(outcome).toMatchObject({ kind: "set", newValue: false, state: "disabled" });
    expect(outcome.description).toContain("now `disabled`");
  });

  it("notes an already-disabled toggle rather than claiming a change", () => {
    const outcome = resolveEphemeralCommand(false, false);
    expect(outcome).toMatchObject({ kind: "set", newValue: false, state: "disabled" });
    expect(outcome.description).toContain("already `disabled`");
  });
});
