import type { ChannelQueue } from "./channel-queue.js";
import type { InstanceConfig } from "./config.js";
import type { NoticeDebouncer } from "./notice-debounce.js";
import type { RouterRuntime } from "./types.js";
import {
  type ChannelCommandDeps,
  type ChannelReplyPayload,
  type DiscordActionRow,
  type DiscordEmbed,
  type InstanceStatus,
  buildUnregisterAckUpdate,
  decideUnregisterClick,
  handleChannelCommand,
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
  DEBUG_COMMAND_SPEC,
  type DebugResult,
  debugSubcommandLabel,
  parseDebugTextCommand,
  runDebugCommand,
} from "./debug-command.js";
import { resolveEphemeralCommand } from "./debug-ephemeral.js";
import {
  DISCORD_API,
  discordDeleteMessage,
  discordSendEphemeral,
  discordSendReply,
  editInteractionContentReply,
  editInteractionEmbedReply,
} from "./discord-api.js";
import { type BuiltEmbed, buildCommandResultEmbed } from "./embed-categories.js";
import { resolveLifecycleCommand } from "./lifecycle-command.js";
import { buildLogEmbed } from "./log-embed.js";
import { readEphemeralCommands, setEphemeralCommands } from "./preferences-store.js";
import { handleTextCommand, isKnownTextCommand } from "./route-message.js";
import { isConversationalBot } from "./router-filters.js";
import { isAuthorizedForChannel } from "./router.js";
import {
  SECRET_MODAL_CUSTOM_ID,
  buildSecretModal,
  buildSecretNoticeEmbed,
  buildSecretReceivedEmbed,
  buildSecretTestReceivedEmbed,
  parseSecretModalSubmit,
  sanitizeSecretName,
  secretReminderMessage,
} from "./secret-command.js";
import {
  buildMissingPermissionText,
  buildPermissionDeniedEmbed,
  buildUnauthorizedNoticeText,
  denyInteractionEphemeral,
  replyUnauthorizedEphemeral,
} from "./unauthorized-notice.js";

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
  /** Root of the instances tree; used to read/write channel-keyed preferences. */
  instancesDir: string;
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
  /**
   * Coalesces the per-user "not authorized" notice so a non-owner spamming a
   * channel gets one immediate reply then at most one per window, not a reply per
   * message. Keyed by `channelId:userId`.
   */
  unauthorizedNoticeDebouncer: NoticeDebouncer;
  /**
   * Channels whose unregister is mid-flight from a confirm-button click, so a
   * second click (a race before the buttons are dropped) is ignored rather than
   * running teardown twice or surfacing a "not registered" message.
   */
  unregisterInFlight: Set<string>;
  describeInstance: (channelId: string) => InstanceStatus | null;
  /** True when the user holds the admin role (or override id). Gates `/debug`. */
  isAdmin: (userId: string) => Promise<boolean>;
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

/**
 * Upper bound for the unregister button's interaction-ack fetch. The in-flight
 * guard is claimed before this ack, so a stalled unbounded request would pin the
 * channel's guard indefinitely; this caps the wait so the guard is always released.
 * Comfortably above Discord's own ~3s interaction window.
 */
const BUTTON_ACK_TIMEOUT_MS = 10_000;

/** CHANNEL_DELETE / THREAD_DELETE dispatch payload fields. */
type ChannelDeleteData = { id?: string };

/** GUILD_DELETE dispatch payload fields. */
type GuildDeleteData = { id?: string };

/**
 * Deliver a `/debug secrettest` secret to the channel's agent, mirroring the
 * `/secret` modal path: enqueue a buffered system turn carrying the secret so the
 * box writes it to `/tmp/secrets/<name>` and the agent is pointed at it. Returns
 * the ack embed to render (ephemerally for slash, in-channel for text), or a
 * not-registered notice. The value arrived as plaintext, so the ack
 * (`buildSecretTestReceivedEmbed`) flags the test-only framing.
 */
function deliverDebugSecret(params: {
  instances: GatewayContext["instances"];
  channelQueue: GatewayContext["channelQueue"];
  runtime: GatewayContext["runtime"];
  channelId: string;
  authorId: string;
  name: string;
  value: string;
}): BuiltEmbed {
  const { instances, channelQueue, runtime, channelId, authorId, name, value } = params;
  if (!instances.get(channelId)) {
    return buildSecretNoticeEmbed(
      "Not Registered.",
      "This channel is not registered, so there is no agent to receive a secret.",
    );
  }
  // Buffered (never steered) so the out-of-band secret reaches routeMessage
  // intact, exactly like the /secret modal submission does. The reminder uses the
  // visible-in-channel framing because the value arrived as plaintext.
  channelQueue.enqueue(channelId, {
    authorId,
    messageContent: secretReminderMessage(name, true),
    systemTurn: true,
    secret: { name, value },
  });
  runtime.log(`[router] debug secrettest "${name}" delivered to channel ${channelId}`);
  return buildSecretTestReceivedEmbed(name);
}

/**
 * Apply a `/debug ephemeral` toggle for a channel and build its reply embed. A
 * bare status query renders a plain Log embed; an on/off toggle persists the new
 * value and renders a Command Result embed whose footer checkbox reflects it. A
 * failed write (e.g. a read-only mount) renders a Log embed reporting that the
 * change did not stick, matching /lifecycle, which surfaces the failure rather
 * than claiming a success the user would not see survive a restart. Shared by the
 * slash and text paths.
 *
 * Also returns `effectiveEphemeral`: the channel's ACTUAL ephemeral-commands
 * value after this call (the new value on a successful write, the unchanged
 * current value on a status query or a failed write). The slash path persists via
 * this helper BEFORE deferring and uses `effectiveEphemeral` for the defer flag,
 * so the reply's ephemerality always matches the stored setting even when the
 * write fails (otherwise a failed `ephemeral off` would still have deferred the
 * "did not stick" reply publicly while the channel stayed private).
 */
function applyDebugEphemeral(
  instancesDir: string,
  channelId: string,
  desired: boolean | null,
  runtime: GatewayContext["runtime"],
): { embed: BuiltEmbed; effectiveEphemeral: boolean } {
  const current = readEphemeralCommands(instancesDir, channelId);
  const outcome = resolveEphemeralCommand(current, desired);
  if (outcome.kind === "status") {
    return { embed: buildLogEmbed(outcome.description), effectiveEphemeral: current };
  }
  if (!setEphemeralCommands(instancesDir, channelId, outcome.newValue)) {
    runtime.error(`[router] failed to persist ephemeral preference for channel ${channelId}`);
    return {
      embed: buildLogEmbed(
        "Could not save the ephemeral command preference. Please try again. (The change did not stick.)",
      ),
      // The write did not stick, so the channel keeps its current value.
      effectiveEphemeral: current,
    };
  }
  runtime.log(`[router] /debug ephemeral for channel ${channelId}: ${outcome.state}`);
  return {
    embed: buildCommandResultEmbed(outcome.description, outcome.state),
    effectiveEphemeral: outcome.newValue,
  };
}

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
    instancesDir,
    instances,
    channelQueue,
    channelGuild,
    allowedBotIds,
    ownerGatedBotIds,
    unauthorizedNoticeEnabled,
    unauthorizedNoticeDebouncer,
    describeInstance,
    channelCommandDeps,
    connectCommandDeps,
    isAdmin,
  } = ctx;

  const authorId = d.author?.id;
  const isBot = d.author?.bot === true;
  const guildId = d.guild_id;
  const messageContent = d.content ?? "";
  let content = messageContent;
  const channelId = d.channel_id;

  // Discord echoes the router's own replies back as MESSAGE_CREATE. Drop them up
  // front, before the MESSAGE_CREATE log and the pre-bot text-command parsers:
  // otherwise an `echo`ed secret (e.g. `/debug echo <credential>`) would persist
  // in the fallback log, and command-looking output (e.g. `/debug echo "/debug
  // help"`) would be parsed and handled a second time. The bot filter below also
  // rejects self, but only after those steps, so guard here. External tester bots
  // are a different author id and still flow through normally.
  if (authorId && authorId === applicationId) {
    return;
  }

  // Learn the channel's guild so GUILD_DELETE can tear down its
  // instances (see channelGuild above).
  if (channelId && guildId) {
    channelGuild.set(channelId, guildId);
  }

  // Collect attachments (voice messages, images, files)
  const rawAttachments = d.attachments ?? [];
  const hasAttachments = rawAttachments.length > 0;

  // Include reply context so the agent knows what message is being responded to.
  const ref = d.referenced_message;
  if (ref && typeof ref === "object") {
    const refAuthor = ref.author?.username ?? "unknown";
    const rawRef = (ref.content ?? "").slice(0, 500);
    // The referenced message may itself carry a secret: a token-bearing
    // `/connections add`, or any `/debug` command (its args can be a pasted
    // credential, and the bot's own ack is a reply to a `/debug secrettest`, so
    // Discord echoes that command back in `referenced_message`). Reduce a `/debug`
    // to just its sanitized subcommand label, matching `debugSubcommandLabel`, so
    // no raw debug input is forwarded into the agent transcript or the log below.
    const refParsed = parseConnectTextCommand(rawRef);
    const refDebug = parseDebugTextCommand(rawRef);
    const refContent =
      refParsed && connectTextCommandHasToken(refParsed)
        ? "/connections add <redacted>"
        : refDebug !== null
          ? `/debug ${debugSubcommandLabel(refDebug)}`
          : rawRef;
    if (refContent) {
      content = `[Replying to ${refAuthor}: "${refContent}"]\n${content}`;
    }
  }

  // Redact a pasted token before it reaches the logs. `/connections add <svc>
  // <token>` carries a secret in the message body; the message is scrubbed from
  // Discord moments later, but router logs persist, so the token must never be
  // written here. Detect against the original message, not the possibly
  // reply-prefixed `content`, so a `/connections add` sent as a reply is still
  // caught. Other content is truncated as before.
  const loggableContent = (() => {
    const parsed = parseConnectTextCommand(messageContent);
    if (parsed && connectTextCommandHasToken(parsed)) {
      return "/connections add <redacted>";
    }
    // Any `/debug` command: its args can be a secret (a `secrettest` value, or a
    // credential accidentally pasted as an unknown subcommand). Router logs
    // persist separately from the channel, so log only the sanitized subcommand
    // label, never the raw input, matching the slash path's `debugSubcommandLabel`.
    const debugInput = parseDebugTextCommand(messageContent);
    if (debugInput !== null) {
      return `/debug ${debugSubcommandLabel(debugInput)}`;
    }
    return content.slice(0, 60);
  })();
  runtime.log(
    `[router] MESSAGE_CREATE: author=${authorId} guild=${guildId ?? "dm"} reply=${!!ref} attachments=${rawAttachments.length} content=${loggableContent}`,
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

  // `/connections` management commands, handled before the bot filter (so a
  // tester bot that is the channel owner can drive them). When the command
  // carried a pasted token, scrub the originating message so the secret does not
  // linger in channel history. Parse the original message (not the reply-prefixed
  // `content`) so a command sent as a reply is still recognized, scrubbed, and
  // kept out of the agent transcript rather than falling through as a normal
  // message that still contains the token.
  const connectCmd = authorId ? parseConnectTextCommand(messageContent) : null;
  if (connectCmd && authorId) {
    const commandMessageId = d.id;
    const hasToken = connectTextCommandHasToken(connectCmd);
    const authorizedInstanceKey = connectCommandDeps.store.instanceKey(channelId);
    const dispatchConnect = () => {
      void handleConnectCommand(
        {
          subcommand: connectCmd.subcommand,
          args: connectCmd.args,
          channelId,
          userId: authorId,
          isDM: !guildId,
          authorizedInstanceKey,
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
        `[router] /connections ${connectCmd.subcommand ?? ""} from ${authorId} in ${channelId} (msg ${commandMessageId}, token=${hasToken})`,
      );
    };
    // Owner-gate the caller: /connections reads and writes the channel's stored
    // credentials, so only its owner may drive it (the slash path gates via
    // runForOwner; this is the text-command equivalent). Gate in any guild channel,
    // registered or not, and in a registered DM. An unregistered guild channel has
    // no owner, so the gate fails closed and denies with the standard notice rather
    // than leaking the "not registered yet" hint to a non-owner. Only an
    // unregistered DM falls through ungated, so the 1:1 owner still gets the
    // handler's "register first" guidance instead of a denial against themselves.
    //
    // A missing guildId here always means a 1:1 DM, never a group DM: a bot cannot
    // be a member of a group DM, so the gateway never delivers a group-DM
    // MESSAGE_CREATE to it, and MessageCreateData accordingly carries no channel
    // type. This is the same invariant the conversation gate below relies on ("DMs
    // are inherently 1:1 with the owner"). The slash and modal paths guard the
    // group-DM channel type only because a user-installed app's INTERACTION_CREATE
    // can originate from a group DM, which this message path cannot.
    if (guildId || authorizedInstanceKey !== null) {
      const status = describeInstance(channelId);
      void isAuthorizedForChannel(channelId, authorId, {
        describeInstance: () => status,
      }).then(async (allowed) => {
        if (!allowed) {
          runtime.log(
            `[router] denied /connections from ${authorId} in channel ${channelId} (not the channel owner)`,
          );
          // Scrub a pasted token even on denial so an unauthorized paste does not
          // linger in channel history. If the delete fails the token is still
          // visible, so always warn the sender to remove it by hand, regardless of
          // whether the (owner-facing) unauthorized notice is enabled.
          if (hasToken) {
            const scrubbed = await discordDeleteMessage(discordToken, channelId, commandMessageId);
            if (!scrubbed) {
              void discordSendReply(
                discordToken,
                channelId,
                commandMessageId,
                "I could not delete your message containing the token. Please delete it " +
                  "manually so it does not stay in chat.",
                { parse: [], replied_user: false },
              );
            }
          }
          if (unauthorizedNoticeEnabled) {
            // Coalesce through the SAME per-user+channel debouncer the
            // conversational denial uses (identical notice text/embed), so a
            // non-owner spamming `/connections` gets one immediate reply then at
            // most one per window, not a reply per command. The latest offending
            // message id is captured per send so the batched reply threads under it.
            const offendingId = commandMessageId;
            unauthorizedNoticeDebouncer.trigger(`${channelId}:${authorId}`, () => {
              const embed = buildPermissionDeniedEmbed(
                buildUnauthorizedNoticeText(channelId, status?.ownerId),
              );
              void discordSendReply(
                discordToken,
                channelId,
                offendingId,
                { embeds: [embed.embed], attachments: embed.attachments },
                { parse: [], replied_user: false },
              );
            });
          }
          return;
        }
        dispatchConnect();
      });
      return;
    }
    dispatchConnect();
    return;
  }

  // `/debug` text path, handled before the bot filter so a trusted tester or
  // automation bot (which cannot invoke slash commands) can drive the admin
  // debug console. Gated on admin identity exactly like the slash path; a
  // non-admin gets the same permission notice. Replies land in-channel (bots
  // cannot send true ephemerals), so unlike the slash path this debug output is
  // visible in the channel, which is acceptable on a testing surface.
  // Parse the original message body (not the reply-prefixed `content`) so a
  // `/debug` sent as a reply is still recognized, matching the `/connections` path.
  const debugInput = authorId ? parseDebugTextCommand(messageContent) : null;
  if (debugInput !== null && authorId) {
    const commandMessageId = d.id;
    const reply = (payload: BuiltEmbed) =>
      void discordSendReply(discordToken, channelId, commandMessageId, {
        embeds: [payload.embed],
        attachments: payload.attachments,
      });
    void (async () => {
      if (!(await isAdmin(authorId))) {
        runtime.log(`[router] denied /debug (text) from ${authorId} (not an admin)`);
        reply(buildPermissionDeniedEmbed(buildMissingPermissionText(DEBUG_COMMAND_SPEC.name)));
        return;
      }
      const result: DebugResult = runDebugCommand(debugInput);
      if (result.kind === "secret") {
        reply(
          deliverDebugSecret({
            instances,
            channelQueue,
            runtime,
            channelId,
            authorId,
            name: result.name,
            value: result.value,
          }),
        );
      } else if (result.kind === "ephemeral") {
        // Text replies are always in-channel (bots cannot send ephemerals), so
        // the toggle only persists the preference for later slash replies here;
        // the effectiveEphemeral value is irrelevant for this in-channel reply.
        reply(applyDebugEphemeral(instancesDir, channelId, result.desired, runtime).embed);
      } else if (result.kind === "embeds") {
        void discordSendReply(discordToken, channelId, commandMessageId, {
          embeds: result.embeds,
          attachments: result.attachments,
        });
      } else {
        void discordSendReply(discordToken, channelId, commandMessageId, result.content);
      }
      runtime.log(`[router] /debug (text) from ${authorId}: ${debugSubcommandLabel(debugInput)}`);
    })();
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
          // A plain user message carries no interaction token, so a true
          // ephemeral reply is impossible. Post a persistent Log embed threaded
          // under the offending message instead. Suppress all mentions so the
          // owner/author are never pinged, even under repeated denials. Debounce
          // per user+channel so a spammer gets one immediate reply then at most
          // one per window, rather than a reply to every message. The message id
          // is captured per send so the batched reply threads under the latest
          // offense.
          const offendingId = d.id;
          unauthorizedNoticeDebouncer.trigger(`${channelId}:${authorId}`, () => {
            const embed = buildPermissionDeniedEmbed(
              buildUnauthorizedNoticeText(channelId, status?.ownerId),
            );
            void discordSendReply(
              discordToken,
              channelId,
              offendingId,
              { embeds: [embed.embed], attachments: embed.attachments },
              { parse: [], replied_user: false },
            );
          });
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
    instancesDir,
    instances,
    channelQueue,
    channelGuild,
    channelCommandDeps,
    connectCommandDeps,
    describeInstance,
    isAdmin,
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

  // Discord fixes a reply's ephemerality when the interaction is first answered
  // (the type-4 response or the type-5 defer), so every command reply derives its
  // flags from the channel's `ephemeralCommands` preference up front. Default true
  // keeps replies private; `/debug ephemeral off` flips a channel public so
  // command output persists for inspection during testing. Returns 64 (ephemeral)
  // or 0 (normal). Denials and the /secret modal intentionally stay ephemeral and
  // do not use this.
  const ephemeralFlags = (channelId: string | undefined): number => {
    if (!channelId) {
      return 64;
    }
    return readEphemeralCommands(instancesDir, channelId) ? 64 : 0;
  };

  // Helper to respond to interactions. Accepts a plain string (content) or an
  // embeds payload from a channel command; either way carries the channel's
  // resolved ephemeral flag.
  const respondToInteraction = (payload: ChannelReplyPayload) => {
    const flags = ephemeralFlags(interactionChannelId);
    const data =
      typeof payload === "string"
        ? { content: payload, flags }
        : {
            embeds: payload.embeds,
            ...(payload.components ? { components: payload.components } : {}),
            flags,
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

  // The /debug command runs an admin-only internal subcommand parsed from its
  // single free-text `command` option. Gating is purely on admin identity (not
  // channel ownership). Replies are ephemeral by default, but honor the channel's
  // `ephemeralCommands` preference. The admin check runs BEFORE the first
  // interaction response so a denial stays ephemeral even on a public channel
  // (see the detailed note at the defer below); the role lookup is a single call,
  // well inside Discord's ~3s window.
  if (interactionData?.name === DEBUG_COMMAND_SPEC.name) {
    const userId = d.member?.user?.id ?? d.user?.id ?? "";
    const commandInput = String(
      (interactionData.options as Array<{ name: string; value: string }> | undefined)?.find(
        (o) => o.name === "command",
      )?.value ?? "",
    );
    void (async () => {
      try {
        // Authorize BEFORE the first interaction response. Discord fixes a reply's
        // ephemerality at defer time and an ephemeral reply cannot be made public
        // (or vice versa) afterward, so if this channel's preference is public
        // (`ephemeral off`), deferring first would publish the permission-denied
        // embed to the whole channel, leaking that a non-admin probed /debug and
        // violating the "every denial is ephemeral" invariant
        // (.agents/docs/command-system.md). Gate first: a denial does its own
        // ephemeral defer; only an authorized call defers with the resolved flag.
        // The admin check is a single role lookup, well inside Discord's ~3s
        // window, so gating before the defer does not risk a timeout.
        if (!(await isAdmin(userId))) {
          runtime.log(`[router] denied /debug from ${userId} (not an admin)`);
          // Deny with the shared permission embed (ephemeral), so /debug refuses
          // access the same way every other slash command does instead of a
          // bespoke plain-text reply. alreadyDeferred:false so the denial opens
          // its own ephemeral response rather than editing a public deferral.
          await denyInteractionEphemeral({
            applicationId,
            interactionId,
            interactionToken,
            notice: buildMissingPermissionText(DEBUG_COMMAND_SPEC.name),
            runtime,
          });
          return;
        }
        const result = runDebugCommand(commandInput);
        // `ephemeral on/off` changes the very preference that fixes this reply's
        // ephemerality, which Discord locks at defer time. So for the ephemeral
        // subcommand, persist the toggle NOW (after authorization, before the
        // defer) and derive the defer flag from the ACTUAL post-write value: a
        // failed `ephemeral off` keeps the channel private, so the "did not stick"
        // reply must still be ephemeral rather than public. Every other subcommand
        // defers with the channel's current preference. The persisted embed is
        // reused for the edit below so the write runs exactly once.
        let prebuiltEphemeral: BuiltEmbed | null = null;
        let deferEphemeral = interactionChannelId
          ? readEphemeralCommands(instancesDir, interactionChannelId)
          : true;
        if (result.kind === "ephemeral") {
          const applied = applyDebugEphemeral(
            instancesDir,
            interactionChannelId ?? "",
            result.desired,
            runtime,
          );
          prebuiltEphemeral = applied.embed;
          deferEphemeral = applied.effectiveEphemeral;
        }
        const deferResp = await fetch(
          `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: 5, data: { flags: deferEphemeral ? 64 : 0 } }),
          },
        );
        if (!deferResp.ok) {
          runtime.error(`[router] debug defer failed (${deferResp.status})`);
          return;
        }
        // `secrettest` delivers a secret to the channel's agent and acks with a
        // single embed; `ephemeral` edits in the embed built (and persisted)
        // before the defer; everything else renders its own embeds or raw content.
        let res: { ok: boolean; status: number };
        if (result.kind === "secret") {
          const ack = deliverDebugSecret({
            instances,
            channelQueue,
            runtime,
            channelId: interactionChannelId ?? "",
            authorId: userId,
            name: result.name,
            value: result.value,
          });
          res = await editInteractionEmbedReply(applicationId, interactionToken, {
            embeds: [ack.embed],
            attachments: ack.attachments,
          });
        } else if (result.kind === "ephemeral") {
          // Already persisted and built above (before the defer).
          const built = prebuiltEphemeral ?? buildLogEmbed("");
          res = await editInteractionEmbedReply(applicationId, interactionToken, {
            embeds: [built.embed],
            attachments: built.attachments,
          });
        } else if (result.kind === "embeds") {
          res = await editInteractionEmbedReply(applicationId, interactionToken, {
            embeds: result.embeds,
            attachments: result.attachments,
          });
        } else {
          res = await editInteractionContentReply(applicationId, interactionToken, result.content);
        }
        if (!res.ok) {
          runtime.error(`[router] debug command result failed (${res.status})`);
        }
        // Log only the caller and the (sanitized) subcommand name, never the
        // arguments: debug input can carry credentials or other sensitive state,
        // and raw text could inject forged newlines into the router log.
        runtime.log(`[router] /debug from ${userId}: ${debugSubcommandLabel(commandInput)}`);
      } catch (err) {
        runtime.error(`[router] debug command failed: ${String(err)}`);
      }
    })();
    return;
  }

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
    // Gate every caller. An unregistered channel has no owner, so the owner gate
    // fails closed and denies with the standard notice rather than opening the
    // modal; only the registered owner (or a 1:1 DM with themselves) may open it.
    runForOwner(interactionChannelId ?? "", openModal);
    return;
  }

  if (interactionData?.name === "lifecycle" && interactionChannelId) {
    // Gate first: a non-owner must get the standard unauthorized notice, not the
    // "not registered" hint. An unregistered channel has no owner, so the gate
    // denies; only the owner (or a 1:1 DM) reaches the registration check below.
    runForOwner(interactionChannelId, () => {
      const instance = instances.get(interactionChannelId);
      if (!instance) {
        respondToInteraction("*This channel is not registered.*");
        return;
      }
      const current = instance.preferences.lifecycleMessages ?? false;
      const setting = (
        interactionData.options as Array<{ name: string; value: string }> | undefined
      )?.find((o: { name: string }) => o.name === "setting")?.value;

      const result = resolveLifecycleCommand(current, setting);
      if (
        result.newValue !== undefined &&
        !setUserPreference(instance, "lifecycleMessages", result.newValue)
      ) {
        runtime.error(
          `[router] failed to persist lifecycle preference for channel ${interactionChannelId}`,
        );
        respondToInteraction("*Could not save your lifecycle preference. Please try again.*");
        return;
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
              body: JSON.stringify({
                type: 5,
                data: { flags: ephemeralFlags(interactionChannelId) },
              }),
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
      // Acknowledge immediately with a deferred, ALWAYS-ephemeral response:
      // register can take up to the daemon's command timeout plus readiness
      // polling, well beyond Discord's ~3s window, and the result is delivered by
      // editing the deferred reply. /channel is deliberately exempt from the
      // channel's `ephemeralCommands` preference (unlike conversational command
      // output): its gating (whitelist/admin/owner) is checked inside
      // handleChannelCommand AFTER this defer, so deferring public would edit a
      // permission-denied embed into a channel-visible reply and leak that a
      // non-owner probed registration, violating the "every denial is ephemeral"
      // invariant (.agents/docs/command-system.md). Every /channel reply already
      // asks for ephemeral, so fixing the defer ephemeral matches that intent.
      void fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: 5,
          data: { flags: 64 },
        }),
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
      const authorizedInstanceKey = connectCommandDeps.store.instanceKey(interactionChannelId);
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
      // Defer (ephemeral): add validates a token over the network and can exceed
      // Discord's ~3s window. Deliver the result by editing the deferred reply.
      // Wait for the defer to land before dispatching: a fast path (list, remove,
      // a validation error) can otherwise edit `@original` before Discord has
      // created the deferred response, so the follow-up fails and the interaction
      // is left unanswered (same race the /lifecycle path guards against).
      const dispatch = () => {
        void (async () => {
          try {
            const deferResp = await fetch(
              `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: 5,
                  data: { flags: ephemeralFlags(interactionChannelId) },
                }),
              },
            );
            if (!deferResp.ok) {
              runtime.error(`[router] connect defer failed (${deferResp.status})`);
              return;
            }
            // Slash option values are never posted as a visible message, so there
            // is no token to scrub (scrubCommandMessage is omitted).
            await handleConnectCommand(
              {
                subcommand: subOpt?.name ?? null,
                args,
                channelId: interactionChannelId,
                userId,
                isDM: !d.guild_id,
                authorizedInstanceKey,
                reply: (payload) => editReply(payload),
              },
              connectCommandDeps,
            );
          } catch (err) {
            runtime.error(`[router] connect dispatch failed: ${String(err)}`);
          }
        })();
      };
      // Owner-gate every caller, reusing the /secret and /lifecycle gate:
      // /connections reads and writes the channel's stored credentials, so only its
      // owner may drive it, and group DMs are rejected (runForOwner fails closed). An
      // unregistered channel has no owner, so the gate denies with the standard
      // notice rather than leaking the "not registered yet" hint to a non-owner.
      runForOwner(interactionChannelId, dispatch);
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

  // Each ack below is a Secrets-category embed whose footer icon is an uploaded
  // attachment, which the plain callback endpoint cannot carry. So defer the
  // interaction ephemerally, then edit the deferred reply in with the attachment
  // -aware editor. The edit waits for the defer to land so the `@original` PATCH
  // cannot race ahead of the response being created. (The guild owner-gate denial
  // is the one exception: it goes through the shared unauthorized notice, a
  // Log-category embed, so every command denies access with identical wording.)
  const ackEmbed = async (built: BuiltEmbed) => {
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
        runtime.error(`[router] secret ack defer failed (${deferResp.status})`);
        return;
      }
      const res = await editInteractionEmbedReply(applicationId, interactionToken, {
        embeds: [built.embed],
        attachments: built.attachments,
      });
      if (!res.ok) {
        runtime.error(`[router] secret ack failed (${res.status})`);
      }
    } catch (err) {
      runtime.error(`[router] secret ack failed: ${String(err)}`);
    }
  };

  if (d.data?.custom_id !== SECRET_MODAL_CUSTOM_ID || !channelId) {
    return;
  }
  const { value, name: rawName } = parseSecretModalSubmit(d.data?.components);
  if (!value) {
    void ackEmbed(buildSecretNoticeEmbed("Secret Not Provided.", "No secret value was provided."));
    return;
  }
  if (!instances.get(channelId)) {
    void ackEmbed(
      buildSecretNoticeEmbed(
        "Channel Not Registered.",
        "This channel is not registered, so there is no agent to receive a secret.",
      ),
    );
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
    void ackEmbed(
      buildSecretNoticeEmbed(
        "Unavailable in Group DMs.",
        "The /secret command is not available in group DMs.",
      ),
    );
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
    void ackEmbed(buildSecretReceivedEmbed(name));
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
  const { applicationId, runtime, channelGuild, channelCommandDeps, unregisterInFlight } = ctx;

  const customId = d.data?.custom_id;
  const parsed = customId ? parseUnregisterCustomId(customId) : null;
  const clickerId = d.member?.user?.id ?? d.user?.id;
  const interactionId = d.id;
  const interactionToken = d.token;
  if (d.channel_id && d.guild_id) {
    channelGuild.set(d.channel_id, d.guild_id);
  }

  if (!parsed || !clickerId || !customId) {
    return;
  }

  // Respond to the interaction with an ephemeral message (used for the
  // wrong-clicker and already-in-flight guards, which must not touch the
  // confirmation message).
  const ephemeralReply = (content: string) =>
    void fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: 4, data: { content, flags: 64 } }),
    }).catch((err) => runtime.error(`[router] button response failed: ${String(err)}`));

  // Replace the confirmation message by editing @original (the component's own
  // message). Uploads the footer icon, reusing the CDN cache the confirmation
  // send warmed, and always drops the buttons.
  const editMessage = (update: {
    embeds: DiscordEmbed[];
    attachments: string[];
    components: DiscordActionRow[];
  }) =>
    editInteractionEmbedReply(applicationId, interactionToken, update)
      .then((res) => {
        if (!res.ok) {
          runtime.error(`[router] button followup failed (${res.status})`);
        }
      })
      .catch((err) => runtime.error(`[router] button followup failed: ${String(err)}`));

  // The custom_id alone tells us synchronously whether this click is ours and
  // whether the clicker is the initiator, with no network call. Use that to
  // acknowledge the interaction BEFORE the async authorization inside
  // decideUnregisterClick (which awaits deps.isAdmin, a Discord member lookup,
  // for a non-owner confirm). Acknowledging first guarantees we beat Discord's
  // ~3s interaction deadline even when the role lookup is slow; without it the
  // type-6/7 ack would land only after that await and the interaction could
  // expire. A wrong-clicker click is answered with its own ephemeral (type 4),
  // leaving the confirmation message untouched for the real initiator.
  if (clickerId !== parsed.initiatorId) {
    ephemeralReply("This confirmation isn't for you.");
    return;
  }

  // Claim the in-flight guard SYNCHRONOUSLY for the FIRST valid-initiator click of
  // EITHER kind, at the moment the click is received, BEFORE awaiting anything
  // (even the ack). Two click handlers interleave only at `await` points, so a
  // guard claimed before the first await cannot be bypassed by a later click:
  // whichever click (confirm OR cancel) arrives first wins and runs to completion;
  // any other click for the same channel sees the guard set and is ignored. This
  // must cover cancel too: a Cancel that only deferred (type 6) and then awaited
  // its callback could otherwise be overtaken by a quick Confirm that claimed the
  // guard and purged, while the Cancel later edited the message to "cancelled".
  // The ignored click is still acked below so the interaction never expires.
  // parsed.channelId comes from the custom_id, so this is all synchronous.
  const alreadyInFlight = unregisterInFlight.has(parsed.channelId);
  const claimedInFlight = !alreadyInFlight;
  if (claimedInFlight) {
    unregisterInFlight.add(parsed.channelId);
  }

  // Acknowledge this click up front, before any authorization. The type-7
  // "processing" UPDATE_MESSAGE (which drops the buttons instantly) is sent ONLY by
  // the confirm click that actually CLAIMED the guard. Every other click — a
  // cancel, or any click that found a teardown already in flight — uses a type-6
  // DEFERRED_UPDATE_MESSAGE, which does not modify the message. This matters for an
  // ignored duplicate confirm: a type-7 from it could land AFTER the first
  // handler's terminal edit and permanently overwrite the result with
  // "Processing..."; a type-6 is message-neutral and cannot. Either ack satisfies
  // Discord's ~3s deadline; the owner-named interim/final states follow from the
  // claiming handler.
  const sendsProcessingUpdate = claimedInFlight && parsed.kind === "confirm";
  const ackBody = sendsProcessingUpdate
    ? {
        type: 7,
        data: { embeds: buildUnregisterAckUpdate(parsed.channelId).embeds, components: [] },
      }
    : { type: 6 };
  // Bound the ack with an AbortController timeout. The guard is already claimed, so
  // a raw unbounded fetch that stalls would hold the channel's in-flight guard
  // indefinitely (teardown never starts, every later click is acked-and-ignored)
  // until the socket eventually died. BUTTON_ACK_TIMEOUT_MS caps the wait; on
  // timeout/failure the finally below still releases the guard. The await lives
  // inside the try so no ack outcome can skip that release.
  const ackController = new AbortController();
  const ackTimer = setTimeout(() => ackController.abort(), BUTTON_ACK_TIMEOUT_MS);
  const ack = fetch(`${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ackBody),
    signal: ackController.signal,
  })
    .catch((err) => runtime.error(`[router] button ack failed: ${String(err)}`))
    .finally(() => clearTimeout(ackTimer));

  // A click for a channel whose teardown is already in flight is acked (above) but
  // otherwise ignored.
  if (alreadyInFlight) {
    return;
  }

  void (async () => {
    try {
      await ack;
      const outcome = await decideUnregisterClick({ customId, clickerId }, channelCommandDeps);
      // notForYou cannot occur here (initiator already matched above); ignored is
      // impossible too (parsed is non-null). Both are handled defensively.
      if (outcome.kind === "ignored" || outcome.kind === "notForYou") {
        return;
      }
      if (outcome.kind === "confirm") {
        // Drop the buttons and show the interim "unregistering..." state at once
        // (editing the already-acked message), then edit again with the final
        // result after teardown completes. The guard was claimed synchronously
        // above, so no concurrent click can enter teardown or render cancellation.
        await editMessage(outcome.interim);
        const final = await outcome.perform();
        await editMessage(final);
        return;
      }
      // cancelled / denied / notRegistered: a single message replacement. The
      // interaction is already acked (type 6 above), so just edit the message (the
      // editor uploads the embed's icon, which may differ from the one already on
      // the message, e.g. the Log denial icon).
      await editMessage(outcome.update);
    } finally {
      // Release the guard this handler claimed. For a confirm teardown this runs
      // after perform() completes (so the window stays held for the whole purge);
      // for a cancel, or a confirm downgraded to denied/notRegistered, it frees the
      // channel once the single message edit is done so a later legitimate attempt
      // is not permanently blocked.
      if (claimedInFlight) {
        unregisterInFlight.delete(parsed.channelId);
      }
    }
  })();
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
