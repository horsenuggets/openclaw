/**
 * Pure helpers and embed builders for the OpenClaw Lab Discord tooling
 * (scripts/lab). Nothing here touches the network or the filesystem, so every
 * decision (name sanitization, sequential thread numbering, archive bin-packing,
 * the thanos split) is unit-testable in isolation; the Discord I/O lives in
 * scripts/lab/discord.ts and the orchestration in scripts/lab/archives.ts.
 */

/** Brand color for every Lab embed (#75fbfd). */
export const LAB_EMBED_COLOR = 0x75fbfd;

/** Footer shown on Testing-category embeds. The icon is attached per message. */
export const TESTING_FOOTER_TEXT = "Testing";
export const TESTING_FOOTER_ICON = "testing.png";

/** Discord allows at most 50 channels per category. */
export const CHANNELS_PER_CATEGORY = 50;

/** A sanitized thread title is capped at this many characters (prefix excluded). */
export const THREAD_NAME_MAX = 32;

/** Testing channels and threads are archived once older than this many days. */
export const ARCHIVE_THRESHOLD_DAYS = 7;

/** Names of the standing Lab categories. */
export const TESTING_CATEGORY = "Testing";
export const SANDBOX_CATEGORY = "Sandbox";

/** Discord's snowflake epoch (2015-01-01T00:00:00Z) in milliseconds. */
const DISCORD_EPOCH = 1420070400000;

/** Minimal shape of a Discord embed payload used by the Lab scripts. */
export type LabEmbed = {
  title: string;
  description: string;
  color: number;
  footer: { text: string; icon_url: string };
  timestamp: string;
};

/**
 * Normalize a raw thread title into a Discord-friendly slug: lowercase, every
 * run of non-alphanumeric characters collapsed to a single hyphen, no leading or
 * trailing hyphen, and capped at THREAD_NAME_MAX characters (trimming any hyphen
 * the cut leaves behind). Returns "" when nothing alphanumeric survives.
 */
export function sanitizeThreadName(raw: string): string {
  const collapsed = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return collapsed.slice(0, THREAD_NAME_MAX).replace(/-+$/, "");
}

/**
 * Zero-pad a thread number to four digits. Numbers past 9999 keep their natural
 * width (10000, 10001, ...), matching the spec's overflow behaviour.
 */
export function formatThreadNumber(n: number): string {
  return String(n).padStart(4, "0");
}

/**
 * The next sequential thread number for a day, given the existing thread names
 * in that day's channel. Reads the leading digits of each `NNNN-...` name, and
 * returns one past the highest (1 when there are none).
 */
export function nextThreadNumber(existingNames: readonly string[]): number {
  let max = 0;
  for (const name of existingNames) {
    const match = /^(\d+)-/.exec(name);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

/** Compose the full thread name `NNNN-<slug>`. */
export function buildThreadName(n: number, slug: string): string {
  return `${formatThreadNumber(n)}-${slug}`;
}

/** The creation time (ms since epoch) encoded in a Discord snowflake id. */
export function snowflakeToMillis(id: string): number {
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
}

/** Whether a channel name is a Testing day channel (`YYYY-MM-DD`). */
export function isDateChannelName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

/** The Testing day-channel name for a date in local time (`YYYY-MM-DD`). */
export function dateChannelName(now: Date): string {
  const y = String(now.getFullYear()).padStart(4, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Whole days between a `YYYY-MM-DD` channel name and `now`, both taken at local
 * midnight. Returns null when the name is not a date. Positive means the channel
 * is in the past.
 */
export function dateChannelAgeDays(name: string, now: Date): number | null {
  if (!isDateChannelName(name)) {
    return null;
  }
  const [y, m, d] = name.split("-").map(Number);
  const then = new Date(y, m - 1, d).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((today - then) / 86400000);
}

/** Whether a Testing day channel is old enough to archive (strictly > 7 days). */
export function isDateChannelExpired(name: string, now: Date): boolean {
  const age = dateChannelAgeDays(name, now);
  return age !== null && age > ARCHIVE_THRESHOLD_DAYS;
}

/** A Testing day channel considered for reordering: its id, date name, and current position. */
export type DayChannel = { id: string; name: string; position: number };

/** A channel position assignment for Discord's bulk "Modify Guild Channel Positions" call. */
export type ChannelPosition = { id: string; position: number };

/**
 * Reorder the Testing-category day channels so the newest date sits at the top
 * (Discord orders ascending by `position`, so newest date = smallest position).
 *
 * Only inputs whose `name` is a `YYYY-MM-DD` day channel participate; callers
 * should pre-filter to the Testing category. The day channels are reassigned to
 * the position slots they currently occupy, in descending-date order, so non-date
 * channels sharing the category keep their positions. Ties on identical date names
 * fall back to the original relative order (stable).
 *
 * Discord allows multiple channels to share a `position` and then breaks the tie by
 * channel id, which is NOT date-ordered. So when day channels share slots, reusing
 * those slots as-is would leave an ambiguous order (two channels at position 1) and
 * wrongly report "no change". To force an unambiguous newest-first order, the
 * TARGET slots are de-duplicated into strictly ascending distinct values: shared
 * slots are spread out by filling the gaps above the smallest occupied slot (and,
 * if necessary, just past the largest). This can nudge a non-date channel that sat
 * between two tied day channels, but an unambiguous date order is the priority and
 * ties are rare in practice (the Testing category normally has distinct positions).
 *
 * Returns only the entries whose position actually changes; an empty array means
 * the channels are already ordered newest-first with distinct positions and no API
 * call is needed.
 */
export function reorderDayChannelsDescending(
  dayChannels: readonly DayChannel[],
): ChannelPosition[] {
  const days = dayChannels.filter((c) => isDateChannelName(c.name));
  // Distinct target slots, ascending: start from the occupied slots, then ensure
  // one strictly-increasing distinct value per day channel so the final order is
  // unambiguous even if the inputs shared positions.
  const occupied = days.map((c) => c.position).toSorted((a, b) => a - b);
  const slots: number[] = [];
  let next = occupied.length > 0 ? occupied[0] : 0;
  for (let i = 0; i < days.length; i++) {
    // Prefer the i-th occupied slot, but never repeat or go backwards.
    const candidate = Math.max(next, occupied[i] ?? next);
    slots.push(candidate);
    next = candidate + 1;
  }
  // Sort by date descending; ties preserve input order for stability.
  const byDateDesc = days
    .map((c, index) => ({ channel: c, index }))
    .toSorted((a, b) => b.channel.name.localeCompare(a.channel.name) || a.index - b.index)
    .map((entry) => entry.channel);
  const changes: ChannelPosition[] = [];
  byDateDesc.forEach((channel, i) => {
    const position = slots[i];
    if (position !== channel.position) {
      changes.push({ id: channel.id, position });
    }
  });
  return changes;
}

/** The canonical name for the Nth archive category (1-based): `Archive 0001`. */
export function archiveCategoryName(index: number): string {
  return `Archive ${String(index).padStart(4, "0")}`;
}

/** The 1-based index of an archive category name, or null if it is not one. */
export function archiveCategoryIndex(name: string): number | null {
  const match = /^Archive (\d{4,})$/.exec(name);
  return match ? Number(match[1]) : null;
}

/** Whether a category name is an archive category (`Archive NNNN`). */
export function isArchiveCategoryName(name: string): boolean {
  return archiveCategoryIndex(name) !== null;
}

/** Split a list into consecutive chunks of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Pick half of the items at random to be removed (the thanos snap). Removes
 * floor(n / 2); an odd one out survives. `rng` is injectable for deterministic
 * tests.
 */
export function pickHalf<T>(items: readonly T[], rng: () => number = Math.random): T[] {
  const removeCount = Math.floor(items.length / 2);
  const pool = [...items];
  const removed: T[] = [];
  for (let i = 0; i < removeCount; i++) {
    const idx = Math.floor(rng() * pool.length);
    removed.push(pool.splice(idx, 1)[0]);
  }
  return removed;
}

/**
 * The de-duplicated ids of every non-bot member in a guild member list. Bots are
 * skipped because they cannot meaningfully participate in a thread (and the Lab
 * bot that creates the thread is already a member).
 */
export function humanMemberIds(
  members: ReadonlyArray<{ user?: { id: string; bot?: boolean } }>,
): string[] {
  const ids = new Set<string>();
  for (const member of members) {
    if (member.user && !member.user.bot) {
      ids.add(member.user.id);
    }
  }
  return [...ids];
}

/** The intro embed posted when a new Testing day channel is created. */
export function buildDateChannelEmbed(now: Date): LabEmbed {
  const name = dateChannelName(now);
  const description =
    "This text channel houses threads for specific, isolated end-to-end testing " +
    "scenarios for OpenClaw. The threads are named as `0001-some-scenario`, " +
    "`0002-some-other-scenario`, and so on. __Testing__ text channels and threads get " +
    `archived after **${ARCHIVE_THRESHOLD_DAYS} days**.\n\nFor organization purposes, ` +
    "__Testing__ text channels cannot be registered; only __Testing__ *threads* can. " +
    "__Sandbox__ text channels can be registered though!\n\nTo create a new thread, " +
    "simply run the following...\n```sh\n" +
    'scripts/lab/create_new_thread.sh "scenario title"\n```';
  return {
    title: `#${name}`,
    description,
    color: LAB_EMBED_COLOR,
    footer: { text: TESTING_FOOTER_TEXT, icon_url: `attachment://${TESTING_FOOTER_ICON}` },
    timestamp: now.toISOString(),
  };
}

/** The confirmation embed posted inside a freshly created Testing thread. */
export function buildThreadConfirmEmbed(
  threadName: string,
  description: string | undefined,
  now: Date,
): LabEmbed {
  const trimmed = (description ?? "").trim();
  return {
    title: threadName,
    description: trimmed === "" ? "No description provided." : trimmed,
    color: LAB_EMBED_COLOR,
    footer: { text: TESTING_FOOTER_TEXT, icon_url: `attachment://${TESTING_FOOTER_ICON}` },
    timestamp: now.toISOString(),
  };
}
