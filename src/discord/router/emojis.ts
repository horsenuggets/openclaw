/**
 * Resolve the router bot's own application emojis to `<:name:id>` references.
 *
 * Application emojis belong to the bot (its application), not a guild, so the bot
 * can use them in any server it is in. Their ids differ per bot (prod vs mirror),
 * so rather than hardcoding ids the router fetches its own set once at startup and
 * caches a name -> id map; call sites reference emojis BY NAME and the correct id
 * resolves for whichever bot is running. If the set has not loaded, or a name is
 * unknown, the caller's plain-text fallback (e.g. a unicode glyph) is returned, so
 * an embed always renders something sensible.
 */

import { DISCORD_API } from "./discord-api.js";

type AppEmoji = { id: string; animated: boolean };
type FetchLike = typeof fetch;

/** Cached name -> emoji map for the running bot; null until the first load. */
let emojiMap: Map<string, AppEmoji> | null = null;

/**
 * Fetch the bot's application emojis and cache the name -> id map. Never throws:
 * on any failure the previous cache (if any) is kept and {@link resolveEmoji}
 * falls back to the caller's text. Safe to call again to refresh. Returns the
 * number of emojis now cached.
 */
export async function initAppEmojis(
  token: string,
  applicationId: string,
  fetchImpl: FetchLike = fetch,
): Promise<number> {
  try {
    const resp = await fetchImpl(`${DISCORD_API}/applications/${applicationId}/emojis`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!resp.ok) {
      return emojiMap?.size ?? 0;
    }
    const body = (await resp.json()) as {
      items?: Array<{ name?: string; id?: string; animated?: boolean }>;
    };
    const next = new Map<string, AppEmoji>();
    for (const e of body.items ?? []) {
      if (e.name && e.id) {
        next.set(e.name, { id: e.id, animated: Boolean(e.animated) });
      }
    }
    emojiMap = next;
    return next.size;
  } catch {
    return emojiMap?.size ?? 0;
  }
}

/**
 * Reference an application emoji by name as `<:name:id>` (or `<a:name:id>` for an
 * animated one). Returns `fallback` when the bot's emoji set has not loaded or has
 * no emoji with that name.
 */
export function resolveEmoji(name: string, fallback: string): string {
  const e = emojiMap?.get(name);
  if (!e) {
    return fallback;
  }
  return `<${e.animated ? "a" : ""}:${name}:${e.id}>`;
}

/** Test hook: drop the cached map so a fresh load (or the fallback path) is exercised. */
export function resetAppEmojis(): void {
  emojiMap = null;
}
