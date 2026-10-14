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
 * Members privileged intent; without it the human add is skipped with a warning and
 * the thread is still created. Any ids in `OPENCLAW_LAB_EXTRA_THREAD_MEMBER_IDS` (a
 * gitignored `.env.mirror` whitelist, e.g. the Mock User bot) are added too, so a bot
 * the human scan skips still joins — and those are added even when the human listing
 * is unavailable, since they need no member scan.
 *
 * Thread numbering reads the current max and adds one, so near-simultaneous or
 * rapid back-to-back runs could read the same max and create threads out of
 * order or with duplicate numbers. To keep numbering in order, a cross-process
 * lock (proper-lockfile) is taken BEFORE any shared-guild mutation, and the whole
 * archive -> discover -> number -> create sequence runs inside it (so two
 * first-of-day runs cannot each create a duplicate day channel and both number
 * from 0001). Consecutive creations are also spaced at least 3 seconds apart (a
 * debounce), using a sibling file that records the last-creation timestamp
 * (written the instant the thread exists).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { archiveExpiredTestingDays } from "./archive_old_threads.js";
import { ChannelType, LabDiscord } from "./discord.js";
import {
  buildDateChannelEmbed,
  buildThreadConfirmEmbed,
  buildThreadName,
  dateChannelName,
  humanMemberIds,
  nextThreadNumber,
  parseExtraThreadMemberIds,
  reorderDayChannelsDescending,
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

/**
 * Cross-process lock options (proper-lockfile). The library keeps the lock fresh
 * while held and only treats one abandoned by a crashed owner as stale after
 * `stale` ms; waiters retry with backoff. Ownership and stale takeover are handled
 * by the library, so there is no hand-rolled steal path to race on.
 */
const LOCK_OPTIONS = {
  stale: 30_000,
  retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
} as const;

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
 * Add every non-bot Lab member to the thread, plus any explicit whitelist ids (e.g.
 * the Mock User bot). Failures (most often the Server Members intent being disabled)
 * warn rather than throw, so a created thread is never lost over an optional follow-up
 * step — and the whitelist ids are still added even when the human listing fails,
 * since they need no member scan.
 */
async function addEveryoneToThread(client: LabDiscord, threadId: string): Promise<void> {
  // Verbose by design: this follow-up step can fail transiently (a rate-limited
  // or flaky member listing abandons the auto-add for ALL humans), so every
  // outcome is narrated. A quiet one-line skip was easy to miss, especially when
  // the command's output is piped through a filter, which hid a real miss before.
  const whitelist = parseExtraThreadMemberIds(process.env.OPENCLAW_LAB_EXTRA_THREAD_MEMBER_IDS);
  let humans: string[] = [];
  try {
    console.log("Auto-add: listing Lab members...");
    humans = humanMemberIds(await client.listGuildMembers());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Loud and explicit: the human listing failed, so NO humans were added (the
    // whitelist ids below are still added — they need no scan). The intent hint only
    // applies to a 403 (listing blocked); other failures (auth, network, rate limits,
    // 5xx) are unrelated to the intent.
    console.warn(`Auto-add: could not list members (no humans added): ${message}`);
    if (/\b403\b/.test(message)) {
      console.warn("Auto-add: enable the Mirror bot's Server Members intent to auto-add members.");
    }
  }
  // Humans first, then any whitelist ids not already present (first-seen order).
  const ids = [...new Set([...humans, ...whitelist])];
  if (whitelist.length > 0) {
    console.log(`Auto-add: whitelist ids to include: ${whitelist.join(", ")}.`);
  }
  console.log(
    ids.length > 0
      ? `Auto-add: ${ids.length} member(s) to add: ${ids.join(", ")}.`
      : "Auto-add: no members found to add.",
  );
  // Add each member independently: one bad id (invalid or inaccessible between
  // listing and insertion) must not abort the rest or fail the whole command.
  let added = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      await client.addThreadMember(threadId, id);
      added += 1;
      console.log(`Auto-add: + ${id}`);
    } catch (err) {
      failed += 1;
      console.warn(`Auto-add: ! could not add ${id}: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, MEMBER_ADD_PACE_MS));
  }
  const suffix = failed > 0 ? ` (${failed} failed)` : "";
  console.log(
    `Auto-add: added ${added} ${added === 1 ? "member" : "members"} to the thread${suffix}.`,
  );
}

/**
 * Reorder the Testing-category day channels so the newest date sits at the top.
 * Re-fetches the channel list so a freshly created day channel's id and position
 * are included. Any failure warns rather than throws: the thread creation is the
 * important part and must not be lost over this cosmetic ordering step.
 */
async function reorderTestingDays(client: LabDiscord, categoryId: string): Promise<void> {
  try {
    const channels = await client.listGuildChannels();
    const dayChannels = channels
      .filter((c) => c.type === ChannelType.GuildText && c.parent_id === categoryId)
      .map((c) => ({ id: c.id, name: c.name, position: c.position ?? 0 }));
    const changes = reorderDayChannelsDescending(dayChannels);
    if (changes.length > 0) {
      await client.modifyChannelPositions(changes);
      console.log(`Reordered ${changes.length} Testing day channel(s) newest-first.`);
    }
  } catch (err) {
    console.warn(
      `Could not reorder Testing day channels: ${err instanceof Error ? err.message : err}`,
    );
  }
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
  const lockTarget = path.join(os.tmpdir(), `openclaw-lab-${client.guildId}.lock`);
  const lastPath = path.join(os.tmpdir(), `openclaw-lab-${client.guildId}.last`);
  // proper-lockfile locks an existing path, so ensure the target file is present.
  fs.closeSync(fs.openSync(lockTarget, "a"));
  const release = await lockfile.lock(lockTarget, LOCK_OPTIONS);
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

    // Keep the Testing category sorted newest-day-at-top. Runs inside the guild
    // lock so it cannot race another run's day-channel creation.
    await reorderTestingDays(client, testingCategory.id);

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
    await release();
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
