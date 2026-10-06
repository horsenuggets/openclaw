import { randomUUID } from "node:crypto";
import type { InstanceConfig } from "./config.js";
import type { DiscordAttachment, RouterRuntime, RunAgentCommand } from "./types.js";
import { wrapSystemReminder } from "../../agents/conversation/system-reminder.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { stripHorizontalRules } from "../markdown-strip.js";
import { convertTimesToDiscordTimestamps } from "../timestamps.js";
import { parseAgentCommand, unescapeAgentText } from "./agent-commands.js";
import { refreshToken, setUserPreference } from "./config.js";
import {
  TYPING_INTERVAL_MS,
  chunkText,
  discordSend,
  discordTyping,
  sendEmbedMessage,
  stripDashes,
} from "./discord-api.js";
import { buildCommandResultEmbed } from "./embed-categories.js";
import { callGatewaySimple } from "./gateway-call.js";
import { resolveLifecycleCommand } from "./lifecycle-command.js";
import { buildLogEmbed, stripSurroundingItalics } from "./log-embed.js";
import { readBootstrapDirective } from "./onboarding.js";
import { classifyRouterError, isLeakedError } from "./router-filters.js";
import { resolveWhisperUrl } from "./whisper-url.js";

/**
 * Decide whether an internal command result should be relayed back to the agent
 * for a follow-up turn. Relaying happens only when the turn was purely internal
 * (a command ran and produced a result but nothing user-visible was delivered)
 * and the roundtrip budget is not exhausted. When the agent both ran a command
 * and spoke to the user in the same turn, relaying would spawn a duplicate reply
 * (e.g. "Great to meet you" followed by "Got it, what can I help you with"), so
 * this returns false.
 */
export function shouldRelayCommandResult(params: {
  ranCommand: boolean;
  commandResult: string | null;
  deliveredThisTurn: boolean;
  commandDepth: number;
  maxRoundtrips: number;
}): boolean {
  return (
    params.ranCommand &&
    params.commandResult !== null &&
    !params.deliveredThisTurn &&
    params.commandDepth < params.maxRoundtrips
  );
}

/** Returns true if the agent responded successfully. */
export async function routeMessage(params: {
  authorId: string;
  channelId: string;
  messageContent: string;
  attachments?: DiscordAttachment[];
  instance: InstanceConfig;
  discordToken: string;
  runtime: RouterRuntime;
  agentTimeoutMs: number;
  /** Handler for `⁘` control commands emitted by the agent. */
  runCommand?: RunAgentCommand;
  /**
   * Mark this as a system-injected turn (not the human speaking). The assembled
   * message is wrapped in a `<system-reminder>` block so the transcript
   * classifier attributes it as `system` rather than `user`. Used by the
   * onboarding kick, which has no real user message behind it.
   */
  systemTurn?: boolean;
}): Promise<boolean> {
  const { authorId, channelId, attachments, instance, discordToken, runtime, agentTimeoutMs } =
    params;
  let messageContent = params.messageContent;

  try {
    runtime.log(
      `[router] routing message from ${authorId} in channel ${channelId}: ${messageContent.slice(0, 80)}`,
    );

    // Typing indicator
    const typingInterval = setInterval(() => {
      void discordTyping(discordToken, channelId);
    }, TYPING_INTERVAL_MS);
    void discordTyping(discordToken, channelId);

    try {
      // Process attachments: transcribe audio locally, pass images to gateway
      const WHISPER_URL = resolveWhisperUrl();
      let gatewayAttachments: Array<{
        type: string;
        mimeType: string;
        fileName: string;
        content: string;
      }> = [];
      if (attachments && attachments.length > 0) {
        const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB
        for (const att of attachments) {
          if (att.size > MAX_ATTACHMENT_BYTES) {
            runtime.log(`[router] skipping large attachment ${att.filename} (${att.size} bytes)`);
            continue;
          }
          try {
            const resp = await fetch(att.url);
            if (!resp.ok) {
              continue;
            }
            const buf = Buffer.from(await resp.arrayBuffer());
            const mime = att.content_type ?? "application/octet-stream";

            if (mime.startsWith("audio/")) {
              // Transcribe audio locally via whisper server
              runtime.log(
                `[router] transcribing ${att.filename} (${mime}, ${buf.length} bytes)...`,
              );
              try {
                const form = new FormData();
                form.append("file", new Blob([buf], { type: mime }), att.filename);
                form.append("response_format", "json");
                form.append("temperature", "0.0");
                const whisperResp = await fetch(WHISPER_URL, {
                  method: "POST",
                  body: form,
                });
                if (whisperResp.ok) {
                  const result = (await whisperResp.json()) as { text?: string };
                  const transcript = result.text?.trim();
                  if (transcript) {
                    runtime.log(`[router] transcribed: ${transcript.slice(0, 80)}`);
                    // Prepend transcript to message content
                    messageContent = messageContent
                      ? `${messageContent}\n\n[Voice message transcript]: ${transcript}`
                      : `[Voice message transcript]: ${transcript}`;
                  } else {
                    runtime.log(`[router] transcription returned empty text`);
                  }
                } else {
                  runtime.error(
                    `[router] whisper failed (${whisperResp.status}): ${await whisperResp.text().catch(() => "")}`,
                  );
                }
              } catch (whisperErr) {
                runtime.error(`[router] whisper error: ${String(whisperErr)}`);
              }
            } else if (mime.startsWith("image/")) {
              // Pass images to gateway as attachments
              gatewayAttachments.push({
                type: "image",
                mimeType: mime,
                fileName: att.filename,
                content: buf.toString("base64"),
              });
              runtime.log(
                `[router] downloaded image ${att.filename} (${mime}, ${buf.length} bytes)`,
              );
            } else {
              runtime.log(`[router] skipping unsupported attachment ${att.filename} (${mime})`);
            }
          } catch (dlErr) {
            runtime.error(
              `[router] failed to download attachment ${att.filename}: ${String(dlErr)}`,
            );
          }
        }
      }

      // Re-read token from disk so we never use a stale cached value
      const freshToken = refreshToken(instance);

      // Drive the agent, processing any `⁘` control commands it emits and
      // relaying their results back so it can continue. A depth cap prevents a
      // command/result loop from running forever.
      let agentMessage = messageContent || "<media>";

      // On a brand-new channel, steer the agent through its first-run checklist
      // by prepending BOOTSTRAP.md (as conversation content, to keep the system
      // prompt billing-safe). Only affects the first turn of this call; command
      // result relays below reuse agentMessage without it.
      const bootstrapDirective = readBootstrapDirective(instance);
      if (bootstrapDirective) {
        agentMessage = `${bootstrapDirective}\n\n${agentMessage}`;
      }

      // A system-injected turn (onboarding kick) carries no human message, so
      // wrap the whole thing in a system-reminder block: the model treats it as
      // system context and the transcript classifier attributes it as `system`
      // instead of persisting a fake `user` turn.
      if (params.systemTurn) {
        agentMessage = wrapSystemReminder(agentMessage);
      }
      let attachmentsForCall = gatewayAttachments;
      let commandDepth = 0;
      const MAX_COMMAND_ROUNDTRIPS = 5;
      let deliveredAnything = false;
      let handled = false;

      while (true) {
        const idempotencyKey = randomUUID();
        const result = await callGatewaySimple({
          url: `ws://127.0.0.1:${instance.port}`,
          token: freshToken || undefined,
          method: "agent",
          params: {
            message: agentMessage,
            channel: "discord",
            deliver: false,
            idempotencyKey,
            sessionKey: `agent:main:discord:default:channel:${channelId}`,
            timeout: Math.floor(agentTimeoutMs / 1000),
            ...(attachmentsForCall.length > 0 ? { attachments: attachmentsForCall } : {}),
          },
          expectFinal: true,
          timeoutMs: agentTimeoutMs + 30_000,
        });
        attachmentsForCall = []; // attachments belong to the first turn only

        const payloads = result?.result?.payloads ?? [];
        if (payloads.length === 0) {
          // A `deliver:false` run returns zero payloads in two very different cases.
          // The silent-reply token (`⁘ return`, the router's host-side no-op) is
          // stripped pre-router, so the agent flags it via `meta.silent`: that means
          // the model deliberately chose to stay silent, and we post nothing. Any
          // other empty result (no text, a suppressed recoverable tool error, etc.)
          // is a genuine non-response and still gets the retry fallback so the user
          // is not left hanging.
          const silent = Boolean(result?.result?.meta?.silent);
          if (!handled) {
            if (silent) {
              runtime.log(`[router] silent (no-op) response for channel ${channelId}`);
            } else {
              runtime.log(`[router] empty response for channel ${channelId}`);
              await discordSend(
                discordToken,
                channelId,
                "*I processed your message but wasn't able to generate a response. Please try again.*",
              );
            }
          }
          break;
        }

        let commandResult: string | null = null;
        let ranCommand = false;
        // Whether this specific turn already delivered user-visible text/media.
        // Used to decide if an internal command result warrants a follow-up
        // turn (see the relay gate below).
        let deliveredThisTurn = false;

        for (const payload of payloads) {
          const raw = payload.text ?? "";

          // Control command? Never rendered to Discord; run it and capture a
          // result to relay back to the agent. Error payloads are data, not
          // commands: a provider error returned verbatim could look like a `⁘`
          // command, so never run it — fall through to the error-embed branch.
          const cmd = params.runCommand && !payload.isError ? parseAgentCommand(raw) : null;
          if (cmd) {
            ranCommand = true;
            handled = true;
            try {
              const res = await params.runCommand!(cmd, { channelId, instance, authorId });
              if (res !== null) {
                commandResult = res;
              }
            } catch (cmdErr) {
              commandResult = `error running ${cmd.command}: ${String(cmdErr)}`;
              runtime.error(`[router] command ${cmd.command} failed: ${String(cmdErr)}`);
            }
            continue;
          }

          // Normal message: unescape a leading `\⁘`, then format and send.
          let text = unescapeAgentText(raw).trim();
          // Agent-runtime error replies (model/API failures formatted by
          // errors.ts) arrive flagged as errors; render them as a Log embed
          // rather than the plain italic text the formatter produced. This runs
          // before the leaked-error filter so a flagged error is never silently
          // dropped just because its text resembles a raw leaked error.
          if (text && payload.isError) {
            const log = buildLogEmbed(stripSurroundingItalics(text));
            let embedSent = false;
            try {
              const sent = await sendEmbedMessage(discordToken, channelId, {
                embeds: [log.embed],
                attachments: log.attachments,
              });
              embedSent = sent.ok;
              if (!sent.ok) {
                runtime.error(`[router] error log embed failed (${sent.status}); sending as text`);
              }
            } catch (err) {
              // A rejected send (e.g. fetch failure) must still reach the
              // plain-text fallback below rather than the outer error handler.
              runtime.error(`[router] error log embed threw (${String(err)}); sending as text`);
            }
            if (embedSent) {
              deliveredAnything = true;
              deliveredThisTurn = true;
              handled = true;
              continue;
            }
            // Embed send failed: fall through to the plain-text path below so the
            // user still gets the error rather than nothing.
          }
          // Suppress raw leaked errors (unflagged tool/JS errors that escaped
          // into agent output). Flagged errors are excluded: one that fell
          // through here after a failed embed send must still reach the
          // plain-text fallback below rather than be silently dropped.
          if (!payload.isError && isLeakedError(text)) {
            runtime.log(`[router] suppressed leaked error: ${text.slice(0, 100)}`);
            continue;
          }
          if (text) {
            text = convertMarkdownTables(text, "code");
            text = stripHorizontalRules(text);
            text = convertTimesToDiscordTimestamps(text);
            text = stripDashes(text);
            for (const chunk of chunkText(text, 2000)) {
              await discordSend(discordToken, channelId, chunk);
            }
            deliveredAnything = true;
            deliveredThisTurn = true;
            handled = true;
          }
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          for (const url of mediaUrls) {
            await discordSend(discordToken, channelId, url);
            deliveredAnything = true;
            deliveredThisTurn = true;
            handled = true;
          }
        }

        runtime.log(`[router] processed ${payloads.length} payload(s) for channel ${channelId}`);

        // If a command produced a result, relay it back to the agent for a
        // follow-up turn (bounded by the depth cap) ONLY when this turn was
        // purely internal (no user-visible text/media). When the agent both
        // ran a command and spoke to the user in the same turn, the turn is
        // already complete: relaying the internal command result would spawn a
        // second user-visible reply (e.g. "Great to meet you" followed by "Got
        // it, what can I help you with"). Internal-only command turns (ticking
        // the checklist, saving a name, `return` no-ops) still relay so the
        // agent can continue.
        if (
          shouldRelayCommandResult({
            ranCommand,
            commandResult,
            deliveredThisTurn,
            commandDepth,
            maxRoundtrips: MAX_COMMAND_ROUNDTRIPS,
          })
        ) {
          commandDepth += 1;
          agentMessage = `[system] Command result: ${commandResult}`;
          // Keep command-result relays system-attributed for a system turn (e.g.
          // the onboarding kick relays the `send_hook_embed welcome` result).
          // Without this only the first call is wrapped, so the relay persists as
          // a fake `user` turn even though this flow has no human message.
          if (params.systemTurn) {
            agentMessage = wrapSystemReminder(agentMessage);
          }
          continue;
        }
        break;
      }

      return handled || deliveredAnything;
    } finally {
      clearInterval(typingInterval);
    }
  } catch (err) {
    const errMsg = String(err);
    runtime.error(`[router] error for channel ${channelId}: ${errMsg}`);

    const sendLog = (text: string): Promise<void> => {
      const log = buildLogEmbed(text);
      return sendEmbedMessage(discordToken, channelId, {
        embeds: [log.embed],
        attachments: log.attachments,
      })
        .then(() => {})
        .catch(() => {});
    };

    const kind = classifyRouterError(errMsg);
    if (kind === "connection-refused") {
      await sendLog("Your agent is not running. Please contact the admin to start your instance.");
    } else if (kind === "auth") {
      // Auth/config failure is an admin problem the user cannot fix by retrying,
      // so don't echo a misleading "try again" — just log for the admin.
      runtime.error(
        `[router] auth/config error for channel ${channelId}, needs admin attention (re-auth or restart)`,
      );
    } else if (kind === "timeout") {
      await sendLog("Your agent is taking too long to respond. Please try again later.");
    } else {
      await sendLog("Something went wrong processing your message. Please try again.");
    }
    return false;
  }
}

/**
 * Handle text-based slash commands (fallback for when Discord slash commands
 * haven't propagated yet). Returns true if the command was handled.
 */
export async function handleTextCommand(params: {
  cmdName: string;
  cmdArg: string | undefined;
  userId: string;
  channelId: string;
  messageId: string;
  instance: InstanceConfig;
  discordToken: string;
  runtime: RouterRuntime;
}): Promise<boolean> {
  const { cmdName, cmdArg, userId, channelId, messageId, instance, discordToken, runtime } = params;

  switch (cmdName) {
    case "lifecycle": {
      const current = instance.preferences.lifecycleMessages ?? false;
      const result = resolveLifecycleCommand(current, cmdArg);
      if (result.newValue !== undefined) {
        setUserPreference(instance, "lifecycleMessages", result.newValue);
      }
      const built = buildCommandResultEmbed(result.description, result.state);
      const sent = await sendEmbedMessage(discordToken, channelId, {
        embeds: [built.embed],
        attachments: built.attachments,
        messageReference: {
          message_id: messageId,
          channel_id: channelId,
          fail_if_not_exists: false,
        },
      });
      if (!sent.ok) {
        runtime.error(`[router] lifecycle command result failed (${sent.status})`);
      }
      runtime.log(`[router] text command /lifecycle for ${userId}: arg=${cmdArg ?? "status"}`);
      return true;
    }
    default:
      return false;
  }
}
