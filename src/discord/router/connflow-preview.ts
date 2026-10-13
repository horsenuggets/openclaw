/**
 * `/debug connflow` simulation. Drives the REAL `/connections` handler
 * (handleConnectCommand) against canned scenario data so the connections UX can be
 * previewed on demand, then re-skins the resulting embeds into the Debug category
 * (debug overrides every other identity, so the preview is unmistakably a debug
 * artifact even though its content is byte-for-byte the Connections output).
 *
 * The simulation is network-free and I/O-free: the store is an in-memory map and
 * the registry wraps the real connectors but swaps each one's auth for a canned
 * flow (real `begin()` instructions, a stubbed successful `complete()`), so even
 * the `add <service> <token>` success path renders without a real "who am I" call.
 *
 * Every scenario is an authorized, registered channel. There is deliberately no
 * "unregistered / register first" scenario: in production an unauthorized caller is
 * denied by the owner gate with the shared unauthorized notice before the handler
 * ever runs, so that path is not reachable here.
 */

import type { ChannelReplyPayload, DiscordEmbed } from "./channel-commands.js";
import type { DisplayConnection, StoredConnection } from "./connections-store.js";
import type { AuthPrompt, AuthResult, ConnectorAuth } from "./connector-auth.js";
import {
  type ConnectionEmoji,
  type ConnectionStore,
  DEFAULT_CONNECTION_EMOJI,
  handleConnectCommand,
} from "./connect-commands.js";
import { type Connector, ConnectorRegistry, connectorRegistry } from "./connectors.js";
import { EMBED_CATEGORIES, attachmentRef } from "./embed-categories.js";

/** A canned connections state to preview. Always an authorized, registered channel. */
export type ConnFlowScenario = {
  id: number;
  /** Short label shown in the usage embed. */
  label: string;
  /** One-line description shown in the usage embed. */
  description: string;
  /** Seed connections for the channel's store (empty models a registered, 0-link channel). */
  connections: DisplayConnection[];
};

const linkedAt = "2026-01-01T00:00:00.000Z";
const link = (connectorId: string, status: DisplayConnection["status"]): DisplayConnection => ({
  connectorId,
  status,
  accountLabel: "preview-account",
  linkedAt,
});

/**
 * The built-in scenarios. Ids are stable so `/debug connflow <id> ...` is a durable
 * reference. Connector ids match the real catalog (google is catalogued but not
 * linkable, so it never seeds a live connection here).
 */
export const CONNFLOW_SCENARIOS: readonly ConnFlowScenario[] = [
  {
    id: 1,
    label: "No connections",
    description: "Registered channel with nothing linked yet.",
    connections: [],
  },
  {
    id: 2,
    label: "Mixed",
    description: "Some linked, one needing re-auth, one mid-ping.",
    connections: [
      link("todoist", "linked"),
      link("notion", "needs_reauth"),
      link("github", "connecting"),
    ],
  },
  {
    id: 3,
    label: "All linked",
    description: "Every linkable service connected.",
    connections: [link("todoist", "linked"), link("notion", "linked"), link("github", "linked")],
  },
];

/** Look up a scenario by its numeric id. */
export function getConnFlowScenario(id: number): ConnFlowScenario | null {
  return CONNFLOW_SCENARIOS.find((s) => s.id === id) ?? null;
}

const PREVIEW_INSTANCE_KEY = "connflow-preview";

/** An in-memory, always-registered store seeded with the scenario's connections. */
function previewStore(connections: DisplayConnection[]): ConnectionStore {
  const map = new Map<string, DisplayConnection>(connections.map((c) => [c.connectorId, c]));
  return {
    list: () => [...map.values()],
    get: (_channelId, id) => map.get(id) ?? null,
    instanceKey: () => PREVIEW_INSTANCE_KEY,
    save: (_channelId, connection: StoredConnection) => {
      map.set(connection.connectorId, { ...connection });
      return true;
    },
    remove: (_channelId, id) => (map.delete(id) ? "removed" : "absent"),
  };
}

/** Canned auth: real instructions via `begin()`, a stubbed success via `complete()`. */
class PreviewAuth implements ConnectorAuth {
  constructor(private readonly real: ConnectorAuth) {}
  get kind() {
    return this.real.kind;
  }
  begin(): AuthPrompt {
    return this.real.begin();
  }
  complete(input: string | undefined): Promise<AuthResult> {
    return Promise.resolve({
      ok: true,
      token: input ?? "preview-token",
      accountLabel: "preview-account",
    });
  }
}

/** The real catalog with every connector's auth swapped for the network-free preview flow. */
function previewRegistry(): ConnectorRegistry {
  const connectors: Connector[] = connectorRegistry.all().map((c) => ({
    ...c,
    auth: new PreviewAuth(c.auth),
  }));
  return new ConnectorRegistry(connectors);
}

/** Re-skin connections embeds into the Debug category (color + footer + icon). */
function reskinToDebug(embeds: DiscordEmbed[]): { embeds: DiscordEmbed[]; attachments: string[] } {
  const debug = EMBED_CATEGORIES.debug;
  const reskinned = embeds.map((embed) => {
    const next: DiscordEmbed = { ...embed, color: debug.color };
    // Only footer-bearing embeds reference the icon (the paginated list puts the
    // footer on its last embed only), so rewrite the footer where present.
    if (next.footer) {
      next.footer = { text: debug.footerText, icon_url: attachmentRef(debug.icon) };
    }
    return next;
  });
  return { embeds: reskinned, attachments: [debug.icon] };
}

/**
 * Run `tokens` (a parsed `/connections` subcommand plus its args) against the
 * scenario and return the Debug-skinned embeds. `emoji` should be the sender's
 * resolved connection glyphs so the preview matches what users see; it falls back
 * to the unicode defaults.
 */
export async function simulateConnFlow(input: {
  scenario: ConnFlowScenario;
  tokens: string[];
  emoji?: ConnectionEmoji;
  now?: () => Date;
}): Promise<{ embeds: DiscordEmbed[]; attachments: string[] }> {
  const { scenario, tokens } = input;
  const captured: DiscordEmbed[] = [];
  await handleConnectCommand(
    {
      subcommand: tokens[0] ?? "list",
      args: tokens.slice(1),
      channelId: "connflow-preview-channel",
      userId: "connflow-preview-user",
      isDM: false,
      reply: (payload: ChannelReplyPayload) => {
        if (typeof payload !== "string") {
          captured.push(...payload.embeds);
        }
      },
    },
    {
      store: previewStore(scenario.connections),
      registry: previewRegistry(),
      emoji: input.emoji ?? DEFAULT_CONNECTION_EMOJI,
      ...(input.now ? { now: input.now } : {}),
      log: () => {},
    },
  );
  return reskinToDebug(captured);
}
