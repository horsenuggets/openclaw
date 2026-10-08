/**
 * `/connect` command: link external accounts (connections) to a channel's agent
 * and see their status. Modeled on channel-commands.ts: transport-agnostic, the
 * router adapts both a real Discord slash command and a plain `/connect` text
 * message into a ConnectCommandContext and calls handleConnectCommand. Storage
 * and token validation are injected (ConnectCommandDeps) so this module never
 * touches the filesystem or network and stays unit-testable.
 *
 * Phase 1 MVP: `paste-token` connectors (Todoist, Notion, GitHub) link end to
 * end; Google is shown as coming soon. OAuth-PKCE and a router-side credential
 * broker are later phases.
 */

import type { ChannelReply, DiscordEmbed, DiscordEmbedField } from "./channel-commands.js";
import type { ConnectionStatus, StoredConnection } from "./connections-store.js";
import { type ConnectorRegistry, connectorRegistry } from "./connectors.js";
import { buildEmbed } from "./embed-categories.js";

export type ConnectSubcommand = "list" | "add" | "remove";

/** Service choices for the slash command, built from the catalog. */
const SERVICE_CHOICES = connectorRegistry.all().map((c) => ({ name: c.label, value: c.id }));

/** Slash-command registration body for Discord (subcommand group). */
export const CONNECTIONS_COMMAND_SPEC = {
  name: "connections",
  description: "Link your accounts (Google, Todoist, Notion, GitHub) to this agent",
  type: 1, // CHAT_INPUT
  contexts: [0, 1, 2], // guild, bot DM, group DM
  options: [
    { name: "list", description: "Show your linked accounts and their status", type: 1 },
    {
      name: "add",
      description: "Link a service to this agent",
      type: 1,
      options: [
        {
          name: "service",
          description: "Which service to link",
          type: 3, // STRING
          required: true,
          choices: SERVICE_CHOICES,
        },
        {
          name: "token",
          description: "Paste your API token (omit to get setup instructions first)",
          type: 3,
          required: false,
        },
      ],
    },
    {
      name: "remove",
      description: "Unlink a service from this agent",
      type: 1,
      options: [
        {
          name: "service",
          description: "Which service to unlink",
          type: 3,
          required: true,
          choices: SERVICE_CHOICES,
        },
      ],
    },
  ],
};

/** `/conn` is a short alias for `/connections` (same options and handler). */
export const CONN_COMMAND_SPEC = {
  ...CONNECTIONS_COMMAND_SPEC,
  name: "conn",
  description: "Alias for /connections",
};

/** All slash specs to register for this command (primary plus alias). */
export const CONNECTIONS_COMMAND_SPECS = [CONNECTIONS_COMMAND_SPEC, CONN_COMMAND_SPEC];

/** Slash-command names that route to the connections handler. */
export const CONNECTIONS_COMMAND_NAMES: readonly string[] = ["connections", "conn"];

/**
 * Storage abstraction over channelId. The router implements this against the
 * per-instance connections file; `null` from these methods means the channel is
 * not registered (no instance), which the handler surfaces to the user.
 */
export type ConnectionStore = {
  /** All connections for the channel, or null when the channel is not registered. */
  list: (channelId: string) => StoredConnection[] | null;
  get: (channelId: string, connectorId: string) => StoredConnection | null;
  save: (channelId: string, connection: StoredConnection) => void;
  remove: (channelId: string, connectorId: string) => boolean;
};

export type ConnectCommandDeps = {
  store: ConnectionStore;
  /**
   * The connector catalog. Injected so tests can supply network-free connectors
   * while the router wires the real registry (with live token validation).
   */
  registry: ConnectorRegistry;
  /**
   * Status glyphs for the list table. Injected so the sender's own custom
   * application emoji (resolved per bot) can be used; falls back to unicode.
   */
  emoji?: ConnectionEmoji;
  /** Current time, injectable for deterministic tests. */
  now?: () => Date;
  log: (message: string) => void;
};

/** Status glyphs for the `/connections list` table. */
export type ConnectionEmoji = {
  connected: string;
  notConnected: string;
  needsAuth: string;
};

/** Unicode fallbacks used when the bot's custom app emoji are unavailable. */
export const DEFAULT_CONNECTION_EMOJI: ConnectionEmoji = {
  connected: "✅",
  notConnected: "❌",
  needsAuth: "⚠️",
};

export type ConnectCommandContext = {
  subcommand: string | null;
  args: string[];
  channelId: string;
  userId: string;
  isDM: boolean;
  reply: ChannelReply;
  /**
   * Delete the originating message when a token was pasted in a visible text
   * command, so the secret does not linger in channel history. No-op for slash
   * commands (their option values are never posted as a message).
   */
  scrubCommandMessage?: () => void | Promise<void>;
};

/** Build a Connections-category embed reply. */
function connectionsReply(
  title: string,
  description: string,
  fields?: DiscordEmbedField[],
): { embeds: DiscordEmbed[]; attachments: string[] } {
  const built = buildEmbed({
    category: "connections",
    title,
    description,
    ...(fields ? { fields } : {}),
  });
  return { embeds: [built.embed], attachments: built.attachments };
}

/**
 * Parse a `/connections ...` (or `/conn ...`) text command, also tolerating a
 * leading `//`. Returns null when the message is not a connections command. The
 * longer name is listed first so `/connections` is not mis-matched as `/conn`.
 */
export function parseConnectTextCommand(
  content: string,
): { subcommand: string | null; args: string[] } | null {
  const match = content.trim().match(/^\/\/?(?:connections|conn)\b\s*(.*)$/is);
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

/** True when a parsed text command would carry a pasted token (so it must be scrubbed). */
export function connectTextCommandHasToken(parsed: {
  subcommand: string | null;
  args: string[];
}): boolean {
  return (parsed.subcommand ?? "").toLowerCase() === "add" && parsed.args.length >= 2;
}

/**
 * The Status-column cell for a connector: a glyph plus a short label. Mirrors the
 * glyph-led cells of the `/channel status` table (see channel-commands.ts).
 */
function statusCell(connection: StoredConnection | null, emoji: ConnectionEmoji): string {
  const status: ConnectionStatus = connection?.status ?? "not_linked";
  if (status === "linked") {
    return `${emoji.connected} Connected`;
  }
  if (status === "needs_reauth") {
    return `${emoji.needsAuth} Needs authentication`;
  }
  return `${emoji.notConnected} Not connected`;
}

const LIST_DESCRIPTION =
  "Below are the services you can link to this channel's agent and their current status. " +
  "Use `/connections add <service>` to link one, or `/connections remove <service>` to unlink.";

/**
 * Build the `/connections list` status embed as a Service Name/Status table,
 * matching the Property/Value layout of `/channel status`.
 */
function listReply(
  registry: ConnectorRegistry,
  connections: StoredConnection[],
  emoji: ConnectionEmoji,
): {
  embeds: DiscordEmbed[];
  attachments: string[];
} {
  const byId = new Map(connections.map((c) => [c.connectorId, c]));
  const services: string[] = [];
  const statuses: string[] = [];
  for (const connector of registry.all()) {
    services.push(connector.label);
    statuses.push(statusCell(byId.get(connector.id) ?? null, emoji));
  }
  return connectionsReply("Your Connections", LIST_DESCRIPTION, [
    { name: "Service Name", value: services.join("\n"), inline: true },
    { name: "Status", value: statuses.join("\n"), inline: true },
  ]);
}

/** The `/connections list` reply when the channel is registered but nothing is linked. */
function emptyListReply(): { embeds: DiscordEmbed[]; attachments: string[] } {
  return connectionsReply(
    "Your Connections",
    `${LIST_DESCRIPTION}\n\n*You have no services linked yet!*`,
  );
}

const NOT_REGISTERED =
  "This channel is not registered yet. Run `/channel register` first, then link your accounts.";

/** Dispatch a parsed `/connections` command. Transport-agnostic. */
export async function handleConnectCommand(
  ctx: ConnectCommandContext,
  deps: ConnectCommandDeps,
): Promise<void> {
  const sub = (ctx.subcommand ?? "list").toLowerCase();

  if (sub === "list") {
    const connections = deps.store.list(ctx.channelId);
    if (connections === null) {
      await ctx.reply(connectionsReply("Your Connections", NOT_REGISTERED), { ephemeral: true });
      return;
    }
    if (connections.length === 0) {
      await ctx.reply(emptyListReply(), { ephemeral: true });
      return;
    }
    const emoji = deps.emoji ?? DEFAULT_CONNECTION_EMOJI;
    await ctx.reply(listReply(deps.registry, connections, emoji), { ephemeral: true });
    return;
  }

  if (sub === "add") {
    const connector = deps.registry.get(ctx.args[0]);
    if (!connector) {
      await ctx.reply(
        connectionsReply(
          "Connect",
          `Unknown service "${ctx.args[0] ?? ""}". Available: ${deps.registry.availableIds()}.`,
        ),
        { ephemeral: true },
      );
      return;
    }
    if (!connector.available) {
      await ctx.reply(
        connectionsReply(
          "Connect",
          `${connector.label} linking is coming soon. For now you can link: ${deps.registry.availableIds()}.`,
        ),
        { ephemeral: true },
      );
      return;
    }
    if (deps.store.list(ctx.channelId) === null) {
      await ctx.reply(connectionsReply("Connect", NOT_REGISTERED), { ephemeral: true });
      return;
    }

    const token = ctx.args[1];
    if (!token) {
      // No token yet: show setup instructions from the connector's auth flow. The
      // user comes back with `/connections add <service> <token>` (or the slash
      // command's token option).
      const prompt = connector.auth.begin();
      const howto = prompt.howto ? `\n\n${prompt.howto}` : "";
      const link = prompt.url ? `\n${prompt.url}` : "";
      await ctx.reply(
        connectionsReply(
          `Link ${connector.label}`,
          `${connector.summary}${howto}${link}\n\nThen run \`/connections add ${connector.id} <token>\` to finish. ` +
            `Your message with the token is deleted right after so it does not stay in chat.`,
        ),
        { ephemeral: true },
      );
      return;
    }

    // A token was provided. Scrub the visible message first (best-effort) so the
    // secret does not linger, then verify and store via the connector's auth flow.
    await ctx.scrubCommandMessage?.();

    const result = await connector.auth.complete(token);
    if (!result.ok) {
      await ctx.reply(
        connectionsReply(
          `Link ${connector.label}`,
          `That token did not work${result.message ? ` (${result.message})` : ""}. ` +
            `Double-check it and try \`/connections add ${connector.id} <token>\` again.`,
        ),
        { ephemeral: true },
      );
      deps.log(`[connect] ${connector.id} validation failed for ${ctx.userId}`);
      return;
    }
    saveLinked(deps, ctx.channelId, connector.id, result.token ?? token, result.accountLabel);
    await ctx.reply(
      connectionsReply(
        "Connected!",
        `${connector.label}${result.accountLabel ? ` (${result.accountLabel})` : ""} is now linked. ` +
          `Unlocks: ${connector.services.join(", ")}.`,
      ),
      { ephemeral: true },
    );
    deps.log(`[connect] ${connector.id} linked for ${ctx.userId}`);
    return;
  }

  if (sub === "remove") {
    const connector = deps.registry.get(ctx.args[0]);
    if (!connector) {
      await ctx.reply(
        connectionsReply(
          "Disconnect",
          `Unknown service "${ctx.args[0] ?? ""}". Available: ${deps.registry.availableIds()}.`,
        ),
        { ephemeral: true },
      );
      return;
    }
    if (deps.store.list(ctx.channelId) === null) {
      await ctx.reply(connectionsReply("Disconnect", NOT_REGISTERED), { ephemeral: true });
      return;
    }
    const removed = deps.store.remove(ctx.channelId, connector.id);
    await ctx.reply(
      connectionsReply(
        "Disconnect",
        removed
          ? `${connector.label} has been unlinked.`
          : `${connector.label} was not linked, so there is nothing to remove.`,
      ),
      { ephemeral: true },
    );
    if (removed) {
      deps.log(`[connect] ${connector.id} unlinked for ${ctx.userId}`);
    }
    return;
  }

  await ctx.reply(
    connectionsReply(
      "Help",
      "Usage: `/connections list`, `/connections add <service> <token>`, or `/connections remove <service>`.",
    ),
    { ephemeral: true },
  );
}

/** Persist a successful link. */
function saveLinked(
  deps: ConnectCommandDeps,
  channelId: string,
  connectorId: string,
  token: string,
  accountLabel?: string,
): void {
  deps.store.save(channelId, {
    connectorId,
    status: "linked",
    token,
    ...(accountLabel ? { accountLabel } : {}),
    linkedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
}
