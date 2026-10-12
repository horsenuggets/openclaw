/**
 * `/channel` command: register / status / unregister a per-channel agent
 * instance. Works in guild channels and DMs, and is driven either by a real
 * Discord slash command or by a plain message that starts with `/channel`
 * (so a bot, which cannot invoke slash commands, can still drive it in tests).
 *
 * This module is transport-agnostic: the router adapts both entry points into a
 * ChannelCommandContext and calls handleChannelCommand. Provisioning (which
 * needs host/Docker access the router does not have) is delegated to an
 * injected ProvisioningClient.
 *
 * Permission model (see whitelist.ts for role sources):
 * > admin        - register/unregister any channel; may register on another
 * >                user's behalf via the `owner` argument.
 * > whitelisted  - register only their own DM (as themselves); unregister only
 * >                channels they own.
 * > owner        - the user a channel was registered for; may unregister it even
 * >                without a role (so an admin can provision a channel for a user
 * >                who can then remove themselves).
 * > status       - open to everyone.
 */

import { buildEmbed } from "./embed-categories.js";
import { resolveEmoji } from "./emojis.js";
import { buildPermissionDeniedEmbed, buildUnauthorizedNoticeText } from "./unauthorized-notice.js";

export type ChannelSubcommand = "register" | "status" | "unregister";

/** Slash-command registration body for Discord (subcommand group). */
export const CHANNEL_COMMAND_SPEC = {
  name: "channel",
  description: "Register, check, or remove this channel's OpenClaw agent",
  type: 1, // CHAT_INPUT
  // Allow use in guilds (0), bot DMs (1), and group DMs (2).
  contexts: [0, 1, 2],
  options: [
    {
      name: "register",
      description: "Register this channel/DM as an agent instance",
      type: 1,
      options: [
        {
          name: "owner",
          description: "Admin only: register this channel on behalf of another user",
          type: 6, // USER
          required: false,
        },
      ],
    },
    { name: "status", description: "Show this channel's instance status", type: 1 },
    {
      name: "unregister",
      description: "Stop and remove this channel's agent instance",
      type: 1,
      options: [
        {
          name: "confirm",
          description: 'Type "yes" to skip the confirmation button',
          type: 3, // STRING
          required: false,
        },
      ],
    },
  ],
};

export type InstanceStatus = {
  port: number;
  ownerId?: string;
  /** Onboarded once the first-run BOOTSTRAP.md has been deleted. */
  onboarded: boolean;
  /** Container running state, when the provisioner can determine it. */
  running?: boolean;
};

export type ProvisioningResult = {
  ok: boolean;
  message: string;
  /**
   * Host registration token minted for a successful register (openclawctl's
   * .reg-token). The router records it to bind a later unregister confirmation to
   * this exact registration; command handlers ignore it.
   */
  regToken?: string;
};

/** Host-side provisioning (create/start/stop instances). Implemented in Phase 2. */
export type ProvisioningClient = {
  register: (params: {
    channelId: string;
    isDM: boolean;
    ownerId: string;
  }) => Promise<ProvisioningResult>;
  /**
   * Tear down a channel. `expectedRegToken`, when given, is the host registration
   * token the caller recorded for the registration this teardown targets; the host
   * validates it under the per-channel lifecycle lock and refuses a mismatch, so a
   * stale request cannot purge a channel re-registered since.
   */
  unregister: (params: {
    channelId: string;
    expectedRegToken?: string;
  }) => Promise<ProvisioningResult>;
};

/**
 * Shared reply payload contract. The router adapter consumes these exact types
 * to render either a plain string or a Discord embed (optionally with an action
 * row of buttons). Kept transport agnostic: this module never imports from the
 * router or touches Discord.
 */
export type DiscordEmbedField = { name: string; value: string; inline?: boolean };
export type DiscordEmbed = {
  title?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string; icon_url?: string };
  thumbnail?: { url: string };
  image?: { url: string };
  /** ISO-8601 timestamp shown in the footer. */
  timestamp?: string;
};
export type DiscordButton = {
  type: 2;
  /** 1 primary, 2 secondary, 3 success, 4 danger, 5 link. */
  style: 1 | 2 | 3 | 4 | 5;
  label: string;
  custom_id?: string;
  url?: string;
  /** Rendered greyed-out and unclickable when true (used by the preview tool). */
  disabled?: boolean;
};
export type DiscordActionRow = { type: 1; components: DiscordButton[] };
export type ChannelReplyPayload =
  | string
  | {
      embeds: DiscordEmbed[];
      /** Icon filenames (in assets/embeds) the embeds reference via attachment://. */
      attachments?: string[];
      components?: DiscordActionRow[];
    };
export type ChannelReply = (
  payload: ChannelReplyPayload,
  opts?: { ephemeral?: boolean },
) => Promise<void> | void;

/** custom_id prefixes for the unregister confirmation buttons. */
export const UNREGISTER_CONFIRM_PREFIX = "chan-unreg";
export const UNREGISTER_CANCEL_PREFIX = "chan-unreg-cancel";

export type ChannelCommandContext = {
  subcommand: string | null;
  args: string[];
  channelId: string;
  userId: string;
  isDM: boolean;
  reply: ChannelReply;
};

export type ChannelCommandDeps = {
  isWhitelisted: (userId: string) => Promise<boolean>;
  isAdmin: (userId: string) => Promise<boolean>;
  whitelistConfigured: () => boolean;
  /**
   * True when the given user id is the router's own bot. A channel cannot be
   * registered to the bot itself: the bot would own an agent instance of itself
   * and loop on its own messages, so registering it is refused up front with the
   * "unavailable user" notice.
   */
  isSelf: (userId: string) => boolean;
  /** Returns the instance's status, or null when the channel is not registered. */
  describeInstance: (channelId: string) => InstanceStatus | null;
  /**
   * A per-registration nonce for the channel that CHANGES on every successful
   * (un)register, or null when unregistered. Used to bind an unregister
   * confirmation to the exact registration it was shown for, so a stale
   * confirmation clicked after the channel was unregistered and re-registered
   * cannot purge the new instance. Must be `:`-free (it is embedded in a
   * colon-delimited custom_id). The port is NOT suitable here: openclawctl reuses
   * the lowest free port, so an immediate re-register typically reuses it.
   */
  registrationNonce: (channelId: string) => string | null;
  /** Optional live check of whether the agent container is up (TCP probe). */
  probeRunning?: (port: number) => Promise<boolean>;
  provisioning: ProvisioningClient;
  /**
   * Fire the agent's first onboarding turn right after a successful register, so
   * the welcome card and greeting appear immediately without the user having to
   * send a message first. Called after the register embed is sent (ordering:
   * register embed, then welcome). Fire-and-forget; a slow agent turn must not
   * block the command handler.
   */
  kickOnboarding?: (channelId: string, ownerId: string) => void;
  log: (message: string) => void;
};

/**
 * Build a Channel Registration reply: a category-styled embed (color, footer
 * label and icon come from the "registration" category) plus the icon filenames
 * the sender must upload. The title is the specific action; the footer carries
 * the "Channel Registration" label.
 */
function registrationReply(
  title: string,
  description: string,
  fields?: DiscordEmbedField[],
): { embeds: DiscordEmbed[]; attachments: string[] } {
  const built = buildEmbed({
    category: "registration",
    title,
    description,
    ...(fields ? { fields } : {}),
  });
  return { embeds: [built.embed], attachments: built.attachments };
}

/**
 * The shared "you are not authorized to use this channel's agent" notice,
 * rendered as the same Log embed every other surface uses. A /channel denial on
 * a channel owned by someone else (e.g. a stranger trying to unregister it) then
 * reads identically to the plain-message, /lifecycle, and /secret denials,
 * naming the owner when known.
 */
function unauthorizedReply(
  channelId: string,
  ownerId?: string | null,
): { embeds: DiscordEmbed[]; attachments: string[] } {
  const built = buildPermissionDeniedEmbed(buildUnauthorizedNoticeText(channelId, ownerId));
  return { embeds: [built.embed], attachments: built.attachments };
}

/**
 * A `/channel register` permission denial, rendered as the shared permission
 * embed rather than a Channel Registration embed. Used for the role-based
 * register refusals (not whitelisted, non-admin registering for someone else, or
 * a non-admin registering a guild channel), so every slash-command permission
 * denial reads identically. Registration *outcomes* (success, already
 * registered, provisioning failure) keep the Channel Registration embed.
 */
function permissionDeniedReply(notice: string): { embeds: DiscordEmbed[]; attachments: string[] } {
  const built = buildPermissionDeniedEmbed(notice);
  return { embeds: [built.embed], attachments: built.attachments };
}

/**
 * Parse a `/channel ...` text command (also tolerates a leading `//`). Returns
 * null when the message is not a channel command.
 */
export function parseChannelTextCommand(
  content: string,
): { subcommand: string | null; args: string[] } | null {
  const match = content.trim().match(/^\/\/?channel\b\s*(.*)$/is);
  if (!match) {
    return null;
  }
  const rest = match[1].trim();
  if (!rest) {
    return { subcommand: null, args: [] };
  }
  const parts = rest.split(/\s+/);
  return { subcommand: parts[0]?.toLowerCase() ?? null, args: parts.slice(1) };
}

/**
 * Accepted `/channel unregister <arg>` tokens that skip the confirmation button
 * and unregister immediately. Kept liberal so whatever a tester or admin types
 * naturally (`confirm`, `yes`, `force`, `--yes`, `-y`, or `confirm:yes`) just
 * works; a leading `confirm:` is stripped so `confirm:yes` matches `yes`. Any
 * other argument (or none) falls back to the button.
 */
const UNREGISTER_CONFIRM_TOKENS = new Set(["confirm", "yes", "force", "--yes", "-y"]);

/** True when an unregister argument explicitly confirms (skips the button). */
export function isUnregisterConfirmArg(arg: string | undefined): boolean {
  const token = (arg ?? "").toLowerCase().replace(/^confirm:/, "");
  return UNREGISTER_CONFIRM_TOKENS.has(token);
}

/** Resolve a Discord user id from a mention (`<@123>` / `<@!123>`) or raw id. */
export function parseUserMention(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  const mention = trimmed.match(/^<@!?(\d{17,20})>$/);
  if (mention) {
    return mention[1];
  }
  return /^\d{17,20}$/.test(trimmed) ? trimmed : null;
}

/**
 * Build a `custom_id` for an unregister confirmation button. The trailing `gen`
 * segment binds the button to the registration it was shown for: a per-
 * registration nonce that changes on every (un)register (see
 * `ChannelCommandDeps.registrationNonce`). Clicking a stale confirmation after the
 * channel was unregistered and re-registered would otherwise purge the NEW
 * instance; decideUnregisterClick revalidates `gen` against the current nonce and
 * refuses a mismatch. `-` marks an unknown/unregistered channel.
 */
export function buildUnregisterCustomId(
  kind: "confirm" | "cancel",
  channelId: string,
  initiatorId: string,
  gen: string,
): string {
  const prefix = kind === "confirm" ? UNREGISTER_CONFIRM_PREFIX : UNREGISTER_CANCEL_PREFIX;
  return `${prefix}:${channelId}:${initiatorId}:${gen}`;
}

export type UnregisterButton = {
  kind: "confirm" | "cancel";
  channelId: string;
  initiatorId: string;
  /**
   * The per-registration nonce the button was issued for (see
   * `ChannelCommandDeps.registrationNonce`), NOT the instance port. Revalidated at
   * click time so a stale confirmation cannot purge a re-registered instance.
   */
  gen: string;
};

/** Parse an unregister button `custom_id`. Returns null for unrelated ids. */
export function parseUnregisterCustomId(customId: string): UnregisterButton | null {
  const parts = customId.split(":");
  if (parts.length !== 4) {
    return null;
  }
  const [prefix, channelId, initiatorId, gen] = parts;
  if (prefix === UNREGISTER_CONFIRM_PREFIX) {
    return { kind: "confirm", channelId, initiatorId, gen };
  }
  if (prefix === UNREGISTER_CANCEL_PREFIX) {
    return { kind: "cancel", channelId, initiatorId, gen };
  }
  return null;
}

/** The registration generation marker for a channel: its current nonce, or `-`. */
function registrationGen(deps: ChannelCommandDeps, channelId: string): string {
  return deps.registrationNonce(channelId) ?? "-";
}

/** The two-button action row shown under an unregister confirmation embed. */
function unregisterButtons(channelId: string, initiatorId: string, gen: string): DiscordActionRow {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 4, // danger
        label: "Confirm Unregister",
        custom_id: buildUnregisterCustomId("confirm", channelId, initiatorId, gen),
      },
      {
        type: 2,
        style: 2, // secondary
        label: "Cancel",
        custom_id: buildUnregisterCustomId("cancel", channelId, initiatorId, gen),
      },
    ],
  };
}

/** Build the `/channel status` reply as an Attribute/Value table. */
function formatStatus(status: InstanceStatus | null): {
  embeds: DiscordEmbed[];
  attachments: string[];
} {
  // Custom check emojis, resolved by name to the running bot's own application
  // emoji (prod and mirror self-resolve to their own ids); fall back to unicode
  // glyphs if the bot's emoji set has not loaded.
  const yes = resolveEmoji("bluecheckfilled", "✅");
  const no = resolveEmoji("bluecheckempty", "❌");
  const registered = status !== null;
  const runningValue = !registered
    ? no
    : status.running === undefined
      ? "`unknown`"
      : status.running
        ? yes
        : no;
  const attributes = ["Registered", "User", "Port", "Onboarded", "Running"].join("\n");
  const values = [
    registered ? yes : no,
    status?.ownerId ? `<@${status.ownerId}>` : "`null`",
    registered ? String(status.port) : "`null`",
    status?.onboarded ? yes : no,
    runningValue,
  ].join("\n");
  return registrationReply(
    "Status",
    "Below are some details about the current registration status of this channel.",
    [
      { name: "Attribute", value: attributes, inline: true },
      { name: "Value", value: values, inline: true },
    ],
  );
}

const OWNER_MENTION_FALLBACK = "another user";

/** Dispatch a parsed `/channel` command. Transport-agnostic. */
export async function handleChannelCommand(
  ctx: ChannelCommandContext,
  deps: ChannelCommandDeps,
): Promise<void> {
  const sub = (ctx.subcommand ?? "").toLowerCase();

  if (sub === "status") {
    const status = deps.describeInstance(ctx.channelId);
    if (status && deps.probeRunning) {
      status.running = await deps.probeRunning(status.port);
    }
    await ctx.reply(formatStatus(status), { ephemeral: true });
    return;
  }

  if (sub === "register") {
    if (!deps.whitelistConfigured()) {
      await ctx.reply(
        registrationReply("Register", "Instance management is not configured on this deployment."),
        { ephemeral: true },
      );
      deps.log(`[channel] register blocked: whitelist not configured`);
      return;
    }
    const admin = await deps.isAdmin(ctx.userId);
    if (!admin && !(await deps.isWhitelisted(ctx.userId))) {
      await ctx.reply(
        permissionDeniedReply(
          "You are not authorized to manage OpenClaw instances. Ask an admin for access.",
        ),
        { ephemeral: true },
      );
      deps.log(`[channel] register denied for non-whitelisted user ${ctx.userId}`);
      return;
    }

    // Resolve the effective owner. Registering on someone else's behalf is
    // admin-only; whitelisted users always register as themselves.
    const requestedOwner = parseUserMention(ctx.args[0]);
    let ownerId = ctx.userId;
    if (requestedOwner && requestedOwner !== ctx.userId) {
      if (!admin) {
        await ctx.reply(
          permissionDeniedReply("Only admins can register a channel on behalf of another user."),
          { ephemeral: true },
        );
        deps.log(`[channel] register on-behalf denied for non-admin ${ctx.userId}`);
        return;
      }
      ownerId = requestedOwner;
    }

    // The bot cannot own an agent instance of itself: it would self-route on its
    // own messages. Refuse before any provisioning with a yellow registration
    // embed naming the owner as unavailable, whether the bot was passed via the
    // `owner` argument or is somehow the caller (e.g. a text-command driver).
    if (deps.isSelf(ownerId)) {
      await ctx.reply(
        registrationReply(
          "Unavailable User",
          `Channel <#${ctx.channelId}> cannot be registered under <@${ownerId}> because that user is a bot and cannot own an agent instance.`,
        ),
        { ephemeral: true },
      );
      deps.log(`[channel] register refused: owner ${ownerId} is the bot itself`);
      return;
    }

    // Whitelisted-but-not-admin users may only register their own DM.
    if (!admin && !ctx.isDM) {
      await ctx.reply(
        permissionDeniedReply(
          "Whitelisted users can only register their own DM. Ask an admin to register this channel.",
        ),
        { ephemeral: true },
      );
      deps.log(`[channel] register denied: non-admin ${ctx.userId} in guild channel`);
      return;
    }

    const existing = deps.describeInstance(ctx.channelId);
    if (existing) {
      const owner = existing.ownerId ? `<@${existing.ownerId}>` : OWNER_MENTION_FALLBACK;
      await ctx.reply(
        registrationReply(
          "Register",
          `Channel <#${ctx.channelId}> is already registered under user ${owner}. Use \`/channel status\` to check it.`,
        ),
        { ephemeral: true },
      );
      return;
    }

    const result = await deps.provisioning.register({
      channelId: ctx.channelId,
      isDM: ctx.isDM,
      ownerId,
    });
    const message = result.ok
      ? `Channel <#${ctx.channelId}> successfully registered under user <@${ownerId}>. The agent is now ready!`
      : `Could not register channel <#${ctx.channelId}>. ${result.message}`;
    await ctx.reply(registrationReply(result.ok ? "Registration Success!" : "Register", message), {
      ephemeral: true,
    });
    deps.log(
      `[channel] register ${ctx.channelId} by ${ctx.userId} owner=${ownerId}: ok=${result.ok}`,
    );
    // Register embed is out; now kick the agent's first turn so the welcome card
    // and greeting land immediately, before the owner says anything.
    if (result.ok) {
      deps.kickOnboarding?.(ctx.channelId, ownerId);
    }
    return;
  }

  if (sub === "unregister") {
    const status = deps.describeInstance(ctx.channelId);
    if (!status) {
      await ctx.reply(
        registrationReply(
          "Unregister",
          `Channel <#${ctx.channelId}> is not registered, so there is nothing to remove.`,
        ),
        { ephemeral: true },
      );
      return;
    }

    // Snapshot the registration nonce BEFORE the async admin lookup below. Like the
    // button flow, the explicit-confirm path must not purge a replacement: for a
    // non-owner admin, the old registration could be removed and the channel
    // re-registered while deps.isAdmin awaits, after which an unguarded
    // unregister({channelId}) would wipe the new instance. Revalidated right before
    // the destructive call.
    const genAtStart = registrationGen(deps, ctx.channelId);

    // The owner may always remove their own channel; otherwise admin only.
    const isOwner = status.ownerId === ctx.userId;
    if (!isOwner && !(await deps.isAdmin(ctx.userId))) {
      await ctx.reply(unauthorizedReply(ctx.channelId, status.ownerId), { ephemeral: true });
      deps.log(`[channel] unregister denied for ${ctx.userId} (not owner or admin)`);
      return;
    }

    // An explicit confirm argument skips the button (used by bots/e2e that
    // cannot click); humans with no argument get a confirmation button instead.
    if (!isUnregisterConfirmArg(ctx.args[0])) {
      await ctx.reply(
        unregisterConfirmPrompt(ctx.channelId, ctx.userId, registrationGen(deps, ctx.channelId)),
        { ephemeral: true },
      );
      return;
    }

    // Revalidate the nonce immediately before the destructive call: if the channel
    // was re-registered since we snapshotted it (e.g. during the admin lookup),
    // abort rather than purge the replacement, mirroring the button path.
    const genNow = registrationGen(deps, ctx.channelId);
    if (genAtStart !== genNow) {
      deps.log(
        `[channel] unregister ${ctx.channelId} aborted: stale registration (gen ${genAtStart} != ${genNow})`,
      );
      await ctx.reply(
        registrationReply(
          "Unregister",
          `This request is out of date: channel <#${ctx.channelId}> was re-registered since it was issued. Run \`/channel unregister\` again if you still want to remove it.`,
        ),
        { ephemeral: true },
      );
      return;
    }

    // The router's provisioning wrapper supplies the host registration token as
    // expectedRegToken from its own records, so the host atomically refuses the
    // purge under the lifecycle lock if the registration changed — closing the
    // residual router-to-host window. (We do not forward genNow here, as it may be
    // the epoch-generation fallback rather than a host token.)
    const result = await deps.provisioning.unregister({ channelId: ctx.channelId });
    await ctx.reply(unregisterResultReply(ctx.channelId, status.ownerId ?? ctx.userId, result), {
      ephemeral: true,
    });
    deps.log(`[channel] unregister ${ctx.channelId} by ${ctx.userId}: ok=${result.ok}`);
    return;
  }

  await ctx.reply(
    registrationReply(
      "Help",
      "Usage: `/channel register`, `/channel status`, or `/channel unregister`.",
    ),
    { ephemeral: true },
  );
}

/**
 * The `/channel unregister` confirmation prompt: the "are you sure" embed plus the
 * confirm/cancel action row (bound to `gen`). Shared by the command handler and the
 * preview tool so the real prompt and its preview never drift.
 */
function unregisterConfirmPrompt(
  channelId: string,
  initiatorId: string,
  gen: string,
): { embeds: DiscordEmbed[]; attachments: string[]; components: DiscordActionRow[] } {
  return {
    ...registrationReply(
      "Unregister",
      `Are you sure you want to unregister channel <#${channelId}>? This stops and removes the agent and its container, frees its port, and wipes all of its data.`,
    ),
    components: [unregisterButtons(channelId, initiatorId, gen)],
  };
}

/** Reply shown after an unregister completes (or fails). */
function unregisterResultReply(
  channelId: string,
  ownerId: string,
  result: ProvisioningResult,
): { embeds: DiscordEmbed[]; attachments: string[] } {
  return registrationReply(
    "Unregister",
    result.ok
      ? // The host commits the teardown by atomically renaming the instance dir
        // (stopping the container and freeing the port), then wipes the data in a
        // detached background process. So the agent/container/port are gone for
        // certain, but the data deletion is still finishing; word it as such rather
        // than promising the bytes are already gone.
        `Channel <#${channelId}> has been unregistered from user <@${ownerId}>. Its agent and container are stopped and its port is freed; the remaining data is being wiped in the background.`
      : `Could not unregister channel <#${channelId}>. ${result.message}`,
  );
}

/**
 * Interim reply shown the instant the confirm button is clicked: the buttons are
 * dropped and the message states that teardown is underway, so the click is
 * acknowledged immediately rather than leaving stale buttons while a slow Docker
 * teardown runs. Uses the same registration icon the confirmation already
 * uploaded, so it can be rendered as a plain UPDATE_MESSAGE without re-uploading.
 */
function unregisterInterimReply(
  channelId: string,
  ownerId: string,
): { embeds: DiscordEmbed[]; attachments: string[] } {
  return registrationReply(
    "Unregister",
    `Unregistering channel <#${channelId}> under user <@${ownerId}>. Stopping the agent and wiping its container, port, and data...`,
  );
}

/** A message replacement for the confirmation message (embeds + no buttons). */
export type UnregisterUpdate = {
  embeds: DiscordEmbed[];
  attachments: string[];
  components: DiscordActionRow[];
};

/**
 * The INSTANT acknowledgement shown the moment a confirm button is clicked, before
 * any authorization runs: drops the buttons (so a second click cannot land) and
 * states that the request is being processed. Deliberately owner-agnostic so the
 * router can send it synchronously via a type-7 UPDATE_MESSAGE without first
 * resolving the owner or awaiting the admin check. Reuses the registration icon
 * already attached to the confirmation message, so no re-upload is needed. The
 * owner-named interim/final states follow once authorization resolves.
 */
export function buildUnregisterAckUpdate(channelId: string): UnregisterUpdate {
  return {
    ...registrationReply(
      "Unregister",
      `Processing the unregister request for channel <#${channelId}>...`,
    ),
    components: [],
  };
}

/**
 * The decision for a click on an unregister confirmation button. The router
 * adapter owns the Discord I/O; this stays transport-agnostic. The `confirm`
 * outcome is two-phase: the adapter renders `interim` immediately (dropping the
 * buttons) and then awaits `perform` for the final result, so a slow teardown
 * never leaves clickable buttons behind.
 */
export type UnregisterClickOutcome =
  | { kind: "ignored" }
  | { kind: "notForYou"; notice: string }
  | { kind: "cancelled"; update: UnregisterUpdate }
  | { kind: "denied"; update: UnregisterUpdate }
  | { kind: "notRegistered"; update: UnregisterUpdate }
  | {
      kind: "confirm";
      channelId: string;
      ownerId: string;
      interim: UnregisterUpdate;
      perform: () => Promise<UnregisterUpdate>;
    };

/**
 * Decide what a click on an unregister confirmation button should do. Only the
 * user who opened the dialog may act on it, and permission is re-checked at click
 * time in case roles changed. Returns `ignored` for `custom_id`s that are not
 * ours. For a valid confirm, returns the interim message plus a `perform` thunk
 * that runs the actual unregister and yields the final message; the adapter
 * sequences the two so the buttons vanish the moment the click lands.
 */
export async function decideUnregisterClick(
  params: { customId: string; clickerId: string },
  deps: ChannelCommandDeps,
): Promise<UnregisterClickOutcome> {
  const parsed = parseUnregisterCustomId(params.customId);
  if (!parsed) {
    return { kind: "ignored" };
  }
  const { kind, channelId, initiatorId, gen } = parsed;

  if (params.clickerId !== initiatorId) {
    return { kind: "notForYou", notice: "This confirmation isn't for you." };
  }

  if (kind === "cancel") {
    return {
      kind: "cancelled",
      update: {
        ...registrationReply(
          "Unregister",
          `Unregister cancelled. Channel <#${channelId}> is still registered.`,
        ),
        components: [],
      },
    };
  }

  const status = deps.describeInstance(channelId);
  if (!status) {
    return {
      kind: "notRegistered",
      update: {
        ...registrationReply(
          "Unregister",
          `Channel <#${channelId}> is not registered, so there is nothing to remove.`,
        ),
        components: [],
      },
    };
  }

  // Refuse a confirm whose registration generation no longer matches the current
  // one. The button's `gen` is the per-registration nonce captured when the dialog
  // was shown; if the channel was unregistered and re-registered since (new nonce),
  // this stale confirmation would otherwise purge the NEW instance and its data.
  // Treat the mismatch as "not registered" (the registration it referred to is
  // gone). The nonce changes on every (un)register, unlike the reusable port.
  const currentGen = registrationGen(deps, channelId);
  if (gen !== currentGen) {
    deps.log(
      `[channel] unregister confirm for ${channelId} ignored: stale registration (button gen ${gen} != current ${currentGen})`,
    );
    return {
      kind: "notRegistered",
      update: {
        ...registrationReply(
          "Unregister",
          `This confirmation is out of date: channel <#${channelId}> was re-registered since the dialog was shown. Run \`/channel unregister\` again if you still want to remove it.`,
        ),
        components: [],
      },
    };
  }

  const isOwner = status.ownerId === params.clickerId;
  if (!isOwner && !(await deps.isAdmin(params.clickerId))) {
    return {
      kind: "denied",
      update: { ...unauthorizedReply(channelId, status.ownerId), components: [] },
    };
  }

  const ownerId = status.ownerId ?? params.clickerId;
  return {
    kind: "confirm",
    channelId,
    ownerId,
    interim: { ...unregisterInterimReply(channelId, ownerId), components: [] },
    perform: async () => {
      // Re-validate the registration generation at the LAST moment before the
      // destructive call. The earlier check and the adapter's interim-edit await
      // leave a window in which another unregister/re-register could complete;
      // provisioning.unregister only takes channelId, so without this re-check a
      // stale confirmation could purge the replacement registration. If the nonce
      // changed, abort without touching provisioning.
      const genNow = registrationGen(deps, channelId);
      if (gen !== genNow) {
        deps.log(
          `[channel] unregister ${channelId} aborted at perform: stale registration (button gen ${gen} != current ${genNow})`,
        );
        return {
          ...registrationReply(
            "Unregister",
            `This confirmation is out of date: channel <#${channelId}> was re-registered since the dialog was shown. Run \`/channel unregister\` again if you still want to remove it.`,
          ),
          components: [],
        };
      }
      // The router's provisioning wrapper supplies the host registration token as
      // expectedRegToken from its own records, so the HOST re-validates it under
      // the lifecycle lock and refuses a mismatch — the atomic guard that closes
      // the residual TOCTOU between this router-side recheck and the host acquiring
      // that lock. (We do not forward the button's gen here: it may be the
      // epoch-generation fallback when no host token exists, which would not match
      // a host .reg-token and would wrongly refuse the purge.)
      const result = await deps.provisioning.unregister({ channelId });
      deps.log(
        `[channel] unregister ${channelId} by ${params.clickerId} (button): ok=${result.ok}`,
      );
      return { ...unregisterResultReply(channelId, ownerId, result), components: [] };
    },
  };
}

/**
 * The three render stages of the unregister confirm-button flow, for the
 * `/debug unregisterflow` preview. `confirm` shows the real prompt but with the
 * buttons disabled (the preview walks the stages itself; it must not be
 * clickable). `interim` and `final` are exactly what a real confirm click
 * produces. The adapter posts `confirm`, then edits the same message to `interim`
 * then `final`, mirroring the live two-phase (buttons drop, then result lands).
 */
export type UnregisterFlowPreview = {
  confirm: UnregisterUpdate;
  interim: UnregisterUpdate;
  final: UnregisterUpdate;
};

export function buildUnregisterFlowPreview(
  channelId: string,
  ownerId: string,
): UnregisterFlowPreview {
  // The preview is non-clickable, so the confirmation's nonce is irrelevant; use
  // the unknown/unregistered marker and disable the buttons.
  const prompt = unregisterConfirmPrompt(channelId, ownerId, "-");
  const disabledButtons: DiscordActionRow[] = prompt.components.map((row) => ({
    type: 1,
    components: row.components.map((button) => ({ ...button, disabled: true })),
  }));
  return {
    confirm: {
      embeds: prompt.embeds,
      attachments: prompt.attachments,
      components: disabledButtons,
    },
    interim: { ...unregisterInterimReply(channelId, ownerId), components: [] },
    final: {
      ...unregisterResultReply(channelId, ownerId, { ok: true, message: "preview" }),
      components: [],
    },
  };
}
