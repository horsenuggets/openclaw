import { describe, expect, it, vi } from "vitest";
import type { ChannelReplyPayload } from "./channel-commands.js";
import type { DisplayConnection, StoredConnection } from "./connections-store.js";
import { type AuthResult, CliAuth, DirectAuth, OAuthPkceAuth } from "./auth-flow.js";
import {
  CONN_REAUTH_TODO,
  CONNECTIONS_COMMAND_SPECS,
  type ConnectCommandContext,
  type ConnectCommandDeps,
  type ConnectionStore,
  type PendingAuthStore,
  buildReauthCustomId,
  connectTextCommandHasToken,
  handleConnectCommand,
  parseConnectTextCommand,
  parseReauthCustomId,
} from "./connect-commands.js";
import { type Connector, ConnectorRegistry } from "./connectors.js";

describe("parseConnectTextCommand", () => {
  it("parses the bare command, subcommands, and args", () => {
    expect(parseConnectTextCommand("/connections")).toEqual({ subcommand: null, args: [] });
    expect(parseConnectTextCommand("/connections list")).toEqual({ subcommand: "list", args: [] });
    expect(parseConnectTextCommand("/connections add todoist tok_123")).toEqual({
      subcommand: "add",
      args: ["todoist", "tok_123"],
    });
    expect(parseConnectTextCommand("  //connections remove github ")).toEqual({
      subcommand: "remove",
      args: ["github"],
    });
  });

  it("accepts the /conn alias", () => {
    expect(parseConnectTextCommand("/conn")).toEqual({ subcommand: null, args: [] });
    expect(parseConnectTextCommand("/conn add notion secret")).toEqual({
      subcommand: "add",
      args: ["notion", "secret"],
    });
    expect(parseConnectTextCommand("//conn list")).toEqual({ subcommand: "list", args: [] });
  });

  it("does not mistake /connections for the /conn alias", () => {
    // The longer name must win so the subcommand is not swallowed into the name.
    expect(parseConnectTextCommand("/connections add todoist t")).toEqual({
      subcommand: "add",
      args: ["todoist", "t"],
    });
  });

  it("returns null for non-connections messages", () => {
    expect(parseConnectTextCommand("hello")).toBeNull();
    expect(parseConnectTextCommand("/channel register")).toBeNull();
    expect(parseConnectTextCommand("connections todoist")).toBeNull();
    expect(parseConnectTextCommand("/connect list")).toBeNull();
    expect(parseConnectTextCommand("/connected")).toBeNull();
  });
});

describe("CONNECTIONS_COMMAND_SPECS", () => {
  it("registers /connections plus the /conn alias, usable in guilds and 1:1 DMs only", () => {
    expect(CONNECTIONS_COMMAND_SPECS.map((s) => s.name)).toEqual(["connections", "conn"]);
    for (const spec of CONNECTIONS_COMMAND_SPECS) {
      expect(spec.type).toBe(1); // CHAT_INPUT
      // Group DMs (context 2) are excluded, like /secret: no owner to gate on.
      expect(spec.contexts).toEqual([0, 1]);
    }
  });

  it("includes an info subcommand with a required service option", () => {
    for (const spec of CONNECTIONS_COMMAND_SPECS) {
      const info = spec.options?.find((o) => o.name === "info");
      expect(info?.type).toBe(1); // subcommand
      const service = info?.options?.find((o) => o.name === "service");
      expect(service?.type).toBe(3); // STRING
      expect(service?.required).toBe(true);
      expect((service?.choices ?? []).map((c) => c.value)).toContain("todoist");
    }
  });
});

describe("reauth custom_id", () => {
  it("round-trips a namespaced connector id", () => {
    expect(buildReauthCustomId("github")).toBe("conn:reauth:github");
    expect(parseReauthCustomId("conn:reauth:github")).toEqual({ connectorId: "github" });
    expect(CONN_REAUTH_TODO).toBe("TODO");
  });

  it("returns null for unrelated or empty ids", () => {
    expect(parseReauthCustomId("chan-unreg:1:2:3")).toBeNull();
    expect(parseReauthCustomId("conn:reauth:")).toBeNull();
    expect(parseReauthCustomId("conn:reauth")).toBeNull();
  });
});

describe("connectTextCommandHasToken", () => {
  it("is true for add with any argument (fail-safe), false otherwise", () => {
    expect(connectTextCommandHasToken({ subcommand: "add", args: ["todoist", "tok"] })).toBe(true);
    // Service omitted: the token is the sole arg, so this must still be scrubbed.
    expect(connectTextCommandHasToken({ subcommand: "add", args: ["ghp_tok"] })).toBe(true);
    expect(connectTextCommandHasToken({ subcommand: "add", args: [] })).toBe(false);
    expect(connectTextCommandHasToken({ subcommand: "list", args: [] })).toBe(false);
    expect(connectTextCommandHasToken({ subcommand: "remove", args: ["todoist", "x"] })).toBe(
      false,
    );
  });
});

const CHANNEL = "123456789012345678";
const USER = "111111111111111111";

const INSTANCE_KEY = "instance-dir-key";

/** In-memory store. `registered: false` makes every method behave as "no instance". */
function makeStore(registered = true, seed: DisplayConnection[] = []) {
  const map = new Map<string, DisplayConnection>(seed.map((c) => [c.connectorId, c]));
  const store: ConnectionStore = {
    list: () => (registered ? [...map.values()] : null),
    get: (_c, id) => (registered ? (map.get(id) ?? null) : null),
    instanceKey: () => (registered ? INSTANCE_KEY : null),
    save: (_c, connection, expectedKey) => {
      if (!registered || expectedKey !== INSTANCE_KEY) {
        return false;
      }
      map.set(connection.connectorId, connection);
      return true;
    },
    remove: (_c, id) => (map.delete(id) ? "removed" : "absent"),
  };
  return { store, map };
}

/** In-memory pending-auth store. `writable: false` models storage being unavailable. */
function makePendingAuth(writable = true) {
  const map = new Map<string, string>();
  const store: PendingAuthStore = {
    get: (_c, id) => map.get(id) ?? null,
    save: (_c, id, pending, expectedKey) => {
      if (!writable || expectedKey !== INSTANCE_KEY) {
        return false;
      }
      map.set(id, pending);
      return true;
    },
    remove: (_c, id) => {
      map.delete(id);
    },
  };
  return { store, map };
}

function makeCtx(
  subcommand: string | null,
  args: string[] = [],
  over: Partial<ConnectCommandContext> = {},
) {
  const replies: { payload: ChannelReplyPayload; ephemeral?: boolean }[] = [];
  const ctx: ConnectCommandContext = {
    subcommand,
    args,
    channelId: CHANNEL,
    userId: USER,
    isDM: true,
    reply: (payload, opts) => {
      replies.push({ payload, ephemeral: opts?.ephemeral });
    },
    ...over,
  };
  return { ctx, replies };
}

/**
 * A network-free connector registry built from the real auth classes. The
 * optional `validate` closure drives every paste-token connector's outcome, so
 * handler tests control linking without hitting the network. Mirrors the real
 * catalog's shape (Google unavailable; Todoist/Notion/GitHub paste-token).
 */
function makeRegistry(
  validate?: (id: string, token: string) => Promise<AuthResult>,
): ConnectorRegistry {
  const paste = (id: string, label: string, services: string[]): Connector => ({
    id,
    label,
    summary: `${label} summary`,
    services,
    skills: [id],
    available: true,
    auth: new DirectAuth({
      url: `https://example.com/${id}`,
      howto: `Get your ${label} token.`,
      validate: (token) => (validate ? validate(id, token) : Promise.resolve({ ok: true })),
    }),
  });
  return new ConnectorRegistry([
    {
      id: "google",
      label: "Google",
      summary: "Google summary",
      services: ["Gmail"],
      skills: ["gog"],
      available: false,
      auth: new CliAuth({ tool: "gog" }),
    },
    paste("todoist", "Todoist", ["Tasks", "Projects", "Labels"]),
    paste("notion", "Notion", ["Pages"]),
    paste("github", "GitHub", ["Repos"]),
  ]);
}

function makeDeps(over: Partial<ConnectCommandDeps> = {}): ConnectCommandDeps {
  return {
    store: over.store ?? makeStore().store,
    pendingAuth: over.pendingAuth ?? makePendingAuth().store,
    registry: over.registry ?? makeRegistry(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    log: () => {},
    ...over,
  };
}

/** A registry with one available OAuth-PKCE connector, network-free via `postForm`. */
function makeOAuthRegistry(
  postForm: (
    url: string,
    form: Record<string, string>,
  ) => Promise<{ ok: boolean; status: number; body: unknown }>,
): ConnectorRegistry {
  return new ConnectorRegistry([
    {
      id: "oauthy",
      label: "OAuthy",
      summary: "OAuthy summary",
      services: ["Stuff"],
      skills: ["oauthy"],
      available: true,
      auth: new OAuthPkceAuth({
        authorizeEndpoint: "https://provider.example/authorize",
        tokenEndpoint: "https://provider.example/token",
        clientId: () => "client-123",
        redirectUri: "http://127.0.0.1",
        scopes: ["read"],
        howto: "Approve access.",
        postForm,
        randomBytes: (size: number) => Buffer.alloc(size, 7),
      }),
    },
  ]);
}

/** Decode the CSRF state out of a stored pending blob (base64 JSON). */
function stateOf(pending: string): string {
  return (JSON.parse(Buffer.from(pending, "base64").toString("utf8")) as { state: string }).state;
}

/** Pull the first embed out of a reply payload (fails if it is a string). */
function embedOf(payload: ChannelReplyPayload) {
  expect(typeof payload).toBe("object");
  const obj = payload as {
    embeds: {
      title?: string;
      description?: string;
      color?: number;
      fields?: { name: string; value: string; inline?: boolean }[];
    }[];
  };
  return obj.embeds[0];
}

/** Pull every embed out of a reply payload (fails if it is a string). */
function embedsOf(payload: ChannelReplyPayload) {
  expect(typeof payload).toBe("object");
  const obj = payload as {
    embeds: {
      title?: string;
      description?: string;
      color?: number;
      footer?: { text: string; icon_url?: string };
      fields?: { name: string; value: string; inline?: boolean }[];
    }[];
  };
  return obj.embeds;
}

/** Concatenate every "Services" field value across all embeds. */
function servicesText(payload: ChannelReplyPayload) {
  return embedsOf(payload)
    .flatMap((e) => e.fields ?? [])
    .filter((f) => f.name === "Services")
    .map((f) => f.value)
    .join("\n");
}

/** The first field with `name` anywhere across the message's embeds. */
function fieldNamed(payload: ChannelReplyPayload, name: string) {
  return embedsOf(payload)
    .flatMap((e) => e.fields ?? [])
    .find((f) => f.name === name)?.value;
}

describe("handleConnectCommand list", () => {
  it("does not read connections after the authorized registration changes", async () => {
    let currentKey = "registration-a";
    const list = vi.fn(() => []);
    const store: ConnectionStore = {
      list,
      get: () => null,
      instanceKey: () => currentKey,
      save: () => false,
      remove: () => "absent",
    };
    currentKey = "registration-b";
    const { ctx, replies } = makeCtx("list", [], {
      authorizedInstanceKey: "registration-a",
    });

    await handleConnectCommand(ctx, makeDeps({ store }));

    expect(list).not.toHaveBeenCalled();
    expect(embedOf(replies[0].payload).description).toContain("registration changed");
  });

  it("tells unregistered channels to register first", async () => {
    const { ctx, replies } = makeCtx("list");
    await handleConnectCommand(ctx, makeDeps({ store: makeStore(false).store }));
    expect(embedOf(replies[0].payload).description).toContain("not registered");
    expect(replies[0].ephemeral).toBe(true);
  });

  it("lists linked services with a status glyph, not the whole catalog", async () => {
    const seed: DisplayConnection[] = [
      {
        connectorId: "todoist",
        status: "linked",
        token: "t",
        accountLabel: "chris",
        linkedAt: "2026-01-01T00:00:00Z",
      },
      // A not-yet-wired connector (Google) that carries a linked record is now shown
      // too: `available` no longer gates listing.
      {
        connectorId: "google",
        status: "linked",
        token: "g",
        linkedAt: "2026-01-01T00:00:00Z",
      },
    ];
    const { ctx, replies } = makeCtx("list");
    await handleConnectCommand(ctx, makeDeps({ store: makeStore(true, seed).store }));
    const services = servicesText(replies[0].payload);
    // Each service is one "glyph name" line; the default emoji is the unicode check.
    expect(services).toContain("✅ Todoist");
    expect(services).toContain("✅ Google");
    expect(services).not.toContain("(chris)"); // account label is not shown
    // Unlinked catalog services still never appear in the list.
    expect(services).not.toContain("Notion");
  });

  it("shows the data (count, legend, services) in one embed with NO subcommand fields", async () => {
    const seed: DisplayConnection[] = [
      { connectorId: "todoist", status: "linked", token: "t", linkedAt: "2026-01-01T00:00:00Z" },
      {
        connectorId: "notion",
        status: "needs_reauth",
        token: "n",
        linkedAt: "2026-01-01T00:00:00Z",
      },
      { connectorId: "github", status: "linked", token: "g", linkedAt: "2026-01-01T00:00:00Z" },
    ];
    const { ctx, replies } = makeCtx("list");
    await handleConnectCommand(ctx, makeDeps({ store: makeStore(true, seed).store }));
    const embeds = embedsOf(replies[0].payload);
    // Collapses to a single embed now that the subcommand previews no longer live here.
    expect(embeds).toHaveLength(1);
    expect(embeds[0].title).toBe("Your Connections");
    expect(embeds[0].description).toBe("Below are accounts linked to this channel's agent...");
    // The subcommand list is NO LONGER shown under /connections list.
    const names = (embeds[0].fields ?? []).map((f) => f.name);
    expect(names).not.toContain("`/connections add <service>`");
    expect(names).not.toContain("`/connections list`");
    expect(names).not.toContain("`/connections remove <service>`");
    // The single embed carries the count (2 of 3 shown are linked) and a full legend.
    expect(fieldNamed(replies[0].payload, "Currently Connected")).toBe("`2/3`");
    const legend = fieldNamed(replies[0].payload, "Legend") ?? "";
    expect(legend).toContain('"Connected!"');
    expect(legend).toContain('"Needs authentication."');
    expect(legend).toContain('"Pinging..."');
  });

  it("truncates over-long service names with an ellipsis", async () => {
    const registry = new ConnectorRegistry([
      {
        id: "verbose",
        label: "Salesforce Marketing Cloud",
        summary: "long",
        services: ["X"],
        skills: ["verbose"],
        available: true,
        auth: new DirectAuth({
          url: "https://example.com/verbose",
          howto: "token",
          validate: () => Promise.resolve({ ok: true }),
        }),
      },
    ]);
    const seed: DisplayConnection[] = [
      { connectorId: "verbose", status: "linked", token: "t", linkedAt: "2026-01-01T00:00:00Z" },
    ];
    const { ctx, replies } = makeCtx("list");
    await handleConnectCommand(ctx, makeDeps({ registry, store: makeStore(true, seed).store }));
    const services = servicesText(replies[0].payload);
    expect(services).toContain("\u2026");
    expect(services).not.toContain("Salesforce Marketing Cloud");
  });

  it("chunks a long Services list into repeated-header fields under the 1024 cap", async () => {
    // Enough linked services (with long custom-emoji glyphs) that the Services
    // column cannot fit one 1024-char field, forcing multiple "Services" fields.
    const specs = Array.from({ length: 60 }, (_, i) => ({
      id: `svc${i}`,
      label: `Service ${i}`,
      summary: "s",
      services: ["X"],
      skills: [`svc${i}`],
      available: true,
      auth: new DirectAuth({
        url: `https://example.com/svc${i}`,
        howto: "token",
        validate: () => Promise.resolve({ ok: true }),
      }),
    }));
    const registry = new ConnectorRegistry(specs);
    const seed: DisplayConnection[] = specs.map((s) => ({
      connectorId: s.id,
      status: "linked" as const,
      token: "t",
      linkedAt: "2026-01-01T00:00:00Z",
    }));
    const { ctx, replies } = makeCtx("list");
    await handleConnectCommand(
      ctx,
      makeDeps({
        registry,
        store: makeStore(true, seed).store,
        emoji: {
          connected: "<:greencheckfilled:1557056834068807791>",
          connecting: "<:bluecheckempty:1557056831040393348>",
          notConnected: "<:redxfilled:1557056838418174022>",
          needsAuth: "<:warningsquare:1557134247234379836>",
        },
      }),
    );
    const embeds = embedsOf(replies[0].payload);
    // Title on the first embed and footer on the last (now that the subcommand
    // previews no longer force a second embed, these 60 services pack into one).
    expect(embeds[0].title).toBe("Your Connections");
    expect(embeds[embeds.length - 1].footer?.text).toBe("Connections");
    // The Services list is still chunked into more than one repeated-header field.
    const serviceFields = embeds
      .flatMap((e) => e.fields ?? [])
      .filter((f) => f.name === "Services");
    expect(serviceFields.length).toBeGreaterThan(1);
    // No single field value breaches the 1024-char cap, and none is empty.
    for (const embed of embeds) {
      for (const field of embed.fields ?? []) {
        expect(field.value.length).toBeGreaterThan(0);
        expect(field.value.length).toBeLessThanOrEqual(1024);
      }
    }
  });

  it("uses injected custom emoji for the status glyphs in the services and legend", async () => {
    const seed: DisplayConnection[] = [
      { connectorId: "todoist", status: "linked", token: "t", linkedAt: "2026-01-01T00:00:00Z" },
      {
        connectorId: "notion",
        status: "needs_reauth",
        token: "n",
        linkedAt: "2026-01-01T00:00:00Z",
      },
      // Transient display-only state the live ping surfaces; exercises the
      // `connecting` glyph + "Pinging..." branch.
      {
        connectorId: "github",
        status: "connecting",
        token: "g",
        linkedAt: "2026-01-01T00:00:00Z",
      },
    ];
    const { ctx, replies } = makeCtx("list");
    await handleConnectCommand(
      ctx,
      makeDeps({
        store: makeStore(true, seed).store,
        emoji: {
          connected: "<:bluecheckfilled:1>",
          connecting: "<:bluecheckempty:2>",
          notConnected: "<:redxfilled:3>",
          needsAuth: "<:warningsquare:4>",
        },
      }),
    );
    // Each service line is "glyph name"; the status is shown by the glyph.
    const services = servicesText(replies[0].payload);
    expect(services).toContain("<:bluecheckfilled:1> Todoist");
    expect(services).toContain("<:warningsquare:4> Notion");
    expect(services).toContain("<:bluecheckempty:2> GitHub");
    // The legend maps each label to its glyph, arrow style.
    const legend = fieldNamed(replies[0].payload, "Legend") ?? "";
    expect(legend).toContain('"Connected!" \u2192 <:bluecheckfilled:1>');
    expect(legend).toContain('"Needs authentication." \u2192 <:warningsquare:4>');
    expect(legend).toContain('"Pinging..." \u2192 <:bluecheckempty:2>');
  });

  it("shows a friendly note in one embed with NO subcommand list when nothing is linked", async () => {
    const { ctx, replies } = makeCtx("list");
    await handleConnectCommand(ctx, makeDeps({ store: makeStore(true, []).store }));
    const embeds = embedsOf(replies[0].payload);
    // A single embed when empty.
    expect(embeds).toHaveLength(1);
    expect(embeds[0].title).toBe("Your Connections");
    expect(embeds[0].description).toBe("You have not linked any accounts yet.");
    // No subcommand list here anymore (it lives under a bare /connections).
    const names = (embeds[0].fields ?? []).map((f) => f.name);
    expect(names).not.toContain("`/connections add <service>`");
    expect(names).not.toContain("`/connections list`");
    // No services/legend/count when there is nothing to list.
    expect(names).not.toContain("Services");
    expect(names).not.toContain("Currently Connected");
  });

  it("renders the Connections Subcommands help for a bare (null) /connections", async () => {
    const { ctx, replies } = makeCtx(null);
    await handleConnectCommand(ctx, makeDeps({ store: makeStore(true, []).store }));
    const embeds = embedsOf(replies[0].payload);
    expect(embeds).toHaveLength(1);
    expect(embeds[0].title).toBe("Connections Subcommands");
    expect(embeds[0].description).toBe(
      "Below are all of the currently-registered subcommands under the `/connections` command...",
    );
    // All six subcommands are listed, debug-help style (alphabetical).
    const names = (embeds[0].fields ?? []).map((f) => f.name);
    expect(names).toEqual([
      "`/connections add <service>`",
      "`/connections available`",
      "`/connections help`",
      "`/connections info <service>`",
      "`/connections list`",
      "`/connections remove <service>`",
    ]);
    expect(replies[0].ephemeral).toBe(true);
  });

  it("renders the Connections Subcommands help for an explicit /connections help", async () => {
    const { ctx, replies } = makeCtx("help");
    await handleConnectCommand(ctx, makeDeps());
    const embed = embedsOf(replies[0].payload)[0];
    expect(embed.title).toBe("Connections Subcommands");
    expect((embed.fields ?? []).map((f) => f.name)).toContain("`/connections help`");
    expect(replies[0].ephemeral).toBe(true);
  });
});

describe("handleConnectCommand available", () => {
  it("lists every catalogued service as `id` -> Label, sorted by id", async () => {
    const { ctx, replies } = makeCtx("available");
    await handleConnectCommand(ctx, makeDeps());
    const value = fieldNamed(replies[0].payload, "Available Services") ?? "";
    // One `id` -> Label line per connector, sorted alphabetically by id.
    expect(value).toBe(
      "`github` \u2192 GitHub\n`google` \u2192 Google\n`notion` \u2192 Notion\n`todoist` \u2192 Todoist",
    );
    expect(replies[0].ephemeral).toBe(true);
  });

  it("works without a registered channel (read-only, owner-safe)", async () => {
    const { ctx, replies } = makeCtx("available");
    await handleConnectCommand(ctx, makeDeps({ store: makeStore(false).store }));
    expect(fieldNamed(replies[0].payload, "Available Services")).toContain(
      "`google` \u2192 Google",
    );
  });
});

/** A linked DisplayConnection seed for the info view. */
function linkFixture(
  connectorId: string,
  status: DisplayConnection["status"] = "linked",
  over: Partial<DisplayConnection> = {},
): DisplayConnection {
  return {
    connectorId,
    status,
    accountLabel: "me@example.com",
    linkedAt: "2026-01-02T03:04:05.000Z",
    ...over,
  };
}

/** Pull the first action row's buttons from a reply payload. */
function buttonsOf(payload: ChannelReplyPayload) {
  expect(typeof payload).toBe("object");
  const obj = payload as {
    components?: {
      type: number;
      components: { type: number; style?: number; label?: string; custom_id?: string }[];
    }[];
  };
  return obj.components?.[0]?.components ?? [];
}

describe("handleConnectCommand info", () => {
  it("renders the linked stats view with glyph, account, timestamp, auth type, and services", async () => {
    const { ctx, replies } = makeCtx("info", ["todoist"]);
    await handleConnectCommand(
      ctx,
      makeDeps({ store: makeStore(true, [linkFixture("todoist", "linked")]).store }),
    );
    const embed = embedOf(replies[0].payload);
    expect(embed.title).toBe("Your Connections \u00bb Todoist");
    expect(embed.description).toBe(
      "Below are some stats about your current **Todoist** connection. You are currently connected!",
    );
    // linkedAt 2026-01-02T03:04:05Z -> unix seconds 1767323045.
    const unix = Math.floor(new Date("2026-01-02T03:04:05.000Z").getTime() / 1000);
    const fields = embed.fields ?? [];
    const byName = (n: string) => fields.find((f) => f.name === n);
    expect(byName("Status")?.value).toBe("\u2705"); // connected default glyph
    expect(byName("Status")?.inline).toBe(true);
    expect(byName("Account")?.value).toBe("me@example.com");
    expect(byName("Account")?.inline).toBe(true);
    expect(byName("Linked")?.value).toBe(`<t:${unix}:D>`);
    expect(byName("Linked")?.inline).toBe(true);
    // Todoist is a direct (paste-token) connector.
    expect(byName("Auth Type")?.value).toBe("Pasted token");
    expect(byName("Last Ping")?.value).toBe("TODO");
    expect(byName("Last Ping")?.inline).toBe(true);
    expect(byName("Services Available")?.value).toBe("Tasks, Projects, Labels");
    expect(byName("Services Available")?.inline).toBe(false);
    expect(replies[0].ephemeral).toBe(true);
  });

  it("uses the connecting status sentence and glyph", async () => {
    const { ctx, replies } = makeCtx("info", ["todoist"]);
    await handleConnectCommand(
      ctx,
      makeDeps({ store: makeStore(true, [linkFixture("todoist", "connecting")]).store }),
    );
    const embed = embedOf(replies[0].payload);
    expect(embed.description).toContain("We are attempting to connect you now!");
    expect((embed.fields ?? []).find((f) => f.name === "Status")?.value).toBe("\u2b1c"); // connecting
  });

  it("uses the needs_reauth status sentence and glyph", async () => {
    const { ctx, replies } = makeCtx("info", ["notion"]);
    await handleConnectCommand(
      ctx,
      makeDeps({ store: makeStore(true, [linkFixture("notion", "needs_reauth")]).store }),
    );
    const embed = embedOf(replies[0].payload);
    expect(embed.description).toContain("Pinging has failed; you may need to reauthenticate.");
    expect((embed.fields ?? []).find((f) => f.name === "Status")?.value).toBe("\u26a0\ufe0f");
  });

  it("labels Auth Type OAuth for an oauth connector", async () => {
    const registry = makeOAuthRegistry(() => Promise.resolve({ ok: true, status: 200, body: {} }));
    const { ctx, replies } = makeCtx("info", ["oauthy"]);
    await handleConnectCommand(
      ctx,
      makeDeps({ registry, store: makeStore(true, [linkFixture("oauthy", "linked")]).store }),
    );
    const embed = embedOf(replies[0].payload);
    expect((embed.fields ?? []).find((f) => f.name === "Auth Type")?.value).toBe("OAuth");
  });

  it("includes a primary Reauthenticate button with a namespaced custom_id", async () => {
    const { ctx, replies } = makeCtx("info", ["github"]);
    await handleConnectCommand(
      ctx,
      makeDeps({ store: makeStore(true, [linkFixture("github", "linked")]).store }),
    );
    const buttons = buttonsOf(replies[0].payload);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({
      type: 2,
      style: 1, // primary
      label: "Reauthenticate",
      custom_id: "conn:reauth:github",
    });
  });

  it("rejects an unknown service, listing every catalogued service", async () => {
    const { ctx, replies } = makeCtx("info", ["slack"]);
    await handleConnectCommand(ctx, makeDeps());
    const embed = embedOf(replies[0].payload);
    expect(embed.title).toBe("Info");
    expect(embed.description).toContain("`slack` is not a valid service");
    expect(fieldNamed(replies[0].payload, "Available Services")).toContain(
      "`google` \u2192 Google",
    );
  });

  it("tells the user a catalogued-but-unlinked service is not linked", async () => {
    const { ctx, replies } = makeCtx("info", ["notion"]);
    // Store registered but empty: notion is catalogued yet not linked here.
    await handleConnectCommand(ctx, makeDeps({ store: makeStore(true, []).store }));
    const embed = embedOf(replies[0].payload);
    expect(embed.title).toBe("Your Connections \u00bb Notion");
    expect(embed.description).toContain("You have not linked Notion yet.");
    expect(embed.description).toContain("/connections add notion");
    // No stats fields or button on the not-linked branch.
    expect(buttonsOf(replies[0].payload)).toHaveLength(0);
  });

  it("requires a registered channel", async () => {
    const { ctx, replies } = makeCtx("info", ["todoist"]);
    await handleConnectCommand(ctx, makeDeps({ store: makeStore(false).store }));
    expect(embedOf(replies[0].payload).description).toContain("not registered yet");
  });
});

describe("handleConnectCommand add", () => {
  it("rejects an unknown service, listing every catalogued service", async () => {
    const { ctx, replies } = makeCtx("add", ["slack"]);
    await handleConnectCommand(ctx, makeDeps());
    const description = embedOf(replies[0].payload).description ?? "";
    expect(description).toContain("`slack` is not a valid service");
    expect(description).not.toContain("Valid services");
    // The services are offered via the shared Available Services field.
    const avail = fieldNamed(replies[0].payload, "Available Services") ?? "";
    expect(avail).toContain("`github` \u2192 GitHub");
    expect(avail).toContain("`todoist` \u2192 Todoist");
  });

  it("shows a TODO placeholder for a not-yet-wired connector (Google)", async () => {
    const { ctx, replies } = makeCtx("add", ["google"]);
    await handleConnectCommand(ctx, makeDeps());
    const embed = embedOf(replies[0].payload);
    expect(embed.title).toBe("Connect \u00bb Google");
    expect(embed.description).toBe("TODO");
    // The old coming-soon copy is gone.
    expect(embed.description).not.toContain("coming soon");
  });

  it("requires registration before linking", async () => {
    const { ctx, replies } = makeCtx("add", ["todoist", "tok"]);
    await handleConnectCommand(ctx, makeDeps({ store: makeStore(false).store }));
    expect(embedOf(replies[0].payload).description).toContain("not registered");
  });

  it("shows instructions when no token is supplied", async () => {
    const { ctx, replies } = makeCtx("add", ["todoist"]);
    await handleConnectCommand(ctx, makeDeps());
    const embed = embedOf(replies[0].payload);
    expect(embed.title).toBe("Link Todoist");
    expect(embed.description).toContain("https://example.com/todoist");
    expect(embed.description).toContain("/connections add todoist <token>");
  });

  it("validates, stores, scrubs, and confirms when a token works", async () => {
    const { store, map } = makeStore();
    const scrubCommandMessage = vi.fn();
    const validate = vi.fn(
      async (): Promise<AuthResult> => ({ ok: true, accountLabel: "octocat" }),
    );
    const { ctx, replies } = makeCtx("add", ["github", "ghp_secret"], { scrubCommandMessage });
    await handleConnectCommand(ctx, makeDeps({ store, registry: makeRegistry(validate) }));

    expect(validate).toHaveBeenCalledWith("github", "ghp_secret");
    expect(scrubCommandMessage).toHaveBeenCalledOnce();
    const stored = map.get("github");
    expect(stored).toMatchObject({
      status: "linked",
      token: "ghp_secret",
      accountLabel: "octocat",
    });
    expect(stored?.linkedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(embedOf(replies[0].payload).title).toBe("Connected!");
    expect(embedOf(replies[0].payload).description).toContain("octocat");
  });

  it("scrubs the message before validating so a bad token still does not linger", async () => {
    const order: string[] = [];
    const scrubCommandMessage = vi.fn(() => {
      order.push("scrub");
    });
    const validate = vi.fn(async (): Promise<AuthResult> => {
      order.push("validate");
      return { ok: false, message: "GitHub returned 401" };
    });
    const { store, map } = makeStore();
    const { ctx, replies } = makeCtx("add", ["github", "bad"], { scrubCommandMessage });
    await handleConnectCommand(ctx, makeDeps({ store, registry: makeRegistry(validate) }));

    expect(order).toEqual(["scrub", "validate"]);
    expect(map.get("github")).toBeUndefined(); // not stored
    expect(embedOf(replies[0].payload).description).toContain("did not work");
    expect(embedOf(replies[0].payload).description).toContain("401");
  });

  it("scrubs a pasted token before the unknown-service early return", async () => {
    // A token aimed at a typo'd service name must still be deleted, even though
    // the command errors out before any validation.
    const scrubCommandMessage = vi.fn(async () => true);
    const { ctx, replies } = makeCtx("add", ["slakc", "tok_secret"], { scrubCommandMessage });
    await handleConnectCommand(ctx, makeDeps());
    expect(scrubCommandMessage).toHaveBeenCalledOnce();
    expect(embedOf(replies[0].payload).description).toContain("is not a valid service");
  });

  it("does not echo args[0] in the unknown-service error when a token was scrubbed", async () => {
    // Service omitted: `/connections add <token>` puts the credential in args[0]. The
    // reply is delivered publicly (the text adapter cannot honor the ephemeral hint),
    // so the error must stay generic and never contain the pasted secret.
    const scrubCommandMessage = vi.fn(async () => true);
    const { ctx, replies } = makeCtx("add", ["ghp_supersecret_token"], { scrubCommandMessage });
    await handleConnectCommand(ctx, makeDeps());
    const description = embedOf(replies[0].payload).description ?? "";
    expect(description).toContain("That is not a valid service.");
    expect(description).not.toContain("ghp_supersecret_token");
  });

  it("still names the unknown id when no token was pasted (slash command, safe)", async () => {
    // No scrub callback => args[0] is a plain service name, safe to surface.
    const { ctx, replies } = makeCtx("add", ["slack"]);
    await handleConnectCommand(ctx, makeDeps());
    expect(embedOf(replies[0].payload).description).toContain("`slack` is not a valid service");
  });

  it("scrubs a pasted token before the not-yet-wired TODO placeholder", async () => {
    const scrubCommandMessage = vi.fn(async () => true);
    const { ctx, replies } = makeCtx("add", ["google", "tok_secret"], { scrubCommandMessage });
    await handleConnectCommand(ctx, makeDeps());
    expect(scrubCommandMessage).toHaveBeenCalledOnce();
    expect(embedOf(replies[0].payload).title).toBe("Connect \u00bb Google");
  });

  it("warns the user to delete manually when the scrub fails", async () => {
    const scrubCommandMessage = vi.fn(async () => false); // delete attempted but failed
    const validate = vi.fn(async (): Promise<AuthResult> => ({ ok: true }));
    const { ctx, replies } = makeCtx("add", ["github", "ghp_secret"], { scrubCommandMessage });
    await handleConnectCommand(ctx, makeDeps({ registry: makeRegistry(validate) }));
    expect(embedOf(replies[0].payload).description).toContain("delete it");
  });

  it("does not warn about scrubbing when the delete succeeds", async () => {
    const scrubCommandMessage = vi.fn(async () => true);
    const validate = vi.fn(async (): Promise<AuthResult> => ({ ok: true }));
    const { ctx, replies } = makeCtx("add", ["github", "ghp_secret"], { scrubCommandMessage });
    await handleConnectCommand(ctx, makeDeps({ registry: makeRegistry(validate) }));
    expect(embedOf(replies[0].payload).description).not.toContain("delete it manually");
  });

  it("does not report success if the instance changes during validation", async () => {
    const map = new Map<string, StoredConnection>();
    let registrationKey = "generation-a";
    const store: ConnectionStore = {
      list: () => [...map.values()],
      get: (_c, id) => map.get(id) ?? null,
      instanceKey: () => registrationKey,
      save: (_c, connection, expectedKey) => {
        if (registrationKey !== expectedKey) {
          return false;
        }
        map.set(connection.connectorId, connection);
        return true;
      },
      remove: (_c, id) => map.delete(id),
    };
    const validate = vi.fn(async (): Promise<AuthResult> => {
      registrationKey = "generation-b";
      return { ok: true };
    });
    const { ctx, replies } = makeCtx("add", ["github", "ghp_secret"]);
    await handleConnectCommand(ctx, makeDeps({ store, registry: makeRegistry(validate) }));
    expect(map.size).toBe(0); // nothing persisted
    const embed = embedOf(replies[0].payload);
    expect(embed.title).not.toBe("Connected!");
    expect(embed.description).toContain("could not store the link");
  });

  it("rechecks the authorized registration after scrubbing an add command", async () => {
    let registrationKey = "generation-a";
    const validate = vi.fn(async (): Promise<AuthResult> => ({ ok: true }));
    const { ctx, replies } = makeCtx("add", ["github", "ghp_secret"], {
      authorizedInstanceKey: "generation-a",
      scrubCommandMessage: async () => {
        registrationKey = "generation-b";
        return true;
      },
    });
    const store = makeStore().store;
    vi.spyOn(store, "instanceKey").mockImplementation(() => registrationKey);

    await handleConnectCommand(ctx, makeDeps({ store, registry: makeRegistry(validate) }));

    expect(validate).not.toHaveBeenCalled();
    expect(embedOf(replies[0].payload).description).toContain("registration changed");
  });

  it("stores the token when the connector's auth confirms it", async () => {
    const { store, map } = makeStore();
    const { ctx, replies } = makeCtx("add", ["todoist", "tok"]);
    await handleConnectCommand(ctx, makeDeps({ store }));
    expect(map.get("todoist")?.token).toBe("tok");
    expect(embedOf(replies[0].payload).title).toBe("Connected!");
  });
});

describe("handleConnectCommand remove", () => {
  it("unlinks an existing connection", async () => {
    const seed: StoredConnection[] = [
      { connectorId: "todoist", status: "linked", token: "t", linkedAt: "2026-01-01T00:00:00Z" },
    ];
    const { store, map } = makeStore(true, seed);
    const { ctx, replies } = makeCtx("remove", ["todoist"]);
    await handleConnectCommand(ctx, makeDeps({ store }));
    expect(map.has("todoist")).toBe(false);
    expect(embedOf(replies[0].payload).description).toContain("unlinked");
  });

  it("reports when there was nothing to remove", async () => {
    const { ctx, replies } = makeCtx("remove", ["todoist"]);
    await handleConnectCommand(ctx, makeDeps());
    expect(embedOf(replies[0].payload).description).toContain("nothing to remove");
  });

  it("rejects an unknown service on remove", async () => {
    const { ctx, replies } = makeCtx("remove", ["slack"]);
    await handleConnectCommand(ctx, makeDeps());
    expect(embedOf(replies[0].payload).description).toContain("`slack` is not a valid service");
  });

  it("reports a storage failure distinctly from an absent connection", async () => {
    const store: ConnectionStore = {
      list: () => [],
      get: () => null,
      instanceKey: () => "k",
      save: () => false,
      remove: () => "error", // entry exists but the rewrite failed (e.g. EROFS)
    };
    const { ctx, replies } = makeCtx("remove", ["todoist"]);
    await handleConnectCommand(ctx, makeDeps({ store }));
    const description = embedOf(replies[0].payload).description ?? "";
    expect(description).toContain("storage is unavailable");
    expect(description).toContain("still linked");
    expect(description).not.toContain("nothing to remove");
  });
});

describe("handleConnectCommand add (OAuth two-step flow)", () => {
  const okPostForm = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      body: { access_token: "at-oauthy", refresh_token: "rt-oauthy", expires_in: 3600 },
    });

  it("begin: shows the authorize link and stashes a pending blob", async () => {
    const pending = makePendingAuth();
    const deps = makeDeps({ registry: makeOAuthRegistry(okPostForm), pendingAuth: pending.store });
    const { ctx, replies } = makeCtx("add", ["oauthy"]);
    await handleConnectCommand(ctx, deps);
    const description = embedOf(replies[0].payload).description ?? "";
    expect(description).toContain("https://provider.example/authorize");
    expect(description).toContain("paste the URL you are redirected to");
    // The PKCE verifier + state are persisted for the finishing command.
    expect(pending.map.get("oauthy")).toBeTruthy();
  });

  it("complete: exchanges the pasted redirect URL, stores the link, clears pending", async () => {
    const conn = makeStore();
    const pending = makePendingAuth();
    const calls: { form: Record<string, string> }[] = [];
    const postForm = (_url: string, form: Record<string, string>) => {
      calls.push({ form });
      return okPostForm();
    };
    const deps = makeDeps({
      store: conn.store,
      registry: makeOAuthRegistry(postForm),
      pendingAuth: pending.store,
    });

    // Step 1: begin stores the pending blob.
    await handleConnectCommand(makeCtx("add", ["oauthy"]).ctx, deps);
    const state = stateOf(pending.map.get("oauthy") ?? "");

    // Step 2: paste the loopback redirect URL to finish.
    const { ctx, replies } = makeCtx("add", [
      "oauthy",
      `http://127.0.0.1/?code=the-code&state=${state}`,
    ]);
    await handleConnectCommand(ctx, deps);

    expect(embedOf(replies[0].payload).title).toBe("Connected!");
    expect(conn.map.get("oauthy")).toMatchObject({
      connectorId: "oauthy",
      status: "linked",
      token: "at-oauthy",
    });
    expect(calls[0]?.form.code).toBe("the-code");
    // The pending blob is consumed once the link is stored.
    expect(pending.map.has("oauthy")).toBe(false);
  });

  it("complete without a prior begin fails (no pending state) and stores nothing", async () => {
    const conn = makeStore();
    const deps = makeDeps({
      store: conn.store,
      registry: makeOAuthRegistry(okPostForm),
      pendingAuth: makePendingAuth().store,
    });
    const { ctx, replies } = makeCtx("add", ["oauthy", "http://127.0.0.1/?code=c&state=s"]);
    await handleConnectCommand(ctx, deps);
    expect(embedOf(replies[0].payload).description).toContain("did not work");
    expect(conn.map.has("oauthy")).toBe(false);
  });

  it("rejects a stale completion when a newer begin replaced the pending blob", async () => {
    const conn = makeStore();
    const pending = makePendingAuth();
    // The exchange (the only await) races a second begin: simulate that newer begin
    // landing mid-flight by replacing the stored blob while postForm is in progress.
    const postForm = () => {
      pending.map.set("oauthy", "newer-blob-from-a-second-begin");
      return okPostForm();
    };
    const deps = makeDeps({
      store: conn.store,
      registry: makeOAuthRegistry(postForm),
      pendingAuth: pending.store,
    });
    await handleConnectCommand(makeCtx("add", ["oauthy"]).ctx, deps);
    // Capture the first begin's state before postForm overwrites the blob mid-exchange.
    const state = stateOf(pending.map.get("oauthy") ?? "");
    const { ctx, replies } = makeCtx("add", [
      "oauthy",
      `http://127.0.0.1/?code=the-code&state=${state}`,
    ]);
    await handleConnectCommand(ctx, deps);
    expect(embedOf(replies[0].payload).description).toContain("newer link attempt");
    // Nothing is stored, and the newer attempt's pending blob survives.
    expect(conn.map.has("oauthy")).toBe(false);
    expect(pending.map.get("oauthy")).toBe("newer-blob-from-a-second-begin");
  });

  it("begin: reports cleanly when pending storage is unavailable", async () => {
    const pending = makePendingAuth(false); // writes always fail (e.g. read-only mount)
    const deps = makeDeps({ registry: makeOAuthRegistry(okPostForm), pendingAuth: pending.store });
    const { ctx, replies } = makeCtx("add", ["oauthy"]);
    await handleConnectCommand(ctx, deps);
    expect(embedOf(replies[0].payload).description).toContain("could not start the link");
    expect(pending.map.has("oauthy")).toBe(false);
  });
});
