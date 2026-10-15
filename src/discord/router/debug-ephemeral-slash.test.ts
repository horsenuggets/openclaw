import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Mock only the attachment-aware edit edge so the embed payload is inspectable
// (it is otherwise sent as multipart form data); everything else runs for real.
vi.mock("./discord-api.js", async (orig) => ({
  ...(await orig<typeof import("./discord-api.js")>()),
  editInteractionEmbedReply: vi.fn(async () => ({ ok: true, status: 200 })),
}));

// /channel's defer (the thing under test for the /channel cases) fires before
// handleChannelCommand, so stub the command itself to a no-op and keep the test
// focused on the defer flag rather than the slow register/status machinery.
vi.mock("./channel-commands.js", async (orig) => ({
  ...(await orig<typeof import("./channel-commands.js")>()),
  handleChannelCommand: vi.fn(async () => {}),
}));

import type { GatewayContext } from "./gateway-events.js";
import type { RouterRuntime } from "./types.js";
import { editInteractionEmbedReply } from "./discord-api.js";
import { handleSlashInteraction } from "./gateway-events.js";
import { readEphemeralCommands, setEphemeralCommands } from "./preferences-store.js";

const CHANNEL = "123456789012345678";
const runtime = { log: () => {}, error: () => {} } as unknown as RouterRuntime;

let instancesDir: string;

type Callback = { type: number; data?: { content?: string; flags?: number } };

/**
 * Drive a `/debug <command>` slash interaction, capturing every interaction
 * callback so a test can assert the first reply's ephemerality. isAdmin is
 * injected per-test to exercise the allow and deny paths.
 */
async function runDebugSlash(params: {
  command: string;
  isAdmin: boolean;
}): Promise<{ callbacks: Callback[] }> {
  const callbacks: Callback[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/callback")) {
        callbacks.push(JSON.parse((init?.body as string) ?? "{}"));
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch,
  );
  try {
    const ctx = {
      applicationId: "app",
      runtime,
      instancesDir,
      instances: new Map(),
      channelQueue: new Map(),
      channelGuild: new Map<string, string>(),
      isAdmin: async () => params.isAdmin,
    } as unknown as GatewayContext;
    handleSlashInteraction(ctx, {
      id: "int1",
      channel_id: CHANNEL,
      token: "tok",
      channel: { type: 0 },
      guild_id: "987654321098765432",
      data: { name: "debug", options: [{ name: "command", value: params.command }] },
      user: { id: "u1" },
    } as never);
    await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
    return { callbacks };
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
 * Minimal `channelCommandDeps` shape the authorization predicate consults before
 * the defer. The defaults model an authorized caller (whitelist configured,
 * caller is admin, channel registered to the caller) so a bare call defers on the
 * preference; individual cases override to model an unauthorized caller.
 */
type AuthDeps = {
  whitelistConfigured?: boolean;
  isAdmin?: boolean;
  isWhitelisted?: boolean;
  owner?: string | null;
};

/**
 * Drive a `/channel <subcommand>` slash interaction, capturing the interaction
 * callbacks so a test can assert the defer's ephemerality. handleChannelCommand
 * is stubbed to a no-op, but the authorization predicate that picks the defer
 * flag runs for real against the injected `channelCommandDeps`, so the deps
 * decide whether the defer honors the preference (authorized) or is forced
 * ephemeral (unauthorized denial).
 */
async function runChannelSlash(
  subcommand: string,
  auth: AuthDeps = {},
): Promise<{ callbacks: Callback[] }> {
  const callbacks: Callback[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/callback")) {
        callbacks.push(JSON.parse((init?.body as string) ?? "{}"));
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ attachments: [] }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  );
  try {
    const registered = auth.owner !== undefined;
    const channelCommandDeps = {
      whitelistConfigured: () => auth.whitelistConfigured ?? true,
      isAdmin: async () => auth.isAdmin ?? true,
      isWhitelisted: async () => auth.isWhitelisted ?? true,
      describeInstance: () => (registered ? { ownerId: auth.owner } : null),
    };
    const ctx = {
      applicationId: "app",
      runtime,
      instancesDir,
      instances: new Map(),
      channelQueue: new Map(),
      channelGuild: new Map<string, string>(),
      channelCommandDeps,
      isAdmin: async () => true,
    } as unknown as GatewayContext;
    handleSlashInteraction(ctx, {
      id: "int1",
      channel_id: CHANNEL,
      token: "tok",
      channel: { type: 0 },
      guild_id: "987654321098765432",
      data: { name: "channel", options: [{ name: subcommand }] },
      user: { id: "u1" },
    } as never);
    await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
    return { callbacks };
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
 * Drive a `/secret` slash interaction in a 1:1 DM (so the owner gate passes) and
 * capture the modal-open callback so a test can confirm /secret stays ephemeral
 * regardless of the channel preference. A /secret modal (type 9) is inherently
 * ephemeral, so it never carries the channel's public flag.
 */
async function runSecretSlash(): Promise<{ callbacks: Callback[] }> {
  const callbacks: Callback[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/callback")) {
        callbacks.push(JSON.parse((init?.body as string) ?? "{}"));
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch,
  );
  try {
    const ctx = {
      applicationId: "app",
      runtime,
      instancesDir,
      instances: new Map(),
      channelQueue: new Map(),
      channelGuild: new Map<string, string>(),
      describeInstance: () => undefined,
      isAdmin: async () => true,
    } as unknown as GatewayContext;
    // A 1:1 DM (channel.type === 1, no guild_id) passes runForOwner untouched, so
    // the modal opens without a registered owner.
    handleSlashInteraction(ctx, {
      id: "int1",
      channel_id: CHANNEL,
      token: "tok",
      channel: { type: 1 },
      data: { name: "secret" },
      user: { id: "u1" },
    } as never);
    await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
    return { callbacks };
  } finally {
    vi.unstubAllGlobals();
  }
}

beforeEach(() => {
  instancesDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-debug-eph-"));
});

afterEach(() => {
  fs.rmSync(instancesDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

it("denies a non-admin /debug ephemerally even when the channel preference is public", async () => {
  // Opt the channel out of ephemeral replies (the public preference). The denial
  // must still be ephemeral: Discord fixes ephemerality at defer, so gating has to
  // happen before the defer or the permission-denied embed would be published to
  // the whole channel (see .agents/docs/command-system.md "every denial is
  // ephemeral").
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  const { callbacks } = await runDebugSlash({ command: "ephemeral", isAdmin: false });
  // The very first interaction response (the denial defer) must be ephemeral.
  expect(callbacks[0]?.data?.flags).toBe(64);
});

it("defers an authorized /debug with the channel's public preference", async () => {
  // Authorized output is allowed to honor the channel preference, so a public
  // channel defers public (flags 0) once the admin check passes.
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  const { callbacks } = await runDebugSlash({ command: "echo hi", isAdmin: true });
  expect(callbacks[0]?.type).toBe(5);
  expect(callbacks[0]?.data?.flags).toBe(0);
});

/** The first embed on the captured edit reply, typed for the Debug-category assertions. */
type ReplyEmbed = {
  title?: string;
  description?: string;
  color?: number;
  footer?: { text?: string };
};

function firstReplyEmbed(): ReplyEmbed {
  const edit = editInteractionEmbedReply as ReturnType<typeof vi.fn>;
  const message = edit.mock.calls[0][2] as { embeds: ReplyEmbed[] };
  return message.embeds[0];
}

/** Assert an embed carries the title-less Debug-category identity (footer + color). */
function expectDebugEmbed(embed: ReplyEmbed): void {
  expect(embed.title).toBeUndefined();
  expect(embed.footer?.text).toBe("Debug");
  expect(embed.color).toBe(0xff80e0);
}

it("renders a bare `ephemeral` status query as a title-less Debug embed", async () => {
  await runDebugSlash({ command: "ephemeral", isAdmin: true });
  const edit = editInteractionEmbedReply as ReturnType<typeof vi.fn>;
  await vi.waitFor(() => expect(edit).toHaveBeenCalled());
  // A status query renders the Debug category (not Command Result) and persists nothing.
  expectDebugEmbed(firstReplyEmbed());
});

it("renders a successful `ephemeral` toggle as a title-less Debug embed", async () => {
  await runDebugSlash({ command: "ephemeral off", isAdmin: true });
  const edit = editInteractionEmbedReply as ReturnType<typeof vi.fn>;
  await vi.waitFor(() => expect(edit).toHaveBeenCalled());
  // A successful toggle is Debug-category too (it used to be Command Result); the
  // write stuck, so the preference is now public.
  expectDebugEmbed(firstReplyEmbed());
  expect(readEphemeralCommands(instancesDir, CHANNEL)).toBe(false);
});

it("reports a save failure instead of a success toggle when the write fails", async () => {
  // Force every preferences write to fail: setEphemeralCommands writes under
  // <instancesDir>/shared/preferences, so a plain file where shared/ must be makes
  // the recursive mkdir throw (the read-only-mount analogue).
  fs.writeFileSync(path.join(instancesDir, "shared"), "not a directory");
  await runDebugSlash({ command: "ephemeral on", isAdmin: true });
  const edit = editInteractionEmbedReply as ReturnType<typeof vi.fn>;
  await vi.waitFor(() => expect(edit).toHaveBeenCalled());
  const embed = firstReplyEmbed();
  expect(embed.description).toContain("Could not save the ephemeral command preference");
  // The failed-save notice is also a title-less Debug embed, not a Log embed.
  expectDebugEmbed(embed);
});

it("defers ephemeral for a failed `ephemeral off` so the did-not-stick reply stays private", async () => {
  // A new channel is private by default. If `ephemeral off` fails to persist, the
  // channel is still private, so the reply (including the "did not stick" notice)
  // must be deferred ephemeral (flags 64) rather than public — the persistence
  // runs before the defer and the defer flag reflects the actual post-write value.
  fs.writeFileSync(path.join(instancesDir, "shared"), "not a directory");
  const { callbacks } = await runDebugSlash({ command: "ephemeral off", isAdmin: true });
  expect(callbacks[0]?.type).toBe(5);
  expect(callbacks[0]?.data?.flags).toBe(64);
});

it("rolls back the ephemeral toggle when the defer ack is rejected", async () => {
  // Channel starts private (default). `ephemeral off` persists the public value
  // before deferring (so the defer flag matches), but if Discord rejects the defer
  // (4xx/5xx) the command visibly failed and no reply lands — so the preference
  // must be rolled back to private rather than silently leaving the channel public.
  expect(readEphemeralCommands(instancesDir, CHANNEL)).toBe(true);
  let deferCalls = 0;
  let publicWhileDeferring = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      // Reject only the interaction defer callback.
      if (typeof url === "string" && url.includes("/callback")) {
        deferCalls += 1;
        // At defer time the toggle has already persisted the public value; capture
        // that so the test proves the rollback (not just the unchanged default).
        publicWhileDeferring = !readEphemeralCommands(instancesDir, CHANNEL);
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch,
  );
  try {
    const ctx = {
      applicationId: "app",
      runtime,
      instancesDir,
      instances: new Map(),
      channelQueue: new Map(),
      channelGuild: new Map<string, string>(),
      isAdmin: async () => true,
    } as unknown as GatewayContext;
    handleSlashInteraction(ctx, {
      id: "int1",
      channel_id: CHANNEL,
      token: "tok",
      channel: { type: 0 },
      guild_id: "987654321098765432",
      data: { name: "debug", options: [{ name: "command", value: "ephemeral off" }] },
      user: { id: "u1" },
    } as never);
    // Wait until the defer actually fired (so the assertion cannot pass on the
    // initial default before the handler ran), confirm the value WAS public at
    // defer time, then confirm it rolled back to private after the rejection.
    await vi.waitFor(() => expect(deferCalls).toBeGreaterThan(0));
    expect(publicWhileDeferring).toBe(true);
    await vi.waitFor(() => expect(readEphemeralCommands(instancesDir, CHANNEL)).toBe(true));
  } finally {
    vi.unstubAllGlobals();
  }
});

it("defers /channel status ephemeral when the channel preference is private (default)", async () => {
  // A new channel is private by default, so /channel status now defers ephemeral
  // (flags 64), honoring the preference rather than being forced ephemeral.
  const { callbacks } = await runChannelSlash("status");
  expect(callbacks[0]?.type).toBe(5);
  expect(callbacks[0]?.data?.flags).toBe(64);
});

it("defers /channel status public when the channel preference is public", async () => {
  // `/debug ephemeral off` opts the channel out of ephemeral replies; /channel
  // status now follows that preference and defers public (flags 0), unlike before
  // when it was always ephemeral.
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  const { callbacks } = await runChannelSlash("status");
  expect(callbacks[0]?.type).toBe(5);
  expect(callbacks[0]?.data?.flags).toBe(0);
});

it("defers an authorized /channel register and unregister public when the preference is public", async () => {
  // Authorization now runs BEFORE the defer, so an authorized caller's SUCCESS can
  // honor the public preference and defer public (flags 0), just like status.
  // register: whitelist configured + caller is admin. unregister: channel
  // registered to the caller ("u1", the interaction user).
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  const register = await runChannelSlash("register", { isAdmin: true });
  expect(register.callbacks[0]?.type).toBe(5);
  expect(register.callbacks[0]?.data?.flags).toBe(0);
  const unregister = await runChannelSlash("unregister", { owner: "u1" });
  expect(unregister.callbacks[0]?.type).toBe(5);
  expect(unregister.callbacks[0]?.data?.flags).toBe(0);
});

it("defers an authorized /channel register and unregister ephemeral when the preference is private (default)", async () => {
  // A new channel is private by default, so even an authorized success defers
  // ephemeral (flags 64), following the preference.
  const register = await runChannelSlash("register", { isAdmin: true });
  expect(register.callbacks[0]?.type).toBe(5);
  expect(register.callbacks[0]?.data?.flags).toBe(64);
  const unregister = await runChannelSlash("unregister", { owner: "u1" });
  expect(unregister.callbacks[0]?.type).toBe(5);
  expect(unregister.callbacks[0]?.data?.flags).toBe(64);
});

it("forces /channel register and unregister denials ephemeral even when the preference is public", async () => {
  // An UNAUTHORIZED caller must never get a public defer: Discord fixes
  // ephemerality at defer time, so a public defer would publish the permission-
  // denied embed to the channel and leak the probe. Authorization runs before the
  // defer, so the denial path forces flags 64 regardless of the public preference.
  // register: caller is neither admin nor whitelisted. unregister: channel owned by
  // someone else and the caller is not an admin.
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  const register = await runChannelSlash("register", { isAdmin: false, isWhitelisted: false });
  expect(register.callbacks[0]?.type).toBe(5);
  expect(register.callbacks[0]?.data?.flags).toBe(64);
  const unregister = await runChannelSlash("unregister", { isAdmin: false, owner: "someone-else" });
  expect(unregister.callbacks[0]?.type).toBe(5);
  expect(unregister.callbacks[0]?.data?.flags).toBe(64);
});

it("keeps /secret ephemeral even when the channel preference is public", async () => {
  // /secret is always ephemeral regardless of `ephemeralCommands`: it opens a
  // modal (type 9) so the secret value is never visible, so it must not inherit a
  // public channel preference.
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  const { callbacks } = await runSecretSlash();
  const modal = callbacks.find((cb) => cb.type === 9);
  expect(modal).toBeDefined();
  // The modal callback carries no public flag; a modal is inherently private.
  expect(modal?.data?.flags).toBeUndefined();
});

it("rolls back the ephemeral toggle when the defer request throws", async () => {
  // Same as above, but the defer fetch THROWS (transport error / abort) rather than
  // returning a non-ok response: it rejects into the outer catch after the toggle
  // already persisted, so the catch must still roll the preference back.
  expect(readEphemeralCommands(instancesDir, CHANNEL)).toBe(true);
  let deferCalls = 0;
  let publicWhileDeferring = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/callback")) {
        deferCalls += 1;
        publicWhileDeferring = !readEphemeralCommands(instancesDir, CHANNEL);
        throw new Error("network down");
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch,
  );
  try {
    const ctx = {
      applicationId: "app",
      runtime,
      instancesDir,
      instances: new Map(),
      channelQueue: new Map(),
      channelGuild: new Map<string, string>(),
      isAdmin: async () => true,
    } as unknown as GatewayContext;
    handleSlashInteraction(ctx, {
      id: "int1",
      channel_id: CHANNEL,
      token: "tok",
      channel: { type: 0 },
      guild_id: "987654321098765432",
      data: { name: "debug", options: [{ name: "command", value: "ephemeral off" }] },
      user: { id: "u1" },
    } as never);
    await vi.waitFor(() => expect(deferCalls).toBeGreaterThan(0));
    expect(publicWhileDeferring).toBe(true);
    await vi.waitFor(() => expect(readEphemeralCommands(instancesDir, CHANNEL)).toBe(true));
  } finally {
    vi.unstubAllGlobals();
  }
});
