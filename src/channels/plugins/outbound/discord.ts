import type { OpenClawConfig } from "../../../config/config.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { resolveDiscordAccount } from "../../../discord/accounts.js";
import { sendMessageDiscord, sendPollDiscord } from "../../../discord/send.js";
import { convertTimesToDiscordTimestamps } from "../../../discord/timestamps.js";

function applyTimestamps(text: string, cfg: OpenClawConfig, accountId?: string | null): string {
  const { config } = resolveDiscordAccount({ cfg, accountId });
  if (config.discordTimestamps !== false) {
    return convertTimesToDiscordTimestamps(text);
  }
  return text;
}

/**
 * Send a message via the Discord router proxy instead of the Discord REST API.
 * Used by Docker containers that delegate Discord to an external router service.
 */
async function sendViaProxy(
  proxyUrl: string,
  to: string,
  text: string,
  opts?: { mediaUrl?: string; replyToId?: string },
): Promise<{ messageId: string; channelId: string }> {
  const resp = await fetch(`${proxyUrl}/discord/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: to,
      text,
      mediaUrl: opts?.mediaUrl,
      replyToId: opts?.replyToId,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Discord proxy send failed (${resp.status}): ${body}`);
  }
  const result = (await resp.json()) as { messageId?: string; channelId?: string };
  return {
    messageId: result.messageId ?? "unknown",
    channelId: result.channelId ?? "unknown",
  };
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: 2000,
  pollMaxOptions: 10,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId }) => {
    const { config } = resolveDiscordAccount({ cfg, accountId });
    const processed = applyTimestamps(text, cfg, accountId);

    // Use proxy if configured (Docker router architecture)
    if (config.proxyUrl) {
      const result = await sendViaProxy(config.proxyUrl, to, processed, {
        replyToId: replyToId ?? undefined,
      });
      return { channel: "discord", ...result };
    }

    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, processed, {
      verbose: false,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps, replyToId }) => {
    const { config } = resolveDiscordAccount({ cfg, accountId });
    const processed = applyTimestamps(text, cfg, accountId);

    // Use proxy if configured (Docker router architecture)
    if (config.proxyUrl) {
      const result = await sendViaProxy(config.proxyUrl, to, processed, {
        mediaUrl,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "discord", ...result };
    }

    const send = deps?.sendDiscord ?? sendMessageDiscord;
    const result = await send(to, processed, {
      verbose: false,
      mediaUrl,
      replyTo: replyToId ?? undefined,
      accountId: accountId ?? undefined,
    });
    return { channel: "discord", ...result };
  },
  sendPoll: async ({ to, poll, accountId }) =>
    await sendPollDiscord(to, poll, {
      accountId: accountId ?? undefined,
    }),
};
