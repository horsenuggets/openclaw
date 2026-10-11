import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Mock only the Discord edges; everything else (setUserPreference, the lifecycle
// command resolution) runs for real so the save-failure branch is genuinely exercised.
vi.mock("./discord-api.js", async (orig) => ({
  ...(await orig<typeof import("./discord-api.js")>()),
  sendEmbedMessage: vi.fn(async () => ({ ok: true, status: 200 })),
}));

import type { InstanceConfig } from "./config.js";
import type { GatewayContext } from "./gateway-events.js";
import type { RouterRuntime } from "./types.js";
import { sendEmbedMessage } from "./discord-api.js";
import { handleSlashInteraction } from "./gateway-events.js";
import { handleTextCommand } from "./route-message.js";

const CHANNEL = "123456789012345678";
const runtime = { log: () => {}, error: () => {} } as unknown as RouterRuntime;

let instancesDir: string;
let instance: InstanceConfig;

beforeEach(() => {
  instancesDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-lifecycle-"));
  // Force every preferences write to fail: setUserPreference writes under
  // <instancesDir>/shared/preferences, so put a regular file where the shared/
  // directory must be and the recursive mkdir throws (the read-only-mount analogue).
  fs.writeFileSync(path.join(instancesDir, "shared"), "not a directory");
  instance = {
    channelId: CHANNEL,
    port: 18999,
    token: "tok",
    preferences: {},
    configPath: path.join(instancesDir, CHANNEL, "openclaw.json"),
    instanceDir: path.join(instancesDir, CHANNEL),
  };
});

afterEach(() => {
  fs.rmSync(instancesDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

it("text /lifecycle reports a save failure instead of a success embed", async () => {
  const handled = await handleTextCommand({
    cmdName: "lifecycle",
    cmdArg: "on",
    userId: "u1",
    channelId: CHANNEL,
    messageId: "m1",
    instance,
    discordToken: "tok",
    runtime,
  });
  expect(handled).toBe(true);
  expect(sendEmbedMessage).toHaveBeenCalledTimes(1);
  const payload = (sendEmbedMessage as ReturnType<typeof vi.fn>).mock.calls[0][2] as {
    embeds: { description?: string }[];
  };
  expect(payload.embeds[0].description).toContain("Could not save your lifecycle preference");
  // The in-memory preference must not flip when the write did not persist.
  expect(instance.preferences.lifecycleMessages).toBeUndefined();
});

it("slash /lifecycle replies with the save-failure notice, not a success result", async () => {
  const callbacks: Array<{ type: number; data?: { content?: string; flags?: number } }> = [];
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
      instances: new Map([[CHANNEL, instance]]),
      channelGuild: new Map<string, string>(),
    } as unknown as GatewayContext;
    // A 1:1 DM (no guild_id, channel type 1) bypasses the owner gate, so the handler
    // reaches the lifecycle toggle directly and the save failure is what is tested.
    handleSlashInteraction(ctx, {
      id: "int1",
      channel_id: CHANNEL,
      token: "tok",
      channel: { type: 1 },
      data: { name: "lifecycle", options: [{ name: "setting", value: "on" }] },
      user: { id: "u1" },
    });
    await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(0));
    const reply = callbacks.find((c) => c.data?.content?.includes("Could not save"));
    expect(reply).toBeDefined();
    expect(reply?.data?.flags).toBe(64);
    expect(instance.preferences.lifecycleMessages).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});
