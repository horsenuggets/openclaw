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

export type ProvisioningResult = { ok: boolean; message: string };

/** Host-side provisioning (create/start/stop instances). Implemented in Phase 2. */
export type ProvisioningClient = {
  register: (params: {
    channelId: string;
    isDM: boolean;
    ownerId: string;
  }) => Promise<ProvisioningResult>;
  unregister: (params: { channelId: string }) => Promise<ProvisioningResult>;
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
  footer?: { text: string };
};
export type DiscordButton = {
  type: 2;
  /** 1 primary, 2 secondary, 3 success, 4 danger, 5 link. */
  style: 1 | 2 | 3 | 4 | 5;
  label: string;
  custom_id?: string;
  url?: string;
};
export type DiscordActionRow = { type: 1; components: DiscordButton[] };
export type ChannelReplyPayload =
  | string
  | { embeds: DiscordEmbed[]; components?: DiscordActionRow[] };
export type ChannelReply = (
  payload: ChannelReplyPayload,
  opts?: { ephemeral?: boolean },
) => Promise<void> | void;

/** Brand yellow shared by every channel-registration embed. */
const BRAND_YELLOW = 0xffff80;

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
  /** Returns the instance's status, or null when the channel is not registered. */
  describeInstance: (channelId: string) => InstanceStatus | null;
  /** Optional live check of whether the agent container is up (TCP probe). */
  probeRunning?: (port: number) => Promise<boolean>;
  provisioning: ProvisioningClient;
  log: (message: string) => void;
};

/** Title for a channel-registration embed, e.g. "Channel Registration » Register". */
function title(action: string): string {
  return `Channel Registration » ${action}`;
}

/** Build a standard yellow channel-registration embed. */
function embed(action: string, description: string, fields?: DiscordEmbedField[]): DiscordEmbed {
  return { title: title(action), description, color: BRAND_YELLOW, ...(fields ? { fields } : {}) };
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

/** Build a `custom_id` for an unregister confirmation button. */
export function buildUnregisterCustomId(
  kind: "confirm" | "cancel",
  channelId: string,
  initiatorId: string,
): string {
  const prefix = kind === "confirm" ? UNREGISTER_CONFIRM_PREFIX : UNREGISTER_CANCEL_PREFIX;
  return `${prefix}:${channelId}:${initiatorId}`;
}

export type UnregisterButton = {
  kind: "confirm" | "cancel";
  channelId: string;
  initiatorId: string;
};

/** Parse an unregister button `custom_id`. Returns null for unrelated ids. */
export function parseUnregisterCustomId(customId: string): UnregisterButton | null {
  const parts = customId.split(":");
  if (parts.length !== 3) {
    return null;
  }
  const [prefix, channelId, initiatorId] = parts;
  if (prefix === UNREGISTER_CONFIRM_PREFIX) {
    return { kind: "confirm", channelId, initiatorId };
  }
  if (prefix === UNREGISTER_CANCEL_PREFIX) {
    return { kind: "cancel", channelId, initiatorId };
  }
  return null;
}

/** The two-button action row shown under an unregister confirmation embed. */
function unregisterButtons(channelId: string, initiatorId: string): DiscordActionRow {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 4, // danger
        label: "Confirm unregister",
        custom_id: buildUnregisterCustomId("confirm", channelId, initiatorId),
      },
      {
        type: 2,
        style: 2, // secondary
        label: "Cancel",
        custom_id: buildUnregisterCustomId("cancel", channelId, initiatorId),
      },
    ],
  };
}

/** Build the `/channel status` embed as a Property/Value table. */
function formatStatus(status: InstanceStatus | null): DiscordEmbed {
  const registered = status !== null;
  const runningValue = !registered
    ? "❌"
    : status.running === undefined
      ? "`unknown`"
      : status.running
        ? "✅"
        : "❌";
  const properties = ["Registered", "User", "Port", "Onboarded", "Running"].join("\n");
  const values = [
    registered ? "✅" : "❌",
    status?.ownerId ? `<@${status.ownerId}>` : "`null`",
    registered ? String(status.port) : "`null`",
    status?.onboarded ? "✅" : "❌",
    runningValue,
  ].join("\n");
  return embed(
    "Status",
    "Below are some details about the current registration status of this channel.",
    [
      { name: "Property", value: properties, inline: true },
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
    await ctx.reply({ embeds: [formatStatus(status)] }, { ephemeral: true });
    return;
  }

  if (sub === "register") {
    if (!deps.whitelistConfigured()) {
      await ctx.reply(
        {
          embeds: [embed("Register", "Instance management is not configured on this deployment.")],
        },
        { ephemeral: true },
      );
      deps.log(`[channel] register blocked: whitelist not configured`);
      return;
    }
    const admin = await deps.isAdmin(ctx.userId);
    if (!admin && !(await deps.isWhitelisted(ctx.userId))) {
      await ctx.reply(
        {
          embeds: [
            embed(
              "Register",
              "You are not authorized to manage OpenClaw instances. Ask an admin for access.",
            ),
          ],
        },
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
          {
            embeds: [
              embed("Register", "Only admins can register a channel on behalf of another user."),
            ],
          },
          { ephemeral: true },
        );
        deps.log(`[channel] register on-behalf denied for non-admin ${ctx.userId}`);
        return;
      }
      ownerId = requestedOwner;
    }

    // Whitelisted-but-not-admin users may only register their own DM.
    if (!admin && !ctx.isDM) {
      await ctx.reply(
        {
          embeds: [
            embed(
              "Register",
              "Whitelisted users can only register their own DM. Ask an admin to register this channel.",
            ),
          ],
        },
        { ephemeral: true },
      );
      deps.log(`[channel] register denied: non-admin ${ctx.userId} in guild channel`);
      return;
    }

    const existing = deps.describeInstance(ctx.channelId);
    if (existing) {
      const owner = existing.ownerId ? `<@${existing.ownerId}>` : OWNER_MENTION_FALLBACK;
      await ctx.reply(
        {
          embeds: [
            embed(
              "Register",
              `Channel <#${ctx.channelId}> is already registered under user ${owner}. Use \`/channel status\` to check it.`,
            ),
          ],
        },
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
    await ctx.reply({ embeds: [embed("Register", message)] }, { ephemeral: true });
    deps.log(
      `[channel] register ${ctx.channelId} by ${ctx.userId} owner=${ownerId}: ok=${result.ok}`,
    );
    return;
  }

  if (sub === "unregister") {
    const status = deps.describeInstance(ctx.channelId);
    if (!status) {
      await ctx.reply(
        {
          embeds: [
            embed(
              "Unregister",
              `Channel <#${ctx.channelId}> is not registered, so there is nothing to remove.`,
            ),
          ],
        },
        { ephemeral: true },
      );
      return;
    }

    // The owner may always remove their own channel; otherwise admin only.
    const isOwner = status.ownerId === ctx.userId;
    if (!isOwner && !(await deps.isAdmin(ctx.userId))) {
      await ctx.reply(
        {
          embeds: [
            embed(
              "Unregister",
              "You do not have permission to unregister this channel. Only the channel owner or an admin can remove it.",
            ),
          ],
        },
        { ephemeral: true },
      );
      deps.log(`[channel] unregister denied for ${ctx.userId} (not owner or admin)`);
      return;
    }

    // A text `confirm:yes` (or bare `yes`) skips the button (used by bots/e2e
    // that cannot click); humans get a confirmation button instead. Strip a
    // leading `confirm:` so both spellings resolve to the same token.
    const confirm = (ctx.args[0] ?? "").toLowerCase().replace(/^confirm:/, "");
    if (confirm !== "yes") {
      await ctx.reply(
        {
          embeds: [
            embed(
              "Unregister",
              `Are you sure you want to unregister channel <#${ctx.channelId}>? This stops and removes the agent (instance data is kept).`,
            ),
          ],
          components: [unregisterButtons(ctx.channelId, ctx.userId)],
        },
        { ephemeral: true },
      );
      return;
    }

    const result = await deps.provisioning.unregister({ channelId: ctx.channelId });
    await ctx.reply(
      { embeds: [unregisterResultEmbed(ctx.channelId, status.ownerId ?? ctx.userId, result)] },
      { ephemeral: true },
    );
    deps.log(`[channel] unregister ${ctx.channelId} by ${ctx.userId}: ok=${result.ok}`);
    return;
  }

  await ctx.reply(
    {
      embeds: [
        embed("Help", "Usage: `/channel register`, `/channel status`, or `/channel unregister`."),
      ],
    },
    { ephemeral: true },
  );
}

/** Embed shown after an unregister completes (or fails). */
function unregisterResultEmbed(
  channelId: string,
  ownerId: string,
  result: ProvisioningResult,
): DiscordEmbed {
  return embed(
    "Unregister",
    result.ok
      ? `Channel <#${channelId}> has been successfully unregistered from user <@${ownerId}>.`
      : `Could not unregister channel <#${channelId}>. ${result.message}`,
  );
}

export type UnregisterButtonResult = {
  /** Replace the original message (Discord UPDATE_MESSAGE / type 7). */
  update?: { embeds: DiscordEmbed[]; components: DiscordActionRow[] };
  /** Send an ephemeral notice instead of updating (e.g. wrong clicker). */
  ephemeral?: string;
};

/**
 * Handle a click on an unregister confirmation button. Only the user who opened
 * the dialog may act on it; permission is re-checked at click time in case roles
 * changed. Returns the message update (or an ephemeral notice). Returns an empty
 * object for `custom_id`s that are not ours.
 */
export async function handleUnregisterButtonClick(
  params: { customId: string; clickerId: string },
  deps: ChannelCommandDeps,
): Promise<UnregisterButtonResult> {
  const parsed = parseUnregisterCustomId(params.customId);
  if (!parsed) {
    return {};
  }
  const { kind, channelId, initiatorId } = parsed;

  if (params.clickerId !== initiatorId) {
    return { ephemeral: "This confirmation isn't for you." };
  }

  if (kind === "cancel") {
    return {
      update: {
        embeds: [
          embed("Unregister", `Unregister cancelled. Channel <#${channelId}> is still registered.`),
        ],
        components: [],
      },
    };
  }

  const status = deps.describeInstance(channelId);
  if (!status) {
    return {
      update: {
        embeds: [
          embed(
            "Unregister",
            `Channel <#${channelId}> is not registered, so there is nothing to remove.`,
          ),
        ],
        components: [],
      },
    };
  }

  const isOwner = status.ownerId === params.clickerId;
  if (!isOwner && !(await deps.isAdmin(params.clickerId))) {
    return {
      update: {
        embeds: [
          embed(
            "Unregister",
            "You do not have permission to unregister this channel. Only the channel owner or an admin can remove it.",
          ),
        ],
        components: [],
      },
    };
  }

  const result = await deps.provisioning.unregister({ channelId });
  deps.log(`[channel] unregister ${channelId} by ${params.clickerId} (button): ok=${result.ok}`);
  return {
    update: {
      embeds: [unregisterResultEmbed(channelId, status.ownerId ?? params.clickerId, result)],
      components: [],
    },
  };
}
