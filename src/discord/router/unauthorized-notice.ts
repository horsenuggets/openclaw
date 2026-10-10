import type { BuiltEmbed } from "./embed-categories.js";
import type { RouterRuntime } from "./types.js";
import { DISCORD_API, editInteractionEmbedReply } from "./discord-api.js";
import { buildLogEmbed } from "./log-embed.js";

/**
 * Shared "permission denied" feedback for slash commands. Every slash command
 * that turns a user away for lack of permission renders the SAME ephemeral embed
 * here, so denials look and read identically across commands (and new commands
 * get the behavior for free by calling {@link denyInteractionEphemeral}). Plain
 * messages reuse the same embed builder via {@link buildPermissionDeniedEmbed}.
 *
 * Two notice flavors are provided: a channel-ownership denial that names the
 * registered owner (for commands that act on a channel's agent), and a generic
 * missing-permission denial naming the command (for globally gated commands such
 * as the admin-only `/debug`).
 */

/**
 * The channel-ownership denial wording: shown when someone who is not the
 * registered owner tries to drive a channel's agent. Names the owner when known.
 */
export function buildUnauthorizedNoticeText(channelId: string, ownerId?: string | null): string {
  return ownerId
    ? `Sorry, but this channel (<#${channelId}>) is registered under user <@${ownerId}>. Unfortunately, you are not authorized to use this channel's agent.`
    : `Sorry, but you are not authorized to use this channel's agent (<#${channelId}>).`;
}

/**
 * The generic missing-permission wording: shown when a user lacks the privilege
 * a command requires (for example the admin-only `/debug`), where channel
 * ownership is not the relevant gate. `commandName` is the bare command name
 * (no leading slash).
 */
export function buildMissingPermissionText(commandName: string): string {
  return `Sorry, but you do not have the necessary permissions to use the \`/${commandName}\` command.`;
}

/**
 * Build the permission-denied embed (a Log-category embed) from a notice string.
 * The single place denial embeds are constructed, so every surface — slash
 * replies, modal submits, and threaded plain-message notices — stays identical.
 */
export function buildPermissionDeniedEmbed(notice: string): BuiltEmbed {
  return buildLogEmbed(notice);
}

/**
 * Deny an interaction with the permission embed, visible only to the caller
 * (ephemeral, flag 64). The embed's footer icon is an uploaded attachment, which
 * the plain callback endpoint cannot carry but the attachment-aware editor can,
 * so the interaction is deferred first and the embed edited into `@original`. The
 * edit waits for the defer to land so the PATCH cannot race ahead of the response
 * being created.
 *
 * Pass `alreadyDeferred: true` when the caller has already sent the deferred
 * (type 5) acknowledgement — e.g. `/debug`, which defers before its admin check —
 * so this does not defer a second time (which Discord would reject).
 */
export async function denyInteractionEphemeral(params: {
  applicationId: string;
  interactionId: string;
  interactionToken: string;
  notice: string;
  runtime: RouterRuntime;
  alreadyDeferred?: boolean;
}): Promise<void> {
  const { applicationId, interactionId, interactionToken, notice, runtime, alreadyDeferred } =
    params;
  try {
    if (!alreadyDeferred) {
      const deferResp = await fetch(
        `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: 5, data: { flags: 64 } }),
        },
      );
      if (!deferResp.ok) {
        runtime.error(`[router] permission denial defer failed (${deferResp.status})`);
        return;
      }
    }
    const built = buildPermissionDeniedEmbed(notice);
    const res = await editInteractionEmbedReply(applicationId, interactionToken, {
      embeds: [built.embed],
      attachments: built.attachments,
    });
    if (!res.ok) {
      runtime.error(`[router] permission denial edit failed (${res.status})`);
    }
  } catch (err) {
    runtime.error(`[router] permission denial failed: ${String(err)}`);
  }
}

/**
 * Deny a slash/modal interaction for a non-owner trying to drive a channel's
 * agent, naming the owner when known. Thin wrapper over
 * {@link denyInteractionEphemeral} with the channel-ownership wording.
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
  await denyInteractionEphemeral({
    applicationId,
    interactionId,
    interactionToken,
    notice: buildUnauthorizedNoticeText(channelId, ownerId),
    runtime,
  });
}
