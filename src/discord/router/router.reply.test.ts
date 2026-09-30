import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordSendReply } from "./router";

// Captures the fetch calls discordSendReply makes so we can assert the exact
// POST body a bot's `/channel` reply produces (the tester-bot path has no
// interaction, so it must post a real referenced reply).
let calls: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "999" }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastBody(): Record<string, unknown> {
  const init = calls.at(-1)!.init;
  return JSON.parse(init.body as string);
}

describe("discordSendReply", () => {
  it("posts a string content reply that references the command message", async () => {
    await discordSendReply("tok", "chan-1", "cmd-42", "not registered");
    const body = lastBody();
    expect(body.content).toBe("not registered");
    expect(body.embeds).toBeUndefined();
    expect(body.message_reference).toEqual({
      message_id: "cmd-42",
      channel_id: "chan-1",
      fail_if_not_exists: false,
    });
    // Real reply, not an interaction response, and never ephemeral (bots cannot
    // send ephemeral outside interactions).
    expect(JSON.stringify(body)).not.toContain('"flags"');
  });

  it("posts an embeds reply that references the command message", async () => {
    const embed = { title: "Channel status", fields: [{ name: "Port", value: "18790" }] };
    await discordSendReply("tok", "chan-1", "cmd-42", { embeds: [embed] });
    const body = lastBody();
    expect(body.embeds).toEqual([embed]);
    expect(body.content).toBeUndefined();
    expect(body.message_reference).toEqual({
      message_id: "cmd-42",
      channel_id: "chan-1",
      fail_if_not_exists: false,
    });
  });

  it("sends the bot authorization header to the channel messages endpoint", async () => {
    await discordSendReply("secret-token", "chan-9", "cmd-1", "hi");
    const { url, init } = calls.at(-1)!;
    expect(url).toContain("/channels/chan-9/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bot secret-token");
    expect(init.method).toBe("POST");
  });
});
