/**
 * Archive expired Testing days in the OpenClaw Lab server.
 *
 * Usage (via the wrapper, which loads the Lab env):
 *   scripts/lab/archive_old_threads.sh
 *
 * A Testing day channel (`YYYY-MM-DD`) older than 7 days, together with all of
 * its threads, is moved out of the Testing category and into the archive
 * categories (`Archive NNNN`) via tidyArchives. create_new_thread invokes this
 * automatically, so it rarely needs to be run by hand.
 */

import { tidyArchives } from "./archives.js";
import { ChannelType, LabDiscord } from "./discord.js";
import { isDateChannelExpired, TESTING_CATEGORY } from "./lab-core.js";

/**
 * Move every expired Testing day channel into the archive categories. Returns
 * the ids that were archived (empty when there is nothing to do).
 */
export async function archiveExpiredTestingDays(
  client: LabDiscord,
  now: Date = new Date(),
): Promise<string[]> {
  const channels = await client.listGuildChannels();
  const testingCategory = channels.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === TESTING_CATEGORY,
  );
  if (!testingCategory) {
    return [];
  }
  const expired = channels
    .filter(
      (c) =>
        c.type === ChannelType.GuildText &&
        c.parent_id === testingCategory.id &&
        isDateChannelExpired(c.name, now),
    )
    .map((c) => c.id);
  if (expired.length > 0) {
    await tidyArchives(client, { include: expired });
  }
  return expired;
}

async function main(): Promise<void> {
  const client = new LabDiscord();
  const archived = await archiveExpiredTestingDays(client);
  const count = archived.length;
  console.log(
    count === 0
      ? "No expired Testing days to archive."
      : `Archived ${count} expired Testing ${count === 1 ? "day" : "days"}.`,
  );
}

// Only run when invoked directly (not when imported by create_new_thread).
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
