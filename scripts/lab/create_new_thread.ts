/**
 * Create a numbered end-to-end testing thread in the OpenClaw Lab server.
 *
 * Usage (via the wrapper, which loads the Lab env):
 *   scripts/lab/create_new_thread.sh <title> [description]
 *
 * A Testing day channel named `YYYY-MM-DD` (local time) is created on demand with
 * its intro embed, then a thread `NNNN-<slug>` is added (numbered sequentially
 * within the day) and a confirmation embed is posted inside it. Expired Testing
 * days are archived first via archive_old_threads.
 *
 * Thread numbering reads the current max and adds one, so it assumes a single
 * operator: this is a manual test-server helper, not a concurrent service, and
 * two simultaneous runs for the same day could pick the same number. Discord has
 * no atomic name reservation, so a lock is deliberately out of scope here.
 */

import { archiveExpiredTestingDays } from "./archive_old_threads.js";
import { ChannelType, LabDiscord } from "./discord.js";
import {
  buildDateChannelEmbed,
  buildThreadConfirmEmbed,
  buildThreadName,
  dateChannelName,
  nextThreadNumber,
  sanitizeThreadName,
  TESTING_CATEGORY,
  TESTING_FOOTER_ICON,
} from "./lab-core.js";

/** Threads auto-archive after 7 days of inactivity (Discord's 10080-minute max). */
const THREAD_AUTO_ARCHIVE_MINUTES = 10080;

/** Descriptions longer than this are rejected before any Discord work. */
const MAX_DESCRIPTION = 1000;

async function createNewThread(): Promise<void> {
  const [title, description] = process.argv.slice(2);
  if (!title) {
    throw new Error("Usage: create_new_thread.sh <title> [description]");
  }
  if (description && description.length > MAX_DESCRIPTION) {
    throw new Error(
      `Description is ${description.length} characters; the limit is ${MAX_DESCRIPTION}.`,
    );
  }

  const slug = sanitizeThreadName(title);
  if (slug === "") {
    throw new Error(`Thread title "${title}" has no alphanumeric characters to slugify.`);
  }

  const client = new LabDiscord();

  // Archive expired Testing days before adding anything new.
  await archiveExpiredTestingDays(client);

  const channels = await client.listGuildChannels();
  const testingCategory =
    channels.find((c) => c.type === ChannelType.GuildCategory && c.name === TESTING_CATEGORY) ??
    (await client.createChannel({ name: TESTING_CATEGORY, type: ChannelType.GuildCategory }));

  const now = new Date();
  const todayName = dateChannelName(now);
  let dayChannel = channels.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.parent_id === testingCategory.id &&
      c.name === todayName,
  );
  if (!dayChannel) {
    dayChannel = await client.createChannel({
      name: todayName,
      type: ChannelType.GuildText,
      parent_id: testingCategory.id,
    });
    await client.sendEmbed(dayChannel.id, buildDateChannelEmbed(now), [TESTING_FOOTER_ICON]);
  }

  // Number the new thread one past the highest existing number for the day,
  // counting both active and archived threads so numbers never collide.
  const [active, archived] = await Promise.all([
    client.listActiveThreads(),
    client.listArchivedPublicThreads(dayChannel.id),
  ]);
  const existing = [...active.filter((t) => t.parent_id === dayChannel.id), ...archived];
  const number = nextThreadNumber(existing.map((t) => t.name));
  const threadName = buildThreadName(number, slug);

  const thread = await client.createThread(dayChannel.id, {
    name: threadName,
    type: ChannelType.PublicThread,
    auto_archive_duration: THREAD_AUTO_ARCHIVE_MINUTES,
  });
  await client.sendEmbed(thread.id, buildThreadConfirmEmbed(threadName, description, now), [
    TESTING_FOOTER_ICON,
  ]);

  console.log(`Created thread "${threadName}" in #${todayName}.`);
  console.log(`https://discord.com/channels/${client.guildId}/${thread.id}`);
}

createNewThread().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
