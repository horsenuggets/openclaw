import type { RouterRuntime } from "./types.js";
import { DISCORD_API, editInteractionEmbedReply } from "./discord-api.js";
import { buildLogEmbed } from "./log-embed.js";

/**
 * The single source of the "you are not authorized to use this channel's agent"
 * wording. Plain messages post it as a threaded Log embed; slash commands and
 * modal submits deliver the same text as an ephemeral reply, so every surface
 * says exactly the same thing.
 */
export function buildUnauthorizedNoticeText(channelId: string, ownerId?: string | null): string {
  return ownerId
    ? `Sorry, but this channel (<#${channelId}>) is registered under user <@${ownerId}>. Unfortunately, you are not authorized to use this channel's agent.`
    : `Sorry, but you are not authorized to use this channel's agent (<#${channelId}>).`;
}

/**
 * Answer an interaction with the unauthorized notice, visible only to the caller
 * (ephemeral, flag 64). Defers first, then edits in the Log embed: the embed's
 * footer icon is an uploaded attachment, which the callback endpoint cannot carry
 * but the attachment-aware editor can. The edit waits for the defer to land so the
 * `@original` PATCH cannot race ahead of the response being created.
 */
export async function replyUnauthorizedEphemeral(params: {
  applicationId: string;
  interactionId: string;
  interactionToken: string;
  channelId: string;
  ownerId?: string | null;
  runtime: RouterRuntime;
}): Promise<void> {
  const { applicationId, interactionId, interactionToken, channelId, ownerId, runtime } = params;
  try {
    const deferResp = await fetch(
      `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: 5, data: { flags: 64 } }),
      },
    );
    if (!deferResp.ok) {
      runtime.error(`[router] unauthorized notice defer failed (${deferResp.status})`);
      return;
    }
    const built = buildLogEmbed(buildUnauthorizedNoticeText(channelId, ownerId));
    const res = await editInteractionEmbedReply(applicationId, interactionToken, {
      embeds: [built.embed],
      attachments: built.attachments,
    });
    if (!res.ok) {
      runtime.error(`[router] unauthorized notice edit failed (${res.status})`);
    }
  } catch (err) {
    runtime.error(`[router] unauthorized notice failed: ${String(err)}`);
  }
}
