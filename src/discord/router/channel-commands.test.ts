import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChannelCommandDeps,
  type ChannelReplyPayload,
  type InstanceStatus,
  buildUnregisterCustomId,
  handleChannelCommand,
  handleUnregisterButtonClick,
  parseChannelTextCommand,
  parseUnregisterCustomId,
  parseUserMention,
} from "./channel-commands.js";
import { initAppEmojis, resetAppEmojis } from "./emojis.js";

// Status renders custom emojis when the bot's set has loaded; drop the cache
// after every test so the default (fallback-glyph) cases stay deterministic.
afterEach(() => resetAppEmojis());

describe("parseChannelTextCommand", () => {
  it("parses the bare command", () => {
    expect(parseChannelTextCommand("/channel")).toEqual({ subcommand: null, args: [] });
  });

  it("parses subcommands and args", () => {
    expect(parseChannelTextCommand("/channel register")).toEqual({
      subcommand: "register",
      args: [],
    });
    expect(parseChannelTextCommand("/channel unregister yes")).toEqual({
      subcommand: "unregister",
      args: ["yes"],
    });
  });

  it("tolerates a double slash and surrounding whitespace", () => {
    expect(parseChannelTextCommand("  //channel status  ")).toEqual({
      subcommand: "status",
      args: [],
    });
  });

  it("returns null for non-channel messages", () => {
    expect(parseChannelTextCommand("hello")).toBeNull();
    expect(parseChannelTextCommand("/lifecycle on")).toBeNull();
    expect(parseChannelTextCommand("channel register")).toBeNull();
  });
});

describe("parseUserMention", () => {
  it("parses mentions and raw ids, rejects junk", () => {
    expect(parseUserMention("<@123456789012345678>")).toBe("123456789012345678");
    expect(parseUserMention("<@!123456789012345678>")).toBe("123456789012345678");
    expect(parseUserMention("123456789012345678")).toBe("123456789012345678");
    expect(parseUserMention("  <@123456789012345678>  ")).toBe("123456789012345678");
    expect(parseUserMention("nope")).toBeNull();
    expect(parseUserMention(undefined)).toBeNull();
  });
});

describe("parseUnregisterCustomId", () => {
  it("round-trips confirm and cancel ids without confusing the shared prefix", () => {
    const confirm = buildUnregisterCustomId("confirm", "C1", "U1");
    const cancel = buildUnregisterCustomId("cancel", "C1", "U1");
    expect(parseUnregisterCustomId(confirm)).toEqual({
      kind: "confirm",
      channelId: "C1",
      initiatorId: "U1",
    });
    expect(parseUnregisterCustomId(cancel)).toEqual({
      kind: "cancel",
      channelId: "C1",
      initiatorId: "U1",
    });
  });

  it("returns null for unrelated ids", () => {
    expect(parseUnregisterCustomId("something-else:C:U")).toBeNull();
    expect(parseUnregisterCustomId("chan-unreg:onlytwo")).toBeNull();
  });
});

type ReplyCall = { payload: ChannelReplyPayload; ephemeral?: boolean };

function makeCtx(
  subcommand: string | null,
  args: string[] = [],
  over: { userId?: string; channelId?: string; isDM?: boolean } = {},
) {
  const replies: ReplyCall[] = [];
  return {
    replies,
    ctx: {
      subcommand,
      args,
      channelId: over.channelId ?? "123456789012345678",
      userId: over.userId ?? "111111111111111111",
      isDM: over.isDM ?? false,
      reply: (payload: ChannelReplyPayload, opts?: { ephemeral?: boolean }) => {
        replies.push({ payload, ephemeral: opts?.ephemeral });
      },
    },
  };
}

/** Narrow a reply payload to its first embed (fails the test if it is a string). */
function embedOf(payload: ChannelReplyPayload) {
  expect(typeof payload).toBe("object");
  const obj = payload as {
    embeds: unknown[];
    components?: { components: { custom_id?: string; label: string; style: number }[] }[];
  };
  expect(Array.isArray(obj.embeds)).toBe(true);
  return {
    embed: obj.embeds[0] as {
      title?: string;
      description?: string;
      color?: number;
      fields?: { name: string; value: string }[];
    },
    components: obj.components,
  };
}

function makeDeps(over: Partial<ChannelCommandDeps> = {}): ChannelCommandDeps {
  return {
    isWhitelisted: vi.fn(async () => true),
    isAdmin: vi.fn(async () => false),
    whitelistConfigured: () => true,
    describeInstance: () => null,
    provisioning: {
      register: vi.fn(async () => ({ ok: true, message: "registered" })),
      unregister: vi.fn(async () => ({ ok: true, message: "removed" })),
    },
    log: () => {},
    ...over,
  };
}

describe("handleChannelCommand status", () => {
  it("renders the not-registered table with null/❌ throughout", async () => {
    const { ctx, replies } = makeCtx("status");
    await handleChannelCommand(ctx, makeDeps());
    const { embed } = embedOf(replies[0].payload);
    expect(embed.title).toBe("Status");
    expect(embed.color).toBe(0xffff80);
    const values = embed.fields?.find((f) => f.name === "Value")?.value ?? "";
    // Registered ❌ / User null / Port null / Onboarded ❌ / Running ❌
    expect(values.split("\n")).toEqual(["❌", "`null`", "`null`", "❌", "❌"]);
    expect(replies[0].ephemeral).toBe(true);
  });

  it("renders registered details and probes running state", async () => {
    const status: InstanceStatus = { port: 18795, ownerId: "999", onboarded: false };
    const probeRunning = vi.fn(async () => true);
    const { ctx, replies } = makeCtx("status");
    await handleChannelCommand(ctx, makeDeps({ describeInstance: () => status, probeRunning }));
    const { embed } = embedOf(replies[0].payload);
    const values = embed.fields?.find((f) => f.name === "Value")?.value ?? "";
    expect(values.split("\n")).toEqual(["✅", "<@999>", "18795", "❌", "✅"]);
    expect(probeRunning).toHaveBeenCalledWith(18795);
  });

  it("never consults the whitelist for status", async () => {
    const isWhitelisted = vi.fn(async () => false);
    const isAdmin = vi.fn(async () => false);
    const { ctx, replies } = makeCtx("status");
    await handleChannelCommand(
      ctx,
      makeDeps({ whitelistConfigured: () => false, isWhitelisted, isAdmin }),
    );
    expect(isWhitelisted).not.toHaveBeenCalled();
    expect(isAdmin).not.toHaveBeenCalled();
    expect(embedOf(replies[0].payload).embed.title).toBe("Status");
  });

  it("renders the custom check emojis under 'Attribute' when the bot's set is loaded", async () => {
    // Load a mock app-emoji set so resolveEmoji returns the custom references.
    await initAppEmojis(
      "tok",
      "appid",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [
            { name: "bluecheckfilled", id: "111" },
            { name: "bluecheckempty", id: "222" },
          ],
        }),
      })) as unknown as typeof fetch,
    );
    const status: InstanceStatus = { port: 18795, ownerId: "999", onboarded: true };
    const { ctx, replies } = makeCtx("status");
    await handleChannelCommand(
      ctx,
      makeDeps({ describeInstance: () => status, probeRunning: vi.fn(async () => true) }),
    );
    const { embed } = embedOf(replies[0].payload);
    // The table column is "Attribute" (not "Property").
    expect(embed.fields?.map((f) => f.name)).toEqual(["Attribute", "Value"]);
    const values = embed.fields?.find((f) => f.name === "Value")?.value.split("\n") ?? [];
    // Registered / Onboarded / Running resolve to the custom filled check.
    expect(values[0]).toBe("<:bluecheckfilled:111>");
    expect(values[3]).toBe("<:bluecheckfilled:111>");
    expect(values[4]).toBe("<:bluecheckfilled:111>");
  });

  it("renders the custom empty check for a stopped instance", async () => {
    await initAppEmojis(
      "tok",
      "appid",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          items: [
            { name: "bluecheckfilled", id: "111" },
            { name: "bluecheckempty", id: "222" },
          ],
        }),
      })) as unknown as typeof fetch,
    );
    const status: InstanceStatus = { port: 18795, ownerId: "999", onboarded: true };
    const { ctx, replies } = makeCtx("status");
    await handleChannelCommand(
      ctx,
      makeDeps({ describeInstance: () => status, probeRunning: vi.fn(async () => false) }),
    );
    const values =
      embedOf(replies[0].payload)
        .embed.fields?.find((f) => f.name === "Value")
        ?.value.split("\n") ?? [];
    // Running is the custom empty check.
    expect(values[4]).toBe("<:bluecheckempty:222>");
  });
});

describe("handleChannelCommand register", () => {
  it("denies non-whitelisted, non-admin users and does not provision", async () => {
    const register = vi.fn(async () => ({ ok: true, message: "x" }));
    const { ctx, replies } = makeCtx("register", [], { isDM: true });
    await handleChannelCommand(
      ctx,
      makeDeps({
        isWhitelisted: async () => false,
        isAdmin: async () => false,
        provisioning: { register, unregister: vi.fn() },
      }),
    );
    expect(embedOf(replies[0].payload).embed.description).toContain("not authorized");
    expect(register).not.toHaveBeenCalled();
  });

  it("lets a whitelisted user register their own DM as themselves", async () => {
    const register = vi.fn(async () => ({ ok: true, message: "ok" }));
    const { ctx, replies } = makeCtx("register", [], { isDM: true, userId: "U1" });
    await handleChannelCommand(ctx, makeDeps({ provisioning: { register, unregister: vi.fn() } }));
    expect(register).toHaveBeenCalledWith({
      channelId: "123456789012345678",
      isDM: true,
      ownerId: "U1",
    });
    const { embed } = embedOf(replies[0].payload);
    expect(embed.description).toContain("successfully registered under user <@U1>");
  });

  it("styles the success reply as a Channel Registration embed with the footer icon", async () => {
    const register = vi.fn(async () => ({ ok: true, message: "ok" }));
    const { ctx, replies } = makeCtx("register", [], { isDM: true, userId: "U1" });
    await handleChannelCommand(ctx, makeDeps({ provisioning: { register, unregister: vi.fn() } }));
    const payload = replies[0].payload as {
      embeds: {
        title?: string;
        color?: number;
        timestamp?: string;
        footer?: { text: string; icon_url?: string };
      }[];
      attachments?: string[];
    };
    expect(payload.attachments).toEqual(["channel-registration.png"]);
    const embed = payload.embeds[0];
    expect(embed.title).toBe("Registration Success!");
    expect(embed.color).toBe(0xffff80);
    expect(embed.footer).toEqual({
      text: "Channel Registration",
      icon_url: "attachment://channel-registration.png",
    });
    expect(embed.timestamp).toBeDefined();
  });

  it("forbids a whitelisted user from registering a guild channel", async () => {
    const register = vi.fn();
    const { ctx, replies } = makeCtx("register", [], { isDM: false });
    await handleChannelCommand(ctx, makeDeps({ provisioning: { register, unregister: vi.fn() } }));
    expect(register).not.toHaveBeenCalled();
    expect(embedOf(replies[0].payload).embed.description).toContain(
      "can only register their own DM",
    );
  });

  it("forbids a whitelisted user from registering on another user's behalf", async () => {
    const register = vi.fn();
    const { ctx, replies } = makeCtx("register", ["<@222222222222222222>"], {
      isDM: true,
      userId: "U1",
    });
    await handleChannelCommand(ctx, makeDeps({ provisioning: { register, unregister: vi.fn() } }));
    expect(register).not.toHaveBeenCalled();
    expect(embedOf(replies[0].payload).embed.description).toContain("Only admins can register");
  });

  it("lets an admin register a guild channel on another user's behalf", async () => {
    const register = vi.fn(async () => ({ ok: true, message: "ok" }));
    const { ctx, replies } = makeCtx("register", ["<@222222222222222222>"], {
      isDM: false,
      userId: "ADMIN",
    });
    await handleChannelCommand(
      ctx,
      makeDeps({ isAdmin: async () => true, provisioning: { register, unregister: vi.fn() } }),
    );
    expect(register).toHaveBeenCalledWith({
      channelId: "123456789012345678",
      isDM: false,
      ownerId: "222222222222222222",
    });
    expect(embedOf(replies[0].payload).embed.description).toContain(
      "registered under user <@222222222222222222>",
    );
  });

  it("refuses when already registered and names the current owner", async () => {
    const register = vi.fn();
    const { ctx, replies } = makeCtx("register", [], { isDM: true });
    await handleChannelCommand(
      ctx,
      makeDeps({
        describeInstance: () => ({ port: 1, ownerId: "777", onboarded: true }),
        provisioning: { register, unregister: vi.fn() },
      }),
    );
    expect(register).not.toHaveBeenCalled();
    expect(embedOf(replies[0].payload).embed.description).toContain(
      "already registered under user <@777>",
    );
  });

  it("blocks register when the whitelist is not configured", async () => {
    const register = vi.fn();
    const { ctx, replies } = makeCtx("register", [], { isDM: true });
    await handleChannelCommand(
      ctx,
      makeDeps({
        whitelistConfigured: () => false,
        provisioning: { register, unregister: vi.fn() },
      }),
    );
    expect(register).not.toHaveBeenCalled();
    expect(embedOf(replies[0].payload).embed.description).toContain("not configured");
  });

  it("surfaces a provisioning failure in the embed", async () => {
    const register = vi.fn(async () => ({ ok: false, message: "daemon down" }));
    const { ctx, replies } = makeCtx("register", [], { isDM: true });
    await handleChannelCommand(ctx, makeDeps({ provisioning: { register, unregister: vi.fn() } }));
    expect(embedOf(replies[0].payload).embed.description).toContain("Could not register");
    expect(embedOf(replies[0].payload).embed.description).toContain("daemon down");
  });

  it("kicks onboarding after a successful register, once the embed is out", async () => {
    const register = vi.fn(async () => ({ ok: true, message: "ok" }));
    // Both the reply and the kick push to a shared log so we can assert the
    // welcome follows registration and never precedes it.
    const order: string[] = [];
    const kickArgs: string[] = [];
    const { ctx } = makeCtx("register", [], { isDM: true, userId: "U1" });
    ctx.reply = () => {
      order.push("embed");
    };
    await handleChannelCommand(
      ctx,
      makeDeps({
        provisioning: { register, unregister: vi.fn() },
        kickOnboarding: (channelId, ownerId) => {
          order.push("kick");
          kickArgs.push(channelId, ownerId);
        },
      }),
    );
    expect(order).toEqual(["embed", "kick"]);
    expect(kickArgs).toEqual(["123456789012345678", "U1"]);
  });

  it("does not kick onboarding when register fails", async () => {
    const register = vi.fn(async () => ({ ok: false, message: "daemon down" }));
    const kickOnboarding = vi.fn();
    const { ctx } = makeCtx("register", [], { isDM: true });
    await handleChannelCommand(
      ctx,
      makeDeps({ provisioning: { register, unregister: vi.fn() }, kickOnboarding }),
    );
    expect(kickOnboarding).not.toHaveBeenCalled();
  });
});

describe("handleChannelCommand unregister", () => {
  it("shows a confirmation button to the owner instead of removing immediately", async () => {
    const unregister = vi.fn();
    const { ctx, replies } = makeCtx("unregister", [], { userId: "U1" });
    await handleChannelCommand(
      ctx,
      makeDeps({
        describeInstance: () => ({ port: 1, ownerId: "U1", onboarded: true }),
        provisioning: { register: vi.fn(), unregister },
      }),
    );
    expect(unregister).not.toHaveBeenCalled();
    const { embed, components } = embedOf(replies[0].payload);
    expect(embed.description).toContain("Are you sure");
    const button = components?.[0].components[0];
    expect(button?.custom_id).toBe(buildUnregisterCustomId("confirm", "123456789012345678", "U1"));
    expect(button?.style).toBe(4);
  });

  it("accepts the confirm:yes text token and skips the button", async () => {
    const unregister = vi.fn(async () => ({ ok: true, message: "removed" }));
    const { ctx } = makeCtx("unregister", ["confirm:yes"], { userId: "U1" });
    await handleChannelCommand(
      ctx,
      makeDeps({
        describeInstance: () => ({ port: 1, ownerId: "U1", onboarded: true }),
        provisioning: { register: vi.fn(), unregister },
      }),
    );
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("denies a non-owner, non-admin user", async () => {
    const unregister = vi.fn();
    const { ctx, replies } = makeCtx("unregister", [], { userId: "STRANGER" });
    await handleChannelCommand(
      ctx,
      makeDeps({
        describeInstance: () => ({ port: 1, ownerId: "U1", onboarded: true }),
        isAdmin: async () => false,
        provisioning: { register: vi.fn(), unregister },
      }),
    );
    expect(unregister).not.toHaveBeenCalled();
    // Denials on a channel owned by someone else use the shared unauthorized
    // notice (naming the owner), matching the plain-message and /lifecycle flows.
    const description = embedOf(replies[0].payload).embed.description;
    expect(description).toContain("not authorized to use this channel's agent");
    expect(description).toContain("<@U1>");
  });

  it("lets an admin unregister a channel they do not own (with confirm:yes)", async () => {
    const unregister = vi.fn(async () => ({ ok: true, message: "removed" }));
    const { ctx, replies } = makeCtx("unregister", ["yes"], { userId: "ADMIN" });
    await handleChannelCommand(
      ctx,
      makeDeps({
        describeInstance: () => ({ port: 1, ownerId: "U1", onboarded: true }),
        isAdmin: async () => true,
        provisioning: { register: vi.fn(), unregister },
      }),
    );
    expect(unregister).toHaveBeenCalledOnce();
    // Success mentions the original owner, not the admin who ran it.
    expect(embedOf(replies[0].payload).embed.description).toContain("unregistered from user <@U1>");
  });

  it("reports nothing to remove for an unregistered channel", async () => {
    const { ctx, replies } = makeCtx("unregister", ["yes"]);
    await handleChannelCommand(ctx, makeDeps({ describeInstance: () => null }));
    expect(embedOf(replies[0].payload).embed.description).toContain("nothing to remove");
  });
});

describe("handleUnregisterButtonClick", () => {
  const owned = (): InstanceStatus => ({ port: 1, ownerId: "U1", onboarded: true });

  it("ignores custom_ids that are not ours", async () => {
    const result = await handleUnregisterButtonClick(
      { customId: "other:C:U", clickerId: "U1" },
      makeDeps(),
    );
    expect(result).toEqual({});
  });

  it("rejects clicks from anyone but the initiator", async () => {
    const unregister = vi.fn();
    const result = await handleUnregisterButtonClick(
      { customId: buildUnregisterCustomId("confirm", "C1", "U1"), clickerId: "U2" },
      makeDeps({ describeInstance: owned, provisioning: { register: vi.fn(), unregister } }),
    );
    expect(result.ephemeral).toContain("isn't for you");
    expect(unregister).not.toHaveBeenCalled();
  });

  it("unregisters and clears the buttons when the owner confirms", async () => {
    const unregister = vi.fn(async () => ({ ok: true, message: "removed" }));
    const result = await handleUnregisterButtonClick(
      { customId: buildUnregisterCustomId("confirm", "C1", "U1"), clickerId: "U1" },
      makeDeps({ describeInstance: owned, provisioning: { register: vi.fn(), unregister } }),
    );
    expect(unregister).toHaveBeenCalledWith({ channelId: "C1" });
    expect(result.update?.components).toEqual([]);
    expect(result.update?.embeds[0].description).toContain("successfully unregistered");
  });

  it("cancels without touching provisioning", async () => {
    const unregister = vi.fn();
    const result = await handleUnregisterButtonClick(
      { customId: buildUnregisterCustomId("cancel", "C1", "U1"), clickerId: "U1" },
      makeDeps({ describeInstance: owned, provisioning: { register: vi.fn(), unregister } }),
    );
    expect(unregister).not.toHaveBeenCalled();
    expect(result.update?.embeds[0].description).toContain("cancelled");
    expect(result.update?.components).toEqual([]);
  });

  it("re-checks permission at click time and blocks a non-owner initiator", async () => {
    // A stranger somehow holds a confirm id for themselves; they are neither
    // owner nor admin, so the click must not remove anything.
    const unregister = vi.fn();
    const result = await handleUnregisterButtonClick(
      { customId: buildUnregisterCustomId("confirm", "C1", "STRANGER"), clickerId: "STRANGER" },
      makeDeps({
        describeInstance: owned,
        isAdmin: async () => false,
        provisioning: { register: vi.fn(), unregister },
      }),
    );
    expect(unregister).not.toHaveBeenCalled();
    expect(result.update?.embeds[0].description).toContain(
      "not authorized to use this channel's agent",
    );
    expect(result.update?.embeds[0].description).toContain("<@U1>");
  });
});
