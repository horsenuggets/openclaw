import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the heavy edges so we can exercise just the payload delivery loop.
vi.mock("./gateway-call.js", () => ({ callGatewaySimple: vi.fn() }));
vi.mock("./config.js", async (orig) => ({
  ...(await orig<typeof import("./config.js")>()),
  refreshToken: vi.fn(() => ""),
}));
vi.mock("./onboarding.js", async (orig) => ({
  ...(await orig<typeof import("./onboarding.js")>()),
  readBootstrapDirective: vi.fn(() => null),
}));
vi.mock("./whisper-url.js", () => ({ resolveWhisperUrl: vi.fn(() => "") }));
vi.mock("./discord-api.js", async (orig) => ({
  ...(await orig<typeof import("./discord-api.js")>()),
  discordTyping: vi.fn(async () => {}),
  discordSend: vi.fn(async () => {}),
  sendEmbedMessage: vi.fn(async () => ({ ok: true, status: 200 })),
}));

import type { InstanceConfig } from "./config.js";
import type { RouterRuntime } from "./types.js";
import { discordSend, sendEmbedMessage } from "./discord-api.js";
import { callGatewaySimple } from "./gateway-call.js";
import { routeMessage } from "./route-message.js";

const instance = {
  port: 18999,
  preferences: {},
  instanceDir: "/tmp/none",
} as unknown as InstanceConfig;
const runtime = { log: () => {}, error: () => {} } as unknown as RouterRuntime;

function route(
  payloads: Array<{ text?: string; isError?: boolean }>,
  runCommand?: Parameters<typeof routeMessage>[0]["runCommand"],
) {
  (callGatewaySimple as ReturnType<typeof vi.fn>).mockResolvedValue({ result: { payloads } });
  return routeMessage({
    authorId: "u1",
    channelId: "c1",
    messageContent: "hi",
    instance,
    discordToken: "tok",
    runtime,
    agentTimeoutMs: 1000,
    inflight: new Set<string>(),
    preacquiredInflight: true,
    runCommand,
  });
}

afterEach(() => vi.clearAllMocks());

describe("routeMessage payload delivery", () => {
  it("renders an isError payload as a Log embed, not plain text", async () => {
    await route([{ text: '*502 {"error":"upstream auth unavailable"}*', isError: true }]);
    expect(sendEmbedMessage).toHaveBeenCalledTimes(1);
    expect(discordSend).not.toHaveBeenCalled();
    const call = (sendEmbedMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    const message = call[2] as { embeds: { description?: string }[]; attachments?: string[] };
    expect(message.attachments).toEqual(["log-message.png"]);
    expect(message.embeds[0].description).toContain("```json");
    expect(message.embeds[0].description).not.toMatch(/^\*/);
  });

  it("sends a normal (non-error) payload as plain text", async () => {
    await route([{ text: "hello world" }]);
    expect(discordSend).toHaveBeenCalledTimes(1);
    expect(sendEmbedMessage).not.toHaveBeenCalled();
  });

  it("never runs a control command from an error payload", async () => {
    const runCommand = vi.fn(async () => "ran");
    await route([{ text: "⁘ lifecycle off", isError: true }], runCommand);
    expect(runCommand).not.toHaveBeenCalled();
    expect(sendEmbedMessage).toHaveBeenCalledTimes(1);
  });

  it("falls back to plain text when the error embed send rejects", async () => {
    (sendEmbedMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network down"));
    await route([{ text: "*boom*", isError: true }]);
    expect(sendEmbedMessage).toHaveBeenCalledTimes(1);
    expect(discordSend).toHaveBeenCalledTimes(1);
  });

  it("falls back to plain text when the error embed send returns non-2xx", async () => {
    (sendEmbedMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
    });
    await route([{ text: "*boom*", isError: true }]);
    expect(discordSend).toHaveBeenCalledTimes(1);
  });
});
