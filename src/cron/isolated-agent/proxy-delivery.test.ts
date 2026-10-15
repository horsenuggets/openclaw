import { describe, expect, it, vi } from "vitest";
import { deliverDiscordViaProxy } from "./proxy-delivery.js";

function okResponse() {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function bodies(fetchImpl: unknown) {
  return (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map(
    ([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>,
  );
}

describe("deliverDiscordViaProxy", () => {
  it("posts a bare channel id (numeric) to /discord/send with channelId", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    await deliverDiscordViaProxy({
      proxyUrl: "http://proxy:18800/",
      to: "123456789012345678",
      toKind: "channel",
      payloads: [{ text: "hello" }],
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://proxy:18800/discord/send"); // trailing slash trimmed
    expect(bodies(fetchImpl)[0]).toEqual({ channelId: "123456789012345678", text: "hello" });
  });

  it("posts a bare user id (numeric) with userId when toKind is user", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    await deliverDiscordViaProxy({
      proxyUrl: "http://proxy:18800",
      to: "456789012345678901",
      toKind: "user",
      payloads: [{ text: "hi" }],
      fetchImpl,
    });
    expect(bodies(fetchImpl)[0]).toEqual({ userId: "456789012345678901", text: "hi" });
  });

  it("honors prefixed targets regardless of toKind", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    // user: prefix wins even though the captured kind says channel.
    await deliverDiscordViaProxy({
      proxyUrl: "http://proxy:18800",
      to: "user:888",
      toKind: "channel",
      payloads: [{ text: "a" }],
      fetchImpl,
    });
    // channel: prefix wins even though the captured kind says user.
    await deliverDiscordViaProxy({
      proxyUrl: "http://proxy:18800",
      to: "channel:999",
      toKind: "user",
      payloads: [{ text: "b" }],
      fetchImpl,
    });
    const sent = bodies(fetchImpl);
    expect(sent[0]).toEqual({ userId: "888", text: "a" });
    expect(sent[1]).toEqual({ channelId: "999", text: "b" });
  });

  it("splits oversized text into multiple <=2000-char sends", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const big = "x".repeat(4500);
    await deliverDiscordViaProxy({
      proxyUrl: "http://proxy:18800",
      to: "123456789012345678",
      toKind: "channel",
      payloads: [{ text: big }],
      fetchImpl,
    });
    const sent = bodies(fetchImpl);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const b of sent) {
      expect((b.text as string).length).toBeLessThanOrEqual(2000);
    }
    expect(sent.map((b) => b.text).join("")).toBe(big);
  });

  it("sends media as its own message with the URL in a single field", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    await deliverDiscordViaProxy({
      proxyUrl: "http://proxy:18800",
      to: "123456789012345678",
      toKind: "channel",
      payloads: [{ text: "see this", mediaUrls: ["http://x/img.png"] }],
      fetchImpl,
    });
    const sent = bodies(fetchImpl);
    // One text message, then one media message. The URL must appear exactly once
    // (no duplicate mediaUrl field) so the proxy does not double-append it.
    expect(sent[0]).toEqual({ channelId: "123456789012345678", text: "see this" });
    expect(sent[1]).toEqual({ channelId: "123456789012345678", text: "http://x/img.png" });
  });

  it("skips non-http media (local paths) but still sends the text", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    await deliverDiscordViaProxy({
      proxyUrl: "http://proxy:18800",
      to: "123456789012345678",
      toKind: "channel",
      payloads: [{ text: "look", mediaUrls: ["./screenshots/image.png"] }],
      fetchImpl,
    });
    const sent = bodies(fetchImpl);
    // Only the text message goes out; the local path is not posted as text.
    expect(sent).toEqual([{ channelId: "123456789012345678", text: "look" }]);
  });

  it("skips empty-text payloads with no media", async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    await deliverDiscordViaProxy({
      proxyUrl: "http://proxy:18800",
      to: "123456789012345678",
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
        to: "123456789012345678",
        toKind: "channel",
        payloads: [{ text: "hello" }],
        fetchImpl,
      }),
    ).rejects.toThrow(/discord proxy send failed \(500\)/);
  });
});
