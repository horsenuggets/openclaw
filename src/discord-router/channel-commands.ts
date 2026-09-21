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
    { name: "register", description: "Register this channel/DM as an agent instance", type: 1 },
    { name: "status", description: "Show this channel's instance status", type: 1 },
    {
      name: "unregister",
      description: "Stop and remove this channel's agent instance",
      type: 1,
      options: [
        {
          name: "confirm",
          description: 'Type "yes" to confirm removal',
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

export type ChannelReply = (text: string, opts?: { ephemeral?: boolean }) => Promise<void> | void;

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
  whitelistConfigured: () => boolean;
  /** Returns the instance's status, or null when the channel is not registered. */
  describeInstance: (channelId: string) => InstanceStatus | null;
  /** Number of currently registered instances (to protect the last one). */
  instanceCount: () => number;
  provisioning: ProvisioningClient;
  log: (message: string) => void;
};

const NOT_WHITELISTED_MESSAGE =
  "You are not authorized to manage OpenClaw instances. Ask an admin for access.";

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

function formatStatus(channelId: string, status: InstanceStatus | null): string {
  if (!status) {
    return "This channel is **not registered**. Use `/channel register` to set it up.";
  }
  const lines = [
    "**Channel status**",
    "- Registered: yes",
    `- Port: ${status.port}`,
    `- Owner: ${status.ownerId ? `<@${status.ownerId}>` : "unknown"}`,
    `- Onboarded: ${status.onboarded ? "yes" : "no (first-run setup pending)"}`,
  ];
  if (status.running !== undefined) {
    lines.push(`- Agent running: ${status.running ? "yes" : "no"}`);
  }
  return lines.join("\n");
}

/** Dispatch a parsed `/channel` command. Transport-agnostic. */
export async function handleChannelCommand(
  ctx: ChannelCommandContext,
  deps: ChannelCommandDeps,
): Promise<void> {
  const sub = (ctx.subcommand ?? "").toLowerCase();

  if (sub === "status") {
    await ctx.reply(formatStatus(ctx.channelId, deps.describeInstance(ctx.channelId)), {
      ephemeral: true,
    });
    return;
  }

  if (sub === "register" || sub === "unregister") {
    if (!deps.whitelistConfigured()) {
      await ctx.reply(
        "Instance management is not configured on this deployment (missing whitelist config).",
        { ephemeral: true },
      );
      deps.log(`[channel] ${sub} blocked: whitelist not configured`);
      return;
    }
    if (!(await deps.isWhitelisted(ctx.userId))) {
      await ctx.reply(NOT_WHITELISTED_MESSAGE, { ephemeral: true });
      deps.log(`[channel] ${sub} denied for non-whitelisted user ${ctx.userId}`);
      return;
    }
  }

  if (sub === "register") {
    if (deps.describeInstance(ctx.channelId)) {
      await ctx.reply("This channel is already registered. Use `/channel status` to check it.", {
        ephemeral: true,
      });
      return;
    }
    const result = await deps.provisioning.register({
      channelId: ctx.channelId,
      isDM: ctx.isDM,
      ownerId: ctx.userId,
    });
    await ctx.reply(result.message, { ephemeral: true });
    deps.log(`[channel] register ${ctx.channelId} by ${ctx.userId}: ok=${result.ok}`);
    return;
  }

  if (sub === "unregister") {
    if (!deps.describeInstance(ctx.channelId)) {
      await ctx.reply("This channel is not registered, so there is nothing to remove.", {
        ephemeral: true,
      });
      return;
    }
    // The boot script and router currently require at least one instance to
    // start, so refuse to remove the last one and strand the control plane.
    if (deps.instanceCount() <= 1) {
      await ctx.reply(
        "This is the only registered channel. Register another before removing this one, so the router still has an instance to run.",
        { ephemeral: true },
      );
      return;
    }
    const confirm = (ctx.args[0] ?? "").toLowerCase();
    if (confirm !== "yes") {
      await ctx.reply(
        "This will stop and remove this channel's agent (instance data is kept). To proceed, run `/channel unregister confirm:yes` (or `/channel unregister yes`).",
        { ephemeral: true },
      );
      return;
    }
    const result = await deps.provisioning.unregister({ channelId: ctx.channelId });
    await ctx.reply(result.message, { ephemeral: true });
    deps.log(`[channel] unregister ${ctx.channelId} by ${ctx.userId}: ok=${result.ok}`);
    return;
  }

  await ctx.reply("Usage: `/channel register`, `/channel status`, or `/channel unregister`.", {
    ephemeral: true,
  });
}
