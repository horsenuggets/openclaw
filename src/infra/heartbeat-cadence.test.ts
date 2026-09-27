import { describe, expect, it } from "vitest";
import { applyBackoff, computeNextIntervalMs } from "./heartbeat-cadence.js";

const HOUR = 60 * 60 * 1000;

describe("applyBackoff", () => {
  it("returns the base interval when the user is active (streak 0)", () => {
    expect(applyBackoff(HOUR, 0, { factor: 2, maxIntervalMs: 7 * 24 * HOUR })).toBe(HOUR);
  });

  it("widens geometrically with the quiet streak", () => {
    const backoff = { factor: 2, maxIntervalMs: 7 * 24 * HOUR };
    expect(applyBackoff(HOUR, 1, backoff)).toBe(2 * HOUR);
    expect(applyBackoff(HOUR, 2, backoff)).toBe(4 * HOUR);
    expect(applyBackoff(HOUR, 3, backoff)).toBe(8 * HOUR);
  });

  it("clamps at the max interval (weekly ceiling)", () => {
    const backoff = { factor: 2, maxIntervalMs: 7 * 24 * HOUR };
    // 2^20 hours is astronomically large; must clamp to a week.
    expect(applyBackoff(HOUR, 20, backoff)).toBe(7 * 24 * HOUR);
  });

  it("is a no-op without backoff config or with factor <= 1", () => {
    expect(applyBackoff(HOUR, 5, undefined)).toBe(HOUR);
    expect(applyBackoff(HOUR, 5, { factor: 1, maxIntervalMs: HOUR })).toBe(HOUR);
  });
});

describe("computeNextIntervalMs", () => {
  it("returns the base interval with no jitter and no backoff", () => {
    expect(computeNextIntervalMs({ baseIntervalMs: HOUR, quietStreak: 0 })).toBe(HOUR);
  });

  it("spreads a 60m base to ~50-70m with 0.17 jitter across the RNG range", () => {
    const base = HOUR;
    // rng=0 -> lower bound (1 - jitter), rng just under 1 -> upper bound.
    const low = computeNextIntervalMs(
      { baseIntervalMs: base, quietStreak: 0 },
      { jitterPct: 0.17, rng: () => 0 },
    );
    const high = computeNextIntervalMs(
      { baseIntervalMs: base, quietStreak: 0 },
      { jitterPct: 0.17, rng: () => 0.999999 },
    );
    const mid = computeNextIntervalMs(
      { baseIntervalMs: base, quietStreak: 0 },
      { jitterPct: 0.17, rng: () => 0.5 },
    );
    expect(low / 60000).toBeCloseTo(49.8, 0); // ~50 min
    expect(high / 60000).toBeCloseTo(70.2, 0); // ~70 min
    expect(mid).toBe(HOUR); // rng 0.5 -> no offset
  });

  it("stays within the jitter envelope for any RNG value (property check)", () => {
    const base = HOUR;
    const jitterPct = 0.17;
    for (let i = 0; i <= 100; i++) {
      const r = i / 100;
      const v = computeNextIntervalMs(
        { baseIntervalMs: base, quietStreak: 0 },
        { jitterPct, rng: () => Math.min(r, 0.999999) },
      );
      expect(v).toBeGreaterThanOrEqual(Math.round(base * (1 - jitterPct)));
      expect(v).toBeLessThanOrEqual(Math.round(base * (1 + jitterPct)));
    }
  });

  it("applies backoff before jitter for dormant users", () => {
    const base = HOUR;
    const backoff = { factor: 2, maxIntervalMs: 7 * 24 * HOUR };
    // streak 2 -> 4h base, no jitter -> exactly 4h.
    expect(computeNextIntervalMs({ baseIntervalMs: base, quietStreak: 2 }, { backoff })).toBe(
      4 * HOUR,
    );
    // streak 2 with jitter still centered on 4h.
    expect(
      computeNextIntervalMs(
        { baseIntervalMs: base, quietStreak: 2 },
        { backoff, jitterPct: 0.17, rng: () => 0.5 },
      ),
    ).toBe(4 * HOUR);
  });

  it("never returns less than 1 second", () => {
    expect(computeNextIntervalMs({ baseIntervalMs: 10, quietStreak: 0 })).toBe(1000);
  });

  it("clamps jitter into a sane range", () => {
    // jitterPct > 1 is clamped so the interval can't go negative.
    const v = computeNextIntervalMs(
      { baseIntervalMs: HOUR, quietStreak: 0 },
      { jitterPct: 5, rng: () => 0 },
    );
    expect(v).toBeGreaterThan(0);
  });
});
