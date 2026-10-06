import { afterEach, describe, expect, it, vi } from "vitest";
import { discordSend } from "./discord-api.js";

function response(status: number, opts?: { retryAfterHeader?: string; retryAfterBody?: number }) {
  return {
    status,
    headers: {
      get: (name: string) => (name === "retry-after" ? (opts?.retryAfterHeader ?? null) : null),
    },
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

  it("gives up after the maximum number of attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(429, { retryAfterHeader: "0" }));
    vi.stubGlobal("fetch", fetchMock);

    await discordSend("tok", "c1", "hello");

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
