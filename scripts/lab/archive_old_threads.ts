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
import { LabDiscord } from "./discord.js";
import { filterTestingDayChannels } from "./testing.js";

/**
 * Move every expired Testing day channel into the archive categories. Returns
 * the ids that were archived (empty when there is nothing to do). Stays quiet
 * so the create_new_thread pre-step does not spam its caller; the standalone
 * main() path logs the per-channel detail instead.
 */
export async function archiveExpiredTestingDays(
  client: LabDiscord,
  now: Date = new Date(),
): Promise<string[]> {
  const channels = await client.listGuildChannels();
  const expired = filterTestingDayChannels(channels, { expiredOnly: true, now });
  if (expired.length > 0) {
    await tidyArchives(client, { include: expired.map((c) => c.id) });
  }
  return expired.map((c) => c.id);
}

async function main(): Promise<void> {
  const client = new LabDiscord();
  const now = new Date();
  const channels = await client.listGuildChannels();
  const expired = filterTestingDayChannels(channels, { expiredOnly: true, now });
  if (expired.length === 0) {
    console.log("No expired Testing days to archive.");
    return;
  }
  for (const c of expired) {
    console.log(`Archiving expired Testing day "${c.name}" (${c.id}).`);
  }
  await tidyArchives(client, { include: expired.map((c) => c.id) });
  const count = expired.length;
  console.log(`Archived ${count} expired Testing ${count === 1 ? "day" : "days"}.`);
}

// Only run when invoked directly (not when imported by create_new_thread).
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
