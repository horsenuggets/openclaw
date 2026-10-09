import { describe, expect, it, vi } from "vitest";
import { connectionEmojiFromMap, emojiRef, fetchAppEmojiMap } from "./app-emojis.js";

function jsonResponse(ok: boolean, body: unknown): Response {
  return { ok, json: async () => body } as unknown as Response;
}

/** Mock fetch: /oauth2/applications/@me returns the app id, then the emojis list. */
function emojiFetch(items: unknown, appOk = true, emojiOk = true) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/oauth2/applications/@me")) {
      return jsonResponse(appOk, { id: "app-1" });
    }
    return jsonResponse(emojiOk, items);
  });
}

describe("fetchAppEmojiMap", () => {
  it("resolves the app id then builds a name->id map from the emoji list", async () => {
    const fetchImpl = emojiFetch({
      items: [
        { id: "111", name: "greencheckfilled" },
        { id: "222", name: "redxfilled" },
        { id: "333" }, // missing name — skipped
      ],
    });
    const map = await fetchAppEmojiMap("tok", fetchImpl as unknown as typeof fetch);
    expect(map).toEqual({ greencheckfilled: "111", redxfilled: "222" });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/v10/oauth2/applications/@me",
      expect.objectContaining({ headers: { Authorization: "Bot tok" } }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://discord.com/api/v10/applications/app-1/emojis",
      expect.objectContaining({ headers: { Authorization: "Bot tok" } }),
    );
  });

  it("also accepts a bare array emoji payload", async () => {
    const fetchImpl = emojiFetch([{ id: "111", name: "greencheckfilled" }]);
    expect(await fetchAppEmojiMap("tok", fetchImpl as unknown as typeof fetch)).toEqual({
      greencheckfilled: "111",
    });
  });

  it("returns an empty map when the app lookup fails", async () => {
    const fetchImpl = emojiFetch({ items: [] }, false);
    expect(await fetchAppEmojiMap("tok", fetchImpl as unknown as typeof fetch)).toEqual({});
  });

  it("returns an empty map on a non-ok emoji response", async () => {
    const fetchImpl = emojiFetch({ items: [] }, true, false);
    expect(await fetchAppEmojiMap("tok", fetchImpl as unknown as typeof fetch)).toEqual({});
  });

  it("returns an empty map when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await fetchAppEmojiMap("tok", fetchImpl as unknown as typeof fetch)).toEqual({});
  });
});

describe("emojiRef", () => {
  it("renders a custom reference when present and falls back otherwise", () => {
    const map = { greencheckfilled: "111" };
    expect(emojiRef(map, "greencheckfilled", "✅")).toBe("<:greencheckfilled:111>");
    expect(emojiRef(map, "redxfilled", "❌")).toBe("❌");
  });
});

describe("connectionEmojiFromMap", () => {
  it("uses the custom connected/not-connected/needs-auth glyphs when present", () => {
    expect(
      connectionEmojiFromMap({ greencheckfilled: "1", redxfilled: "2", warningsquare: "3" }),
    ).toEqual({
      connected: "<:greencheckfilled:1>",
      notConnected: "<:redxfilled:2>",
      needsAuth: "<:warningsquare:3>",
    });
  });

  it("falls back to unicode when the custom emoji are absent", () => {
    expect(connectionEmojiFromMap({})).toEqual({
      connected: "✅",
      notConnected: "❌",
      needsAuth: "⚠️",
    });
  });
});
