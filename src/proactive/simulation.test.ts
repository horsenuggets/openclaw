/**
 * Multi-day proactive messaging simulation.
 *
 * Runs a realistic multi-day scenario with a mocked clock where hours
 * pass in milliseconds. Tracks every proactive trigger the service
 * fires, verifies quiet hours, rate limits, daily resets, user
 * activity interruptions, and startup greetings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { ProactiveService } from "./service.js";

// ── mocks ──────────────────────────────────────────────────────────

vi.mock("../auto-reply/reply/route-reply.js", () => ({
  isRoutableChannel: vi.fn(() => true),
}));

vi.mock("../agents/date-time.js", () => ({
  resolveUserTimezone: vi.fn(() => "America/New_York"),
  resolveUserTimeFormat: vi.fn(() => "12"),
  formatUserTime: vi.fn((date: Date, _tz: string, _fmt: string) => date.toISOString()),
}));

// Shared mutable session store that persists across updateSessionStore
// calls inside one test run, so the heuristic filters see the state
// that previous proactive triggers wrote.
let sessionStore: Record<string, SessionEntry> = {};

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => sessionStore),
  resolveStorePath: vi.fn(() => "/tmp/sim-sessions.json5"),
  updateSessionStore: vi.fn(
    async (_path: string, mutator: (s: Record<string, SessionEntry>) => void) => {
      mutator(sessionStore);
    },
  ),
}));

// ── helpers ─────────────────────────────────────────────────────────

/** Timestamps in this simulation are driven by a manually-advanced clock. */
let simNow = 0;
/** Cumulative elapsed time across advanceAndCheck calls within a test. */
let simElapsed = 0;

function makeConfig(overrides: Partial<OpenClawConfig["proactive"]> = {}): OpenClawConfig {
  return {
    proactive: {
      enabled: true,
      checkIntervalMinutes: 5,
      quietHoursStart: "22:00",
      quietHoursEnd: "06:00",
      minIdleMinutes: 60,
      minGapMinutes: 120,
      maxPerDay: 6,
      ...overrides,
    },
  };
}

type ProactiveEvent = {
  type: "trigger" | "silent";
  sessionKey: string;
  atMs: number;
  atHuman: string;
  prompt: string;
  response: string;
};

/**
 * Helper to format a timestamp as a human-readable label relative
 * to the simulation start (Day 1 Mon 6:00 AM ET).
 */
function humanTime(ms: number): string {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const rest = parts
    .filter((p) => p.type !== "weekday" && p.type !== "literal")
    .map((p) => p.value)
    .join("");
  // Compute day number from simulation start
  const dayNum = Math.floor((ms - simNow) / (24 * 60 * 60_000)) + 1;
  return `Day ${dayNum} ${weekday} ${rest}`;
}

// ── simulation ──────────────────────────────────────────────────────

describe("Multi-day proactive messaging simulation", () => {
  // Timeline starts Monday 6:00 AM ET = 11:00 UTC
  const SIM_START = new Date("2026-02-23T11:00:00Z").getTime();
  const HOUR = 60 * 60_000;
  const MINUTE = 60_000;

  let events: ProactiveEvent[];
  let agentResponses: Map<string, (prompt: string, time: number) => string>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SIM_START));
    simNow = SIM_START;
    simElapsed = 0;
    events = [];
    agentResponses = new Map();

    // Default agent behavior: respond with something contextual
    agentResponses.set("default", (prompt, time) => {
      const d = new Date(time);
      const hour = Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          hour12: false,
        })
          .formatToParts(d)
          .find((p) => p.type === "hour")?.value ?? 0,
      );
      if (hour >= 6 && hour < 12) {
        return "Good morning! How did you sleep?";
      }
      if (hour >= 12 && hour < 17) {
        return "Hey, how's your afternoon going?";
      }
      if (hour >= 17 && hour < 22) {
        return "Hope you're having a good evening!";
      }
      return "NO_REPLY";
    });

    // Reset the session store with a realistic DM session
    sessionStore = {
      "discord:peter-123": {
        sessionId: "sess-peter",
        updatedAt: SIM_START - 10 * HOUR,
        chatType: "direct",
        lastChannel: "discord",
        lastTo: "peter-123",
        lastUserMessageAt: SIM_START - 10 * HOUR,
        lastAgentResponseAt: SIM_START - 10 * HOUR,
      } as SessionEntry,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildService(
    configOverrides: Partial<OpenClawConfig["proactive"]> = {},
  ): ProactiveService {
    const config = makeConfig(configOverrides);

    const runAgentCommand = vi.fn(async (opts: { message: string; sessionKey: string }) => {
      const now = Date.now();
      const responder = agentResponses.get(opts.sessionKey) ?? agentResponses.get("default")!;
      const response = responder(opts.message, now);
      const isSilent = response === "NO_REPLY" || response.trim() === "";

      events.push({
        type: isSilent ? "silent" : "trigger",
        sessionKey: opts.sessionKey,
        atMs: now,
        atHuman: humanTime(now),
        prompt: opts.message.slice(0, 80) + "...",
        response,
      });

      // If the agent sent something, update session state to
      // simulate lastAgentResponseAt being set (agentCommand does
      // this in production).
      if (!isSilent) {
        const entry = sessionStore[opts.sessionKey];
        if (entry) {
          entry.lastAgentResponseAt = now;
        }
      }

      return {
        payloads: isSilent ? [{ text: "NO_REPLY" }] : [{ text: response }],
      };
    });

    return new ProactiveService({
      loadConfig: () => config,
      runAgentCommand,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      nowMs: () => Date.now(),
    });
  }

  /**
   * Advance the simulation clock by the given milliseconds and run
   * a proactive check at each step interval.
   */
  async function advanceAndCheck(
    service: ProactiveService,
    totalMs: number,
    stepMs: number = 5 * MINUTE,
  ) {
    let elapsed = 0;
    while (elapsed < totalMs) {
      const step = Math.min(stepMs, totalMs - elapsed);
      simElapsed += step;
      vi.setSystemTime(new Date(SIM_START + simElapsed));
      await service.checkNow();
      elapsed += step;
    }
  }

  /**
   * Simulate a user sending a message at the current time.
   */
  function userSendsMessage(sessionKey: string) {
    const entry = sessionStore[sessionKey];
    if (entry) {
      entry.lastUserMessageAt = Date.now();
      entry.lastAgentResponseAt = Date.now();
    }
  }

  // ── test scenarios ────────────────────────────────────────────────

  it("simulates a full day: morning greeting, afternoon check-in, quiet hours silence", async () => {
    const service = buildService();

    // 6:00 AM - 11:59 PM (18 hours)
    await advanceAndCheck(service, 18 * HOUR);

    // Should have some triggers and they should all be during waking hours
    const triggers = events.filter((e) => e.type === "trigger");
    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(triggers.length).toBeLessThanOrEqual(6); // maxPerDay

    // Verify no triggers during quiet hours (10 PM - 6 AM)
    for (const evt of triggers) {
      const d = new Date(evt.atMs);
      const hour = Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          hour12: false,
        })
          .formatToParts(d)
          .find((p) => p.type === "hour")?.value ?? 0,
      );
      expect(hour).toBeGreaterThanOrEqual(6);
      expect(hour).toBeLessThan(22);
    }

    // First trigger should be a morning greeting
    expect(triggers[0].response).toContain("morning");

    service.stop();
  });

  it("respects the 2-hour gap between proactive messages", async () => {
    const service = buildService();

    // Run for 8 hours (6 AM - 2 PM)
    await advanceAndCheck(service, 8 * HOUR);

    const triggers = events.filter((e) => e.type === "trigger");
    // With 2-hour gaps and 8 hours, expect ~4 triggers max
    expect(triggers.length).toBeLessThanOrEqual(4);

    // Verify minimum 2-hour gap between consecutive triggers
    for (let i = 1; i < triggers.length; i++) {
      const gap = triggers[i].atMs - triggers[i - 1].atMs;
      expect(gap).toBeGreaterThanOrEqual(2 * HOUR);
    }

    service.stop();
  });

  it("enforces daily limit of 6 messages", async () => {
    const service = buildService({
      minGapMinutes: 30, // Shorter gap to hit the daily limit
      minIdleMinutes: 15,
    });

    // Run for 16 waking hours
    await advanceAndCheck(service, 16 * HOUR);

    const triggers = events.filter((e) => e.type === "trigger");
    expect(triggers.length).toBeLessThanOrEqual(6);

    service.stop();
  });

  it("resets daily count across midnight", async () => {
    const service = buildService({
      minGapMinutes: 30,
      minIdleMinutes: 15,
    });

    // Day 1: 6 AM - 10 PM (16 hours)
    await advanceAndCheck(service, 16 * HOUR);
    const day1Triggers = events.filter((e) => e.type === "trigger");
    const day1Count = day1Triggers.length;
    expect(day1Count).toBeGreaterThanOrEqual(1);

    // Advance through quiet hours (10 PM - 6 AM = 8 hours)
    const eventsBeforeQuiet = events.length;
    await advanceAndCheck(service, 8 * HOUR);
    const quietTriggers = events.filter(
      (e, i) =>
        i >= eventsBeforeQuiet &&
        e.type === "trigger" &&
        e.atMs > SIM_START + 16 * HOUR &&
        e.atMs < SIM_START + 24 * HOUR,
    );
    expect(quietTriggers.length).toBe(0);

    // Day 2: 6 AM - 2 PM (8 hours)
    await advanceAndCheck(service, 8 * HOUR);
    const day2Triggers = events.filter(
      (e) => e.type === "trigger" && e.atMs > SIM_START + 24 * HOUR,
    );
    // Day 2 should have new triggers (daily count reset)
    expect(day2Triggers.length).toBeGreaterThanOrEqual(1);

    service.stop();
  });

  it("pauses when user is active, resumes after idle", async () => {
    const service = buildService({ minIdleMinutes: 60 });

    // Run for 2 hours (should get first proactive message)
    await advanceAndCheck(service, 2 * HOUR);
    const beforeUserMsg = events.filter((e) => e.type === "trigger").length;
    expect(beforeUserMsg).toBeGreaterThanOrEqual(1);

    // User sends a message (resets idle timer)
    userSendsMessage("discord:peter-123");
    events.length = 0; // Clear events for clarity

    // Run for 30 minutes (under idle threshold, no triggers)
    await advanceAndCheck(service, 30 * MINUTE);
    const duringActive = events.filter((e) => e.type === "trigger").length;
    expect(duringActive).toBe(0);

    // Run for another 2 hours (past idle threshold + gap)
    await advanceAndCheck(service, 2 * HOUR);
    const afterIdle = events.filter((e) => e.type === "trigger").length;
    expect(afterIdle).toBeGreaterThanOrEqual(1);

    service.stop();
  });

  it("simulates 3 days with varying user activity", async () => {
    const service = buildService({
      minGapMinutes: 90,
      minIdleMinutes: 45,
    });

    // ── Day 1 (Mon): User is mostly away ──
    // 6 AM - 10 PM
    await advanceAndCheck(service, 16 * HOUR);
    const day1 = events.filter((e) => e.type === "trigger");
    expect(day1.length).toBeGreaterThanOrEqual(2);

    // Quiet hours
    await advanceAndCheck(service, 8 * HOUR);

    // ── Day 2 (Tue): User is chatty in the morning ──
    // 6 AM - 8 AM: user messages every 20 min
    for (let i = 0; i < 6; i++) {
      await advanceAndCheck(service, 20 * MINUTE);
      userSendsMessage("discord:peter-123");
    }
    const day2Morning = events.filter(
      (e) => e.type === "trigger" && e.atMs > SIM_START + 24 * HOUR,
    );
    // Should not trigger while user is active
    expect(day2Morning.length).toBe(0);

    // 8 AM - 10 PM: user goes quiet
    await advanceAndCheck(service, 14 * HOUR);
    const day2Afternoon = events.filter(
      (e) => e.type === "trigger" && e.atMs > SIM_START + 26 * HOUR, // After 8 AM
    );
    expect(day2Afternoon.length).toBeGreaterThanOrEqual(1);

    // Quiet hours
    await advanceAndCheck(service, 8 * HOUR);

    // ── Day 3 (Wed): Normal day ──
    await advanceAndCheck(service, 16 * HOUR);
    const day3 = events.filter((e) => e.type === "trigger" && e.atMs > SIM_START + 48 * HOUR);
    expect(day3.length).toBeGreaterThanOrEqual(1);

    // ── Summary ──
    const allTriggers = events.filter((e) => e.type === "trigger");
    const allSilent = events.filter((e) => e.type === "silent");

    // Print simulation summary for review
    console.log("\n=== 3-Day Simulation Summary ===");
    console.log(`Total proactive triggers: ${allTriggers.length}`);
    console.log(`Total silent checks: ${allSilent.length}`);
    console.log("\nTimeline:");
    for (const evt of allTriggers) {
      console.log(`  ${evt.atHuman}: "${evt.response}"`);
    }
    console.log("");

    // Sanity checks
    expect(allTriggers.length).toBeGreaterThanOrEqual(5);
    // No triggers during quiet hours
    for (const evt of allTriggers) {
      const d = new Date(evt.atMs);
      const hour = Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          hour12: false,
        })
          .formatToParts(d)
          .find((p) => p.type === "hour")?.value ?? 0,
      );
      expect(hour).toBeGreaterThanOrEqual(6);
      expect(hour).toBeLessThan(22);
    }

    service.stop();
  });

  it("startup greeting fires with relaxed idle threshold", async () => {
    // Session was active 45 min ago (under normal 60-min threshold,
    // above startup's relaxed 30-min threshold)
    sessionStore["discord:peter-123"]!.lastUserMessageAt = SIM_START - 45 * MINUTE;
    sessionStore["discord:peter-123"]!.lastAgentResponseAt = SIM_START - 45 * MINUTE;

    const service = buildService();
    await service.checkNow({ isStartup: true });

    const triggers = events.filter((e) => e.type === "trigger");
    expect(triggers.length).toBe(1);

    service.stop();
  });

  it("does not trigger for group chats", async () => {
    sessionStore["discord:group-456"] = {
      sessionId: "sess-group",
      updatedAt: SIM_START - 10 * HOUR,
      chatType: "group",
      lastChannel: "discord",
      lastTo: "group-456",
      lastUserMessageAt: SIM_START - 10 * HOUR,
      lastAgentResponseAt: SIM_START - 10 * HOUR,
    } as SessionEntry;

    const service = buildService();
    await advanceAndCheck(service, 4 * HOUR);

    // Only DM session should get triggers
    const groupTriggers = events.filter(
      (e) => e.sessionKey === "discord:group-456" && e.type === "trigger",
    );
    expect(groupTriggers.length).toBe(0);

    service.stop();
  });
});
