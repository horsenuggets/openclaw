import { describe, expect, it, vi } from "vitest";
import { deliverDiscordViaProxy } from "./proxy-delivery.js";

function okResponse() {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

describe("deliverDiscordViaProxy", () => {
  it("posts a channel target to /discord/send with channelId", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    await deliverDiscordViaProxy({
      proxyUrl: "http://proxy:18800/",
      to: "thread-1",
      toKind: "channel",
      payloads: [{ text: "hello" }],
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    // Trailing slash on the base is trimmed.
    expect(url).toBe("http://proxy:18800/discord/send");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      channelId: "thread-1",
      text: "hello",
    });
  });

  it("posts a user target with userId (DM path)", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    await deliverDiscordViaProxy({
      proxyUrl: "http://proxy:18800",
      to: "user-9",
      toKind: "user",
      payloads: [{ text: "hi" }],
      fetchImpl,
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      userId: "user-9",
      text: "hi",
    });
  });

  it("skips empty-text payloads with no media", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    await deliverDiscordViaProxy({
      proxyUrl: "http://proxy:18800",
      to: "thread-1",
      toKind: "channel",
      payloads: [{ text: "   " }, { text: "real" }],
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-2xx proxy response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("boom", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(
      deliverDiscordViaProxy({
        proxyUrl: "http://proxy:18800",
        to: "thread-1",
        toKind: "channel",
        payloads: [{ text: "hello" }],
        fetchImpl,
      }),
    ).rejects.toThrow(/discord proxy send failed \(500\)/);
  });
});
