/**
 * Archive every channel in the Testing category of the OpenClaw Lab server,
 * regardless of age.
 *
 * Usage (via the wrapper, which loads the Lab env):
 *   scripts/lab/archive_all_threads.sh
 *
 * Unlike archive_old_threads (which only sweeps day text channels older than 7
 * days), this moves EVERY non-category channel under Testing (and its threads)
 * into the archive categories (`Archive NNNN`) via tidyArchives, including any
 * non-date-named channel. Use it to clear out the whole Testing category at once.
 */

import { tidyArchives } from "./archives.js";
import { LabDiscord } from "./discord.js";
import { filterTestingDayChannels } from "./testing.js";

async function archiveAllThreads(): Promise<void> {
  const client = new LabDiscord();
  const channels = await client.listGuildChannels();
  const targets = filterTestingDayChannels(channels, { expiredOnly: false });
  if (targets.length === 0) {
    console.log("No Testing channels to archive.");
    return;
  }
  for (const c of targets) {
    console.log(`Archiving "${c.name}" (${c.id}).`);
  }
  await tidyArchives(client, { include: targets.map((c) => c.id) });
  const count = targets.length;
  console.log(`Archived ${count} Testing ${count === 1 ? "channel" : "channels"}.`);
}

archiveAllThreads().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
