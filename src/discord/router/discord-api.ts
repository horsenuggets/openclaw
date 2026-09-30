import { Routes } from "discord-api-types/v10";
import net from "node:net";
import type { ChannelReplyPayload, DiscordEmbed } from "./channel-commands.js";

export const DISCORD_API = "https://discord.com/api/v10";
export const TYPING_INTERVAL_MS = 8_000;

export async function discordSend(
  token: string,
  channelId: string,
  content: string,
): Promise<void> {
  await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
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
): Promise<void> {
  const message_reference = {
    message_id: commandMessageId,
    channel_id: channelId,
    fail_if_not_exists: false,
  };
  const body =
    typeof payload === "string"
      ? { content: payload, message_reference }
      : {
          embeds: payload.embeds satisfies DiscordEmbed[],
          ...(payload.components ? { components: payload.components } : {}),
          message_reference,
        };
  await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
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

/** Send a Discord embed message. */
export async function discordSendEmbed(
  token: string,
  channelId: string,
  embed: { title: string; description: string; color?: number },
): Promise<void> {
  await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ embeds: [embed] }),
  });
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

export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.3) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < limit * 0.3) {
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}
