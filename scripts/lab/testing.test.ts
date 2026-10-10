import { describe, expect, it } from "vitest";
import { ChannelType, type DiscordChannel } from "./discord.js";
import { dateChannelName, TESTING_CATEGORY } from "./lab-core.js";
import { filterTestingDayChannels } from "./testing.js";

/** A fixed reference date so expiry decisions are deterministic. */
const NOW = new Date(2026, 9, 10); // 2026-10-10 local

function category(id: string, name: string): DiscordChannel {
  return { id, name, type: ChannelType.GuildCategory, parent_id: null };
}

function text(id: string, name: string, parentId: string | null): DiscordChannel {
  return { id, name, type: ChannelType.GuildText, parent_id: parentId };
}

describe("filterTestingDayChannels", () => {
  const testing = category("100", TESTING_CATEGORY);
  const old = text("201", "2026-10-01", testing.id); // 9 days old -> expired
  const today = text("202", dateChannelName(NOW), testing.id); // not expired
  const notes = text("203", "scratch-notes", testing.id); // not a date channel
  const elsewhere = text("301", "2026-10-01", "999"); // under another category

  it("returns all Testing children when expiredOnly is false", () => {
    const channels = [testing, old, today, notes, elsewhere];
    const result = filterTestingDayChannels(channels, { expiredOnly: false, now: NOW });
    expect(result.map((c) => c.id).toSorted()).toEqual(["201", "202", "203"]);
  });

  it("returns only expired date channels when expiredOnly is true", () => {
    const channels = [testing, old, today, elsewhere];
    const result = filterTestingDayChannels(channels, { expiredOnly: true, now: NOW });
    expect(result.map((c) => c.id)).toEqual(["201"]);
  });

  it("returns [] when there is no Testing category", () => {
    const channels = [old, today, notes];
    expect(filterTestingDayChannels(channels, { expiredOnly: false, now: NOW })).toEqual([]);
    expect(filterTestingDayChannels(channels, { expiredOnly: true, now: NOW })).toEqual([]);
  });

  it("excludes a non-date-named Testing child only when expiredOnly is true", () => {
    const channels = [testing, notes];
    expect(
      filterTestingDayChannels(channels, { expiredOnly: false, now: NOW }).map((c) => c.id),
    ).toEqual(["203"]);
    expect(filterTestingDayChannels(channels, { expiredOnly: true, now: NOW })).toEqual([]);
  });
});
