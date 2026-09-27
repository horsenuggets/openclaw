import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Integration tests for the heartbeat scheduler's cadence: jitter and
 * engagement-adaptive backoff. Uses fake timers to "tick fast" through wakes
 * without waiting real minutes, and a mocked runOnce so no model runs.
 */
describe("heartbeat scheduler cadence", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function baseCfg(heartbeat: Record<string, unknown>): OpenClawConfig {
    return { agents: { defaults: { heartbeat } } } as OpenClawConfig;
  }

  it("keeps a flat cadence with no jitter and an engaged user", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    // User always messaged more recently than the previous wake -> never backs off.
    const runner = startHeartbeatRunner({
      cfg: baseCfg({ every: "60m" }),
      runOnce: runSpy,
      readEngagementMs: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(3 * HOUR + 1000);
    expect(runSpy).toHaveBeenCalledTimes(3); // fired at ~1h, 2h, 3h
    runner.stop();
  });

  it("widens the interval for a dormant user (backoff) and snaps back on engagement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });

    // Dormant: user's last message stays fixed in the past. The first wake is
    // "free" (no prior wake to compare), then the quiet streak grows and the
    // interval widens: base 1h, then 2h, then 4h (factor 2).
    let engagementMs = 0;
    const runner = startHeartbeatRunner({
      cfg: baseCfg({ every: "60m", backoff: { factor: 2, max: "24h" } }),
      runOnce: runSpy,
      readEngagementMs: () => engagementMs,
    });

    // Wake 1 at ~1h (streak stays 0 on the first wake) -> next scheduled at +1h.
    await vi.advanceTimersByTimeAsync(HOUR + 1000);
    expect(runSpy).toHaveBeenCalledTimes(1);
    // Wake 2 at ~2h -> dormant, streak becomes 1 -> next widened to +2h.
    await vi.advanceTimersByTimeAsync(HOUR + 1000);
    expect(runSpy).toHaveBeenCalledTimes(2);
    // Only 1h later (~3h) the widened 2h gap means NO wake yet.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(runSpy).toHaveBeenCalledTimes(2);
    // Crossing ~4h fires wake 3 -> streak 2 -> next widened to +4h.
    await vi.advanceTimersByTimeAsync(HOUR + 1000);
    expect(runSpy).toHaveBeenCalledTimes(3);

    // User replies now. The next wake (scheduled ~8h) sees engagement and resets
    // the streak, snapping the cadence back to the base 1h.
    await vi.advanceTimersByTimeAsync(1000);
    engagementMs = Date.now();
    await vi.advanceTimersByTimeAsync(4 * HOUR + 2000); // reach the ~8h wake
    expect(runSpy).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(HOUR + 1000); // back to base cadence -> fires at +1h
    expect(runSpy).toHaveBeenCalledTimes(5);
    runner.stop();
  });

  it("keeps jittered wakes within the configured envelope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: baseCfg({ every: "60m", jitterPct: 0.17 }),
      runOnce: runSpy,
      readEngagementMs: () => Date.now(),
    });

    // The initial wake is at the base interval (60m). Advancing 50m must not fire.
    await vi.advanceTimersByTimeAsync(50 * MIN);
    expect(runSpy).toHaveBeenCalledTimes(0);
    // By 61m the first wake has fired.
    await vi.advanceTimersByTimeAsync(11 * MIN + 1000);
    expect(runSpy).toHaveBeenCalledTimes(1);
    // The next (jittered) wake lands within 50-70m; by +71m it must have fired.
    await vi.advanceTimersByTimeAsync(71 * MIN);
    expect(runSpy).toHaveBeenCalledTimes(2);
    runner.stop();
  });
});
