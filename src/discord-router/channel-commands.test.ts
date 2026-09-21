import { describe, expect, it, vi } from "vitest";
import {
  type ChannelCommandDeps,
  type ChannelReplyPayload,
  type InstanceStatus,
  handleChannelCommand,
  parseChannelTextCommand,
} from "./channel-commands.js";

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

type ReplyCall = { payload: ChannelReplyPayload; ephemeral?: boolean };

function makeCtx(subcommand: string | null, args: string[] = []) {
  const replies: ReplyCall[] = [];
  return {
    replies,
    ctx: {
      subcommand,
      args,
      channelId: "123456789012345678",
      userId: "111111111111111111",
      isDM: false,
      reply: (payload: ChannelReplyPayload, opts?: { ephemeral?: boolean }) => {
        replies.push({ payload, ephemeral: opts?.ephemeral });
      },
    },
  };
}

/** Narrow a reply payload to a plain string (fails the test if it is an embed). */
function textOf(payload: ChannelReplyPayload): string {
  expect(typeof payload).toBe("string");
  return payload as string;
}

/** Narrow a reply payload to its first embed (fails the test if it is a string). */
function embedOf(payload: ChannelReplyPayload) {
  expect(typeof payload).toBe("object");
  const { embeds } = payload as { embeds: unknown[] };
  expect(Array.isArray(embeds)).toBe(true);
  return embeds[0] as {
    title?: string;
    description?: string;
    fields?: { name: string; value: string }[];
  };
}

function makeDeps(over: Partial<ChannelCommandDeps> = {}): ChannelCommandDeps {
  return {
    isWhitelisted: vi.fn(async () => true),
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

describe("handleChannelCommand", () => {
  it("status reports not-registered via an embed", async () => {
    const { ctx, replies } = makeCtx("status");
    await handleChannelCommand(ctx, makeDeps());
    const embed = embedOf(replies[0].payload);
    expect(embed.title).toBe("Channel status");
    expect(embed.description).toContain("not registered");
    expect(replies[0].ephemeral).toBe(true);
  });

  it("status reports registered details as an embed table", async () => {
    const status: InstanceStatus = { port: 18795, ownerId: "999", onboarded: false };
    const { ctx, replies } = makeCtx("status");
    await handleChannelCommand(ctx, makeDeps({ describeInstance: () => status }));
    const embed = embedOf(replies[0].payload);
    expect(embed.title).toBe("Channel status");
    const fields = embed.fields ?? [];
    const field = (name: string) => fields.find((f) => f.name === name)?.value;
    expect(field("Port")).toBe("18795");
    expect(field("Owner")).toBe("<@999>");
    expect(field("Onboarded")).toContain("no");
  });

  it("register denies non-whitelisted users and does not provision", async () => {
    const register = vi.fn(async () => ({ ok: true, message: "registered" }));
    const { ctx, replies } = makeCtx("register");
    await handleChannelCommand(
      ctx,
      makeDeps({
        isWhitelisted: async () => false,
        provisioning: { register, unregister: vi.fn() },
      }),
    );
    expect(textOf(replies[0].payload)).toContain("not authorized");
    expect(register).not.toHaveBeenCalled();
  });

  it("register provisions for a whitelisted user on an unregistered channel", async () => {
    const register = vi.fn(async () => ({ ok: true, message: "done" }));
    const { ctx, replies } = makeCtx("register");
    await handleChannelCommand(ctx, makeDeps({ provisioning: { register, unregister: vi.fn() } }));
    expect(register).toHaveBeenCalledOnce();
    expect(textOf(replies[0].payload)).toBe("done");
  });

  it("register refuses when already registered", async () => {
    const register = vi.fn();
    const { ctx, replies } = makeCtx("register");
    await handleChannelCommand(
      ctx,
      makeDeps({
        describeInstance: () => ({ port: 1, onboarded: true }),
        provisioning: { register, unregister: vi.fn() },
      }),
    );
    expect(register).not.toHaveBeenCalled();
    expect(textOf(replies[0].payload)).toContain("already registered");
  });

  it("unregister requires explicit confirmation before removing", async () => {
    const unregister = vi.fn(async () => ({ ok: true, message: "removed" }));
    const deps = makeDeps({
      describeInstance: () => ({ port: 1, onboarded: true }),
      provisioning: { register: vi.fn(), unregister },
    });

    const first = makeCtx("unregister");
    await handleChannelCommand(first.ctx, deps);
    expect(unregister).not.toHaveBeenCalled();
    expect(textOf(first.replies[0].payload)).toContain("To proceed");

    const second = makeCtx("unregister", ["yes"]);
    await handleChannelCommand(second.ctx, deps);
    expect(unregister).toHaveBeenCalledOnce();
    expect(textOf(second.replies[0].payload)).toBe("removed");
  });

  it("blocks register when whitelist is not configured", async () => {
    const register = vi.fn();
    const { ctx, replies } = makeCtx("register");
    await handleChannelCommand(
      ctx,
      makeDeps({
        whitelistConfigured: () => false,
        provisioning: { register, unregister: vi.fn() },
      }),
    );
    expect(register).not.toHaveBeenCalled();
    expect(textOf(replies[0].payload)).toContain("not configured");
  });

  it("allows status for anyone without a configured whitelist", async () => {
    const isWhitelisted = vi.fn(async () => false);
    const { ctx, replies } = makeCtx("status");
    await handleChannelCommand(ctx, makeDeps({ whitelistConfigured: () => false, isWhitelisted }));
    // status must never consult the whitelist and always replies with an embed.
    expect(isWhitelisted).not.toHaveBeenCalled();
    expect(embedOf(replies[0].payload).title).toBe("Channel status");
  });
});
