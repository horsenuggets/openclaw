/**
 * Clear the OpenClaw Lab archive: delete every archived channel, then tidy
 * (which removes the now-empty archive categories).
 *
 * Usage (via the wrapper, which loads the Lab env):
 *   scripts/lab/clear_archives.sh [--yes]
 *
 * Irreversible, so it prompts unless `--yes` is passed.
 */

import { collectArchiveChannelIds, deleteChannels, tidyArchives } from "./archives.js";
import { LabDiscord } from "./discord.js";
import { confirmDestructive } from "./prompt.js";

async function clearArchives(): Promise<void> {
  const client = new LabDiscord();
  // Map ids to names so the deletion log reads channel names, not bare ids.
  const channels = await client.listGuildChannels();
  const nameById = new Map(channels.map((c) => [c.id, c.name]));
  const ids = await collectArchiveChannelIds(client);
  if (ids.length === 0) {
    // Still tidy so any stray empty archive categories are removed.
    await tidyArchives(client);
    console.log("No archived channels to clear.");
    return;
  }
  if (!(await confirmDestructive(`Delete all ${ids.length} archived channels?`, process.argv))) {
    console.log("Aborted. Re-run with --yes to confirm.");
    return;
  }
  for (const id of ids) {
    console.log(`Deleting "${nameById.get(id) ?? id}" (${id}).`);
  }
  await deleteChannels(client, ids);
  await tidyArchives(client);
  console.log(`Cleared ${ids.length} archived ${ids.length === 1 ? "channel" : "channels"}.`);
}

clearArchives().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
