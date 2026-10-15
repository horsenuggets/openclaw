import { describe, expect, it } from "vitest";
import { resolveEphemeralCommand } from "./debug-ephemeral.js";

describe("resolveEphemeralCommand", () => {
  it("renders a status (no newValue) for a bare query when enabled", () => {
    const outcome = resolveEphemeralCommand(true, null);
    expect(outcome.newValue).toBeUndefined();
    expect(outcome.state).toBe("enabled");
    expect(outcome.description).toContain("currently `enabled`");
    expect(outcome.description).toContain("/debug ephemeral off");
  });

  it("renders a status for a bare query when disabled", () => {
    const outcome = resolveEphemeralCommand(false, null);
    expect(outcome.newValue).toBeUndefined();
    expect(outcome.state).toBe("disabled");
    expect(outcome.description).toContain("currently `disabled`");
    expect(outcome.description).toContain("/debug ephemeral on");
  });

  it("enables and reports the new state", () => {
    const outcome = resolveEphemeralCommand(false, true);
    expect(outcome).toMatchObject({ newValue: true, state: "enabled" });
    expect(outcome.description).toBe("Ephemeral command replies are now `enabled`.");
  });

  it("notes an already-enabled toggle and that nothing changed", () => {
    const outcome = resolveEphemeralCommand(true, true);
    expect(outcome).toMatchObject({ newValue: true, state: "enabled" });
    expect(outcome.description).toBe(
      "Ephemeral command replies were already `enabled`, so nothing changed.",
    );
  });

  it("disables and reports the new state", () => {
    const outcome = resolveEphemeralCommand(true, false);
    expect(outcome).toMatchObject({ newValue: false, state: "disabled" });
    expect(outcome.description).toBe("Ephemeral command replies are now `disabled`.");
  });

  it("notes an already-disabled toggle and that nothing changed", () => {
    const outcome = resolveEphemeralCommand(false, false);
    expect(outcome).toMatchObject({ newValue: false, state: "disabled" });
    expect(outcome.description).toBe(
      "Ephemeral command replies were already `disabled`, so nothing changed.",
    );
  });

  it("drops the verbose per-command explanation from toggle replies", () => {
    // The toggle/status replies now state only the first sentence; the old
    // `/debug`, `/lifecycle`, `/connections` enumeration is gone.
    for (const [current, desired] of [
      [false, true],
      [true, true],
      [true, false],
      [false, false],
      [true, null],
      [false, null],
    ] as const) {
      const { description } = resolveEphemeralCommand(current, desired);
      expect(description).not.toContain("/lifecycle");
      expect(description).not.toContain("/connections");
      expect(description).not.toContain("/channel");
    }
  });
});
