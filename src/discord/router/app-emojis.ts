import type { ConnectionEmoji } from "./connect-commands.js";
import { DEFAULT_CONNECTION_EMOJI } from "./connect-commands.js";

/**
 * Discord application (bot-owned) emoji resolution. A bot can use its OWN
 * application emoji in any guild it is in, but the same emoji has a different id
 * per bot, so an embed must reference the ids of the bot that sends it. The
 * router/preview resolve their own emoji by name at startup, keeping the code free
 * of environment-specific ids and falling back to unicode when absent.
 *
 * Custom emoji names expected in the app: `greencheckfilled` (connected),
 * `redxfilled` (not connected), and `warningsquare` (needs authentication). Each
 * falls back to a unicode glyph when the named emoji is absent on the app.
 */

type AppEmoji = { id?: string; name?: string };

/**
 * Fetch the bot's application emoji as a name->id map. Returns {} on any failure.
 * The emoji endpoint needs the concrete application id (the `@me` shortcut is not
 * accepted there), so resolve it via `/oauth2/applications/@me` first.
 */
export async function fetchAppEmojiMap(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  try {
    const headers = { Authorization: `Bot ${token}` };
    // `startRouter` awaits this before connecting to the gateway, so bound both
    // calls: a stalled emoji endpoint must not keep the router from ever coming
    // up. On timeout the fetch rejects and the catch below returns the unicode
    // fallback map, exactly as for any other failure.
    const appResp = await fetchImpl("https://discord.com/api/v10/oauth2/applications/@me", {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!appResp.ok) {
      return {};
    }
    const appId = ((await appResp.json().catch(() => null)) as { id?: string } | null)?.id;
    if (!appId) {
      return {};
    }
    const resp = await fetchImpl(`https://discord.com/api/v10/applications/${appId}/emojis`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      return {};
    }
    const body = (await resp.json().catch(() => null)) as
      | { items?: AppEmoji[] }
      | AppEmoji[]
      | null;
    const items = Array.isArray(body) ? body : (body?.items ?? []);
    const map: Record<string, string> = {};
    for (const e of items) {
      if (e?.name && e?.id) {
        map[e.name] = e.id;
      }
    }
    return map;
  } catch {
    return {};
  }
}

/** `<:name:id>` reference for a named app emoji, or the unicode fallback if absent. */
export function emojiRef(map: Record<string, string>, name: string, fallback: string): string {
  const id = map[name];
  return id ? `<:${name}:${id}>` : fallback;
}

/** Build the connection status glyphs from a resolved app-emoji map (unicode fallback). */
export function connectionEmojiFromMap(map: Record<string, string>): ConnectionEmoji {
  return {
    connected: emojiRef(map, "greencheckfilled", DEFAULT_CONNECTION_EMOJI.connected),
    notConnected: emojiRef(map, "redxfilled", DEFAULT_CONNECTION_EMOJI.notConnected),
    needsAuth: emojiRef(map, "warningsquare", DEFAULT_CONNECTION_EMOJI.needsAuth),
  };
}
