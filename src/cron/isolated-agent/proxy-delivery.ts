import type { ReplyPayload } from "../../auto-reply/types.js";

/**
 * Deliver cron output to Discord through the router's container proxy.
 *
 * Agent containers run with OPENCLAW_SKIP_CHANNELS=1 and no registered Discord
 * channel plugin, so the normal outbound path cannot resolve "discord". When the
 * instance is configured with channels.discord.proxyUrl, we POST the isolated
 * run's payloads straight to the router's /discord/send endpoint instead. The
 * router owns the bot token and performs the actual send.
 *
 * A "channel" target posts directly to that channel/thread id; a "user" target
 * is resolved to a DM channel by the router. The kind is captured when the job is
 * created (see inferDeliveryFromSessionKey) so we do not have to guess here.
 */

export type DiscordProxyTargetKind = "channel" | "user";

type ProxySendBody = {
  text: string;
  mediaUrl?: string;
  channelId?: string;
  userId?: string;
};

function targetField(
  to: string,
  kind: DiscordProxyTargetKind,
): { channelId: string } | { userId: string } {
  return kind === "channel" ? { channelId: to } : { userId: to };
}

async function postSend(fetchImpl: typeof fetch, base: string, body: ProxySendBody): Promise<void> {
  const resp = await fetchImpl(`${base}/discord/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`discord proxy send failed (${resp.status})${detail ? `: ${detail}` : ""}`);
  }
}

export async function deliverDiscordViaProxy(params: {
  proxyUrl: string;
  to: string;
  toKind: DiscordProxyTargetKind;
  payloads: ReplyPayload[];
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const base = params.proxyUrl.replace(/\/+$/, "");
  const target = targetField(params.to, params.toKind);
  for (const payload of params.payloads) {
    const text = payload.text?.trim() ?? "";
    const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    if (mediaUrls.length === 0) {
      if (!text) {
        continue;
      }
      await postSend(fetchImpl, base, { ...target, text });
      continue;
    }
    let first = true;
    for (const mediaUrl of mediaUrls) {
      // The proxy requires non-empty text, so fall back to the media URL as the
      // body when there is no caption for this payload.
      const caption = first ? text : "";
      await postSend(fetchImpl, base, { ...target, text: caption || mediaUrl, mediaUrl });
      first = false;
    }
  }
}
