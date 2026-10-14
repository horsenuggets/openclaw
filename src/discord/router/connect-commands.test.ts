import { describe, expect, it, vi } from "vitest";
import type { ChannelReplyPayload } from "./channel-commands.js";
import type { DisplayConnection, StoredConnection } from "./connections-store.js";
import {
  CONNECTIONS_COMMAND_SPECS,
  type ConnectCommandContext,
  type ConnectCommandDeps,
  type ConnectionStore,
  connectTextCommandHasToken,
  handleConnectCommand,
  parseConnectTextCommand,
} from "./connect-commands.js";
import { type AuthResult, CliAuth, PasteTokenAuth } from "./connector-auth.js";
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
    auth: new PasteTokenAuth({
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
    registry: over.registry ?? makeRegistry(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    log: () => {},
    ...over,
  };
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

  it("lists only linked services with a status glyph, not the whole catalog", async () => {
    const seed: DisplayConnection[] = [
      {
        connectorId: "todoist",
        status: "linked",
        token: "t",
        accountLabel: "chris",
        linkedAt: "2026-01-01T00:00:00Z",
      },
      // Unavailable ("coming soon") connector carrying a stale linked record: it
      // must still be filtered out of the list per the coming-soon contract.
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
    expect(services).not.toContain("(chris)"); // account label is not shown
    // Not-linked and coming-soon services never appear in the list, even when an
    // unavailable connector has a persisted linked record.
    expect(services).not.toContain("Notion");
    expect(services).not.toContain("Google");
    expect(services).not.toContain("Coming soon");
  });

  it("shows the subcommand previews, a Currently Connected count, and a legend", async () => {
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
    // Default layout is two embeds: a header embed and a content embed.
    expect(embeds).toHaveLength(2);
    expect(embeds[0].title).toBe("Your Connections");
    expect(embeds[0].description).not.toContain("```"); // no markdown code block anymore
    // Embed 1 advertises the /conn subcommands, debug-help style.
    const subNames = (embeds[0].fields ?? []).map((f) => f.name);
    expect(subNames).toContain("`/conn add <service>`");
    expect(subNames).toContain("`/conn remove <service>`");
    // Only registered/handled subcommands are advertised (no `/conn info`).
    expect(subNames).not.toContain("`/conn info <service>`");
    // Embed 2 carries the count (2 of 3 shown are linked) and a full legend.
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
        auth: new PasteTokenAuth({
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
      auth: new PasteTokenAuth({
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
    expect(embeds.length).toBeGreaterThan(1);
    // Header embed first (no footer), footer on the last embed.
    expect(embeds[0].title).toBe("Your Connections");
    expect(embeds[0].footer).toBeUndefined();
    expect(embeds[embeds.length - 1].footer?.text).toBe("Connections");
    // The Services list is chunked into more than one repeated-header field.
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

  it("shows a friendly note plus the subcommands in one embed when nothing is linked", async () => {
    const { ctx, replies } = makeCtx("list");
    await handleConnectCommand(ctx, makeDeps({ store: makeStore(true, []).store }));
    const embeds = embedsOf(replies[0].payload);
    // A single embed when empty (no content embed to split to).
    expect(embeds).toHaveLength(1);
    expect(embeds[0].title).toBe("Your Connections");
    expect(embeds[0].description).toContain("not linked any accounts yet");
    // Still shows how to connect via the subcommand previews.
    const names = (embeds[0].fields ?? []).map((f) => f.name);
    expect(names).toContain("`/conn add <service>`");
    // No services/legend/count when there is nothing to list.
    expect(names).not.toContain("Services");
    expect(names).not.toContain("Currently Connected");
  });

  it("defaults a null subcommand to list", async () => {
    const seed: StoredConnection[] = [
      { connectorId: "todoist", status: "linked", token: "t", linkedAt: "2026-01-01T00:00:00Z" },
    ];
    const { ctx, replies } = makeCtx(null);
    await handleConnectCommand(ctx, makeDeps({ store: makeStore(true, seed).store }));
    expect(embedOf(replies[0].payload).title).toBe("Your Connections");
  });
});

describe("handleConnectCommand add", () => {
  it("rejects an unknown service", async () => {
    const { ctx, replies } = makeCtx("add", ["slack"]);
    await handleConnectCommand(ctx, makeDeps());
    expect(embedOf(replies[0].payload).description).toContain("not a service I recognize");
  });

  it("refuses a not-yet-available connector (Google)", async () => {
    const { ctx, replies } = makeCtx("add", ["google"]);
    await handleConnectCommand(ctx, makeDeps());
    expect(embedOf(replies[0].payload).description).toContain("coming soon");
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
    expect(embedOf(replies[0].payload).description).toContain("not a service I recognize");
  });

  it("scrubs a pasted token before the unavailable-service early return", async () => {
    const scrubCommandMessage = vi.fn(async () => true);
    const { ctx, replies } = makeCtx("add", ["google", "tok_secret"], { scrubCommandMessage });
    await handleConnectCommand(ctx, makeDeps());
    expect(scrubCommandMessage).toHaveBeenCalledOnce();
    expect(embedOf(replies[0].payload).description).toContain("coming soon");
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
    expect(embedOf(replies[0].payload).description).toContain("not a service I recognize");
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
