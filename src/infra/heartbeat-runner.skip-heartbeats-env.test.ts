import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

// Avoid pulling optional runtime deps during isolated imports.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

// The OPENCLAW_SKIP_HEARTBEATS gate is read once at module load, so each case sets
// the env var and imports the runner in isolation via vi.resetModules().
const ENV_KEY = "OPENCLAW_SKIP_HEARTBEATS";

describe("OPENCLAW_SKIP_HEARTBEATS gate", () => {
  const previous = process.env[ENV_KEY];

  afterEach(() => {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
    vi.resetModules();
  });

  // Default agent is heartbeat-enabled and the interval resolves, so the only path
  // to reason "disabled" is the module-level env gate (checked before any I/O).
  const enabledCfg: OpenClawConfig = {
    agents: { defaults: { heartbeat: { every: "30m" } } },
  };

  it("short-circuits every heartbeat as disabled when set to 1", async () => {
    process.env[ENV_KEY] = "1";
    vi.resetModules();
    const { runHeartbeatOnce } = await import("./heartbeat-runner.js");

    const res = await runHeartbeatOnce({ cfg: enabledCfg });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("disabled");
    }
  });

  it("does not gate heartbeats when unset (proceeds past the env check)", async () => {
    delete process.env[ENV_KEY];
    vi.resetModules();
    const { runHeartbeatOnce } = await import("./heartbeat-runner.js");

    // Quiet hours is the next cheap skip after the env gate and returns before any
    // session/reply I/O, so a "quiet-hours" result proves the gate let it through.
    const res = await runHeartbeatOnce({
      cfg: {
        agents: {
          defaults: {
            userTimezone: "UTC",
            heartbeat: {
              every: "30m",
              activeHours: { start: "08:00", end: "24:00", timezone: "user" },
            },
          },
        },
      },
      deps: { nowMs: () => Date.UTC(2025, 0, 1, 7, 0, 0) },
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("quiet-hours");
    }
  });
});
