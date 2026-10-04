import type { InstanceConfig } from "./config.js";
import type { RouterRuntime, RunAgentCommand } from "./types.js";
import {
  type ChannelCommandDeps,
  type ChannelReplyPayload,
  type InstanceStatus,
  handleChannelCommand,
  handleUnregisterButtonClick,
  parseChannelTextCommand,
  parseUnregisterCustomId,
} from "./channel-commands.js";
import { setUserPreference } from "./config.js";
import {
  DISCORD_API,
  discordSendEphemeral,
  discordSendReply,
  editInteractionEmbedReply,
} from "./discord-api.js";
import { handleTextCommand, routeMessage } from "./route-message.js";
import { isConversationalBot } from "./router-filters.js";
import { isAuthorizedForChannel } from "./router.js";

/**
 * The closed-over router state a gateway DISPATCH handler needs. Assembled once
 * in {@link startRouter} and passed to every handler, so the socket lifecycle
 * (connect/reconnect/heartbeat) stays in router.ts while the event bodies live
 * here. Module-level helpers the handlers call (routeMessage, handleChannelCommand,
 * discordSend*, isConversationalBot, isAuthorizedForChannel) are imports, not
 * members — only per-instance/per-process state and wired closures belong here.
 */
export type GatewayContext = {
  discordToken: string;
  applicationId: string;
  agentTimeoutMs: number;
  runtime: RouterRuntime;
  instances: Map<string, InstanceConfig>;
  inflight: Set<string>;
  /** Best-effort channel -> guild map, learned from message/interaction events. */
  channelGuild: Map<string, string>;
  /** Trusted bot ids (OPENCLAW_ROUTER_ALLOW_BOT_IDS) that may converse. */
  allowedBotIds: Set<string>;
  describeInstance: (channelId: string) => InstanceStatus | null;
  channelCommandDeps: ChannelCommandDeps;
  runAgentCommand: RunAgentCommand;
  /** Tear an instance down through the same provisioning path as unregister. */
  cleanupDeletedChannel: (channelId: string, reason: string) => void;
};

/** MESSAGE_CREATE dispatch payload fields the handler reads. */
type MessageCreateData = {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  author?: { id?: string; bot?: boolean };
  referenced_message?: { author?: { username?: string }; content?: string };
  attachments?: Array<{
    id: string;
    filename: string;
    content_type?: string;
    url: string;
    size: number;
  }>;
};

/** INTERACTION_CREATE (type 2, slash command) dispatch payload fields. */
type SlashInteractionData = {
  id: string;
  channel_id: string;
  token: string;
  guild_id?: string;
  data?: { name?: string; options?: unknown };
  member?: { user?: { id?: string } };
  user?: { id?: string };
};

/** INTERACTION_CREATE (type 3, message component) dispatch payload fields. */
type ComponentInteractionData = {
  id: string;
  token: string;
  channel_id?: string;
  guild_id?: string;
  data?: { custom_id?: string };
  member?: { user?: { id?: string } };
  user?: { id?: string };
};

/** CHANNEL_DELETE / THREAD_DELETE dispatch payload fields. */
type ChannelDeleteData = { id?: string };

/** GUILD_DELETE dispatch payload fields. */
type GuildDeleteData = { id?: string };

/**
 * Forward a user (or trusted bot) message to its channel's agent. Handles the
 * `/channel` management commands first (so they work before registration and
 * for bots), then the bot/empty filter, the registered-instance gate, text
 * commands, and shared-guild access control.
 */
export function handleMessageCreate(ctx: GatewayContext, d: MessageCreateData): void {
  const {
    discordToken,
    applicationId,
    agentTimeoutMs,
    runtime,
    instances,
    inflight,
    channelGuild,
    allowedBotIds,
    describeInstance,
    channelCommandDeps,
    runAgentCommand,
  } = ctx;

  const authorId = d.author?.id;
  const isBot = d.author?.bot === true;
  const guildId = d.guild_id;
  let content = d.content ?? "";
  const channelId = d.channel_id;

  // Learn the channel's guild so GUILD_DELETE can tear down its
  // instances (see channelGuild above).
  if (channelId && guildId) {
    channelGuild.set(channelId, guildId);
  }

  // Collect attachments (voice messages, images, files)
  const rawAttachments = d.attachments ?? [];
  const hasAttachments = rawAttachments.length > 0;

  // Include reply context so the agent knows what message is being responded to
  const ref = d.referenced_message;
  if (ref && typeof ref === "object") {
    const refAuthor = ref.author?.username ?? "unknown";
    const refContent = (ref.content ?? "").slice(0, 500);
    if (refContent) {
      content = `[Replying to ${refAuthor}: "${refContent}"]\n${content}`;
    }
  }

  runtime.log(
    `[router] MESSAGE_CREATE: author=${authorId} guild=${guildId ?? "dm"} reply=${!!ref} attachments=${rawAttachments.length} content=${content.slice(0, 60)}`,
  );

  // `/channel` management commands must work even when the channel is
  // not registered yet (register is the whole point) AND even when the
  // author is a bot (e.g. an automated tester bot, which cannot invoke
  // slash commands), so handle them before both the bot filter and the
  // registered-instance gate below. register/unregister stay
  // whitelist-gated inside handleChannelCommand: authorization is the
  // configured auth-guild role, applied uniformly to bots and humans.
  // A bot can therefore provision only if it has been granted that
  // role (the intended setup for a trusted tester/automation bot);
  // untrusted bots without the role are rejected exactly like
  // untrusted humans. status stays open to everyone.
  const channelCmd = authorId ? parseChannelTextCommand(content) : null;
  if (channelCmd && authorId) {
    const commandMessageId = d.id;
    void handleChannelCommand(
      {
        subcommand: channelCmd.subcommand,
        args: channelCmd.args,
        channelId,
        userId: authorId,
        isDM: !guildId,
        // Bots cannot send true ephemeral messages outside an
        // interaction. Reply as a real Discord reply (referencing the
        // command message) so status/denials thread under the command
        // and embeds render. Ephemeral hints still fall back to an
        // auto-deleting plain message (only strings can auto-delete
        // cleanly; embeds are always full replies).
        reply: (payload, opts) =>
          opts?.ephemeral && typeof payload === "string"
            ? discordSendEphemeral(discordToken, channelId, payload)
            : discordSendReply(discordToken, channelId, commandMessageId, payload),
      },
      channelCommandDeps,
    );
    runtime.log(
      `[router] /channel ${channelCmd.subcommand ?? ""} from ${authorId} in ${channelId} (msg ${commandMessageId})`,
    );
    return;
  }

  // Normal agent messages: ignore untrusted bots and empty messages.
  // Channel commands were already handled above so bots can still drive
  // them. Trusted bots (OPENCLAW_ROUTER_ALLOW_BOT_IDS) may converse, but
  // never the router's own bot (self-routing would loop).
  const botAllowed = isBot ? isConversationalBot(authorId, applicationId, allowedBotIds) : false;
  if (!authorId || (isBot && !botAllowed) || (!content.trim() && !hasAttachments)) {
    return;
  }

  const instance = instances.get(channelId);
  if (!instance) {
    // Only respond in DMs (no guild_id), silently ignore unregistered guild channels
    if (!guildId) {
      void discordSendEphemeral(discordToken, channelId, "*This channel is not registered.*");
    }
    return;
  }

  // Route the message to the instance (text-command fallback first,
  // then the agent). Onboarding (including offering Google) is driven
  // by the agent's BOOTSTRAP.md checklist and the `⁘` command channel,
  // not by a router-side state machine.
  const routeInstanceMessage = (): void => {
    const commandMatch = content.trim().match(/^\/\/?(\w+)(?:\s+(.*))?$/);
    if (commandMatch) {
      const cmdName = commandMatch[1].toLowerCase();
      const cmdArg = commandMatch[2]?.trim().toLowerCase();
      const messageId = d.id;
      void handleTextCommand({
        cmdName,
        cmdArg,
        userId: authorId,
        channelId,
        messageId,
        instance,
        discordToken,
        runtime,
      }).then((handled) => {
        if (!handled) {
          void routeMessage({
            authorId,
            channelId,
            messageContent: content,
            attachments: rawAttachments,
            instance,
            discordToken,
            runtime,
            agentTimeoutMs,
            inflight,
            runCommand: runAgentCommand,
          });
        }
      });
      return;
    }

    void routeMessage({
      authorId,
      channelId,
      messageContent: content,
      attachments: rawAttachments,
      instance,
      discordToken,
      runtime,
      agentTimeoutMs,
      inflight,
      runCommand: runAgentCommand,
    });
  };

  // Access control. DMs are inherently 1:1 with the owner, so they
  // pass through untouched (onboarding a brand-new user happens here).
  // In a shared guild channel, restrict human conversation to the channel
  // owner. Explicitly trusted automation bots remain allowed for E2E use.
  if (guildId && !botAllowed) {
    void isAuthorizedForChannel(channelId, authorId, {
      describeInstance,
    }).then((allowed) => {
      if (!allowed) {
        runtime.log(
          `[router] denied message from ${authorId} in channel ${channelId} (not the channel owner)`,
        );
        void discordSendEphemeral(
          discordToken,
          channelId,
          "*You are not authorized to use this channel's agent.*",
        );
        return;
      }
      routeInstanceMessage();
    });
    return;
  }

  routeInstanceMessage();
}

/**
 * Handle a slash-command interaction (`/lifecycle`, `/channel`). Responds
 * ephemerally; `/channel` defers first because register can exceed Discord's
 * ~3s window, then edits the deferred reply with the result.
 */
export function handleSlashInteraction(ctx: GatewayContext, d: SlashInteractionData): void {
  const { applicationId, runtime, instances, channelGuild, channelCommandDeps } = ctx;

  const interactionData = d.data;
  const interactionChannelId = d.channel_id;
  const interactionToken = d.token;
  const interactionId = d.id;

  // Learn the channel's guild from interactions too (e.g. a channel
  // registered via `/channel register` before any message is sent), so
  // GUILD_DELETE can still tear its instance down (see channelGuild).
  if (interactionChannelId && d.guild_id) {
    channelGuild.set(interactionChannelId, d.guild_id);
  }

  // Helper to respond to interactions (always ephemeral). Accepts a
  // plain string (content) or an embeds payload from a channel
  // command; either way keeps the ephemeral flag (64).
  const respondToInteraction = (payload: ChannelReplyPayload) => {
    const data =
      typeof payload === "string"
        ? { content: payload, flags: 64 }
        : {
            embeds: payload.embeds,
            ...(payload.components ? { components: payload.components } : {}),
            flags: 64,
          };
    void fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: 4,
        data,
      }),
    })
      .then((resp) => {
        if (!resp.ok) {
          runtime.error(`[router] interaction response failed (${resp.status})`);
        }
      })
      .catch((err) => runtime.error(`[router] interaction response failed: ${String(err)}`));
  };

  if (interactionData?.name === "lifecycle" && interactionChannelId) {
    const instance = instances.get(interactionChannelId);
    if (!instance) {
      respondToInteraction("*This channel is not registered.*");
      return;
    }

    const current = instance.preferences.lifecycleMessages ?? false;
    const setting = (
      interactionData.options as Array<{ name: string; value: string }> | undefined
    )?.find((o: { name: string }) => o.name === "setting")?.value;

    let statusText: string;
    if (setting === "on") {
      setUserPreference(instance, "lifecycleMessages", true);
      statusText =
        "Lifecycle messages **enabled**. You'll see *Back online.* and *Shutting down...* messages.";
    } else if (setting === "off") {
      setUserPreference(instance, "lifecycleMessages", false);
      statusText = "Lifecycle messages **disabled**. You won't see startup/shutdown notifications.";
    } else {
      statusText = current
        ? "Lifecycle messages are currently **enabled**. Use `/lifecycle off` to disable."
        : "Lifecycle messages are currently **disabled**. Use `/lifecycle on` to enable.";
    }

    respondToInteraction(statusText);
    runtime.log(
      `[router] lifecycle for channel ${interactionChannelId}: setting=${setting ?? "status"} result=${setting === "on" ? "true" : setting === "off" ? "false" : String(current)}`,
    );
  }

  if (interactionData?.name === "channel" && interactionChannelId) {
    // Subcommand + its options (e.g. unregister confirm) live one level
    // down in the interaction options tree.
    const subOpt = (
      interactionData.options as
        | Array<{
            name: string;
            options?: Array<{ name: string; value: string | number | boolean }>;
          }>
        | undefined
    )?.[0];
    // A subcommand carries at most one relevant option: register's
    // optional `owner` (a user id) or unregister's optional `confirm`.
    // Either becomes args[0], interpreted per subcommand downstream.
    const args: string[] = [];
    const owner = subOpt?.options?.find((o) => o.name === "owner")?.value;
    if (owner !== undefined) {
      args.push(String(owner));
    }
    const confirm = subOpt?.options?.find((o) => o.name === "confirm")?.value;
    if (confirm !== undefined) {
      args.push(String(confirm));
    }
    const userId = d.member?.user?.id ?? d.user?.id;
    if (userId) {
      // Acknowledge immediately with a deferred (ephemeral) response:
      // register can take up to the daemon's command timeout plus
      // readiness polling, well beyond Discord's ~3s window. The
      // result is then delivered by editing the deferred reply.
      void fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: 5, data: { flags: 64 } }),
      }).catch((err) => runtime.error(`[router] channel defer failed: ${String(err)}`));
      const editReply = (payload: ChannelReplyPayload) => {
        // Embed replies upload their category icons (attachment://), so route
        // them through the attachment-aware editor; strings stay plain content.
        if (typeof payload !== "string") {
          void editInteractionEmbedReply(applicationId, interactionToken, {
            embeds: payload.embeds,
            attachments: payload.attachments,
            // Always send components so an updated reply can also clear a
            // previous action row (e.g. the confirm button).
            components: payload.components ?? [],
          })
            .then((res) => {
              if (!res.ok) {
                runtime.error(`[router] channel followup failed (${res.status})`);
              }
            })
            .catch((err) => runtime.error(`[router] channel followup failed: ${String(err)}`));
          return;
        }
        void fetch(
          `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: payload }),
          },
        )
          .then((resp) => {
            if (!resp.ok) {
              runtime.error(`[router] channel followup failed (${resp.status})`);
            }
          })
          .catch((err) => runtime.error(`[router] channel followup failed: ${String(err)}`));
      };
      void handleChannelCommand(
        {
          subcommand: subOpt?.name ?? null,
          args,
          channelId: interactionChannelId,
          userId,
          isDM: !d.guild_id,
          reply: (payload) => editReply(payload),
        },
        channelCommandDeps,
      );
    }
  }
}

/**
 * Handle a message-component interaction (buttons). Currently only the
 * `/channel unregister` confirmation buttons.
 */
export function handleComponentInteraction(ctx: GatewayContext, d: ComponentInteractionData): void {
  const { applicationId, runtime, channelGuild, channelCommandDeps } = ctx;

  const customId = d.data?.custom_id;
  const parsed = customId ? parseUnregisterCustomId(customId) : null;
  const clickerId = d.member?.user?.id ?? d.user?.id;
  const interactionId = d.id;
  const interactionToken = d.token;
  if (d.channel_id && d.guild_id) {
    channelGuild.set(d.channel_id, d.guild_id);
  }

  if (parsed && clickerId && customId) {
    if (parsed.initiatorId !== clickerId) {
      // Someone other than the initiator clicked: reply ephemerally
      // and leave the original confirmation message untouched.
      void fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: 4,
          data: { content: "This confirmation isn't for you.", flags: 64 },
        }),
      }).catch((err) => runtime.error(`[router] button response failed: ${String(err)}`));
    } else {
      // Defer the message update (type 6) so a slow unregister does
      // not blow Discord's ~3s response window, then edit the original
      // confirmation message with the result and drop the buttons.
      void fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: 6 }),
      }).catch((err) => runtime.error(`[router] button defer failed: ${String(err)}`));
      void handleUnregisterButtonClick({ customId, clickerId }, channelCommandDeps).then(
        (result) => {
          if (!result.update) {
            return;
          }
          // Upload the footer icon (reusing the CDN cache the confirmation send
          // warmed) and drop the buttons.
          void editInteractionEmbedReply(applicationId, interactionToken, {
            embeds: result.update.embeds,
            attachments: result.update.attachments,
            components: result.update.components,
          })
            .then((res) => {
              if (!res.ok) {
                runtime.error(`[router] button followup failed (${res.status})`);
              }
            })
            .catch((err) => runtime.error(`[router] button followup failed: ${String(err)}`));
        },
      );
    }
  }
}

/**
 * A guild channel (or thread) was deleted. If it had a registered instance,
 * tear it down so we don't keep a dead route around. `eventType` is the
 * originating dispatch name (CHANNEL_DELETE / THREAD_DELETE) used as the reason.
 */
export function handleChannelDelete(
  ctx: GatewayContext,
  d: ChannelDeleteData,
  eventType: string,
): void {
  const deletedChannelId = d.id;
  if (deletedChannelId) {
    // Drop the learned guild mapping so deleted channels don't
    // accumulate as stale entries on a long-lived router.
    ctx.channelGuild.delete(deletedChannelId);
    ctx.cleanupDeletedChannel(deletedChannelId, eventType.toLowerCase());
  }
}

/**
 * The bot was removed from a guild (or the guild was deleted). Tear down every
 * registered instance that lived in that guild. The transient-outage case
 * (GUILD_DELETE with `unavailable: true`) is filtered out by the dispatcher.
 */
export function handleGuildDelete(ctx: GatewayContext, d: GuildDeleteData): void {
  const deletedGuildId = d.id;
  if (deletedGuildId) {
    for (const [channelId, guildId] of ctx.channelGuild) {
      if (guildId === deletedGuildId) {
        ctx.channelGuild.delete(channelId);
        ctx.cleanupDeletedChannel(channelId, "guild_delete");
      }
    }
  }
}
