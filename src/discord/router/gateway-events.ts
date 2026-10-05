import type { ChannelQueue } from "./channel-queue.js";
import type { InstanceConfig } from "./config.js";
import type { RouterRuntime } from "./types.js";
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
  CONNECTIONS_COMMAND_NAMES,
  type ConnectCommandDeps,
  connectTextCommandHasToken,
  handleConnectCommand,
  parseConnectTextCommand,
} from "./connect-commands.js";
import {
  DISCORD_API,
  discordDeleteMessage,
  discordSendEphemeral,
  discordSendReply,
  editInteractionEmbedReply,
} from "./discord-api.js";
import { buildCommandResultEmbed } from "./embed-categories.js";
import { resolveLifecycleCommand } from "./lifecycle-command.js";
import { buildLogEmbed } from "./log-embed.js";
import { handleTextCommand, isKnownTextCommand } from "./route-message.js";
import { isConversationalBot } from "./router-filters.js";
import { isAuthorizedForChannel } from "./router.js";
import {
  SECRET_MODAL_CUSTOM_ID,
  buildSecretModal,
  parseSecretModalSubmit,
  sanitizeSecretName,
  secretReminderMessage,
} from "./secret-command.js";
import { buildUnauthorizedNoticeText, replyUnauthorizedEphemeral } from "./unauthorized-notice.js";

/**
 * The closed-over router state a gateway DISPATCH handler needs. Assembled once
 * in {@link startRouter} and passed to every handler, so the socket lifecycle
 * (connect/reconnect/heartbeat) stays in router.ts while the event bodies live
 * here. Module-level helpers the handlers call (handleChannelCommand,
 * discordSend*, isConversationalBot, isAuthorizedForChannel) are imports, not
 * members — only per-instance/per-process state and wired closures belong here.
 */
export type GatewayContext = {
  discordToken: string;
  applicationId: string;
  runtime: RouterRuntime;
  instances: Map<string, InstanceConfig>;
  /** Per-channel queue that debounces, coalesces, and serializes inbound turns. */
  channelQueue: ChannelQueue;
  /** Best-effort channel -> guild map, learned from message/interaction events. */
  channelGuild: Map<string, string>;
  /** Trusted bot id (OPENCLAW_MOCK_USER_BOT_ID) that may converse. */
  allowedBotIds: Set<string>;
  /**
   * Test-only (OPENCLAW_ROUTER_OWNER_GATED_BOT_IDS): bot ids subjected to the
   * human channel-owner access gate instead of bypassing it, so an E2E driver
   * bot can exercise the unauthorized-access denial. Empty by default.
   */
  ownerGatedBotIds: Set<string>;
  /**
   * Whether to tell a non-owner why their message in a registered channel was
   * ignored (OPENCLAW_ROUTER_UNAUTHORIZED_NOTICE, default true). False => deny
   * silently.
   */
  unauthorizedNoticeEnabled: boolean;
  describeInstance: (channelId: string) => InstanceStatus | null;
  channelCommandDeps: ChannelCommandDeps;
  connectCommandDeps: ConnectCommandDeps;
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
  /** The interaction's channel object; `type` 1 = DM, 3 = group DM. */
  channel?: { type?: number };
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

/** INTERACTION_CREATE (type 5, modal submit) dispatch payload fields. */
type ModalSubmitData = {
  id: string;
  token: string;
  channel_id?: string;
  guild_id?: string;
  /** The interaction's channel object; `type` 1 = DM, 3 = group DM. */
  channel?: { type?: number };
  data?: {
    custom_id?: string;
    components?: Array<{ components?: Array<{ custom_id?: string; value?: string }> }>;
  };
  member?: { user?: { id?: string } };
  user?: { id?: string };
};

/** Discord channel type for a 1:1 DM. */
const DM_CHANNEL_TYPE = 1;

/** Discord channel type for a multi-participant group DM (no owner to gate on). */
const GROUP_DM_CHANNEL_TYPE = 3;

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
    runtime,
    instances,
    channelQueue,
    channelGuild,
    allowedBotIds,
    ownerGatedBotIds,
    unauthorizedNoticeEnabled,
    describeInstance,
    channelCommandDeps,
    connectCommandDeps,
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

  // `/connect` management commands, handled before the bot filter (so a tester
  // bot can drive them) but gated on registration inside the handler. When the
  // command carried a pasted token, scrub the originating message so the secret
  // does not linger in channel history.
  const connectCmd = authorId ? parseConnectTextCommand(content) : null;
  if (connectCmd && authorId) {
    const commandMessageId = d.id;
    const hasToken = connectTextCommandHasToken(connectCmd);
    void handleConnectCommand(
      {
        subcommand: connectCmd.subcommand,
        args: connectCmd.args,
        channelId,
        userId: authorId,
        isDM: !guildId,
        reply: (payload, opts) =>
          opts?.ephemeral && typeof payload === "string"
            ? discordSendEphemeral(discordToken, channelId, payload)
            : discordSendReply(discordToken, channelId, commandMessageId, payload),
        ...(hasToken
          ? {
              scrubCommandMessage: () =>
                discordDeleteMessage(discordToken, channelId, commandMessageId),
            }
          : {}),
      },
      connectCommandDeps,
    );
    runtime.log(
      `[router] /connect ${connectCmd.subcommand ?? ""} from ${authorId} in ${channelId} (msg ${commandMessageId}, token=${hasToken})`,
    );
    return;
  }

  // Normal agent messages: ignore untrusted bots and empty messages.
  // Channel commands were already handled above so bots can still drive
  // them. A trusted bot (OPENCLAW_MOCK_USER_BOT_ID) may converse, but
  // never the router's own bot (self-routing would loop).
  const botAllowed = isBot ? isConversationalBot(authorId, applicationId, allowedBotIds) : false;
  // Test-only: a bot listed in OPENCLAW_ROUTER_OWNER_GATED_BOT_IDS is treated like
  // a human for access control, so it must pass the bot filter here (rather than
  // being dropped as an untrusted bot) and then face the ownership gate below.
  // Exclude the router's own id (as isConversationalBot does): Discord echoes our
  // replies back as MESSAGE_CREATE, so gating self would let a denial reply loop.
  const ownerGatedBot =
    isBot && !!authorId && authorId !== applicationId && ownerGatedBotIds.has(authorId);
  if (
    !authorId ||
    (isBot && !botAllowed && !ownerGatedBot) ||
    (!content.trim() && !hasAttachments)
  ) {
    // Silent drops here looked like hangs during a real incident: a driver
    // bot's messages to a registered channel got no reply and no log line
    // explained why. Surface the reason, but only for registered channels
    // (unregistered channels are a routine, high-volume case and get their
    // own handling below). Skip the router's own messages: Discord echoes the
    // bot's replies as MESSAGE_CREATE and `isConversationalBot` rejects
    // `authorId === applicationId`, so logging them would spam a bogus
    // "untrusted bot" drop for every normal response. Match the
    // `[router] ...` drop/skip log style.
    if (channelId && authorId !== applicationId && instances.get(channelId)) {
      const reason = !authorId
        ? "missing author id"
        : isBot && !botAllowed
          ? "untrusted bot"
          : "empty message";
      runtime.log(
        `[router] dropped message from ${authorId ?? "unknown"} in channel ${channelId} (${reason})`,
      );
    }
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
    const cmdName = commandMatch?.[1].toLowerCase();
    // Only a recognized text command goes down the async host-side path. An
    // unrecognized `/word` is just a normal message and must enqueue
    // synchronously, in arrival order: deciding that inside handleTextCommand's
    // `.then` would run a microtask later, so a message dispatched right after it
    // (which enqueues synchronously) could jump ahead and break FIFO.
    if (commandMatch && cmdName && isKnownTextCommand(cmdName)) {
      void handleTextCommand({
        cmdName,
        cmdArg: commandMatch[2]?.trim().toLowerCase(),
        userId: authorId,
        channelId,
        messageId: d.id,
        instance,
        discordToken,
        runtime,
      });
      return;
    }

    channelQueue.enqueue(channelId, {
      authorId,
      messageContent: content,
      attachments: rawAttachments,
    });
  };

  // Access control. DMs are inherently 1:1 with the owner, so they
  // pass through untouched (onboarding a brand-new user happens here).
  // In a shared guild channel, restrict human conversation to the channel
  // owner. Explicitly trusted automation bots remain allowed for E2E use.
  if (guildId && (!botAllowed || ownerGatedBot)) {
    // Read the instance once and reuse it for both the ownership decision and
    // the owner mention in the denial notice, so an unauthorized message does
    // not trigger a second `.onboarding.json` read on the hot path.
    const status = describeInstance(channelId);
    void isAuthorizedForChannel(channelId, authorId, {
      describeInstance: () => status,
    }).then((allowed) => {
      if (!allowed) {
        runtime.log(
          `[router] denied message from ${authorId} in channel ${channelId} (not the channel owner)`,
        );
        if (unauthorizedNoticeEnabled) {
          const embed = buildLogEmbed(buildUnauthorizedNoticeText(channelId, status?.ownerId));
          // A plain user message carries no interaction token, so a true
          // ephemeral reply is impossible. Post a persistent Log embed threaded
          // under the offending message instead. Suppress all mentions so the
          // owner/author are never pinged, even under repeated denials.
          void discordSendReply(
            discordToken,
            channelId,
            d.id,
            { embeds: [embed.embed], attachments: embed.attachments },
            { parse: [], replied_user: false },
          );
        }
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
  const {
    applicationId,
    runtime,
    instances,
    channelGuild,
    channelCommandDeps,
    connectCommandDeps,
    describeInstance,
  } = ctx;

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

  // Owner gate for the commands that act on a channel's agent (/lifecycle, /secret).
  // In a guild channel only the registered owner may proceed; anyone else gets the
  // standard unauthorized notice as an ephemeral reply, the same wording a plain
  // message earns. A 1:1 DM is inherently with its owner, so it passes untouched.
  // (/channel is exempt: it manages registration itself and has its own admin and
  // owner rules, and it must work on channels that have no owner yet.)
  const runForOwner = (channelId: string, proceed: () => void) => {
    // Fail closed: only an explicit 1:1 DM skips the gate. A group DM has several
    // participants and no guild id, and a payload without channel metadata is
    // never trusted to be a 1:1 DM.
    if (!d.guild_id && d.channel?.type === DM_CHANNEL_TYPE) {
      proceed();
      return;
    }
    const userId = d.member?.user?.id ?? d.user?.id ?? "";
    const status = describeInstance(channelId);
    void isAuthorizedForChannel(channelId, userId, { describeInstance: () => status }).then(
      (allowed) => {
        if (allowed) {
          proceed();
          return;
        }
        runtime.log(
          `[router] denied /${interactionData?.name} from ${userId} in channel ${channelId} (not the channel owner)`,
        );
        void replyUnauthorizedEphemeral({
          applicationId,
          interactionId,
          interactionToken,
          channelId,
          ownerId: status?.ownerId,
          runtime,
        });
      },
    );
  };

  // The /secret command opens a modal (popup) so the secret value is entered
  // privately and never appears in the channel. The submission arrives later as
  // a separate MODAL_SUBMIT interaction, handled by handleModalSubmit.
  if (interactionData?.name === "secret") {
    const openModal = () =>
      void fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: 9, data: buildSecretModal() }),
      })
        .then((resp) => {
          if (!resp.ok) {
            runtime.error(`[router] secret modal open failed (${resp.status})`);
          }
        })
        .catch((err) => runtime.error(`[router] secret modal open failed: ${String(err)}`));
    // An unregistered channel has no owner to gate on; the modal submit reports it.
    if (interactionChannelId && instances.get(interactionChannelId)) {
      runForOwner(interactionChannelId, openModal);
    } else {
      openModal();
    }
    return;
  }

  if (interactionData?.name === "lifecycle" && interactionChannelId) {
    const instance = instances.get(interactionChannelId);
    if (!instance) {
      respondToInteraction("*This channel is not registered.*");
      return;
    }

    runForOwner(interactionChannelId, () => {
      const current = instance.preferences.lifecycleMessages ?? false;
      const setting = (
        interactionData.options as Array<{ name: string; value: string }> | undefined
      )?.find((o: { name: string }) => o.name === "setting")?.value;

      const result = resolveLifecycleCommand(current, setting);
      if (result.newValue !== undefined) {
        setUserPreference(instance, "lifecycleMessages", result.newValue);
      }
      const built = buildCommandResultEmbed(result.description, result.state);
      // Defer ephemerally, then edit with the uploaded footer icon (the command
      // result embed needs the attachment-aware editor, like the /channel flow).
      // The edit must wait for the defer to land, or the @original PATCH can race
      // ahead of the response being created and fail.
      void (async () => {
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
            runtime.error(`[router] lifecycle defer failed (${deferResp.status})`);
            return;
          }
          const res = await editInteractionEmbedReply(applicationId, interactionToken, {
            embeds: [built.embed],
            attachments: built.attachments,
          });
          if (!res.ok) {
            runtime.error(`[router] lifecycle command result failed (${res.status})`);
          }
        } catch (err) {
          runtime.error(`[router] lifecycle command result failed: ${String(err)}`);
        }
      })();
      runtime.log(
        `[router] lifecycle for channel ${interactionChannelId}: setting=${setting ?? "status"} result=${result.state}`,
      );
    });
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

  if (
    interactionData?.name &&
    CONNECTIONS_COMMAND_NAMES.includes(interactionData.name) &&
    interactionChannelId
  ) {
    const subOpt = (
      interactionData.options as
        | Array<{
            name: string;
            options?: Array<{ name: string; value: string | number | boolean }>;
          }>
        | undefined
    )?.[0];
    // add/remove both carry `service`; add also carries an optional `token`.
    // Order matters: service first, token second (interpreted downstream).
    const args: string[] = [];
    const service = subOpt?.options?.find((o) => o.name === "service")?.value;
    if (service !== undefined) {
      args.push(String(service));
    }
    const token = subOpt?.options?.find((o) => o.name === "token")?.value;
    if (token !== undefined) {
      args.push(String(token));
    }
    const userId = d.member?.user?.id ?? d.user?.id;
    if (userId) {
      // Defer (ephemeral): add validates a token over the network and can exceed
      // Discord's ~3s window. Deliver the result by editing the deferred reply.
      void fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: 5, data: { flags: 64 } }),
      }).catch((err) => runtime.error(`[router] connect defer failed: ${String(err)}`));
      const editReply = (payload: ChannelReplyPayload) => {
        if (typeof payload === "string") {
          void fetch(
            `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: payload }),
            },
          ).catch((err) => runtime.error(`[router] connect followup failed: ${String(err)}`));
          return;
        }
        void editInteractionEmbedReply(applicationId, interactionToken, {
          embeds: payload.embeds,
          attachments: payload.attachments,
          components: payload.components ?? [],
        })
          .then((res) => {
            if (!res.ok) {
              runtime.error(`[router] connect followup failed (${res.status})`);
            }
          })
          .catch((err) => runtime.error(`[router] connect followup failed: ${String(err)}`));
      };
      // Slash option values are never posted as a visible message, so there is no
      // token to scrub (scrubCommandMessage is omitted).
      void handleConnectCommand(
        {
          subcommand: subOpt?.name ?? null,
          args,
          channelId: interactionChannelId,
          userId,
          isDM: !d.guild_id,
          reply: (payload) => editReply(payload),
        },
        connectCommandDeps,
      );
    }
  }
}

/**
 * Handle a modal submission (interaction type 5). Currently only the `/secret`
 * popup: parse the private value + optional name, then hand it to the channel's
 * agent out-of-band as its own buffered turn (never steered) whose
 * system-reminder points the agent at `/tmp/secrets/<name>`. The value never
 * touches the channel, a log line, or the turn's message text. Owner-gated in
 * guild channels, since it injects a turn into someone's agent.
 */
export function handleModalSubmit(ctx: GatewayContext, d: ModalSubmitData): void {
  const { applicationId, runtime, instances, channelQueue, channelGuild, describeInstance } = ctx;
  const interactionId = d.id;
  const interactionToken = d.token;
  const channelId = d.channel_id;
  if (d.channel_id && d.guild_id) {
    channelGuild.set(d.channel_id, d.guild_id);
  }

  const ack = (content: string) => {
    void fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: 4, data: { content, flags: 64 } }),
    }).catch((err) => runtime.error(`[router] secret ack failed: ${String(err)}`));
  };

  if (d.data?.custom_id !== SECRET_MODAL_CUSTOM_ID || !channelId) {
    return;
  }
  const { value, name: rawName } = parseSecretModalSubmit(d.data?.components);
  if (!value) {
    ack("No secret value was provided.");
    return;
  }
  if (!instances.get(channelId)) {
    ack("This channel is not registered, so there is no agent to receive a secret.");
    return;
  }
  const userId = d.member?.user?.id ?? d.user?.id;
  if (!userId) {
    return;
  }
  // A group DM has multiple participants but no guild_id to owner-gate on, so
  // the DM-is-1:1 assumption below would let any member hand the agent a secret.
  // The command spec already excludes group DMs (contexts [0, 1]); reject here
  // too as defense-in-depth in case a stale registration still dispatches one.
  if (!d.guild_id && d.channel?.type === GROUP_DM_CHANNEL_TYPE) {
    ack("The /secret command is not available in group DMs.");
    return;
  }
  const name = sanitizeSecretName(rawName, value);

  const deliver = () => {
    // Buffered (never steered) so the out-of-band secret reaches routeMessage
    // intact and its intent never leaks into a live run's transcript.
    channelQueue.enqueue(channelId, {
      authorId: userId,
      messageContent: secretReminderMessage(name),
      systemTurn: true,
      secret: { name, value },
    });
    ack(`Secret \`${name}\` received and handed to this channel's agent (temporary).`);
    runtime.log(`[router] secret "${name}" delivered to channel ${channelId}`);
  };

  // Owner-gate in guild channels (a DM is inherently 1:1 with the owner).
  if (d.guild_id) {
    const status = describeInstance(channelId);
    void isAuthorizedForChannel(channelId, userId, { describeInstance: () => status }).then(
      (allowed) => {
        if (!allowed) {
          runtime.log(
            `[router] denied /secret from ${userId} in channel ${channelId} (not the channel owner)`,
          );
          void replyUnauthorizedEphemeral({
            applicationId,
            interactionId,
            interactionToken,
            channelId,
            ownerId: status?.ownerId,
            runtime,
          });
          return;
        }
        deliver();
      },
    );
    return;
  }
  deliver();
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
