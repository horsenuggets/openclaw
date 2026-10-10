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
 * Every non-bot member of the Lab server is always added to the new thread as a
 * follow-up so all testers see it. Auto-adding needs the Mirror bot's Server
 * Members privileged intent; without it the add is skipped with a warning and the
 * thread is still created.
 *
 * Thread numbering reads the current max and adds one, so near-simultaneous or
 * rapid back-to-back runs could read the same max and create threads out of
 * order or with duplicate numbers. To keep numbering in order, the lock is taken
 * BEFORE the day channel is discovered/created and the whole discover -> number
 * -> create sequence runs inside it (so two first-of-day runs cannot each create
 * a duplicate day channel and both number from 0001). Consecutive creations are
 * spaced at least 3 seconds apart (a debounce). A sibling file records the
 * last-creation timestamp (written the instant the thread exists). The lockfile
 * carries an owner token and its mtime is refreshed by a heartbeat while held, so
 * a waiter only steals a lock whose owner has actually died, and a releasing
 * process only removes a lock it still owns.
 */

import { randomUUID } from "node:crypto";
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

/** While held, the lock's mtime is refreshed this often to prove liveness. */
const LOCK_HEARTBEAT_MS = 2000;

/**
 * A lock whose mtime has not advanced within this window is treated as stale (its
 * owner crashed) and may be stolen. It must exceed LOCK_HEARTBEAT_MS so a live
 * owner mid-operation is never mistaken for a dead one.
 */
const LOCK_STALE_MS = 10_000;

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

/** A held cross-process lock: its file, our owner token, and the heartbeat timer. */
type Lock = { path: string; token: string; heartbeat: ReturnType<typeof setInterval> };

/**
 * Acquire a cross-process lock by atomically creating a lockfile (O_EXCL) that
 * carries a unique owner token. Poll until free; steal a lock only if its owner
 * stopped refreshing the mtime for longer than LOCK_STALE_MS (i.e. it crashed).
 * While held, a heartbeat refreshes the mtime so a live owner is never stolen
 * from, even during a slow, rate-limited Discord scan.
 */
async function acquireLock(lockPath: string): Promise<Lock> {
  const token = `${process.pid}-${randomUUID()}`;
  const stealPath = `${lockPath}.steal`;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, token, { flag: "wx" });
      const heartbeat = setInterval(() => {
        try {
          const now = new Date();
          fs.utimesSync(lockPath, now, now);
        } catch {
          // The lock file vanished; nothing to refresh.
        }
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      return { path: lockPath, token, heartbeat };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      reclaimIfStale(lockPath, stealPath, token);
      await sleep(LOCK_POLL_MS);
    }
  }
}

/**
 * Reclaim the lock only if it is stale, serializing the check-and-remove behind a
 * short-lived steal lock and RE-checking staleness while holding it. Two waiters
 * can therefore never both delete the lock: whichever wins the steal lock removes
 * the stale file, and the other then sees either no lock or a fresh one under the
 * mutex and backs off. A crashed reclaimer's steal lock is itself reclaimed by
 * mtime, so the steal path cannot deadlock.
 */
function reclaimIfStale(lockPath: string, stealPath: string, token: string): void {
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs <= LOCK_STALE_MS) {
      return;
    }
  } catch {
    return; // The lock vanished between our open and stat; just retry.
  }
  try {
    fs.writeFileSync(stealPath, token, { flag: "wx" });
  } catch (err) {
    // Another waiter is already reclaiming. Only clear its steal lock if the
    // reclaimer itself died (its steal lock went stale); otherwise leave it be.
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Reclamation takes microseconds, so a steal lock older than LOCK_STALE_MS
      // means its holder crashed. Capture it atomically with a rename (exactly one
      // waiter wins; the rest get ENOENT) before removing it, so the removal
      // itself is not a check-then-delete race.
      try {
        if (Date.now() - fs.statSync(stealPath).mtimeMs > LOCK_STALE_MS) {
          const captured = `${stealPath}.${token}`;
          fs.renameSync(stealPath, captured);
          fs.rmSync(captured, { force: true });
        }
      } catch {
        // Lost the capture race or the steal lock vanished; nothing to do.
      }
    }
    return;
  }
  try {
    // Re-check under mutual exclusion: remove the lock only if it is STILL stale,
    // so a lock another waiter just refreshed or recreated is never deleted.
    if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // The lock already went away.
  } finally {
    fs.rmSync(stealPath, { force: true });
  }
}

/** Release a lock: stop the heartbeat and remove the file only if we still own it. */
function releaseLock(lock: Lock): void {
  clearInterval(lock.heartbeat);
  try {
    if (fs.readFileSync(lock.path, "utf8") === lock.token) {
      fs.rmSync(lock.path, { force: true });
    }
  } catch {
    // Already gone.
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

  // Take the guild lock BEFORE any shared-guild mutation so concurrent runs are
  // fully serialized: the expired-day archiving, the debounce wait, the day
  // channel discovery/creation, numbering, and thread creation all happen inside
  // the one critical section (two first-of-day runs cannot both create a
  // duplicate YYYY-MM-DD channel or the same Archive category). Member adds run
  // afterwards, outside the lock.
  const lockPath = path.join(os.tmpdir(), `openclaw-lab-${client.guildId}.lock`);
  const lastPath = path.join(os.tmpdir(), `openclaw-lab-${client.guildId}.last`);
  const lock = await acquireLock(lockPath);
  let threadId: string | undefined;
  try {
    await archiveExpiredTestingDays(client);

    const wait = remainingDebounceMs(readLastMs(lastPath), Date.now(), THREAD_DEBOUNCE_MS);
    if (wait > 0) {
      console.log(`Waiting ${wait}ms to space thread creation.`);
      await sleep(wait);
    }

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
    // Record the spacing timestamp the instant the thread exists, so a later
    // sendEmbed failure cannot let the next run skip the debounce.
    fs.writeFileSync(lastPath, String(Date.now()));
    await client.sendEmbed(thread.id, buildThreadConfirmEmbed(threadName, description, now), [
      TESTING_FOOTER_ICON,
    ]);

    console.log(`Created thread "${threadName}" in #${todayName}.`);
    console.log(`https://discord.com/channels/${client.guildId}/${thread.id}`);
    threadId = thread.id;
  } finally {
    releaseLock(lock);
  }

  if (threadId) {
    await addEveryoneToThread(client, threadId);
  }
}

// Only run when invoked directly (not when imported by the test file).
if (import.meta.main) {
  createNewThread().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
