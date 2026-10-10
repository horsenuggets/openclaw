/**
 * Pure selection of the Testing-category day channels in the OpenClaw Lab
 * server, shared by the archive_old_threads and archive_all_threads
 * entrypoints. Nothing here touches the network: it takes the already-fetched
 * guild channel list and returns the Testing day channels to act on, optionally
 * narrowed to the ones old enough to archive. The Discord I/O lives in
 * scripts/lab/discord.ts.
 */

import { ChannelType, type DiscordChannel } from "./discord.js";
import { isDateChannelExpired, TESTING_CATEGORY } from "./lab-core.js";

/**
 * The non-category children of the Testing category. With `expiredOnly`, keep
 * only the day text channels (`YYYY-MM-DD`, `GuildText`) old enough to archive
 * (strictly older than the archive threshold) so a stray non-text channel named
 * like a date is never swept up; without it, every Testing child is returned
 * (the bulk archive_all case). Returns [] when there is no Testing category.
 */
export function filterTestingDayChannels(
  channels: DiscordChannel[],
  opts: { expiredOnly: boolean; now?: Date },
): DiscordChannel[] {
  const testing = channels.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === TESTING_CATEGORY,
  );
  if (!testing) {
    return [];
  }
  const now = opts.now ?? new Date();
  return channels.filter((c) => {
    if (c.parent_id !== testing.id || c.type === ChannelType.GuildCategory) {
      return false;
    }
    if (!opts.expiredOnly) {
      return true;
    }
    return c.type === ChannelType.GuildText && isDateChannelExpired(c.name, now);
  });
}
