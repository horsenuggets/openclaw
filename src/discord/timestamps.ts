import { logVerbose } from "../globals.js";

/**
 * Placeholder for escaped colons (\:). Uses a Unicode Private Use
 * Area character that won't appear in normal chat text. Swapped in
 * before timestamp conversion and restored afterward so the escaped
 * colon renders as a plain `:` in the final output.
 */
const ESCAPED_COLON = "\uE000";

/**
 * Regex for 12-hour times: "6:30pm", "6:30 PM", "12:00 am", "6pm"
 * Captures: (hour)(:(minutes))?(am/pm)
 * Negative lookbehind avoids matching inside Discord timestamps or code.
 */
const TIME_12H_PATTERN = /(?<!<t:|`)\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM|a\.m\.|p\.m\.)\b/g;

/**
 * Regex for 24-hour times: "18:30", "08:00", "0:15", "23:59".
 * Requires two-digit minutes to avoid matching scores like "3:2".
 * Negative lookahead avoids partial matches on HH:MM:SS patterns.
 */
const TIME_24H_PATTERN = /(?<!<t:|`)\b([01]?\d|2[0-3]):([0-5]\d)\b(?!:\d)/g;

/**
 * Regex for full date-time: "February 9, 2026 at 6:30 PM" or
 * "February 9 at 6:30pm" or "Jan 9, 2026 at 18:30".
 * Captures month name, day, optional year, hour, optional minutes,
 * optional am/pm.
 */
const DATE_TIME_PATTERN =
  /(?<!<t:|`)(\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:(?:st|nd|rd|th))?,?\s*(?:\d{4})?\s+at\s+)(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM|a\.m\.|p\.m\.)?/g;

/** Month name to 0-indexed month number. */
const MONTH_MAP: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

function parseAmPm(hour: number, ampm: string | undefined): number | null {
  if (!ampm) {
    // 24-hour format; accept 0-23.
    return hour >= 0 && hour <= 23 ? hour : null;
  }
  const lower = ampm.toLowerCase().replace(/\./g, "");
  if (hour < 1 || hour > 12) {
    return null;
  }
  if (lower === "am") {
    return hour === 12 ? 0 : hour;
  }
  if (lower === "pm") {
    return hour === 12 ? 12 : hour + 12;
  }
  return null;
}

/**
 * Check whether a position in the text is inside a code block or
 * inline code span. Simple heuristic: count backticks before the
 * position.
 */
function isInsideCode(text: string, index: number): boolean {
  // Check for fenced code blocks (```...```)
  const before = text.slice(0, index);
  const fenceCount = (before.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    return true;
  }
  // Check for inline code (`...`)
  // Count unescaped single backticks that aren't part of triple backticks
  const singleTicks = before.replace(/```/g, "").match(/`/g);
  if (singleTicks && singleTicks.length % 2 === 1) {
    return true;
  }
  return false;
}

/**
 * Convert time references in text to Discord timestamp format.
 * Matches 12-hour times ("6:30pm"), 24-hour times ("18:30"), and
 * full date-times ("February 9 at 18:30"). Assumes the current
 * date when only a time is given. Skips times inside code blocks
 * or inline code.
 *
 * Escape with backslash-colon (`\:`) to keep a time as plain
 * text: `18\:30` renders as `18:30` without conversion.
 *
 * Discord format: `<t:UNIX_SECONDS:t>` renders as a localized
 * time in each user's timezone.
 */
export function convertTimesToDiscordTimestamps(text: string): string {
  // Protect escaped colons (\:) from timestamp conversion
  let result = text.replaceAll("\\:", ESCAPED_COLON);

  // First pass: replace full date-time patterns (most specific)
  result = result.replace(
    DATE_TIME_PATTERN,
    (
      match,
      prefix: string,
      hourStr: string,
      minStr: string | undefined,
      ampm: string | undefined,
      offset: number,
    ) => {
      if (isInsideCode(text, offset)) {
        return match;
      }

      // Parse the date from the prefix
      const dateMatch = prefix.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/);
      if (!dateMatch) {
        return match;
      }
      const monthName = dateMatch[1].toLowerCase();
      const day = Number.parseInt(dateMatch[2], 10);
      const yearStr = dateMatch[3];
      const month = MONTH_MAP[monthName];
      if (month === undefined || Number.isNaN(day)) {
        return match;
      }

      const hour = Number.parseInt(hourStr, 10);
      const minutes = minStr ? Number.parseInt(minStr, 10) : 0;
      const hour24 = parseAmPm(hour, ampm);
      if (hour24 === null || minutes < 0 || minutes > 59) {
        return match;
      }

      const now = new Date();
      const year = yearStr ? Number.parseInt(yearStr, 10) : now.getFullYear();
      const date = new Date(year, month, day, hour24, minutes, 0);
      if (Number.isNaN(date.getTime())) {
        return match;
      }

      const unix = Math.floor(date.getTime() / 1000);
      logVerbose(`discord-timestamps: "${match.trim()}" → <t:${unix}:f>`);
      return `<t:${unix}:f>`;
    },
  );

  // Second pass: replace 12-hour standalone time patterns
  result = result.replace(
    TIME_12H_PATTERN,
    (match, hourStr: string, minStr: string | undefined, ampm: string, offset: number) => {
      if (isInsideCode(result, offset)) {
        return match;
      }

      // Skip if this is already inside a Discord timestamp
      const before = result.slice(Math.max(0, offset - 3), offset);
      if (before.includes("<t:")) {
        return match;
      }

      const hour = Number.parseInt(hourStr, 10);
      const minutes = minStr ? Number.parseInt(minStr, 10) : 0;
      const hour24 = parseAmPm(hour, ampm);
      if (hour24 === null || minutes < 0 || minutes > 59) {
        return match;
      }

      const now = new Date();
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour24, minutes, 0);
      if (Number.isNaN(date.getTime())) {
        return match;
      }

      const unix = Math.floor(date.getTime() / 1000);
      logVerbose(`discord-timestamps: "${match}" → <t:${unix}:t>`);
      return `<t:${unix}:t>`;
    },
  );

  // Third pass: replace 24-hour standalone time patterns
  result = result.replace(
    TIME_24H_PATTERN,
    (match, hourStr: string, minStr: string, offset: number) => {
      if (isInsideCode(result, offset)) {
        return match;
      }

      // Skip if this is already inside a Discord timestamp
      const before = result.slice(Math.max(0, offset - 3), offset);
      if (before.includes("<t:")) {
        return match;
      }

      const hour = Number.parseInt(hourStr, 10);
      const minutes = Number.parseInt(minStr, 10);
      if (hour < 0 || hour > 23 || minutes < 0 || minutes > 59) {
        return match;
      }

      const now = new Date();
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minutes, 0);
      if (Number.isNaN(date.getTime())) {
        return match;
      }

      const unix = Math.floor(date.getTime() / 1000);
      logVerbose(`discord-timestamps: "${match}" → <t:${unix}:t>`);
      return `<t:${unix}:t>`;
    },
  );

  // Restore escaped colons as plain colons
  result = result.replaceAll(ESCAPED_COLON, ":");

  return result;
}
