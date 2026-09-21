import { describe, expect, it, vi } from "vitest";
import {
  type ChannelCommandDeps,
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

type ReplyCall = { text: string; ephemeral?: boolean };

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
      reply: (text: string, opts?: { ephemeral?: boolean }) => {
        replies.push({ text, ephemeral: opts?.ephemeral });
      },
    },
  };
}

function makeDeps(over: Partial<ChannelCommandDeps> = {}): ChannelCommandDeps {
  return {
    isWhitelisted: vi.fn(async () => true),
    whitelistConfigured: () => true,
    describeInstance: () => null,
    instanceCount: () => 2,
    provisioning: {
      register: vi.fn(async () => ({ ok: true, message: "registered" })),
      unregister: vi.fn(async () => ({ ok: true, message: "removed" })),
    },
    log: () => {},
    ...over,
  };
}

describe("handleChannelCommand", () => {
  it("status reports not-registered", async () => {
    const { ctx, replies } = makeCtx("status");
    await handleChannelCommand(ctx, makeDeps());
    expect(replies[0].text).toContain("not registered");
  });

  it("status reports registered details", async () => {
    const status: InstanceStatus = { port: 18795, ownerId: "999", onboarded: false };
    const { ctx, replies } = makeCtx("status");
    await handleChannelCommand(ctx, makeDeps({ describeInstance: () => status }));
    expect(replies[0].text).toContain("Port: 18795");
    expect(replies[0].text).toContain("<@999>");
    expect(replies[0].text).toContain("Onboarded: no");
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
    expect(replies[0].text).toContain("not authorized");
    expect(register).not.toHaveBeenCalled();
  });

  it("register provisions for a whitelisted user on an unregistered channel", async () => {
    const register = vi.fn(async () => ({ ok: true, message: "done" }));
    const { ctx, replies } = makeCtx("register");
    await handleChannelCommand(ctx, makeDeps({ provisioning: { register, unregister: vi.fn() } }));
    expect(register).toHaveBeenCalledOnce();
    expect(replies[0].text).toBe("done");
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
    expect(replies[0].text).toContain("already registered");
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
    expect(first.replies[0].text).toContain("To proceed");

    const second = makeCtx("unregister", ["yes"]);
    await handleChannelCommand(second.ctx, deps);
    expect(unregister).toHaveBeenCalledOnce();
    expect(second.replies[0].text).toBe("removed");
  });

  it("refuses to unregister the last remaining instance", async () => {
    const unregister = vi.fn(async () => ({ ok: true, message: "removed" }));
    const { ctx, replies } = makeCtx("unregister", ["yes"]);
    await handleChannelCommand(
      ctx,
      makeDeps({
        describeInstance: () => ({ port: 1, onboarded: true }),
        instanceCount: () => 1,
        provisioning: { register: vi.fn(), unregister },
      }),
    );
    expect(unregister).not.toHaveBeenCalled();
    expect(replies[0].text).toContain("only registered channel");
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
    expect(replies[0].text).toContain("not configured");
  });
});
