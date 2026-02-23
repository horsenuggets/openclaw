import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  getTodayDateStr,
  isDailyLimitReached,
  isGapLongEnough,
  isIdleLongEnough,
  isQuietHours,
  shouldEvaluateSession,
} from "./heuristics.js";

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "test-session",
    updatedAt: Date.now(),
    chatType: "direct",
    lastChannel: "discord",
    lastTo: "123456",
    lastUserMessageAt: Date.now() - 2 * 60 * 60_000,
    lastAgentResponseAt: Date.now() - 2 * 60 * 60_000,
    ...overrides,
  };
}

describe("isQuietHours", () => {
  const tz = "America/New_York";

  it("detects quiet hours crossing midnight (22:00-06:00)", () => {
    // 11pm ET = 4am UTC next day (in winter)
    const midnight = new Date("2026-02-22T05:00:00Z").getTime(); // ~midnight ET
    expect(
      isQuietHours({
        nowMs: midnight,
        quietHoursStart: "22:00",
        quietHoursEnd: "06:00",
        userTimezone: tz,
      }),
    ).toBe(true);
  });

  it("returns false outside quiet hours", () => {
    // 2pm ET = 7pm UTC
    const afternoon = new Date("2026-02-22T19:00:00Z").getTime();
    expect(
      isQuietHours({
        nowMs: afternoon,
        quietHoursStart: "22:00",
        quietHoursEnd: "06:00",
        userTimezone: tz,
      }),
    ).toBe(false);
  });

  it("handles same-day range (08:00-17:00)", () => {
    // 12pm ET = 5pm UTC
    const noon = new Date("2026-02-22T17:00:00Z").getTime();
    expect(
      isQuietHours({
        nowMs: noon,
        quietHoursStart: "8:00",
        quietHoursEnd: "17:00",
        userTimezone: tz,
      }),
    ).toBe(true);

    // 7am ET = 12pm UTC
    const early = new Date("2026-02-22T12:00:00Z").getTime();
    expect(
      isQuietHours({
        nowMs: early,
        quietHoursStart: "8:00",
        quietHoursEnd: "17:00",
        userTimezone: tz,
      }),
    ).toBe(false);
  });

  it("returns false for invalid time format", () => {
    expect(
      isQuietHours({
        nowMs: Date.now(),
        quietHoursStart: "invalid",
        quietHoursEnd: "06:00",
        userTimezone: tz,
      }),
    ).toBe(false);
  });
});

describe("isIdleLongEnough", () => {
  it("returns true when idle longer than threshold", () => {
    const now = Date.now();
    const entry = makeSessionEntry({
      lastUserMessageAt: now - 90 * 60_000,
      lastAgentResponseAt: now - 90 * 60_000,
    });
    expect(isIdleLongEnough({ entry, minIdleMinutes: 60, nowMs: now })).toBe(true);
  });

  it("returns false when recently active", () => {
    const now = Date.now();
    const entry = makeSessionEntry({
      lastUserMessageAt: now - 10 * 60_000,
      lastAgentResponseAt: now - 5 * 60_000,
    });
    expect(isIdleLongEnough({ entry, minIdleMinutes: 60, nowMs: now })).toBe(false);
  });

  it("returns false with no prior activity", () => {
    const entry = makeSessionEntry({
      lastUserMessageAt: undefined,
      lastAgentResponseAt: undefined,
    });
    expect(isIdleLongEnough({ entry, minIdleMinutes: 60, nowMs: Date.now() })).toBe(false);
  });

  it("uses the most recent activity from either side", () => {
    const now = Date.now();
    // User idle for 2 hours, but agent responded 10 minutes ago
    const entry = makeSessionEntry({
      lastUserMessageAt: now - 120 * 60_000,
      lastAgentResponseAt: now - 10 * 60_000,
    });
    expect(isIdleLongEnough({ entry, minIdleMinutes: 60, nowMs: now })).toBe(false);
  });
});

describe("isGapLongEnough", () => {
  it("returns true when no previous proactive message", () => {
    const entry = makeSessionEntry();
    expect(isGapLongEnough({ entry, minGapMinutes: 120, nowMs: Date.now() })).toBe(true);
  });

  it("returns true when gap is sufficient", () => {
    const now = Date.now();
    const entry = makeSessionEntry({
      lastProactiveMessageSentAt: now - 3 * 60 * 60_000,
    });
    expect(isGapLongEnough({ entry, minGapMinutes: 120, nowMs: now })).toBe(true);
  });

  it("returns false when gap is too short", () => {
    const now = Date.now();
    const entry = makeSessionEntry({
      lastProactiveMessageSentAt: now - 30 * 60_000,
    });
    expect(isGapLongEnough({ entry, minGapMinutes: 120, nowMs: now })).toBe(false);
  });
});

describe("isDailyLimitReached", () => {
  it("returns false on a new day", () => {
    const entry = makeSessionEntry({
      proactiveMessageCountDate: "2026-02-21",
      proactiveMessageCountToday: 10,
    });
    expect(isDailyLimitReached({ entry, maxPerDay: 6, todayDate: "2026-02-22" })).toBe(false);
  });

  it("returns false when under limit", () => {
    const entry = makeSessionEntry({
      proactiveMessageCountDate: "2026-02-22",
      proactiveMessageCountToday: 3,
    });
    expect(isDailyLimitReached({ entry, maxPerDay: 6, todayDate: "2026-02-22" })).toBe(false);
  });

  it("returns true when at limit", () => {
    const entry = makeSessionEntry({
      proactiveMessageCountDate: "2026-02-22",
      proactiveMessageCountToday: 6,
    });
    expect(isDailyLimitReached({ entry, maxPerDay: 6, todayDate: "2026-02-22" })).toBe(true);
  });

  it("returns true when over limit", () => {
    const entry = makeSessionEntry({
      proactiveMessageCountDate: "2026-02-22",
      proactiveMessageCountToday: 10,
    });
    expect(isDailyLimitReached({ entry, maxPerDay: 6, todayDate: "2026-02-22" })).toBe(true);
  });
});

describe("getTodayDateStr", () => {
  it("returns YYYY-MM-DD for a given timezone", () => {
    // Feb 22, 2026 in UTC
    const ts = new Date("2026-02-22T15:00:00Z").getTime();
    const result = getTodayDateStr(ts, "America/New_York");
    expect(result).toBe("2026-02-22");
  });

  it("handles timezone day boundary", () => {
    // Feb 23 at 1am UTC = Feb 22 at 8pm ET (still Feb 22)
    const ts = new Date("2026-02-23T01:00:00Z").getTime();
    const result = getTodayDateStr(ts, "America/New_York");
    expect(result).toBe("2026-02-22");
  });
});

describe("shouldEvaluateSession", () => {
  const baseConfig = {};
  const tz = "America/New_York";

  function makeEvalCtx(
    entryOverrides: Partial<SessionEntry> = {},
    opts: { isStartup?: boolean } = {},
  ) {
    const now = Date.now();
    return {
      sessionKey: "discord:123",
      entry: makeSessionEntry({
        lastUserMessageAt: now - 2 * 60 * 60_000,
        lastAgentResponseAt: now - 2 * 60 * 60_000,
        ...entryOverrides,
      }),
      config: baseConfig,
      userTimezone: tz,
      nowMs: now,
      isStartup: opts.isStartup,
    };
  }

  it("rejects non-direct chat types", () => {
    const result = shouldEvaluateSession(makeEvalCtx({ chatType: "group" }));
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("not-direct");
    }
  });

  it("rejects sessions without delivery route", () => {
    const result = shouldEvaluateSession(
      makeEvalCtx({ lastChannel: undefined, lastTo: undefined }),
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("no-delivery-route");
    }
  });

  it("rejects sessions with no prior interaction", () => {
    const result = shouldEvaluateSession(
      makeEvalCtx({
        lastUserMessageAt: undefined,
        lastAgentResponseAt: undefined,
      }),
    );
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("no-prior-interaction");
    }
  });

  it("accepts eligible DM sessions", () => {
    // 2pm ET on a weekday, idle for 2 hours
    const now = new Date("2026-02-22T19:00:00Z").getTime(); // 2pm ET
    const result = shouldEvaluateSession({
      sessionKey: "discord:123",
      entry: makeSessionEntry({
        lastUserMessageAt: now - 2 * 60 * 60_000,
        lastAgentResponseAt: now - 2 * 60 * 60_000,
      }),
      config: baseConfig,
      userTimezone: tz,
      nowMs: now,
    });
    expect(result.eligible).toBe(true);
  });

  it("uses relaxed idle threshold on startup", () => {
    // Session idle for 45 minutes (under default 60 min, above startup 30 min)
    const now = new Date("2026-02-22T19:00:00Z").getTime();
    const result = shouldEvaluateSession({
      sessionKey: "discord:123",
      entry: makeSessionEntry({
        lastUserMessageAt: now - 45 * 60_000,
        lastAgentResponseAt: now - 45 * 60_000,
      }),
      config: baseConfig,
      userTimezone: tz,
      nowMs: now,
      isStartup: true,
    });
    expect(result.eligible).toBe(true);
  });

  it("rejects during quiet hours", () => {
    // 11pm ET
    const now = new Date("2026-02-23T04:00:00Z").getTime(); // 11pm ET
    const result = shouldEvaluateSession({
      sessionKey: "discord:123",
      entry: makeSessionEntry({
        lastUserMessageAt: now - 2 * 60 * 60_000,
        lastAgentResponseAt: now - 2 * 60 * 60_000,
      }),
      config: baseConfig,
      userTimezone: tz,
      nowMs: now,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("quiet-hours");
    }
  });

  it("rejects when gap between proactive messages is too short", () => {
    const now = new Date("2026-02-22T19:00:00Z").getTime();
    const result = shouldEvaluateSession({
      sessionKey: "discord:123",
      entry: makeSessionEntry({
        lastUserMessageAt: now - 2 * 60 * 60_000,
        lastAgentResponseAt: now - 2 * 60 * 60_000,
        lastProactiveMessageSentAt: now - 60 * 60_000, // 1 hour ago
      }),
      config: baseConfig,
      userTimezone: tz,
      nowMs: now,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("gap-too-short");
    }
  });

  it("rejects when daily limit is reached", () => {
    const now = new Date("2026-02-22T19:00:00Z").getTime();
    const todayDate = getTodayDateStr(now, tz);
    const result = shouldEvaluateSession({
      sessionKey: "discord:123",
      entry: makeSessionEntry({
        lastUserMessageAt: now - 3 * 60 * 60_000,
        lastAgentResponseAt: now - 3 * 60 * 60_000,
        proactiveMessageCountDate: todayDate,
        proactiveMessageCountToday: 6,
      }),
      config: baseConfig,
      userTimezone: tz,
      nowMs: now,
    });
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reason).toBe("rate-limited");
    }
  });
});
