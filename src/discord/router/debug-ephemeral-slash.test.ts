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

it("reports a save failure instead of a success toggle when the write fails", async () => {
  // Force every preferences write to fail: setEphemeralCommands writes under
  // <instancesDir>/shared/preferences, so a plain file where shared/ must be makes
  // the recursive mkdir throw (the read-only-mount analogue).
  fs.writeFileSync(path.join(instancesDir, "shared"), "not a directory");
  await runDebugSlash({ command: "ephemeral on", isAdmin: true });
  const edit = editInteractionEmbedReply as ReturnType<typeof vi.fn>;
  await vi.waitFor(() => expect(edit).toHaveBeenCalled());
  const message = edit.mock.calls[0][2] as { embeds: Array<{ description?: string }> };
  expect(message.embeds[0].description).toContain(
    "Could not save the ephemeral command preference",
  );
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      // Reject only the interaction defer callback.
      if (typeof url === "string" && url.includes("/callback")) {
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
    // The toggle persisted "public" then rolled back to the private default after
    // the rejected defer.
    await vi.waitFor(() => expect(readEphemeralCommands(instancesDir, CHANNEL)).toBe(true));
  } finally {
    vi.unstubAllGlobals();
  }
});
