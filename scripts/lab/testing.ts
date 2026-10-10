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
 * only the day channels (`YYYY-MM-DD`) old enough to archive (strictly older
 * than the archive threshold); without it, every Testing child is returned.
 * Returns [] when there is no Testing category.
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
  return channels.filter(
    (c) =>
      c.parent_id === testing.id &&
      c.type !== ChannelType.GuildCategory &&
      (!opts.expiredOnly || isDateChannelExpired(c.name, now)),
  );
}
