import { afterEach, describe, expect, it, vi } from "vitest";
import { discordDeleteMessage, discordSend } from "./discord-api.js";

function response(status: number, opts?: { retryAfterHeader?: string; retryAfterBody?: number }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => (name === "retry-after" ? (opts?.retryAfterHeader ?? null) : null),
    },
    text: async () => "",
    clone: () => ({ json: async () => ({ retry_after: opts?.retryAfterBody }) }),
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discordSend rate-limit handling", () => {
  it("retries after a 429 and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, { retryAfterHeader: "0" }))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal("fetch", fetchMock);

    await discordSend("tok", "c1", "hello");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads retry_after from the JSON body when the header is absent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, { retryAfterBody: 0 }))
      .mockResolvedValueOnce(response(200));
    vi.stubGlobal("fetch", fetchMock);

    await discordSend("tok", "c1", "hello");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends exactly once when there is no rate limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200));
    vi.stubGlobal("fetch", fetchMock);

    await discordSend("tok", "c1", "hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-429 error response instead of reporting success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discordSend("tok", "c1", "hello")).rejects.toThrow(/failed \(500\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting the maximum number of attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(429, { retryAfterHeader: "0" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(discordSend("tok", "c1", "hello")).rejects.toThrow(/rate limited/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe("discordDeleteMessage", () => {
  it("returns true when Discord confirms the delete", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(204)));
    expect(await discordDeleteMessage("tok", "c1", "m1")).toBe(true);
  });

  it("returns false on an error response so the caller can warn the user", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(403)));
    expect(await discordDeleteMessage("tok", "c1", "m1")).toBe(false);
  });

  it("returns false when the request throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await discordDeleteMessage("tok", "c1", "m1")).toBe(false);
  });

  it("bounds the request with an abort signal so a stall cannot hang the caller", async () => {
    const mock = vi.fn().mockResolvedValue(response(204));
    vi.stubGlobal("fetch", mock);
    await discordDeleteMessage("tok", "c1", "m1");
    const init = mock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
