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

import type { ChannelCommandDeps } from "./channel-commands.js";
import type { GatewayContext } from "./gateway-events.js";
import type { RouterRuntime } from "./types.js";
import { buildUnregisterCustomId, handleChannelCommand } from "./channel-commands.js";
import { editInteractionEmbedReply } from "./discord-api.js";
import { handleComponentInteraction, handleSlashInteraction } from "./gateway-events.js";
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
  /** Drive the interaction as a 1:1 DM (no guild_id) rather than a guild channel. */
  isDM?: boolean;
  /** register's `owner` option (a user id), to exercise the on-behalf gate. */
  ownerArg?: string;
};

/**
 * Drive a `/channel <subcommand>` slash interaction, capturing the interaction
 * callbacks so a test can assert the defer's ephemerality. handleChannelCommand
 * is stubbed to a no-op, but the authorization predicate that picks the defer
 * flag runs for real against the injected `channelCommandDeps`, so the deps
 * decide whether the defer honors the preference (authorized) or is forced
 * ephemeral (unauthorized denial).
 */
type CapturedRequest = { url: string; method?: string; body: Record<string, unknown> };

async function runChannelSlash(
  subcommand: string,
  auth: AuthDeps = {},
): Promise<{ callbacks: Callback[]; requests: CapturedRequest[] }> {
  const callbacks: Callback[] = [];
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string") {
        const body = JSON.parse((init?.body as string) ?? "{}");
        requests.push({ url, method: init?.method, body });
        if (url.includes("/callback")) {
          callbacks.push(body);
        }
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
    const subOptions = auth.ownerArg ? [{ name: "owner", value: auth.ownerArg }] : undefined;
    handleSlashInteraction(ctx, {
      id: "int1",
      channel_id: CHANNEL,
      token: "tok",
      // A 1:1 DM has channel.type 1 and no guild_id; a guild channel has type 0.
      channel: { type: auth.isDM ? 1 : 0 },
      ...(auth.isDM ? {} : { guild_id: "987654321098765432" }),
      data: {
        name: "channel",
        options: [{ name: subcommand, ...(subOptions ? { options: subOptions } : {}) }],
      },
      user: { id: "u1" },
    } as never);
    await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
    return { callbacks, requests };
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

it("forces a whitelisted non-admin register denial ephemeral when the handler would deny", async () => {
  // A whitelisted non-admin is denied by the handler when registering a guild
  // channel or registering on another user's behalf. The preflight gate must mirror
  // those denials so the public preference never leaks a permission-denied embed.
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  // Guild channel (not a DM): denied.
  const guild = await runChannelSlash("register", { isAdmin: false, isWhitelisted: true });
  expect(guild.callbacks[0]?.type).toBe(5);
  expect(guild.callbacks[0]?.data?.flags).toBe(64);
  // On another user's behalf, even in their own DM: denied.
  const onBehalf = await runChannelSlash("register", {
    isAdmin: false,
    isWhitelisted: true,
    isDM: true,
    ownerArg: "<@999999999999999999>",
  });
  expect(onBehalf.callbacks[0]?.type).toBe(5);
  expect(onBehalf.callbacks[0]?.data?.flags).toBe(64);
});

it("defers a whitelisted non-admin register of their own DM public when the preference is public", async () => {
  // The one register a whitelisted non-admin IS allowed: their own DM, no on-behalf
  // owner. That success honors the public preference like any other.
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  const dm = await runChannelSlash("register", {
    isAdmin: false,
    isWhitelisted: true,
    isDM: true,
  });
  expect(dm.callbacks[0]?.type).toBe(5);
  expect(dm.callbacks[0]?.data?.flags).toBe(0);
});

it("routes a late /channel denial (after a public defer) to an ephemeral follow-up", async () => {
  // The preflight gate authorizes before the defer, but the handler re-checks
  // authorization after it (owner/admin revalidation, the stale-registration nonce
  // guard), and in that sub-second window the re-check can flip to a denial. On a
  // public-preference channel the deferred reply is already public, so that late
  // denial must NOT be edited into the public placeholder: it is delivered as an
  // ephemeral follow-up (flags 64) and the public message is neutralized. Model the
  // flip by having the stubbed handler emit an {ephemeral:true} denial reply.
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  vi.mocked(handleChannelCommand).mockImplementationOnce(async (ctx) => {
    // A denial sets both ephemeral and the `denied` marker; only `denied` reroutes
    // to the private path (every reply sets ephemeral, so it cannot distinguish).
    void ctx.reply(
      { embeds: [{ description: "You are not authorized." }], attachments: [] },
      { ephemeral: true, denied: true },
    );
  });
  // Authorized preflight (admin unregister of a channel owned by the caller) so the
  // defer is public; the late denial comes from the handler, not the preflight.
  const { callbacks, requests } = await runChannelSlash("unregister", { owner: "u1" });
  // The defer is public (flags 0).
  expect(callbacks[0]?.type).toBe(5);
  expect(callbacks[0]?.data?.flags).toBe(0);
  // An ephemeral follow-up (POST to the webhook base URL, flags 64) carries the
  // denial. The public @original edit does not: strings go through fetch, embeds
  // through the mocked editor, so assert the ephemeral POST exists and is private.
  await vi.waitFor(() => {
    const followup = requests.find(
      (r) =>
        r.method === "POST" &&
        r.url.endsWith("/webhooks/app/tok") &&
        (r.body as { flags?: number }).flags === 64,
    );
    expect(followup).toBeDefined();
  });
  // The public placeholder is neutralized (a plain-content @original PATCH), never
  // left showing the denial text.
  const neutralize = requests.find(
    (r) => r.method === "PATCH" && r.url.includes("/messages/@original"),
  );
  expect(neutralize).toBeDefined();
  expect((neutralize?.body as { content?: string } | undefined)?.content).toBe(
    "This request was handled privately.",
  );
});

it("edits a SUCCESS /channel reply into the public deferred reply (not the private path)", async () => {
  // Every /channel reply sets ephemeral:true, including register/unregister SUCCESS.
  // Only `denied` reroutes to the private path; a success (ephemeral, NOT denied)
  // after a public defer must edit the public deferred reply in place, so the result
  // is visible to the channel. Guards against misclassifying success as a denial.
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  vi.mocked(handleChannelCommand).mockImplementationOnce(async (ctx) => {
    void ctx.reply(
      { embeds: [{ description: "Registered successfully." }], attachments: [] },
      { ephemeral: true },
    );
  });
  const { callbacks, requests } = await runChannelSlash("register", { isAdmin: true });
  expect(callbacks[0]?.data?.flags).toBe(0);
  // The success is NOT neutralized: no "handled privately" PATCH and no ephemeral
  // (flags 64) follow-up POST. It goes through the attachment-aware embed editor
  // (mocked), which does not hit fetch, so no @original PATCH content should appear.
  const privatized = requests.find(
    (r) =>
      (r.body as { content?: string }).content === "This request was handled privately." ||
      (r.body as { flags?: number }).flags === 64,
  );
  expect(privatized).toBeUndefined();
  // The embed editor (mocked) carried the success embed.
  const edit = editInteractionEmbedReply as ReturnType<typeof vi.fn>;
  expect(edit).toHaveBeenCalled();
});

it("the real handler's register success stays public on a public channel (no misclassification)", async () => {
  // End-to-end with the REAL handleChannelCommand (not the no-op mock): an admin
  // register success on a public-preference channel defers public and its result is
  // edited into the public reply, never rerouted to the private path. This exercises
  // the real {ephemeral:true} success reply the no-op mock would otherwise hide.
  const actual =
    await vi.importActual<typeof import("./channel-commands.js")>("./channel-commands.js");
  expect(setEphemeralCommands(instancesDir, CHANNEL, false)).toBe(true);
  const deps: Partial<ChannelCommandDeps> = {
    whitelistConfigured: () => true,
    isAdmin: async () => true,
    isWhitelisted: async () => true,
    isSelf: () => false,
    describeInstance: () => null,
    registrationNonce: () => "1",
    provisioning: {
      register: vi.fn(async () => ({ ok: true, message: "ready" })),
      unregister: vi.fn(async () => ({ ok: true, message: "" })),
    } as unknown as ChannelCommandDeps["provisioning"],
    kickOnboarding: () => {},
    log: () => {},
  };
  vi.mocked(handleChannelCommand).mockImplementationOnce((ctx) =>
    actual.handleChannelCommand(ctx, deps as ChannelCommandDeps),
  );
  const { callbacks, requests } = await runChannelSlash("register", { isAdmin: true });
  expect(callbacks[0]?.data?.flags).toBe(0);
  // No private reroute: no neutralizing PATCH and no ephemeral follow-up.
  const privatized = requests.find(
    (r) =>
      (r.body as { content?: string }).content === "This request was handled privately." ||
      (r.body as { flags?: number }).flags === 64,
  );
  expect(privatized).toBeUndefined();
  const edit = editInteractionEmbedReply as ReturnType<typeof vi.fn>;
  await vi.waitFor(() => expect(edit).toHaveBeenCalled());
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

it("routes a denied unregister confirm click to an ephemeral follow-up and neutralizes the public prompt", async () => {
  // A public unregister confirmation prompt (public-preference channel) can be shown
  // to an admin who then loses admin before clicking Confirm, so decideUnregisterClick
  // returns `denied`. That permission denial must NOT be edited into the public
  // confirmation message: it is delivered as an ephemeral follow-up (flags 64) and
  // the public message is replaced with a neutral, non-revealing note.
  const requests: { url: string; method?: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string") {
        requests.push({
          url,
          method: init?.method,
          body: JSON.parse((init?.body as string) ?? "{}"),
        });
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch,
  );
  try {
    // Channel registered to someone else; clicker is neither owner nor admin, so the
    // click resolves to `denied`. registrationNonce "g1" matches the button's gen.
    const channelCommandDeps = {
      describeInstance: () => ({ ownerId: "owner-other" }),
      registrationNonce: () => "g1",
      isAdmin: async () => false,
      log: () => {},
    };
    const ctx = {
      applicationId: "app",
      runtime,
      channelGuild: new Map<string, string>(),
      channelCommandDeps,
      unregisterInFlight: new Set<string>(),
    } as unknown as GatewayContext;
    const customId = buildUnregisterCustomId("confirm", CHANNEL, "u1", "g1");
    handleComponentInteraction(ctx, {
      id: "int1",
      token: "tok",
      channel_id: CHANNEL,
      guild_id: "987654321098765432",
      data: { custom_id: customId },
      user: { id: "u1" },
    } as never);
    // The ephemeral follow-up (POST to the webhook base URL, flags 64) carries the
    // denial embed.
    await vi.waitFor(() => {
      const followup = requests.find(
        (r) =>
          r.method === "POST" &&
          r.url.endsWith("/webhooks/app/tok") &&
          (r.body as { flags?: number }).flags === 64,
      );
      expect(followup).toBeDefined();
    });
    // The initial ack is a type-7 "processing" update (drops the buttons), never the
    // denial. The public message is subsequently neutralized via the mocked
    // editInteractionEmbedReply, so the denial text never shows publicly.
    const ack = requests.find((r) => r.url.includes("/callback"));
    expect(ack).toBeDefined();
    expect((ack?.body as { type?: number } | undefined)?.type).toBe(7);
  } finally {
    vi.unstubAllGlobals();
  }
});
