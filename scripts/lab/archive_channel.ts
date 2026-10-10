/**
 * Archive a single channel in the OpenClaw Lab server.
 *
 * Usage (via the wrapper, which loads the Lab env):
 *   scripts/lab/archive_channel.sh <channel-id>
 *
 * The channel is moved into the archive categories (`Archive NNNN`) and the
 * archive is tidied so categories stay packed to 50 with none left empty.
 */

import { tidyArchives } from "./archives.js";
import { LabDiscord } from "./discord.js";

async function archiveChannel(): Promise<void> {
  const channelId = process.argv[2];
  if (!channelId) {
    throw new Error("Usage: archive_channel.sh <channel-id>");
  }
  const client = new LabDiscord();
  await tidyArchives(client, { include: [channelId] });
  console.log(`Archived channel ${channelId}.`);
}

archiveChannel().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
