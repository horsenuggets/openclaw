import type { ReplyPayload } from "../../auto-reply/types.js";
import { chunkMarkdownText } from "../../auto-reply/chunk.js";
import { parseDiscordTarget } from "../../discord/targets.js";

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
 * created (see inferDeliveryFromSessionKey) and refined per target: a prefixed
 * target (channel:123 / user:456 / <@id>) carries its own kind and is reduced to a
 * bare id, while a bare id falls back to the captured kind.
 */

export type DiscordProxyTargetKind = "channel" | "user";

const DISCORD_TEXT_LIMIT = 2000;

type ProxySendBody = {
  text: string;
  mediaUrl?: string;
  channelId?: string;
  userId?: string;
};

function resolveTargetField(
  to: string,
  defaultKind: DiscordProxyTargetKind,
): { channelId: string } | { userId: string } {
  // parseDiscordTarget turns a prefixed/mention target into a bare id + explicit
  // kind; a bare numeric id resolves to defaultKind (the kind captured from the
  // originating session). Fall back to the raw value if parsing yields nothing.
  const parsed = parseDiscordTarget(to, { defaultKind });
  const id = parsed?.id ?? to;
  return parsed?.kind === "user" ? { userId: id } : { channelId: id };
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
  toKind?: DiscordProxyTargetKind;
  payloads: ReplyPayload[];
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const base = params.proxyUrl.replace(/\/+$/, "");
  const target = resolveTargetField(params.to, params.toKind ?? "channel");
  for (const payload of params.payloads) {
    const text = payload.text?.trim() ?? "";
    const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    // Split text into <=2000-char chunks so Discord never rejects an oversized
    // message (the router's send is verbatim, and an "at" job would otherwise
    // disable itself without delivering).
    if (text) {
      for (const chunk of chunkMarkdownText(text, DISCORD_TEXT_LIMIT)) {
        if (chunk.trim()) {
          await postSend(fetchImpl, base, { ...target, text: chunk });
        }
      }
    }
    // Send each media URL as its own message, passing the URL in exactly one
    // field (the text) so the proxy does not double-append it and blow the
    // 2000-char limit. Discord auto-embeds a bare media URL in message content.
    // The container proxy can only post URLs, not upload files, so a non-http
    // media reference (e.g. a local `./path.png`) is skipped rather than posted
    // as a broken path; the text summary still delivers.
    for (const mediaUrl of mediaUrls) {
      if (!/^https?:\/\//i.test(mediaUrl)) {
        continue;
      }
      await postSend(fetchImpl, base, { ...target, text: mediaUrl });
    }
  }
}
