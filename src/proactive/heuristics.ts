import type { SessionEntry } from "../config/sessions/types.js";
import type { ProactiveConfig } from "./types.js";
import { PROACTIVE_DEFAULTS } from "./types.js";

export type ProactiveEvalContext = {
  sessionKey: string;
  entry: SessionEntry;
  config: ProactiveConfig;
  /** User timezone string (e.g. "America/New_York"). */
  userTimezone: string;
  nowMs: number;
  /** Whether this is a startup greeting check (relaxed idle threshold). */
  isStartup?: boolean;
};

export type ProactiveSkipReason =
  | "not-direct"
  | "no-delivery-route"
  | "quiet-hours"
  | "not-idle-enough"
  | "gap-too-short"
  | "rate-limited"
  | "no-prior-interaction";

export type ProactiveEvalResult =
  | { eligible: true }
  | { eligible: false; reason: ProactiveSkipReason };

/**
 * Parse an "HH:mm" string into hours and minutes.
 */
function parseHHmm(value: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return { hours, minutes };
}

/**
 * Check whether the current time falls within quiet hours.
 * Handles ranges that cross midnight (e.g. 22:00 - 06:00).
 */
export function isQuietHours(params: {
  nowMs: number;
  quietHoursStart: string;
  quietHoursEnd: string;
  userTimezone: string;
}): boolean {
  const start = parseHHmm(params.quietHoursStart);
  const end = parseHHmm(params.quietHoursEnd);
  if (!start || !end) {
    return false;
  }

  const nowDate = new Date(params.nowMs);
  let currentHour: number;
  let currentMinute: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: params.userTimezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(nowDate);
    currentHour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    currentMinute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    // Intl hour12=false can return 24 for midnight in some locales
    if (currentHour === 24) {
      currentHour = 0;
    }
  } catch {
    return false;
  }

  const nowMinutes = currentHour * 60 + currentMinute;
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  if (startMinutes <= endMinutes) {
    // Same-day range (e.g. 08:00 - 17:00)
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Crosses midnight (e.g. 22:00 - 06:00)
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/**
 * Check whether the session has been idle long enough for a proactive
 * message. "Idle" means both the user and agent have been quiet.
 */
export function isIdleLongEnough(params: {
  entry: SessionEntry;
  minIdleMinutes: number;
  nowMs: number;
}): boolean {
  const { entry, minIdleMinutes, nowMs } = params;
  const minIdleMs = minIdleMinutes * 60_000;

  // Most recent activity from either side
  const lastUserAt = entry.lastUserMessageAt ?? 0;
  const lastAgentAt = entry.lastAgentResponseAt ?? 0;
  const lastActivity = Math.max(lastUserAt, lastAgentAt);
  if (lastActivity === 0) {
    return false;
  }
  return nowMs - lastActivity >= minIdleMs;
}

/**
 * Check whether enough time has passed since the last proactive message.
 */
export function isGapLongEnough(params: {
  entry: SessionEntry;
  minGapMinutes: number;
  nowMs: number;
}): boolean {
  const lastProactive = params.entry.lastProactiveMessageSentAt;
  if (typeof lastProactive !== "number" || !Number.isFinite(lastProactive)) {
    return true;
  }
  const minGapMs = params.minGapMinutes * 60_000;
  return params.nowMs - lastProactive >= minGapMs;
}

/**
 * Check whether the daily proactive message limit has been reached.
 */
export function isDailyLimitReached(params: {
  entry: SessionEntry;
  maxPerDay: number;
  todayDate: string;
}): boolean {
  const { entry, maxPerDay, todayDate } = params;
  if (entry.proactiveMessageCountDate !== todayDate) {
    // Different day, counter resets
    return false;
  }
  return (entry.proactiveMessageCountToday ?? 0) >= maxPerDay;
}

/**
 * Get today's date string in YYYY-MM-DD format for the given timezone.
 */
export function getTodayDateStr(nowMs: number, userTimezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: userTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(nowMs));
    const year = parts.find((p) => p.type === "year")?.value ?? "1970";
    const month = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${year}-${month}-${day}`;
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/**
 * Evaluate whether a session is eligible for a proactive message.
 * Pure function — no I/O, fully testable with injected time.
 */
export function shouldEvaluateSession(ctx: ProactiveEvalContext): ProactiveEvalResult {
  const { entry, config, userTimezone, nowMs } = ctx;

  // DMs only
  if (entry.chatType !== "direct") {
    return { eligible: false, reason: "not-direct" };
  }

  // Must have a delivery route
  const channel = entry.deliveryContext?.channel ?? entry.lastChannel;
  const to = entry.deliveryContext?.to ?? entry.lastTo;
  if (!channel || !to) {
    return { eligible: false, reason: "no-delivery-route" };
  }

  // Must have had at least one prior interaction
  const lastUserAt = entry.lastUserMessageAt ?? 0;
  const lastAgentAt = entry.lastAgentResponseAt ?? 0;
  if (lastUserAt === 0 && lastAgentAt === 0) {
    return { eligible: false, reason: "no-prior-interaction" };
  }

  // Quiet hours
  const quietStart = config.quietHoursStart ?? PROACTIVE_DEFAULTS.quietHoursStart;
  const quietEnd = config.quietHoursEnd ?? PROACTIVE_DEFAULTS.quietHoursEnd;
  if (isQuietHours({ nowMs, quietHoursStart: quietStart, quietHoursEnd: quietEnd, userTimezone })) {
    return { eligible: false, reason: "quiet-hours" };
  }

  // Idle time check (relaxed on startup)
  const minIdle = ctx.isStartup
    ? Math.min(config.minIdleMinutes ?? PROACTIVE_DEFAULTS.minIdleMinutes, 30)
    : (config.minIdleMinutes ?? PROACTIVE_DEFAULTS.minIdleMinutes);
  if (!isIdleLongEnough({ entry, minIdleMinutes: minIdle, nowMs })) {
    return { eligible: false, reason: "not-idle-enough" };
  }

  // Gap between proactive messages
  const minGap = config.minGapMinutes ?? PROACTIVE_DEFAULTS.minGapMinutes;
  if (!isGapLongEnough({ entry, minGapMinutes: minGap, nowMs })) {
    return { eligible: false, reason: "gap-too-short" };
  }

  // Daily limit
  const maxPerDay = config.maxPerDay ?? PROACTIVE_DEFAULTS.maxPerDay;
  const todayDate = getTodayDateStr(nowMs, userTimezone);
  if (isDailyLimitReached({ entry, maxPerDay, todayDate })) {
    return { eligible: false, reason: "rate-limited" };
  }

  return { eligible: true };
}
