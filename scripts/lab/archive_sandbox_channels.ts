/**
 * Archive every Sandbox channel in the OpenClaw Lab server.
 *
 * Usage (via the wrapper, which loads the Lab env):
 *   scripts/lab/archive_sandbox_channels.sh
 *
 * Moves all channels under the `Sandbox` category into the archive categories
 * (`Archive NNNN`) and tidies. Use when the Sandbox gets too cluttered; the
 * empty Sandbox category itself is left in place for future use.
 */

import { tidyArchives } from "./archives.js";
import { ChannelType, LabDiscord } from "./discord.js";
import { SANDBOX_CATEGORY } from "./lab-core.js";

async function archiveSandboxChannels(): Promise<void> {
  const client = new LabDiscord();
  const channels = await client.listGuildChannels();
  const sandbox = channels.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === SANDBOX_CATEGORY,
  );
  if (!sandbox) {
    console.log(`No "${SANDBOX_CATEGORY}" category found.`);
    return;
  }
  const ids = channels
    .filter((c) => c.parent_id === sandbox.id && c.type !== ChannelType.GuildCategory)
    .map((c) => c.id);
  if (ids.length === 0) {
    console.log("No Sandbox channels to archive.");
    return;
  }
  await tidyArchives(client, { include: ids });
  console.log(`Archived ${ids.length} Sandbox ${ids.length === 1 ? "channel" : "channels"}.`);
}

archiveSandboxChannels().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
