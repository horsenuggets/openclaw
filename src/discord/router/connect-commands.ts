/**
 * `/connect` command: link external accounts (connections) to a channel's agent
 * and see their status. Modeled on channel-commands.ts: transport-agnostic, the
 * router adapts both a real Discord slash command and a plain `/connect` text
 * message into a ConnectCommandContext and calls handleConnectCommand. Storage
 * and token validation are injected (ConnectCommandDeps) so this module never
 * touches the filesystem or network and stays unit-testable.
 *
 * Direct-token connectors (Todoist, Notion, GitHub) link in one step: paste a token.
 * OAuth connectors link in two steps: the first `add` shows an authorize link and
 * stashes a `pending` blob (PKCE verifier + CSRF state) via the injected
 * PendingAuthStore; the second `add` (with the pasted redirect URL or code) completes
 * the exchange. A router-side credential broker is a later phase.
 */

import type {
  ChannelReply,
  DiscordActionRow,
  DiscordEmbed,
  DiscordEmbedField,
} from "./channel-commands.js";
import type { ConnectionStatus, DisplayConnection, StoredConnection } from "./connections-store.js";
import { type Connector, type ConnectorRegistry, connectorRegistry } from "./connectors.js";
import { buildEmbed } from "./embed-categories.js";
import { buildPaginatedEmbeds, chunkLinesIntoFields } from "./embed-pagination.js";
import { buildSubcommandFields } from "./subcommand-fields.js";

export type ConnectSubcommand = "list" | "add" | "remove" | "available" | "info";

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
    { name: "available", description: "List every service you can link", type: 1 },
    {
      name: "info",
      description: "Show stats about one of your connections",
      type: 1,
      options: [
        {
          name: "service",
          description: "Which service to inspect",
          type: 3, // STRING
          required: true,
          choices: SERVICE_CHOICES,
        },
      ],
    },
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
          description:
            "Paste your token, or the OAuth redirect URL (omit for setup instructions first)",
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
  list: (channelId: string) => DisplayConnection[] | null;
  get: (channelId: string, connectorId: string) => DisplayConnection | null;
  /**
   * A unique identity for the channel's current registration, or null when the
   * channel is not registered. It changes across unregister/re-register even when
   * the instance directory is reused.
   */
  instanceKey: (channelId: string) => string | null;
  /**
   * Persist a connection, but only if the channel still maps to the instance
   * identified by `expectedKey`. Returns false (writing nothing) when the channel
   * is no longer registered or its registration has changed, so a validated token
   * cannot be written into a later owner's instance.
   */
  save: (channelId: string, connection: StoredConnection, expectedKey: string) => boolean;
  /**
   * Remove a connection. `"removed"` when one was deleted, `"absent"` when there
   * was nothing to remove, and `"error"` when the entry exists but the rewrite
   * failed (e.g. a read-only mount) — distinguished so a failed unlink is never
   * reported to the user as "was not linked" while the credential is still stored.
   */
  remove: (channelId: string, connectorId: string) => RemoveResult;
};

export type RemoveResult = "removed" | "absent" | "error";

/**
 * Storage for an in-flight OAuth link's between-step `pending` blob (the PKCE
 * verifier + CSRF state), keyed by channel and connector. `begin()` mints the blob
 * and the user finishes with a second `/connections add` command, so it must persist
 * across the two calls. Backed per-instance by pending-auth-store.ts; injected here so
 * the handler stays fs-free. Flows that carry no between-step state (direct tokens)
 * never touch it.
 */
export type PendingAuthStore = {
  /** The pending blob for a connector, or null when none is in flight. */
  get: (channelId: string, connectorId: string) => string | null;
  /**
   * Persist the pending blob, but only if the channel still maps to the instance
   * identified by `expectedKey` (same guard as the connection store). Returns false
   * (writing nothing) when the registration changed or storage is unavailable.
   */
  save: (channelId: string, connectorId: string, pending: string, expectedKey: string) => boolean;
  /** Drop the pending blob once the exchange completes (best-effort; never throws). */
  remove: (channelId: string, connectorId: string) => void;
};

export type ConnectCommandDeps = {
  store: ConnectionStore;
  /** Between-step storage for OAuth flows (see {@link PendingAuthStore}). */
  pendingAuth: PendingAuthStore;
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
  connecting: string;
  notConnected: string;
  needsAuth: string;
};

/** Unicode fallbacks used when the bot's custom app emoji are unavailable. */
export const DEFAULT_CONNECTION_EMOJI: ConnectionEmoji = {
  connected: "✅",
  connecting: "⬜",
  notConnected: "❌",
  needsAuth: "⚠️",
};

export type ConnectCommandContext = {
  subcommand: string | null;
  args: string[];
  channelId: string;
  userId: string;
  isDM: boolean;
  /** Registration identity captured when the caller was authorized. */
  authorizedInstanceKey?: string | null;
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

/**
 * Build a Connections-category embed reply, optionally carrying an action row.
 * `title` and `description` are optional so a reply can be field-only (e.g.
 * `/connections available`); pass `undefined` rather than an empty string so no
 * blank title/description line renders.
 */
function connectionsReply(
  title: string | undefined,
  description: string | undefined,
  fields?: DiscordEmbedField[],
  components?: DiscordActionRow[],
): { embeds: DiscordEmbed[]; attachments: string[]; components?: DiscordActionRow[] } {
  const built = buildEmbed({
    category: "connections",
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(fields ? { fields } : {}),
  });
  return {
    embeds: [built.embed],
    attachments: built.attachments,
    ...(components ? { components } : {}),
  };
}

/** custom_id prefix for the `/connections info` Reauthenticate button. */
export const CONN_REAUTH_PREFIX = "conn:reauth";

/** custom_id prefix for the `/connections info` Remove Connection button. */
export const CONN_REMOVE_PREFIX = "conn:remove";

/**
 * The text the Reauthenticate and Remove Connection buttons reply with (neither
 * flow is wired yet, so both answer with a plain TODO).
 */
export const CONN_REAUTH_TODO = "TODO";

/** Build the Reauthenticate button custom_id, namespaced by connector id. */
export function buildReauthCustomId(connectorId: string): string {
  return `${CONN_REAUTH_PREFIX}:${connectorId}`;
}

/** Build the Remove Connection button custom_id, namespaced by connector id. */
export function buildRemoveConnectionCustomId(connectorId: string): string {
  return `${CONN_REMOVE_PREFIX}:${connectorId}`;
}

/**
 * Parse a Reauthenticate button custom_id, returning the connector id or null for
 * unrelated ids. The connector id may itself be any catalog id; only the fixed
 * two-segment prefix is matched so the id is taken verbatim as the remainder.
 */
export function parseReauthCustomId(customId: string): { connectorId: string } | null {
  const prefix = `${CONN_REAUTH_PREFIX}:`;
  if (!customId.startsWith(prefix)) {
    return null;
  }
  const connectorId = customId.slice(prefix.length);
  return connectorId ? { connectorId } : null;
}

/**
 * Parse a Remove Connection button custom_id, returning the connector id or null
 * for unrelated ids. Mirrors {@link parseReauthCustomId}: only the fixed
 * two-segment prefix is matched so the id is taken verbatim as the remainder.
 */
export function parseRemoveConnectionCustomId(customId: string): { connectorId: string } | null {
  const prefix = `${CONN_REMOVE_PREFIX}:`;
  if (!customId.startsWith(prefix)) {
    return null;
  }
  const connectorId = customId.slice(prefix.length);
  return connectorId ? { connectorId } : null;
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

/**
 * True when a parsed text command might carry a pasted token (so the originating
 * message must be scrubbed). Fail-safe: ANY argument after `add` counts, not just
 * a second one. `/connections add <token>` (service omitted) puts the secret in
 * the first argument, so requiring two args would leave that common mistake
 * unscrubbed.
 */
export function connectTextCommandHasToken(parsed: {
  subcommand: string | null;
  args: string[];
}): boolean {
  return (parsed.subcommand ?? "").toLowerCase() === "add" && parsed.args.length >= 1;
}

/** The short status label shown in the Legend (also the word in each glyph key). */
const STATUS_LABEL: Record<ConnectionStatus, string> = {
  linked: "Connected!",
  connecting: "Pinging...",
  needs_reauth: "Needs authentication.",
  not_linked: "Not connected.",
};

/** The status glyph (custom emoji, unicode fallback) for a display status. */
function statusGlyph(status: ConnectionStatus, emoji: ConnectionEmoji): string {
  if (status === "linked") {
    return emoji.connected;
  }
  if (status === "connecting") {
    return emoji.connecting;
  }
  if (status === "needs_reauth") {
    return emoji.needsAuth;
  }
  return emoji.notConnected;
}

const LIST_TITLE = "Your Connections";
const LIST_DESCRIPTION =
  "Below are accounts linked to this channel's agent. You can use the following " +
  "subcommands to manage your connections...";

const LIST_EMPTY =
  "You have not linked any accounts yet. Below are all of the currently-registered " +
  "subcommands under the `/connections` command...";

/**
 * The subcommand previews, debug-help style (backtick usage + one-line value).
 * Rendered via the shared helper (same shape as `/debug help`), in the authored
 * order that matches the `/connections` command surface.
 */
const SUBCOMMAND_FIELDS: DiscordEmbedField[] = buildSubcommandFields("/connections", [
  { usage: "add <service>", description: "Connect a new service." },
  { usage: "available", description: "List out available services you can connect to." },
  { usage: "info <service>", description: "Get info about a service." },
  { usage: "list", description: "List your currently-linked accounts." },
  { usage: "remove <service>", description: "Remove a service." },
]);

const COUNT_FIELD_NAME = "Currently Connected";
const LEGEND_FIELD_NAME = "Legend";
const SERVICES_FIELD_NAME = "Services";
/** Statuses listed in the Legend, in display order (every list uses only these). */
const LEGEND_STATUSES: readonly ConnectionStatus[] = ["linked", "needs_reauth", "connecting"];
/** Longer service names are truncated to this many characters with an ellipsis. */
const NAME_MAX = 20;

/** Truncate an over-long service name, replacing the tail with an ellipsis. */
function truncateServiceName(label: string): string {
  if (label.length <= NAME_MAX) {
    return label;
  }
  return `${label.slice(0, NAME_MAX - 1).trimEnd()}\u2026`;
}

/** The Legend value: one `"Label" -> glyph` line per status (always all three). */
function legendValue(emoji: ConnectionEmoji): string {
  return LEGEND_STATUSES.map(
    (status) => `"${STATUS_LABEL[status]}" \u2192 ${statusGlyph(status, emoji)}`,
  ).join("\n");
}

/**
 * Build the `/connections list` reply as two embeds in one message (by default):
 * the first carries the title, description, and the `/connections` subcommand
 * previews; the second carries the Currently Connected count, the status Legend, and
 * the Services list (one `glyph name` line per service, the status shown by the glyph
 * and decoded by the Legend). Both are packed by the shared buildPaginatedEmbeds,
 * so a long Services list repeats as several Services fields on the second embed,
 * and if the shared message budget is exhausted a truncation note is appended.
 * Only services that are actually linked (connected, re-auth needed, or a transient
 * ping) are listed, regardless of whether the connector's connect flow is wired.
 * When nothing is linked, a single embed shows a friendly note plus the subcommands.
 */
function listReply(
  registry: ConnectorRegistry,
  connections: DisplayConnection[],
  emoji: ConnectionEmoji,
): {
  embeds: DiscordEmbed[];
  attachments: string[];
} {
  const byId = new Map(connections.map((c) => [c.connectorId, c]));
  // Walk the catalog (for stable display order) and keep every connector that has a
  // live connection to show. The `available` flag no longer gates listing: a linked
  // record is shown whether or not its connect flow is wired.
  const linked = registry
    .all()
    .map((connector) => ({ connector, connection: byId.get(connector.id) ?? null }))
    .filter(
      (entry): entry is { connector: Connector; connection: DisplayConnection } =>
        entry.connection !== null && entry.connection.status !== "not_linked",
    );
  if (linked.length === 0) {
    // Nothing linked: a single embed with the empty note and the subcommands, so
    // the user still sees how to connect.
    return buildPaginatedEmbeds({
      category: "connections",
      title: LIST_TITLE,
      description: LIST_EMPTY,
      groups: [SUBCOMMAND_FIELDS],
    });
  }

  const connected = linked.filter(({ connection }) => connection.status === "linked").length;
  const total = linked.length;
  const serviceLines = linked.map(
    ({ connector, connection }) =>
      `${statusGlyph(connection.status, emoji)} ${truncateServiceName(connector.label)}`,
  );

  // Second embed's fields: the count, the legend, then the Services list chunked
  // under the per-field cap (each chunk keeps the "Services" header).
  const contentFields: DiscordEmbedField[] = [
    { name: COUNT_FIELD_NAME, value: `\`${connected}/${total}\`` },
    { name: LEGEND_FIELD_NAME, value: legendValue(emoji) },
    ...chunkLinesIntoFields(SERVICES_FIELD_NAME, serviceLines),
  ];

  return buildPaginatedEmbeds({
    category: "connections",
    title: LIST_TITLE,
    description: LIST_DESCRIPTION,
    groups: [SUBCOMMAND_FIELDS, contentFields],
    truncationField: {
      name: "\u2026",
      value: "Some services were omitted because the list exceeded Discord's message limit.",
    },
  });
}

const AVAILABLE_FIELD_NAME = "Available Services";

/**
 * The "Available Services" field: one `` `id` -> Label `` line per catalogued
 * connector, sorted alphabetically by id. Shared by the `available` subcommand and
 * the unknown-service error so both show the same canonical list.
 */
function availableServicesField(registry: ConnectorRegistry): DiscordEmbedField {
  const lines = registry
    .all()
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((c) => `\`${c.id}\` \u2192 ${c.label}`)
    .join("\n");
  return { name: AVAILABLE_FIELD_NAME, value: lines };
}

/**
 * Build the `/connections available` reply: a single Connections-category embed
 * carrying ONLY the "Available Services" field (no title, no description) listing
 * every catalogued connector. Read-only and owner-safe (static catalog).
 */
function availableReply(registry: ConnectorRegistry): {
  embeds: DiscordEmbed[];
  attachments: string[];
} {
  return connectionsReply(undefined, undefined, [availableServicesField(registry)]);
}

/**
 * The status sentence appended to the `/connections info` description. `not_linked`
 * never reaches the stats view (it is handled by the not-linked branch), but keep the
 * map total over ConnectionStatus so every case is covered.
 */
const INFO_STATUS_SENTENCE: Record<ConnectionStatus, string> = {
  linked: "You are currently connected!",
  connecting: "We are attempting to connect you now!",
  needs_reauth: "Pinging has failed; you may need to reauthenticate.",
  not_linked: "You are not connected.",
};

const INFO_SERVICES_FIELD_NAME = "Skills Available";

/** Human label for how a connector authenticates, derived from its auth flow. */
function authTypeLabel(connector: Connector): string {
  // Derive from the flow, never per-id: OAuth connectors run a hosted dance, every
  // other flow (direct token paste, CLI) hands over a token the user already holds.
  return connector.auth.authKind === "oauth" ? "OAuth" : "Pasted token";
}

/**
 * Build the `/connections info <service>` stats view for a LINKED connection: a
 * Connections embed titled `Your Connections » <Label>` with the per-connection
 * stats as inline fields (Status glyph, Account, Linked date, Auth Type, Last Ping)
 * plus a non-inline Skills Available list, and an action row with a Primary
 * "Reauthenticate" button followed by a Danger "Remove Connection" button.
 */
function infoReply(
  connector: Connector,
  connection: DisplayConnection,
  emoji: ConnectionEmoji,
): { embeds: DiscordEmbed[]; attachments: string[]; components?: DiscordActionRow[] } {
  const linkedUnix = Math.floor(new Date(connection.linkedAt).getTime() / 1000);
  const linkedValue = Number.isFinite(linkedUnix) ? `<t:${linkedUnix}:D>` : "Unknown";
  const fields: DiscordEmbedField[] = [
    { name: "Status", value: statusGlyph(connection.status, emoji), inline: true },
    { name: "Account", value: connection.accountLabel ?? "Unknown", inline: true },
    { name: "Linked", value: linkedValue, inline: true },
    { name: "Auth Type", value: authTypeLabel(connector), inline: true },
    // No last-ping time is tracked yet; the field is present with a TODO value on
    // purpose until ping tracking lands.
    { name: "Last Ping", value: "TODO", inline: true },
    { name: INFO_SERVICES_FIELD_NAME, value: connector.services.join(", "), inline: false },
  ];
  // Reauthenticate (primary) first, then Remove Connection (danger) to its right.
  const actionRow: DiscordActionRow = {
    type: 1,
    components: [
      {
        type: 2,
        style: 1, // primary
        label: "Reauthenticate",
        custom_id: buildReauthCustomId(connector.id),
      },
      {
        type: 2,
        style: 4, // danger
        label: "Remove Connection",
        custom_id: buildRemoveConnectionCustomId(connector.id),
      },
    ],
  };
  return connectionsReply(
    `${LIST_TITLE} \u00bb ${connector.label}`,
    `Below are some stats about your current **${connector.label}** connection. ` +
      INFO_STATUS_SENTENCE[connection.status],
    fields,
    [actionRow],
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
  const registrationIsCurrent = () =>
    ctx.authorizedInstanceKey === undefined ||
    deps.store.instanceKey(ctx.channelId) === ctx.authorizedInstanceKey;
  const registrationChanged = async () =>
    ctx.reply(
      connectionsReply(
        "Connections",
        "This channel's registration changed while handling your command. Please try again.",
      ),
      { ephemeral: true },
    );

  if (sub === "list") {
    if (!registrationIsCurrent()) {
      await registrationChanged();
      return;
    }
    const connections = deps.store.list(ctx.channelId);
    if (connections === null) {
      await ctx.reply(connectionsReply("Your Connections", NOT_REGISTERED), { ephemeral: true });
      return;
    }
    const emoji = deps.emoji ?? DEFAULT_CONNECTION_EMOJI;
    await ctx.reply(listReply(deps.registry, connections, emoji), { ephemeral: true });
    return;
  }

  if (sub === "available") {
    // Read-only, owner-safe listing of every catalogued service. No registration or
    // ownership check: it reveals nothing channel-specific, just the static catalog.
    await ctx.reply(availableReply(deps.registry), { ephemeral: true });
    return;
  }

  if (sub === "info") {
    const connector = deps.registry.get(ctx.args[0]);
    if (!connector) {
      // Unknown service: reuse the shared Available Services field, mirroring `add`.
      await ctx.reply(
        connectionsReply("Info", `\`${ctx.args[0] ?? ""}\` is not a valid service.`, [
          availableServicesField(deps.registry),
        ]),
        { ephemeral: true },
      );
      return;
    }
    if (!registrationIsCurrent()) {
      await registrationChanged();
      return;
    }
    const connections = deps.store.list(ctx.channelId);
    if (connections === null) {
      await ctx.reply(connectionsReply(`${LIST_TITLE} \u00bb ${connector.label}`, NOT_REGISTERED), {
        ephemeral: true,
      });
      return;
    }
    const connection = deps.store.get(ctx.channelId, connector.id);
    if (!connection || connection.status === "not_linked") {
      await ctx.reply(
        connectionsReply(
          `${LIST_TITLE} \u00bb ${connector.label}`,
          `You have not linked ${connector.label} yet. ` +
            `Use \`/connections add ${connector.id}\` to link it.`,
        ),
        { ephemeral: true },
      );
      return;
    }
    const emoji = deps.emoji ?? DEFAULT_CONNECTION_EMOJI;
    await ctx.reply(infoReply(connector, connection, emoji), { ephemeral: true });
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

    if (!registrationIsCurrent()) {
      await ctx.reply(
        connectionsReply(
          "Connect",
          withScrubNote(
            "This channel's registration changed while handling your command. Please try again.",
          ),
        ),
        { ephemeral: true },
      );
      return;
    }

    const connector = deps.registry.get(ctx.args[0]);
    if (!connector) {
      // Never echo ctx.args[0] back when a token-carrying text command was scrubbed:
      // if the user omitted the service (`/connections add <token>`), args[0] IS the
      // credential, and the reply is delivered publicly despite the ephemeral hint
      // (the text adapter cannot send ephemerally). Only name the unknown id when no
      // scrub callback is present (slash command, or a text command with no token),
      // where args[0] is safe to surface.
      const named = ctx.scrubCommandMessage
        ? "That is not a valid service."
        : `\`${ctx.args[0] ?? ""}\` is not a valid service.`;
      await ctx.reply(
        connectionsReply("Connect", withScrubNote(named), [availableServicesField(deps.registry)]),
        { ephemeral: true },
      );
      return;
    }
    if (!connector.available) {
      // The connect flow for this service is not implemented yet: show a blank TODO
      // placeholder rather than running begin(). It is still listed and selectable.
      await ctx.reply(
        connectionsReply(`Connect \u00bb ${connector.label}`, withScrubNote("TODO")),
        {
          ephemeral: true,
        },
      );
      return;
    }
    // Snapshot the channel's instance identity now, before the (possibly slow)
    // token validation. `save` below requires it to still match, so a channel
    // unregistered or re-registered to a different instance during validation
    // fails instead of silently dropping the token or writing it elsewhere.
    const instanceKey =
      ctx.authorizedInstanceKey === undefined
        ? deps.store.instanceKey(ctx.channelId)
        : ctx.authorizedInstanceKey;
    if (instanceKey === null) {
      await ctx.reply(connectionsReply("Connect", withScrubNote(NOT_REGISTERED)), {
        ephemeral: true,
      });
      return;
    }

    const token = ctx.args[1];
    if (!token) {
      // No token yet: show how to start linking. begin() returns instructions and,
      // for OAuth, an authorize URL plus an opaque `pending` blob (the PKCE verifier
      // + CSRF state) that complete() needs. Persist that blob, keyed to this
      // instance, so the user's second command can finish the exchange.
      const prompt = connector.auth.begin();
      if (prompt.pending) {
        const stored = deps.pendingAuth.save(
          ctx.channelId,
          connector.id,
          prompt.pending,
          instanceKey,
        );
        if (!stored) {
          await ctx.reply(
            connectionsReply(
              `Link ${connector.label}`,
              withScrubNote(
                "I could not start the link right now (its storage is unavailable, or the " +
                  `channel's registration changed). Please try \`/connections add ${connector.id}\` again.`,
              ),
            ),
            { ephemeral: true },
          );
          return;
        }
      }
      const howto = prompt.howto ? `\n\n${prompt.howto}` : "";
      const linkLine = prompt.url ? `\n${prompt.url}` : "";
      // OAuth starts with an authorize link and finishes by pasting the redirect URL;
      // a direct connector finishes by pasting the token itself.
      const finish =
        connector.auth.outgoing === "link"
          ? "\n\nApprove access at the link above, then paste the URL you are redirected to " +
            `(or the code it shows) with \`/connections add ${connector.id} <pasted>\`.`
          : `\n\nThen run \`/connections add ${connector.id} <token>\` to finish. ` +
            "Your message with the token is deleted right after so it does not stay in chat.";
      await ctx.reply(
        connectionsReply(
          `Link ${connector.label}`,
          `${connector.summary}${howto}${linkLine}${finish}`,
        ),
        { ephemeral: true },
      );
      return;
    }

    // Finish the link. For OAuth, hand complete() the pending blob begin() stored so
    // it can verify the CSRF state and exchange the code with the original verifier;
    // a direct connector ignores it.
    const pending = deps.pendingAuth.get(ctx.channelId, connector.id) ?? undefined;
    const result = await connector.auth.complete(token, pending);
    // OAuth and direct connectors fail differently: an OAuth user pasted a redirect
    // URL/code and must restart the authorize dance, while a direct user re-pastes a
    // token. Shape the copy off the flow so the retry instruction is actionable.
    const isOAuth = connector.auth.outgoing === "link";
    const reason = result.ok ? "" : result.message ? ` (${result.message})` : "";
    if (!result.ok) {
      await ctx.reply(
        connectionsReply(
          `Link ${connector.label}`,
          withScrubNote(
            isOAuth
              ? `That did not work${reason}. Start over with \`/connections add ${connector.id}\`, ` +
                  "approve again, and paste the new URL."
              : `That token did not work${reason}. ` +
                  `Double-check it and try \`/connections add ${connector.id} <token>\` again.`,
          ),
        ),
        { ephemeral: true },
      );
      deps.log(`[connect] ${connector.id} validation failed for ${ctx.userId}`);
      return;
    }
    // Guard against a concurrent restart: the token exchange above is the only await
    // here, so if `begin()` replaced the pending blob while it was in flight, this
    // completion is stale. Reject it rather than persist the superseded account and
    // clobber the newer attempt's pending. (No further await follows, so the value
    // cannot change again between this check and the save/remove below.)
    if (pending !== undefined && deps.pendingAuth.get(ctx.channelId, connector.id) !== pending) {
      await ctx.reply(
        connectionsReply(
          `Link ${connector.label}`,
          withScrubNote(
            "A newer link attempt replaced this one. Please finish the most recent " +
              `\`/connections add ${connector.id}\` you started.`,
          ),
        ),
        { ephemeral: true },
      );
      deps.log(`[connect] ${connector.id} completion superseded for ${ctx.userId}`);
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
      const retry = isOAuth
        ? `start over with \`/connections add ${connector.id}\``
        : `try \`/connections add ${connector.id} <token>\` again`;
      await ctx.reply(
        connectionsReply(
          `Link ${connector.label}`,
          withScrubNote(
            `I verified the ${isOAuth ? "authorization" : "token"} but could not store the link ` +
              "(the channel may have been unregistered, or its storage is unavailable). " +
              `Please ${retry}.`,
          ),
        ),
        { ephemeral: true },
      );
      deps.log(`[connect] ${connector.id} save failed for ${ctx.userId} (not persisted)`);
      return;
    }
    // The link is stored, so any OAuth pending blob is consumed; drop it (no-op for
    // direct connectors, which never stored one). Kept on failure above so the user
    // can retry the paste against the same authorize session.
    deps.pendingAuth.remove(ctx.channelId, connector.id);
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
        connectionsReply("Disconnect", `\`${ctx.args[0] ?? ""}\` is not a valid service.`, [
          availableServicesField(deps.registry),
        ]),
        { ephemeral: true },
      );
      return;
    }
    if (!registrationIsCurrent()) {
      await registrationChanged();
      return;
    }
    if (deps.store.list(ctx.channelId) === null) {
      await ctx.reply(connectionsReply("Disconnect", NOT_REGISTERED), { ephemeral: true });
      return;
    }
    const result = deps.store.remove(ctx.channelId, connector.id);
    const message =
      result === "removed"
        ? `${connector.label} has been unlinked.`
        : result === "absent"
          ? `${connector.label} was not linked, so there is nothing to remove.`
          : `I could not unlink ${connector.label} right now — its storage is unavailable. ` +
            "It is still linked; please try again.";
    await ctx.reply(connectionsReply("Disconnect", message), { ephemeral: true });
    if (result === "removed") {
      deps.log(`[connect] ${connector.id} unlinked for ${ctx.userId}`);
    }
    return;
  }

  await ctx.reply(
    connectionsReply(
      "Help",
      "Usage: `/connections list`, `/connections available`, `/connections info <service>`, `/connections add <service> <token>`, or `/connections remove <service>`.",
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
