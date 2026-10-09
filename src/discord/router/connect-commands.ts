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
  // Guild + 1:1 DM only. Group DMs (context 2) are excluded, matching /secret: a
  // group DM has several participants and no owner to gate on, so any member could
  // otherwise read or change the channel owner's stored credentials.
  contexts: [0, 1],
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
  /**
   * A stable identity for the channel's current instance (e.g. its instance dir),
   * or null when the channel is not registered. Snapshotted before a slow token
   * validation so {@link ConnectionStore.save} can detect the channel being
   * unregistered or re-registered to a different instance in the meantime.
   */
  instanceKey: (channelId: string) => string | null;
  /**
   * Persist a connection, but only if the channel still maps to the instance
   * identified by `expectedKey`. Returns false (writing nothing) when the channel
   * is no longer registered or now points at a different instance, so the caller
   * never reports success after silently dropping the token or writing it into a
   * different owner's instance.
   */
  save: (channelId: string, connection: StoredConnection, expectedKey: string) => boolean;
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
   * command, so the secret does not linger in channel history. Resolves true when
   * the delete is confirmed and false when it was attempted but failed (so the
   * handler can warn the user). Omitted for slash commands (their option values
   * are never posted as a message) and for text commands without a token.
   */
  scrubCommandMessage?: () => Promise<boolean>;
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
 * matching the Property/Value layout of `/channel status`. The table is always
 * rendered, even when nothing is linked yet: a freshly registered channel is
 * exactly when the user needs to discover what they can link, so every connector
 * shows (as "Not connected" or "Coming soon"). When nothing is linked a friendly
 * note is appended under the description.
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
    // A not-yet-available connector (e.g. Google) can never be linked yet, so
    // show "Coming soon" rather than the "Not connected" cell, which would imply
    // the user could connect it right now.
    statuses.push(
      connector.available ? statusCell(byId.get(connector.id) ?? null, emoji) : "Coming soon",
    );
  }
  const description =
    connections.length === 0
      ? `${LIST_DESCRIPTION}\n\n*You have no services linked yet!*`
      : LIST_DESCRIPTION;
  return connectionsReply("Your Connections", description, [
    { name: "Service Name", value: services.join("\n"), inline: true },
    { name: "Status", value: statuses.join("\n"), inline: true },
  ]);
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
    const emoji = deps.emoji ?? DEFAULT_CONNECTION_EMOJI;
    await ctx.reply(listReply(deps.registry, connections, emoji), { ephemeral: true });
    return;
  }

  if (sub === "add") {
    // Scrub the pasted token FIRST, before any early return. The gateway only
    // wires scrubCommandMessage when the command actually carried a token, so a
    // no-token `add` is a no-op here; but when a token is present it must be
    // deleted even if the service is unknown/unavailable or the channel is
    // unregistered, or the secret would linger in channel history on those paths.
    const scrubResult = await ctx.scrubCommandMessage?.();
    // scrubResult is undefined when there was nothing to scrub (slash command, or
    // no token). Only an explicit `false` means the delete was attempted and
    // failed, in which case every reply below warns the user to delete it by hand.
    const scrubFailed = scrubResult === false;
    const withScrubNote = (body: string): string =>
      scrubFailed
        ? `${body}\n\nI could not delete your message containing the token. Please delete it ` +
          `manually so it does not stay in chat.`
        : body;

    const connector = deps.registry.get(ctx.args[0]);
    if (!connector) {
      await ctx.reply(
        connectionsReply(
          "Connect",
          withScrubNote(
            `Unknown service "${ctx.args[0] ?? ""}". Available: ${deps.registry.availableIds()}.`,
          ),
        ),
        { ephemeral: true },
      );
      return;
    }
    if (!connector.available) {
      await ctx.reply(
        connectionsReply(
          "Connect",
          withScrubNote(
            `${connector.label} linking is coming soon. For now you can link: ${deps.registry.availableIds()}.`,
          ),
        ),
        { ephemeral: true },
      );
      return;
    }
    // Snapshot the channel's instance identity now, before the (possibly slow)
    // token validation. `save` below requires it to still match, so a channel
    // unregistered or re-registered to a different instance during validation
    // fails instead of silently dropping the token or writing it elsewhere.
    const instanceKey = deps.store.instanceKey(ctx.channelId);
    if (instanceKey === null) {
      await ctx.reply(connectionsReply("Connect", withScrubNote(NOT_REGISTERED)), {
        ephemeral: true,
      });
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

    const result = await connector.auth.complete(token);
    if (!result.ok) {
      await ctx.reply(
        connectionsReply(
          `Link ${connector.label}`,
          withScrubNote(
            `That token did not work${result.message ? ` (${result.message})` : ""}. ` +
              `Double-check it and try \`/connections add ${connector.id} <token>\` again.`,
          ),
        ),
        { ephemeral: true },
      );
      deps.log(`[connect] ${connector.id} validation failed for ${ctx.userId}`);
      return;
    }
    const saved = saveLinked(
      deps,
      ctx.channelId,
      connector.id,
      result.token ?? token,
      result.accountLabel,
      instanceKey,
    );
    if (!saved) {
      await ctx.reply(
        connectionsReply(
          `Link ${connector.label}`,
          withScrubNote(
            "This channel's registration changed while I was verifying the token, so I did not " +
              `store it. Please run \`/connections add ${connector.id} <token>\` again.`,
          ),
        ),
        { ephemeral: true },
      );
      deps.log(`[connect] ${connector.id} save skipped for ${ctx.userId} (instance changed)`);
      return;
    }
    await ctx.reply(
      connectionsReply(
        "Connected!",
        withScrubNote(
          `${connector.label}${result.accountLabel ? ` (${result.accountLabel})` : ""} is now linked. ` +
            `Unlocks: ${connector.services.join(", ")}.`,
        ),
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

/** Persist a successful link; returns false if the instance changed under us. */
function saveLinked(
  deps: ConnectCommandDeps,
  channelId: string,
  connectorId: string,
  token: string,
  accountLabel: string | undefined,
  expectedKey: string,
): boolean {
  return deps.store.save(
    channelId,
    {
      connectorId,
      status: "linked",
      token,
      ...(accountLabel ? { accountLabel } : {}),
      linkedAt: (deps.now?.() ?? new Date()).toISOString(),
    },
    expectedKey,
  );
}
