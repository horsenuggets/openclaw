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

import { ChannelType, type DiscordChannel, type LabDiscord } from "./discord.js";
import {
  archiveCategoryIndex,
  archiveCategoryName,
  chunk,
  CHANNELS_PER_CATEGORY,
} from "./lab-core.js";

/** A brief pause between mutations to stay friendly to Discord's rate limits. */
const PACE_MS = 300;

function pace(): Promise<void> {
  return new Promise((r) => setTimeout(r, PACE_MS));
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
export async function collectArchiveChannelIds(client: LabDiscord): Promise<string[]> {
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
 * Moves are done in two phases — first detach every channel that must move
 * (parent_id = null), then attach it to its target — so a category is never
 * transiently pushed past Discord's 50-channel ceiling during the shuffle.
 */
export async function tidyArchives(
  client: LabDiscord,
  options: { include?: string[] } = {},
): Promise<void> {
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
        await pace();
      }
      categoryIds.push(cat.id);
    } else {
      const created = await client.createChannel({ name: want, type: ChannelType.GuildCategory });
      await pace();
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

  // Phase 1: detach movers so their target categories have room.
  for (const move of moves) {
    await client.modifyChannel(move.id, { parent_id: null });
    await pace();
  }
  // Phase 2: attach each mover to its destination category.
  for (const move of moves) {
    await client.modifyChannel(move.id, { parent_id: move.target });
    await pace();
  }

  // Delete any archive categories beyond what we need; they are now empty.
  for (let i = groups.length; i < cats.length; i++) {
    await client.deleteChannel(cats[i].id);
    await pace();
  }
}

/** Delete the given channels, pacing between calls. */
export async function deleteChannels(client: LabDiscord, ids: string[]): Promise<void> {
  for (const id of ids) {
    await client.deleteChannel(id);
    await pace();
  }
}
