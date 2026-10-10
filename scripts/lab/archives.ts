/**
 * Archive-category orchestration for the OpenClaw Lab server, shared by the
 * archive_channel / tidy_archives / thanos_snap_archives / clear_archives /
 * archive_sandbox_channels entrypoints.
 *
 * Archived channels live in categories named `Archive 0001`, `Archive 0002`, ...
 * Discord caps a category at 50 channels, so the archive spills into sequential
 * categories. tidyArchives is the single source of truth: it repacks every
 * archived channel (plus any newly included ones) into the minimum number of
 * fully-used categories, renames them to a contiguous sequence, and deletes any
 * category left empty.
 */

import { ChannelType, type DiscordChannel } from "./discord.js";
import {
  archiveCategoryIndex,
  archiveCategoryName,
  chunk,
  CHANNELS_PER_CATEGORY,
} from "./lab-core.js";

/**
 * The subset of the Discord client the archive helpers need. Narrowing to this
 * interface (which LabDiscord satisfies) lets tests drive the logic with an
 * in-memory fake.
 */
export interface ArchiveClient {
  listGuildChannels(): Promise<DiscordChannel[]>;
  createChannel(body: {
    name: string;
    type: number;
    parent_id?: string | null;
  }): Promise<DiscordChannel>;
  modifyChannel(channelId: string, body: Record<string, unknown>): Promise<DiscordChannel>;
  deleteChannel(channelId: string): Promise<void>;
}

/** Whether an error is Discord's "category is full" (max 50 channels) rejection. */
function isCategoryFullError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b30035\b/.test(message) || /maximum number of channels/i.test(message);
}

/** Default pause between mutations, to stay friendly to Discord's rate limits. */
const DEFAULT_PACE_MS = 300;

function pace(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function byPosition(a: DiscordChannel, b: DiscordChannel): number {
  return (a.position ?? 0) - (b.position ?? 0);
}

/** The archive categories in the guild, ordered by their numeric suffix. */
function archiveCategories(channels: DiscordChannel[]): DiscordChannel[] {
  return channels
    .filter((c) => c.type === ChannelType.GuildCategory && archiveCategoryIndex(c.name) !== null)
    .toSorted((a, b) => archiveCategoryIndex(a.name)! - archiveCategoryIndex(b.name)!);
}

/** Non-category children of a category, in display order. */
function childrenOf(channels: DiscordChannel[], categoryId: string): DiscordChannel[] {
  return channels
    .filter((c) => c.parent_id === categoryId && c.type !== ChannelType.GuildCategory)
    .toSorted(byPosition);
}

/** Ids of every channel currently sitting in an archive category. */
export async function collectArchiveChannelIds(client: ArchiveClient): Promise<string[]> {
  const channels = await client.listGuildChannels();
  const ids: string[] = [];
  for (const cat of archiveCategories(channels)) {
    for (const child of childrenOf(channels, cat.id)) {
      ids.push(child.id);
    }
  }
  return ids;
}

/**
 * Repack the archive categories. Existing archived channels keep their relative
 * order; any `include` ids (channels being newly archived, e.g. from Sandbox or
 * an expired Testing day) are appended. The result is contiguous `Archive NNNN`
 * categories of up to 50 channels each, with no empty category left behind.
 *
 * Each channel is moved straight to its destination category; a move that would
 * momentarily exceed Discord's 50-channel ceiling is deferred and retried once
 * another move frees a slot. Channels are never parked parentless, so a failure
 * mid-repack leaves every channel inside an archive category rather than
 * orphaned outside it.
 */
export async function tidyArchives(
  client: ArchiveClient,
  options: { include?: string[]; paceMs?: number } = {},
): Promise<void> {
  const paceMs = options.paceMs ?? DEFAULT_PACE_MS;
  const channels = await client.listGuildChannels();
  const byId = new Map(channels.map((c) => [c.id, c]));
  const cats = archiveCategories(channels);

  // Current archived channels in order, then the newly included ones (that exist
  // and are not already archived).
  const flat: string[] = [];
  const seen = new Set<string>();
  for (const cat of cats) {
    for (const child of childrenOf(channels, cat.id)) {
      flat.push(child.id);
      seen.add(child.id);
    }
  }
  for (const id of options.include ?? []) {
    if (!seen.has(id) && byId.has(id)) {
      flat.push(id);
      seen.add(id);
    }
  }

  const groups = chunk(flat, CHANNELS_PER_CATEGORY);

  // Ensure exactly groups.length archive categories, reusing existing ones and
  // normalizing their names to the contiguous Archive NNNN sequence.
  const categoryIds: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const want = archiveCategoryName(i + 1);
    if (i < cats.length) {
      const cat = cats[i];
      if (cat.name !== want) {
        await client.modifyChannel(cat.id, { name: want });
        await pace(paceMs);
      }
      categoryIds.push(cat.id);
    } else {
      const created = await client.createChannel({ name: want, type: ChannelType.GuildCategory });
      await pace(paceMs);
      categoryIds.push(created.id);
    }
  }

  // Work out which channels actually need to move to reach the target layout.
  const moves: Array<{ id: string; target: string }> = [];
  for (let i = 0; i < groups.length; i++) {
    for (const id of groups[i]) {
      const current = byId.get(id)?.parent_id ?? null;
      if (current !== categoryIds[i]) {
        moves.push({ id, target: categoryIds[i] });
      }
    }
  }

  // Apply the moves directly to their destination category, deferring any that
  // momentarily hit Discord's 50-channel ceiling and retrying once other moves
  // have freed a slot. Channels are never parked parentless, so a crash or
  // network failure mid-repack leaves every channel inside an archive category
  // (where the next run re-discovers it) rather than orphaned outside it.
  let pending = moves;
  while (pending.length > 0) {
    const deferred: typeof moves = [];
    let progressed = false;
    for (const move of pending) {
      try {
        await client.modifyChannel(move.id, { parent_id: move.target });
        progressed = true;
        await pace(paceMs);
      } catch (err) {
        if (isCategoryFullError(err)) {
          deferred.push(move);
          continue;
        }
        throw err;
      }
    }
    if (!progressed) {
      throw new Error("Archive repack is stuck: every remaining channel targets a full category.");
    }
    pending = deferred;
  }

  // Delete any archive categories beyond what we need; they are now empty.
  for (let i = groups.length; i < cats.length; i++) {
    await client.deleteChannel(cats[i].id);
    await pace(paceMs);
  }
}

/** Delete the given channels, pacing between calls. */
export async function deleteChannels(
  client: ArchiveClient,
  ids: string[],
  paceMs: number = DEFAULT_PACE_MS,
): Promise<void> {
  for (const id of ids) {
    await client.deleteChannel(id);
    await pace(paceMs);
  }
}
