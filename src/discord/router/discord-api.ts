import { Routes } from "discord-api-types/v10";
import net from "node:net";
import type { ChannelReplyPayload, DiscordActionRow, DiscordEmbed } from "./channel-commands.js";
import { readEmbedAsset } from "./embed-assets.js";

export const DISCORD_API = "https://discord.com/api/v10";
export const TYPING_INTERVAL_MS = 8_000;

/** Discord `allowed_mentions`; use to suppress pings on an outgoing message. */
export type AllowedMentions = {
  parse?: ("users" | "roles" | "everyone")[];
  users?: string[];
  roles?: string[];
  replied_user?: boolean;
};

/** Max attempts for a rate-limited (429) message send before giving up. */
const SEND_MAX_ATTEMPTS = 5;
/** Fallback wait when a 429 response carries no retry-after hint. */
const SEND_RETRY_FALLBACK_MS = 1_000;
/** Cushion added to Discord's retry-after so the bucket has fully reset. */
const SEND_RETRY_CUSHION_MS = 50;

/**
 * Read the retry-after delay (ms) from a 429 response. Prefers the
 * `Retry-After` header (seconds) and falls back to the JSON body's
 * `retry_after` field. Returns a safe default when neither is present.
 */
async function parseRetryAfterMs(resp: Response): Promise<number> {
  const header = resp.headers.get("retry-after");
  const headerSeconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return Math.ceil(headerSeconds * 1_000) + SEND_RETRY_CUSHION_MS;
  }
  try {
    const body = (await resp.clone().json()) as { retry_after?: number };
    if (typeof body.retry_after === "number" && body.retry_after >= 0) {
      return Math.ceil(body.retry_after * 1_000) + SEND_RETRY_CUSHION_MS;
    }
  } catch {
    // Body was not JSON; fall through to the default.
  }
  return SEND_RETRY_FALLBACK_MS;
}

export async function discordSend(
  token: string,
  channelId: string,
  content: string,
): Promise<void> {
  const url = `${DISCORD_API}${Routes.channelMessages(channelId)}`;
  // Replies are split into one message per paragraph, so a single turn can
  // exceed Discord's per-channel rate limit (5 messages / 5s). Honor the
  // 429 retry-after so paragraphs are paced out rather than silently dropped.
  for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    if (resp.ok) {
      return;
    }
    // Non-429 failures (e.g. 401/403/5xx) are not retryable: throw so the caller
    // treats the message as undelivered instead of silently dropping it.
    if (resp.status !== 429) {
      const detail = (await resp.text().catch(() => "")).slice(0, 200);
      throw new Error(
        `Discord send to channel ${channelId} failed (${resp.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    // Still rate limited on the final attempt: throw rather than return, so the
    // caller treats the message as undelivered instead of silently dropping it.
    if (attempt === SEND_MAX_ATTEMPTS) {
      throw new Error(
        `Discord send to channel ${channelId} rate limited after ${SEND_MAX_ATTEMPTS} attempts`,
      );
    }
    const retryAfterMs = await parseRetryAfterMs(resp);
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
  }
}

/**
 * Post a real Discord reply that references the triggering command message
 * (threads under it in the client). Accepts a plain string (content) or an
 * embeds payload. Bots cannot send true ephemeral replies, so callers that
 * want an auto-deleting notice use `discordSendEphemeral` instead.
 */
export async function discordSendReply(
  token: string,
  channelId: string,
  commandMessageId: string,
  payload: ChannelReplyPayload,
  allowedMentions?: AllowedMentions,
): Promise<void> {
  const messageReference = {
    message_id: commandMessageId,
    channel_id: channelId,
    fail_if_not_exists: false,
  };
  if (typeof payload !== "string") {
    // Embed replies upload their category icons, so route them through the
    // attachment-aware sender (which also reuses cached CDN URLs).
    await sendEmbedMessage(token, channelId, {
      embeds: payload.embeds,
      attachments: payload.attachments,
      components: payload.components,
      messageReference,
      allowedMentions,
    });
    return;
  }
  await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: payload,
      message_reference: messageReference,
      ...(allowedMentions ? { allowed_mentions: allowedMentions } : {}),
    }),
  });
}

/**
 * Send a message that looks ephemeral (italic, low-key).
 * True ephemeral messages require interaction responses — for regular messages
 * we send a normal message that auto-deletes after a few seconds.
 */
export async function discordSendEphemeral(
  token: string,
  channelId: string,
  content: string,
): Promise<void> {
  const resp = await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  if (resp.ok) {
    // Auto-delete after 10 seconds
    const msg = (await resp.json()) as { id?: string };
    if (msg.id) {
      setTimeout(() => {
        void fetch(`${DISCORD_API}${Routes.channelMessage(channelId, msg.id!)}`, {
          method: "DELETE",
          headers: { Authorization: `Bot ${token}` },
        }).catch(() => {});
      }, 10_000);
    }
  }
}

/**
 * Delete a message. Used to scrub a pasted secret (e.g. `/connections add <svc>
 * <token>`) from channel history. Returns true only when Discord confirms the
 * delete (2xx); a 403/404 or a network failure returns false so the caller can
 * warn the user their token is still visible instead of silently claiming it was
 * removed.
 */
export async function discordDeleteMessage(
  token: string,
  channelId: string,
  messageId: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${DISCORD_API}${Routes.channelMessage(channelId, messageId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bot ${token}` },
      // Bound the scrub: the caller awaits it before validating/replying, so a
      // stalled delete must not hang the whole command with the token still
      // visible. On timeout the fetch aborts and the catch returns false, which
      // triggers the manual-delete warning just like any other failure.
      signal: AbortSignal.timeout(10_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function discordTyping(token: string, channelId: string): Promise<void> {
  await fetch(`${DISCORD_API}${Routes.channelTyping(channelId)}`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
  }).catch(() => {});
}

/** Open a DM channel with a user and return the channel ID. */
export async function openDMChannel(token: string, userId: string): Promise<string | null> {
  const resp = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!resp.ok) {
    return null;
  }
  const data = (await resp.json()) as { id?: string };
  return data.id ?? null;
}

/** How long a Discord CDN attachment URL is reused before re-upload (12 hours). */
const CDN_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

type CdnCacheEntry = { url: string; expiresAt: number };

// Icon filename -> cached Discord CDN URL. In-memory only, on purpose: a router
// restart clears it, forcing a fresh upload. That is intended, because a restart
// may ship updated icons and the old CDN URLs would still serve the previous
// image until their signed expiry.
const cdnCache = new Map<string, CdnCacheEntry>();

/** Test hook: drop every cached CDN URL. */
export function clearEmbedCdnCache(): void {
  cdnCache.clear();
}

/** A category embed plus the icon files it references, ready to post. */
export type EmbedMessage = {
  embeds: DiscordEmbed[];
  /** Icon filenames (in assets/embeds) the embeds reference via attachment://. */
  attachments?: string[];
  components?: DiscordActionRow[];
  /** Post as a referenced reply to this message, when set. */
  messageReference?: { message_id: string; channel_id: string; fail_if_not_exists?: boolean };
  /** `allowed_mentions` to attach, e.g. to suppress pings. */
  allowedMentions?: AllowedMentions;
};

/** Fresh cached CDN URL for an icon, or null when absent or expired. */
function cachedCdnUrl(filename: string, now: number): string | null {
  const entry = cdnCache.get(filename);
  if (!entry) {
    return null;
  }
  if (entry.expiresAt <= now) {
    cdnCache.delete(filename);
    return null;
  }
  return entry.url;
}

/**
 * Cache expiry for an uploaded icon: the smaller of our 12h window and the
 * signed-URL expiry Discord encodes in the `ex` query param (hex epoch
 * seconds), so we never reuse a URL past the point Discord would reject it.
 */
function cdnExpiry(url: string, now: number): number {
  const ttlExpiry = now + CDN_CACHE_TTL_MS;
  const match = url.match(/[?&]ex=([0-9a-fA-F]+)/);
  if (match) {
    const signedExpiry = Number.parseInt(match[1], 16) * 1000;
    if (Number.isFinite(signedExpiry) && signedExpiry > now) {
      return Math.min(ttlExpiry, signedExpiry);
    }
  }
  return ttlExpiry;
}

/** Rewrite `attachment://<file>` icon references to a resolved URL across embeds. */
function rewriteAttachmentUrls(embeds: DiscordEmbed[], subs: Map<string, string>): DiscordEmbed[] {
  return embeds.map((embed) => {
    const copy = structuredClone(embed);
    for (const [file, url] of subs) {
      const ref = `attachment://${file}`;
      if (copy.footer?.icon_url === ref) {
        copy.footer.icon_url = url;
      }
      if (copy.thumbnail?.url === ref) {
        copy.thumbnail.url = url;
      }
      if (copy.image?.url === ref) {
        copy.image.url = url;
      }
    }
    return copy;
  });
}

/** Strip `attachment://<file>` references whose icon could not be resolved. */
function dropAttachmentUrls(embeds: DiscordEmbed[], files: Set<string>): DiscordEmbed[] {
  return embeds.map((embed) => {
    const copy = structuredClone(embed);
    for (const file of files) {
      const ref = `attachment://${file}`;
      if (copy.footer?.icon_url === ref) {
        delete copy.footer.icon_url;
      }
      if (copy.thumbnail?.url === ref) {
        delete copy.thumbnail;
      }
      if (copy.image?.url === ref) {
        delete copy.image;
      }
    }
    return copy;
  });
}

/** One embed request to dispatch (a channel POST or an interaction-reply PATCH). */
type EmbedDispatch = {
  url: string;
  method: "POST" | "PATCH";
  /** Bot token for channel sends; omitted for webhook/interaction edits. */
  authToken?: string;
  embeds: DiscordEmbed[];
  /** Icon filenames (in assets/embeds) the embeds reference via attachment://. */
  attachments?: string[];
  components?: DiscordActionRow[];
  /** Always include a components field (interaction edits clear action rows with []). */
  forceComponents?: boolean;
  messageReference?: { message_id: string; channel_id: string; fail_if_not_exists?: boolean };
  allowedMentions?: AllowedMentions;
};

/**
 * Core embed sender shared by channel posts and interaction-reply edits. Any
 * referenced category icon is either substituted from the in-memory CDN cache
 * (fresh prior upload), uploaded as a multipart attachment (and then cached from
 * the response), or dropped when its file cannot be read. Works for both the
 * initial reply (cold cache uploads) and follow-up edits (warm cache reuses).
 */
async function dispatchEmbed(request: EmbedDispatch): Promise<{ ok: boolean; status: number }> {
  const now = Date.now();
  const needed = [...new Set(request.attachments ?? [])];

  // Split needed icons into cache hits (substitute URL) and uploads (send bytes).
  const subs = new Map<string, string>();
  const toUpload: { filename: string; data: Buffer }[] = [];
  const missing = new Set<string>();
  for (const file of needed) {
    const url = cachedCdnUrl(file, now);
    if (url) {
      subs.set(file, url);
      continue;
    }
    const data = readEmbedAsset(file);
    if (data) {
      toUpload.push({ filename: file, data });
    } else {
      missing.add(file);
    }
  }

  let embeds = request.embeds;
  if (subs.size > 0) {
    embeds = rewriteAttachmentUrls(embeds, subs);
  }
  if (missing.size > 0) {
    embeds = dropAttachmentUrls(embeds, missing);
  }

  const payload: Record<string, unknown> = { embeds };
  if (request.components || request.forceComponents) {
    payload.components = request.components ?? [];
  }
  if (request.messageReference) {
    payload.message_reference = request.messageReference;
  }
  if (request.allowedMentions) {
    payload.allowed_mentions = request.allowedMentions;
  }
  const authHeader: Record<string, string> = request.authToken
    ? { Authorization: `Bot ${request.authToken}` }
    : {};

  if (toUpload.length === 0) {
    const resp = await fetch(request.url, {
      method: request.method,
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: resp.ok, status: resp.status };
  }

  payload.attachments = toUpload.map((file, index) => ({ id: index, filename: file.filename }));
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  toUpload.forEach((file, index) => {
    // Copy into a plain ArrayBuffer-backed Uint8Array so it satisfies BlobPart.
    const bytes = Uint8Array.from(file.data);
    form.append(`files[${index}]`, new Blob([bytes], { type: "image/png" }), file.filename);
  });
  const resp = await fetch(request.url, {
    method: request.method,
    headers: authHeader,
    body: form,
  });
  if (resp.ok) {
    await cacheUploadedIcons(resp, toUpload, now);
  }
  return { ok: resp.ok, status: resp.status };
}

/**
 * Post one or more category embeds to a channel, uploading referenced icons as
 * attachments (reusing cached CDN URLs where possible).
 */
export async function sendEmbedMessage(
  token: string,
  channelId: string,
  message: EmbedMessage,
): Promise<{ ok: boolean; status: number }> {
  return dispatchEmbed({
    url: `${DISCORD_API}${Routes.channelMessages(channelId)}`,
    method: "POST",
    authToken: token,
    embeds: message.embeds,
    attachments: message.attachments,
    components: message.components,
    messageReference: message.messageReference,
    allowedMentions: message.allowedMentions,
  });
}

/**
 * Edit an interaction's original (deferred) reply with category embeds, uploading
 * referenced icons the same way a channel post does. Used by the `/channel`
 * slash-command reply and the unregister confirmation button follow-up, both of
 * which deferred first and now deliver the result by editing `@original`.
 */
export async function editInteractionEmbedReply(
  applicationId: string,
  interactionToken: string,
  message: { embeds: DiscordEmbed[]; attachments?: string[]; components?: DiscordActionRow[] },
): Promise<{ ok: boolean; status: number }> {
  return dispatchEmbed({
    url: `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    method: "PATCH",
    embeds: message.embeds,
    attachments: message.attachments,
    components: message.components,
    forceComponents: true,
  });
}

/** Cache CDN URLs from the send response for the icons we just uploaded. */
async function cacheUploadedIcons(
  resp: Response,
  uploaded: { filename: string; data: Buffer }[],
  now: number,
): Promise<void> {
  try {
    const body = (await resp.json()) as {
      attachments?: { filename?: string; url?: string }[];
    };
    const names = new Set(uploaded.map((file) => file.filename));
    for (const att of body.attachments ?? []) {
      if (att.filename && att.url && names.has(att.filename)) {
        cdnCache.set(att.filename, { url: att.url, expiresAt: cdnExpiry(att.url, now) });
      }
    }
  } catch {
    // Response body unreadable; skip caching (the next send re-uploads).
  }
}

/**
 * Quick liveness check: resolve true if a TCP connection to 127.0.0.1:port
 * succeeds within the timeout, false otherwise. Used by `/channel status` to
 * report whether the agent container is actually up.
 */
export function probePort(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Deterministically remove em (—) and en (–) dashes from outgoing agent text.
 * The model still emits them despite prompt rules, so this is a belt-and-braces
 * post-process applied only to user-facing reply text (never control commands
 * or embeds). A dash used as punctuation (surrounded by spaces) collapses to a
 * comma; a bare dash becomes ", " so joined clauses stay readable. Regular
 * hyphens (-) in compound words, CLI flags, and filenames are untouched.
 */
export function stripDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ").replace(/,\s+,/g, ",");
}
