import { describe, expect, it, vi } from "vitest";

describe("legacy config detection", () => {
  it("rejects a retired proactive block under the strict schema", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      proactive: { enabled: true },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("proactive");
    }
  });

  it("auto-migrates by dropping proactive so the config validates", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      proactive: { enabled: true, checkIntervalMinutes: 5 },
    });
    expect(res.changes).toContain(
      "Removed proactive (retired; heartbeats handle proactive messaging).",
    );
    expect(res.config).not.toBeNull();
    expect((res.config as { proactive?: unknown }).proactive).toBeUndefined();
  });
});
