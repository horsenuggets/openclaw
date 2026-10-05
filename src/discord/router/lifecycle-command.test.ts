import { describe, expect, it } from "vitest";
import { resolveLifecycleCommand } from "./lifecycle-command.js";

describe("resolveLifecycleCommand", () => {
  it("enables when currently off", () => {
    const r = resolveLifecycleCommand(false, "on");
    expect(r.newValue).toBe(true);
    expect(r.state).toBe("enabled");
    expect(r.description).toBe(
      "Lifecycle messages are now `enabled`. You will see startup/shutdown notification messages in this channel.",
    );
  });

  it("reports already-enabled when turning on while on (still the enabled icon)", () => {
    const r = resolveLifecycleCommand(true, "on");
    expect(r.newValue).toBe(true);
    expect(r.state).toBe("enabled");
    expect(r.description).toContain("already `enabled`");
  });

  it("disables when currently on", () => {
    const r = resolveLifecycleCommand(true, "off");
    expect(r.newValue).toBe(false);
    expect(r.state).toBe("disabled");
    expect(r.description).toContain("now `disabled`");
    expect(r.description).toContain("no longer see");
  });

  it("reports already-disabled when turning off while off", () => {
    const r = resolveLifecycleCommand(false, "off");
    expect(r.newValue).toBe(false);
    expect(r.state).toBe("disabled");
    expect(r.description).toContain("already `disabled`");
  });

  it("is a status query (no write) when enabled with no arg", () => {
    const r = resolveLifecycleCommand(true, undefined);
    expect(r.newValue).toBeUndefined();
    expect(r.state).toBe("enabled");
    expect(r.description).toContain("currently `enabled`");
    expect(r.description).toContain("/lifecycle off");
  });

  it("is a status query (no write) when disabled with no arg", () => {
    const r = resolveLifecycleCommand(false, undefined);
    expect(r.newValue).toBeUndefined();
    expect(r.state).toBe("disabled");
    expect(r.description).toContain("currently `disabled`");
    expect(r.description).toContain("/lifecycle on");
  });
});
