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
import {
  CONNECTORS,
  type ConnectorDef,
  availableConnectorIds,
  getConnector,
} from "./connectors.js";
import { buildEmbed } from "./embed-categories.js";

export type ConnectSubcommand = "list" | "add" | "remove";

/** Service choices for the slash command, built from the catalog. */
const SERVICE_CHOICES = CONNECTORS.map((c) => ({ name: c.label, value: c.id }));

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

/** Result of validating a pasted token against the service's API. */
export type TokenValidation = { ok: boolean; accountLabel?: string; message?: string };

export type ConnectCommandDeps = {
  store: ConnectionStore;
  /**
   * Validate a pasted token against the service (e.g. GET /user). Optional: when
   * omitted, tokens are stored without a live check. Keeps the handler testable
   * and lets the router wire real fetch calls.
   */
  validateToken?: (connectorId: string, token: string) => Promise<TokenValidation>;
  /** Current time, injectable for deterministic tests. */
  now?: () => Date;
  log: (message: string) => void;
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

/** Status glyph for a connector given its stored connection (if any). */
function statusGlyph(connector: ConnectorDef, connection: StoredConnection | null): string {
  if (!connector.available) {
    return "🚧";
  }
  const status: ConnectionStatus = connection?.status ?? "not_linked";
  if (status === "linked") {
    return "✅";
  }
  if (status === "needs_reauth") {
    return "♻️";
  }
  return "⚪";
}

/** One line in the status embed for a connector. */
function statusLine(connector: ConnectorDef, connection: StoredConnection | null): string {
  const glyph = statusGlyph(connector, connection);
  const account = connection?.accountLabel ? ` (${connection.accountLabel})` : "";
  const note = !connector.available ? " — coming soon" : "";
  return `${glyph} **${connector.label}**${account}${note}`;
}

/** Build the `/connections list` status embed from the catalog plus stored connections. */
function listReply(connections: StoredConnection[]): {
  embeds: DiscordEmbed[];
  attachments: string[];
} {
  const byId = new Map(connections.map((c) => [c.connectorId, c]));
  const lines = CONNECTORS.map((connector) =>
    statusLine(connector, byId.get(connector.id) ?? null),
  ).join("\n");
  return connectionsReply(
    "Your connections",
    `${lines}\n\nUse \`/connections add <service>\` to link one, or \`/connections remove <service>\` to unlink.`,
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
      await ctx.reply(connectionsReply("Connections", NOT_REGISTERED), { ephemeral: true });
      return;
    }
    await ctx.reply(listReply(connections), { ephemeral: true });
    return;
  }

  if (sub === "add") {
    const connector = getConnector(ctx.args[0]);
    if (!connector) {
      await ctx.reply(
        connectionsReply(
          "Connect",
          `Unknown service "${ctx.args[0] ?? ""}". Available: ${availableConnectorIds()}.`,
        ),
        { ephemeral: true },
      );
      return;
    }
    if (!connector.available) {
      await ctx.reply(
        connectionsReply(
          "Connect",
          `${connector.label} linking is coming soon. For now you can link: ${availableConnectorIds()}.`,
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
      // No token yet: show setup instructions. The user comes back with
      // `/connections add <service> <token>` (or the slash command's token option).
      const howto = connector.tokenHowto ? `\n\n${connector.tokenHowto}` : "";
      const link = connector.tokenUrl ? `\n${connector.tokenUrl}` : "";
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
    // secret does not linger, then validate and store.
    await ctx.scrubCommandMessage?.();

    if (deps.validateToken) {
      const result = await deps.validateToken(connector.id, token);
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
      saveLinked(deps, ctx.channelId, connector.id, token, result.accountLabel);
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

    saveLinked(deps, ctx.channelId, connector.id, token);
    await ctx.reply(
      connectionsReply(
        "Connected!",
        `${connector.label} is now linked. Unlocks: ${connector.services.join(", ")}.`,
      ),
      { ephemeral: true },
    );
    deps.log(`[connect] ${connector.id} linked for ${ctx.userId} (no validation)`);
    return;
  }

  if (sub === "remove") {
    const connector = getConnector(ctx.args[0]);
    if (!connector) {
      await ctx.reply(
        connectionsReply(
          "Disconnect",
          `Unknown service "${ctx.args[0] ?? ""}". Available: ${availableConnectorIds()}.`,
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
      "Connections",
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
