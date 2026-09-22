import { describe, expect, it } from "vitest";
import { shouldRelayCommandResult } from "./router";

const MAX = 5;

function relay(overrides: {
  ranCommand?: boolean;
  commandResult?: string | null;
  deliveredThisTurn?: boolean;
  commandDepth?: number;
  maxRoundtrips?: number;
}): boolean {
  return shouldRelayCommandResult({
    ranCommand: overrides.ranCommand ?? true,
    // Respect an explicitly-passed null; only default when the key is absent.
    commandResult: "commandResult" in overrides ? (overrides.commandResult ?? null) : "ok",
    deliveredThisTurn: overrides.deliveredThisTurn ?? false,
    commandDepth: overrides.commandDepth ?? 0,
    maxRoundtrips: overrides.maxRoundtrips ?? MAX,
  });
}

describe("shouldRelayCommandResult", () => {
  it("relays an internal-only command turn so the agent can continue", () => {
    // Command ran, produced a result, nothing user-visible was delivered.
    expect(relay({ ranCommand: true, commandResult: "ticked", deliveredThisTurn: false })).toBe(
      true,
    );
  });

  it("does not relay when the turn already spoke to the user", () => {
    // The double-reply regression: a turn that both ran a command and delivered
    // text must NOT spawn a second user-visible follow-up turn.
    expect(relay({ ranCommand: true, commandResult: "ticked", deliveredThisTurn: true })).toBe(
      false,
    );
  });

  it("does not relay when no command ran", () => {
    expect(relay({ ranCommand: false, commandResult: null })).toBe(false);
  });

  it("does not relay when the command produced no result", () => {
    expect(relay({ ranCommand: true, commandResult: null })).toBe(false);
  });

  it("does not relay once the roundtrip budget is exhausted", () => {
    expect(relay({ commandDepth: MAX })).toBe(false);
    expect(relay({ commandDepth: MAX - 1 })).toBe(true);
  });

  it("relays only for the internal-only, in-budget combination across the truth table", () => {
    for (const ranCommand of [false, true]) {
      for (const hasResult of [false, true]) {
        for (const deliveredThisTurn of [false, true]) {
          for (const inBudget of [false, true]) {
            const expected = ranCommand && hasResult && !deliveredThisTurn && inBudget;
            expect(
              shouldRelayCommandResult({
                ranCommand,
                commandResult: hasResult ? "ok" : null,
                deliveredThisTurn,
                commandDepth: inBudget ? 0 : MAX,
                maxRoundtrips: MAX,
              }),
            ).toBe(expected);
          }
        }
      }
    }
  });
});
