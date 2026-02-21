import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../globals.js", () => ({
  logVerbose: vi.fn(),
  shouldLogVerbose: vi.fn(() => false),
}));

const { convertTimesToDiscordTimestamps } = await import("./timestamps.js");

describe("convertTimesToDiscordTimestamps", () => {
  beforeEach(() => {
    // Pin system time to 2026-02-09 12:00:00 local time
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 1, 9, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- 12-hour times ---

  it("converts 12-hour time with PM", () => {
    const result = convertTimesToDiscordTimestamps("Your meeting is at 6:30pm.");
    expect(result).toMatch(/<t:\d+:t>/);
    expect(result).not.toContain("6:30pm");
  });

  it("converts 12-hour time with space before AM/PM", () => {
    const result = convertTimesToDiscordTimestamps("Call at 2:00 PM.");
    expect(result).toMatch(/<t:\d+:t>/);
    expect(result).not.toContain("2:00 PM");
  });

  it("converts hour-only time like 6pm", () => {
    const result = convertTimesToDiscordTimestamps("Let's meet at 6pm.");
    expect(result).toMatch(/<t:\d+:t>/);
    expect(result).not.toContain("6pm");
  });

  it("converts AM times correctly (12am = midnight)", () => {
    const result = convertTimesToDiscordTimestamps("It starts at 12:00am.");
    expect(result).toMatch(/<t:\d+:t>/);
    const match = result.match(/<t:(\d+):t>/);
    expect(match).not.toBeNull();
    const date = new Date(Number(match![1]) * 1000);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
  });

  it("does not match invalid times like 13:00pm", () => {
    const input = "At 13:00pm.";
    const result = convertTimesToDiscordTimestamps(input);
    // 13pm is invalid 12-hour, and the "pm" suffix prevents the
    // 24h word-boundary match, so this stays unchanged.
    expect(result).toBe(input);
  });

  it("returns the correct unix timestamp for 6:30pm today", () => {
    const result = convertTimesToDiscordTimestamps("At 6:30pm.");
    const match = result.match(/<t:(\d+):t>/);
    expect(match).not.toBeNull();
    const unix = Number(match![1]);
    const date = new Date(unix * 1000);
    expect(date.getHours()).toBe(18);
    expect(date.getMinutes()).toBe(30);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(1);
    expect(date.getDate()).toBe(9);
  });

  // --- 24-hour times ---

  it("converts 24-hour time like 18:30", () => {
    const result = convertTimesToDiscordTimestamps("Dinner is at 18:30.");
    expect(result).toMatch(/<t:\d+:t>/);
    expect(result).not.toContain("18:30");
    const match = result.match(/<t:(\d+):t>/);
    const date = new Date(Number(match![1]) * 1000);
    expect(date.getHours()).toBe(18);
    expect(date.getMinutes()).toBe(30);
  });

  it("converts 24-hour time 08:00", () => {
    const result = convertTimesToDiscordTimestamps("Wake up at 08:00.");
    expect(result).toMatch(/<t:\d+:t>/);
    expect(result).not.toContain("08:00");
    const match = result.match(/<t:(\d+):t>/);
    const date = new Date(Number(match![1]) * 1000);
    expect(date.getHours()).toBe(8);
    expect(date.getMinutes()).toBe(0);
  });

  it("converts 24-hour time 0:15", () => {
    const result = convertTimesToDiscordTimestamps("Midnight snack at 0:15.");
    expect(result).toMatch(/<t:\d+:t>/);
    expect(result).not.toContain("0:15");
    const match = result.match(/<t:(\d+):t>/);
    const date = new Date(Number(match![1]) * 1000);
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(15);
  });

  it("converts 24-hour time 23:59", () => {
    const result = convertTimesToDiscordTimestamps("Deadline is 23:59.");
    expect(result).toMatch(/<t:\d+:t>/);
    expect(result).not.toContain("23:59");
    const match = result.match(/<t:(\d+):t>/);
    const date = new Date(Number(match![1]) * 1000);
    expect(date.getHours()).toBe(23);
    expect(date.getMinutes()).toBe(59);
  });

  it("does not match invalid 24-hour time like 25:00", () => {
    const input = "At 25:00.";
    const result = convertTimesToDiscordTimestamps(input);
    expect(result).toBe(input);
  });

  it("does not match invalid minutes like 18:60", () => {
    const input = "At 18:60.";
    const result = convertTimesToDiscordTimestamps(input);
    expect(result).toBe(input);
  });

  it("does not match single-digit minutes like 3:2", () => {
    const input = "Score is 3:2.";
    const result = convertTimesToDiscordTimestamps(input);
    expect(result).toBe(input);
  });

  it("does not partially match HH:MM:SS patterns", () => {
    const input = "Duration was 18:30:45.";
    const result = convertTimesToDiscordTimestamps(input);
    expect(result).toBe(input);
  });

  it("handles multiple 24-hour times", () => {
    const result = convertTimesToDiscordTimestamps("From 09:00 to 17:30.");
    const matches = result.match(/<t:\d+:t>/g);
    expect(matches).toHaveLength(2);
    expect(result).not.toContain("09:00");
    expect(result).not.toContain("17:30");
  });

  // --- Escape mechanism ---

  it("does not convert escaped 24-hour time (backslash-colon)", () => {
    const result = convertTimesToDiscordTimestamps("Version 18\\:30 released.");
    expect(result).toBe("Version 18:30 released.");
    expect(result).not.toMatch(/<t:/);
  });

  it("does not convert escaped 12-hour time (backslash-colon)", () => {
    const result = convertTimesToDiscordTimestamps("Run at 6\\:30pm.");
    expect(result).toBe("Run at 6:30pm.");
    expect(result).not.toMatch(/<t:/);
  });

  it("converts unescaped times but preserves escaped ones", () => {
    const result = convertTimesToDiscordTimestamps("Meeting at 14:00 but version is 2\\:30.");
    expect(result).toMatch(/<t:\d+:t>/);
    expect(result).toContain("2:30");
    expect(result).not.toContain("14:00");
  });

  it("strips escape backslash even when no conversion applies", () => {
    const result = convertTimesToDiscordTimestamps("Ratio is 100\\:1.");
    expect(result).toBe("Ratio is 100:1.");
  });

  // --- Code blocks and existing timestamps ---

  it("leaves text inside inline code untouched", () => {
    const result = convertTimesToDiscordTimestamps("Run `sleep 6:30pm` to wait.");
    expect(result).toContain("`sleep 6:30pm`");
  });

  it("leaves 24-hour time inside inline code untouched", () => {
    const result = convertTimesToDiscordTimestamps("Use `--time 18:30` flag.");
    expect(result).toContain("`--time 18:30`");
  });

  it("leaves existing Discord timestamps untouched", () => {
    const input = "Event at <t:1707500200:t>.";
    const result = convertTimesToDiscordTimestamps(input);
    expect(result).toBe(input);
  });

  // --- Multiple times ---

  it("handles multiple times in the same text", () => {
    const result = convertTimesToDiscordTimestamps("Start at 9:00am and end at 5:30pm.");
    const matches = result.match(/<t:\d+:t>/g);
    expect(matches).toHaveLength(2);
    expect(result).not.toContain("9:00am");
    expect(result).not.toContain("5:30pm");
  });

  it("handles mixed 12-hour and 24-hour times", () => {
    const result = convertTimesToDiscordTimestamps(
      "Breakfast at 8am, lunch at 12:30, dinner at 18:00.",
    );
    const matches = result.match(/<t:\d+:t>/g);
    expect(matches).toHaveLength(3);
  });

  // --- Plain text ---

  it("passes through plain text with no times", () => {
    const input = "Hello, how are you today?";
    const result = convertTimesToDiscordTimestamps(input);
    expect(result).toBe(input);
  });
});
