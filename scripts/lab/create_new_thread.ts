/**
 * Create a numbered end-to-end testing thread in the OpenClaw Lab server.
 *
 * Usage (via the wrapper, which loads the Lab env):
 *   scripts/lab/create_new_thread.sh <title> [description] [--no-members]
 *
 * A Testing day channel named `YYYY-MM-DD` (local time) is created on demand with
 * its intro embed, then a thread `NNNN-<slug>` is added (numbered sequentially
 * within the day) and a confirmation embed is posted inside it. Expired Testing
 * days are archived first via archive_old_threads.
 *
 * By default every non-bot member of the Lab server is added to the new thread as
 * a follow-up so all testers see it; pass `--no-members` to skip that. Auto-adding
 * needs the Mirror bot's Server Members privileged intent; without it the add is
 * skipped with a warning and the thread is still created.
 *
 * Thread numbering reads the current max and adds one, so near-simultaneous or
 * rapid back-to-back runs could read the same max and create threads out of
 * order or with duplicate numbers. To keep numbering in order, the whole
 * read-max -> create sequence is serialized with a cross-process lockfile and
 * consecutive creations are spaced at least 3 seconds apart (a debounce). A
 * sibling file records the last-creation timestamp used to compute the wait, and
 * a stale lock (older than the safety timeout) is cleared so a crashed run can
 * never deadlock future ones.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveExpiredTestingDays } from "./archive_old_threads.js";
import { ChannelType, LabDiscord } from "./discord.js";
import {
  buildDateChannelEmbed,
  buildThreadConfirmEmbed,
  buildThreadName,
  dateChannelName,
  humanMemberIds,
  nextThreadNumber,
  sanitizeThreadName,
  TESTING_CATEGORY,
  TESTING_FOOTER_ICON,
} from "./lab-core.js";

/** Threads auto-archive after 7 days of inactivity (Discord's 10080-minute max). */
const THREAD_AUTO_ARCHIVE_MINUTES = 10080;

/** Descriptions longer than this are rejected before any Discord work. */
const MAX_DESCRIPTION = 1000;

/** Pause between thread-member adds, to stay friendly to Discord's rate limits. */
const MEMBER_ADD_PACE_MS = 200;

/** Minimum spacing between consecutive thread creations, to keep numbering in order. */
const THREAD_DEBOUNCE_MS = 3000;

/** Poll interval while waiting to acquire the cross-process lock. */
const LOCK_POLL_MS = 100;

/** A lockfile older than this (by mtime) is treated as stale and removed. */
const LOCK_STALE_MS = 30_000;

/**
 * Remaining milliseconds to wait before the next creation so that consecutive
 * creations are spaced by at least `intervalMs`. A `null` last timestamp (no
 * prior creation recorded) means no wait.
 */
export function remainingDebounceMs(
  lastMs: number | null,
  nowMs: number,
  intervalMs: number,
): number {
  return lastMs === null ? 0 : Math.max(0, intervalMs - (nowMs - lastMs));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire a cross-process lock by atomically creating a lockfile (O_EXCL). Poll
 * until it is free, clearing a stale lock (older than LOCK_STALE_MS) so a crashed
 * run cannot deadlock future ones.
 */
async function acquireLock(lockPath: string): Promise<void> {
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      // Lock is held; drop it if it is stale, otherwise wait and retry.
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // The holder released the lock between our open and stat; just retry.
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

/** Read the recorded last-creation timestamp (epoch ms), or null if absent/invalid. */
function readLastMs(lastPath: string): number | null {
  try {
    const value = Number.parseInt(fs.readFileSync(lastPath, "utf8").trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Add every non-bot Lab member to the thread. Failures (most often the Server
 * Members intent being disabled) warn rather than throw, so a created thread is
 * never lost over an optional follow-up step.
 */
async function addEveryoneToThread(client: LabDiscord, threadId: string): Promise<void> {
  let ids: string[];
  try {
    ids = humanMemberIds(await client.listGuildMembers());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Skipped adding members: ${message}`);
    // The intent hint only applies to a 403 (listing blocked); other failures
    // (auth, network, rate limits, 5xx) are unrelated to the intent setting.
    if (/\b403\b/.test(message)) {
      console.warn("Enable the Mirror bot's Server Members intent to auto-add members.");
    }
    return;
  }
  // Add each member independently: one bad id (invalid or inaccessible between
  // listing and insertion) must not abort the rest or fail the whole command.
  let added = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await client.addThreadMember(threadId, id);
      added += 1;
    } catch (err) {
      failed += 1;
      console.warn(`Could not add member ${id}: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, MEMBER_ADD_PACE_MS));
  }
  const suffix = failed > 0 ? ` (${failed} failed)` : "";
  console.log(`Added ${added} ${added === 1 ? "member" : "members"} to the thread${suffix}.`);
}

async function createNewThread(): Promise<void> {
  const args = process.argv.slice(2);
  const addMembers = !args.includes("--no-members");
  const [title, description] = args.filter((arg) => arg !== "--no-members");
  if (!title) {
    throw new Error("Usage: create_new_thread.sh <title> [description] [--no-members]");
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

  // Serialize the read-max -> create sequence across processes with a lockfile,
  // and space consecutive creations at least THREAD_DEBOUNCE_MS apart so rapid
  // back-to-back runs cannot read the same max and create threads out of order.
  const lockPath = path.join(os.tmpdir(), `openclaw-lab-${client.guildId}.lock`);
  const lastPath = path.join(os.tmpdir(), `openclaw-lab-${client.guildId}.last`);
  await acquireLock(lockPath);
  let thread: Awaited<ReturnType<LabDiscord["createThread"]>>;
  let threadName: string;
  try {
    const wait = remainingDebounceMs(readLastMs(lastPath), Date.now(), THREAD_DEBOUNCE_MS);
    if (wait > 0) {
      console.log(`Waiting ${wait}ms to space thread creation.`);
      await sleep(wait);
    }

    // Number the new thread one past the highest existing number for the day,
    // counting both active and archived threads so numbers never collide.
    const [active, archived] = await Promise.all([
      client.listActiveThreads(),
      client.listArchivedPublicThreads(dayChannel.id),
    ]);
    const existing = [...active.filter((t) => t.parent_id === dayChannel.id), ...archived];
    const number = nextThreadNumber(existing.map((t) => t.name));
    threadName = buildThreadName(number, slug);

    thread = await client.createThread(dayChannel.id, {
      name: threadName,
      type: ChannelType.PublicThread,
      auto_archive_duration: THREAD_AUTO_ARCHIVE_MINUTES,
    });
    await client.sendEmbed(thread.id, buildThreadConfirmEmbed(threadName, description, now), [
      TESTING_FOOTER_ICON,
    ]);

    fs.writeFileSync(lastPath, String(Date.now()));
  } finally {
    fs.rmSync(lockPath, { force: true });
  }

  console.log(`Created thread "${threadName}" in #${todayName}.`);
  console.log(`https://discord.com/channels/${client.guildId}/${thread.id}`);

  if (addMembers) {
    await addEveryoneToThread(client, thread.id);
  }
}

// Only run when invoked directly (not when imported by the test file).
if (import.meta.main) {
  createNewThread().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
