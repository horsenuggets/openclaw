import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCadenceOptions, resolveHeartbeatIntervalMs } from "./heartbeat-runner.js";

const cfg = {} as OpenClawConfig;

describe("heartbeat debug time overrides", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_HEARTBEAT_EVERY;
    delete process.env.OPENCLAW_HEARTBEAT_NO_JITTER;
  });

  it("OPENCLAW_HEARTBEAT_EVERY overrides the configured interval", () => {
    expect(resolveHeartbeatIntervalMs(cfg, undefined, { every: "60m" })).toBe(60 * 60_000);
    process.env.OPENCLAW_HEARTBEAT_EVERY = "20s";
    expect(resolveHeartbeatIntervalMs(cfg, undefined, { every: "60m" })).toBe(20_000);
  });

  it("ignores an invalid OPENCLAW_HEARTBEAT_EVERY and falls back to config", () => {
    process.env.OPENCLAW_HEARTBEAT_EVERY = "not-a-duration";
    // Invalid override => resolveHeartbeatIntervalMs returns null (unparseable).
    expect(resolveHeartbeatIntervalMs(cfg, undefined, { every: "60m" })).toBeNull();
  });

  it("OPENCLAW_HEARTBEAT_NO_JITTER strips jitter from resolved cadence", () => {
    expect(resolveCadenceOptions({ jitterPct: 0.17 }).jitterPct).toBe(0.17);
    process.env.OPENCLAW_HEARTBEAT_NO_JITTER = "1";
    expect(resolveCadenceOptions({ jitterPct: 0.17 }).jitterPct).toBeUndefined();
  });
});
