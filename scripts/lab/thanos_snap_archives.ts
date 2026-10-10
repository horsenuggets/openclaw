/**
 * Thanos-snap the OpenClaw Lab archive: delete a random half of the archived
 * channels, then tidy.
 *
 * Usage (via the wrapper, which loads the Lab env):
 *   scripts/lab/thanos_snap_archives.sh [--yes]
 *
 * Deletes floor(n / 2) archived channels chosen at random (an odd one out
 * survives), then repacks the survivors. Irreversible, so it prompts unless
 * `--yes` is passed.
 */

import { collectArchiveChannelIds, deleteChannels, tidyArchives } from "./archives.js";
import { LabDiscord } from "./discord.js";
import { pickHalf } from "./lab-core.js";
import { confirmDestructive } from "./prompt.js";

async function thanosSnapArchives(): Promise<void> {
  const client = new LabDiscord();
  // Map ids to names so the deletion log reads channel names, not bare ids.
  const channels = await client.listGuildChannels();
  const nameById = new Map(channels.map((c) => [c.id, c.name]));
  const ids = await collectArchiveChannelIds(client);
  console.log(`Found ${ids.length} archived ${ids.length === 1 ? "channel" : "channels"}.`);
  const doomed = pickHalf(ids);
  console.log(`Selected ${doomed.length} for deletion.`);
  if (doomed.length === 0) {
    // Nothing to delete, but still honor the promised tidy so any empty or
    // non-contiguously named archive categories get cleaned up.
    await tidyArchives(client);
    console.log(
      ids.length === 0
        ? "No archived channels to snap."
        : "Only one archived channel; nothing to snap.",
    );
    return;
  }
  if (
    !(await confirmDestructive(
      `Delete ${doomed.length} of ${ids.length} archived channels?`,
      process.argv,
    ))
  ) {
    console.log("Aborted. Re-run with --yes to confirm.");
    return;
  }
  for (const id of doomed) {
    console.log(`Deleting "${nameById.get(id) ?? id}" (${id}).`);
  }
  await deleteChannels(client, doomed);
  await tidyArchives(client);
  console.log(`Snapped ${doomed.length} of ${ids.length} archived channels.`);
}

thanosSnapArchives().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
