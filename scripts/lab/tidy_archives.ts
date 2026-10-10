/**
 * Reorganize the archive categories in the OpenClaw Lab server.
 *
 * Usage (via the wrapper, which loads the Lab env):
 *   scripts/lab/tidy_archives.sh
 *
 * Repacks every archived channel into contiguous `Archive NNNN` categories of up
 * to 50 channels each, so each category is fully used before the next is created
 * and no empty category is left behind. Runs automatically whenever a channel is
 * archived; manual use is rarely needed.
 */

import { tidyArchives } from "./archives.js";
import { LabDiscord } from "./discord.js";

async function main(): Promise<void> {
  const client = new LabDiscord();
  await tidyArchives(client);
  console.log("Tidied archive categories.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
