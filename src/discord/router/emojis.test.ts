import { afterEach, describe, expect, it, vi } from "vitest";
import { initAppEmojis, resetAppEmojis, resolveEmoji } from "./emojis.js";

afterEach(() => resetAppEmojis());

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

describe("resolveEmoji", () => {
  it("returns the fallback before any load", () => {
    expect(resolveEmoji("bluecheckfilled", "✅")).toBe("✅");
  });

  it("resolves a loaded static emoji to <:name:id>", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [{ name: "bluecheckfilled", id: "123", animated: false }] }),
    );
    const count = await initAppEmojis("tok", "appid", fetchImpl as unknown as typeof fetch);
    expect(count).toBe(1);
    expect(resolveEmoji("bluecheckfilled", "✅")).toBe("<:bluecheckfilled:123>");
  });

  it("prefixes an animated emoji with 'a'", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [{ name: "spin", id: "999", animated: true }] }),
    );
    await initAppEmojis("tok", "appid", fetchImpl as unknown as typeof fetch);
    expect(resolveEmoji("spin", ":spin:")).toBe("<a:spin:999>");
  });

  it("returns the fallback for an unknown name after a load", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ items: [{ name: "bluecheckfilled", id: "123" }] }),
    );
    await initAppEmojis("tok", "appid", fetchImpl as unknown as typeof fetch);
    expect(resolveEmoji("missing", "❌")).toBe("❌");
  });

  it("sends the bot token and hits the application emojis endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [] }));
    await initAppEmojis("secret-token", "appid", fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/applications/appid/emojis");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bot secret-token" });
  });
});

describe("initAppEmojis resilience", () => {
  it("keeps the fallback and does not throw on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false));
    const count = await initAppEmojis("tok", "appid", fetchImpl as unknown as typeof fetch);
    expect(count).toBe(0);
    expect(resolveEmoji("bluecheckfilled", "✅")).toBe("✅");
  });

  it("keeps a prior cache when a refresh fails", async () => {
    const good = vi.fn(async () =>
      jsonResponse({ items: [{ name: "bluecheckfilled", id: "123" }] }),
    );
    await initAppEmojis("tok", "appid", good as unknown as typeof fetch);
    const bad = vi.fn(async () => {
      throw new Error("network down");
    });
    const count = await initAppEmojis("tok", "appid", bad as unknown as typeof fetch);
    expect(count).toBe(1);
    expect(resolveEmoji("bluecheckfilled", "✅")).toBe("<:bluecheckfilled:123>");
  });

  it("ignores items missing a name or id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        items: [{ name: "ok", id: "1" }, { name: "noId" }, { id: "2" }],
      }),
    );
    const count = await initAppEmojis("tok", "appid", fetchImpl as unknown as typeof fetch);
    expect(count).toBe(1);
    expect(resolveEmoji("ok", "x")).toBe("<:ok:1>");
    expect(resolveEmoji("noId", "x")).toBe("x");
  });
});
