import { describe, expect, it } from "vitest";
import {
  archiveCategoryIndex,
  archiveCategoryName,
  ARCHIVE_THRESHOLD_DAYS,
  buildDateChannelEmbed,
  buildThreadConfirmEmbed,
  buildThreadName,
  chunk,
  dateChannelAgeDays,
  dateChannelName,
  formatThreadNumber,
  humanMemberIds,
  isArchiveCategoryName,
  isDateChannelExpired,
  isDateChannelName,
  LAB_EMBED_COLOR,
  nextThreadNumber,
  pickHalf,
  sanitizeThreadName,
  snowflakeToMillis,
} from "./lab-core.js";

describe("sanitizeThreadName", () => {
  // The four worked examples from the spec.
  it("passes through an already-clean slug", () => {
    expect(sanitizeThreadName("some-scenario")).toBe("some-scenario");
  });
  it("lowercases and drops trailing punctuation", () => {
    expect(sanitizeThreadName("Another scenario!")).toBe("another-scenario");
  });
  it("collapses runs of punctuation and trims edges", () => {
    expect(sanitizeThreadName("a_b--c  d%e-")).toBe("a-b-c-d-e");
  });
  it("truncates to 32 characters", () => {
    expect(sanitizeThreadName("0123456789abcdefghijklmnopqrstuvwxyz")).toBe(
      "0123456789abcdefghijklmnopqrstuv",
    );
  });
  it("returns an empty string when nothing alphanumeric survives", () => {
    expect(sanitizeThreadName("---")).toBe("");
    expect(sanitizeThreadName("  %% ")).toBe("");
  });
  it("trims a trailing hyphen left by truncation", () => {
    // 32nd character is a hyphen, which must not dangle after the cut.
    expect(sanitizeThreadName("0123456789abcdefghijklmnopqrstu v")).toBe(
      "0123456789abcdefghijklmnopqrstu",
    );
  });
});

describe("formatThreadNumber", () => {
  it("zero-pads to four digits", () => {
    expect(formatThreadNumber(1)).toBe("0001");
    expect(formatThreadNumber(42)).toBe("0042");
    expect(formatThreadNumber(9999)).toBe("9999");
  });
  it("keeps natural width past 9999", () => {
    expect(formatThreadNumber(10000)).toBe("10000");
    expect(formatThreadNumber(10001)).toBe("10001");
  });
});

describe("nextThreadNumber", () => {
  it("starts at 1 for an empty day", () => {
    expect(nextThreadNumber([])).toBe(1);
  });
  it("returns one past the highest existing number", () => {
    expect(nextThreadNumber(["0001-a", "0003-c", "0002-b"])).toBe(4);
  });
  it("ignores names without a numeric prefix", () => {
    expect(nextThreadNumber(["welcome", "0005-x", "notes"])).toBe(6);
  });
  it("continues past 9999", () => {
    expect(nextThreadNumber(["9999-x"])).toBe(10000);
  });
});

describe("buildThreadName", () => {
  it("joins the padded number and slug", () => {
    expect(buildThreadName(1, "some-scenario")).toBe("0001-some-scenario");
    expect(buildThreadName(10000, "x")).toBe("10000-x");
  });
});

describe("snowflakeToMillis", () => {
  it("decodes the creation time encoded in a snowflake", () => {
    const ms = 1_600_000_000_000;
    const id = (BigInt(ms - 1_420_070_400_000) << 22n).toString();
    expect(snowflakeToMillis(id)).toBe(ms);
  });
});

describe("date channel helpers", () => {
  it("recognizes YYYY-MM-DD names only", () => {
    expect(isDateChannelName("2026-10-05")).toBe(true);
    expect(isDateChannelName("general")).toBe(false);
    expect(isDateChannelName("2026-10-5")).toBe(false);
  });
  it("formats a local date as the channel name", () => {
    expect(dateChannelName(new Date(2026, 9, 5))).toBe("2026-10-05");
    expect(dateChannelName(new Date(2026, 0, 1))).toBe("2026-01-01");
  });
  it("counts whole days of age", () => {
    const now = new Date(2026, 9, 10);
    expect(dateChannelAgeDays("2026-10-10", now)).toBe(0);
    expect(dateChannelAgeDays("2026-10-01", now)).toBe(9);
    expect(dateChannelAgeDays("not-a-date", now)).toBeNull();
  });
  it("expires strictly past the threshold", () => {
    const now = new Date(2026, 9, 10);
    const sevenDaysAgo = dateChannelName(new Date(2026, 9, 10 - ARCHIVE_THRESHOLD_DAYS));
    const eightDaysAgo = dateChannelName(new Date(2026, 9, 10 - ARCHIVE_THRESHOLD_DAYS - 1));
    expect(isDateChannelExpired(sevenDaysAgo, now)).toBe(false);
    expect(isDateChannelExpired(eightDaysAgo, now)).toBe(true);
    expect(isDateChannelExpired("2026-10-10", now)).toBe(false);
  });
});

describe("archive category naming", () => {
  it("formats and parses sequential names", () => {
    expect(archiveCategoryName(1)).toBe("Archive 0001");
    expect(archiveCategoryName(12)).toBe("Archive 0012");
    expect(archiveCategoryIndex("Archive 0012")).toBe(12);
    expect(archiveCategoryIndex("Archive 10000")).toBe(10000);
  });
  it("rejects non-archive names", () => {
    expect(archiveCategoryIndex("Testing")).toBeNull();
    expect(archiveCategoryIndex("Archive 12")).toBeNull();
    expect(isArchiveCategoryName("Archive 0001")).toBe(true);
    expect(isArchiveCategoryName("Sandbox")).toBe(false);
  });
});

describe("chunk", () => {
  it("splits into consecutive runs of at most size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 50)).toEqual([]);
  });
});

describe("pickHalf", () => {
  it("removes floor(n / 2) items", () => {
    expect(pickHalf([], () => 0)).toEqual([]);
    expect(pickHalf(["a"], () => 0)).toEqual([]);
    expect(pickHalf(["a", "b", "c", "d"], () => 0)).toEqual(["a", "b"]);
    expect(pickHalf(["a", "b", "c", "d", "e"], () => 0)).toHaveLength(2);
  });
  it("uses the rng to choose which to remove", () => {
    // rng returns the last index each call, so it removes from the end.
    const almostOne = 0.999999;
    expect(pickHalf(["a", "b", "c", "d"], () => almostOne)).toEqual(["d", "c"]);
  });
});

describe("humanMemberIds", () => {
  it("returns non-bot member ids and drops bots and member-less entries", () => {
    const members = [
      { user: { id: "1" } },
      { user: { id: "2", bot: true } },
      { user: { id: "3", bot: false } },
      {},
    ];
    expect(humanMemberIds(members)).toEqual(["1", "3"]);
  });

  it("de-duplicates repeated ids", () => {
    expect(humanMemberIds([{ user: { id: "7" } }, { user: { id: "7" } }])).toEqual(["7"]);
  });

  it("returns an empty list for no members", () => {
    expect(humanMemberIds([])).toEqual([]);
  });
});

describe("embed builders", () => {
  const now = new Date("2026-10-05T12:00:00.000Z");

  it("builds the day-channel intro embed", () => {
    const embed = buildDateChannelEmbed(now);
    expect(embed.title).toBe(`#${dateChannelName(now)}`);
    expect(embed.color).toBe(LAB_EMBED_COLOR);
    expect(embed.footer).toEqual({ text: "Testing", icon_url: "attachment://testing.png" });
    expect(embed.timestamp).toBe(now.toISOString());
    expect(embed.description).toContain(`archived after **${ARCHIVE_THRESHOLD_DAYS} days**`);
    expect(embed.description).toContain('scripts/lab/create_new_thread.sh "scenario title"');
  });

  it("builds the thread confirmation embed with a description", () => {
    const embed = buildThreadConfirmEmbed("0001-some-scenario", "An example description.", now);
    expect(embed.title).toBe("0001-some-scenario");
    expect(embed.description).toBe("An example description.");
    expect(embed.footer.icon_url).toBe("attachment://testing.png");
  });

  it("falls back to a placeholder when the description is blank", () => {
    expect(buildThreadConfirmEmbed("0001-x", undefined, now).description).toBe(
      "No description provided.",
    );
    expect(buildThreadConfirmEmbed("0001-x", "   ", now).description).toBe(
      "No description provided.",
    );
  });
});
