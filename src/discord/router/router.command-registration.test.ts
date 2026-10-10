import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterRuntime } from "./types.js";
import {
  clearGuildScopedCommands,
  registerGlobalCommands,
  ROUTER_COMMAND_SPECS,
} from "./router.js";

function makeRuntime(): RouterRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RouterRuntime;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerGlobalCommands", () => {
  it("sends exactly one global PUT carrying the complete command set", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true } as unknown as Response);
    const runtime = makeRuntime();

    const ok = await registerGlobalCommands("app-1", "tok", runtime);

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://discord.com/api/v10/applications/app-1/commands");
    expect(init).toMatchObject({
      method: "PUT",
      headers: { Authorization: "Bot tok", "Content-Type": "application/json" },
    });
    const sent: string[] = JSON.parse((init as { body: string }).body).map(
      (c: { name: string }) => c.name,
    );
    // The picker must contain exactly these and nothing else; a dropped spec or
    // a regression to additive registration would fail here.
    expect(sent.toSorted((a, b) => a.localeCompare(b))).toEqual([
      "channel",
      "conn",
      "connections",
      "debug",
      "lifecycle",
      "secret",
    ]);
    expect(sent).toHaveLength(ROUTER_COMMAND_SPECS.length);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("returns false and logs on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "forbidden",
    } as unknown as Response);
    const runtime = makeRuntime();

    expect(await registerGlobalCommands("app-1", "tok", runtime)).toBe(false);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("HTTP 403"));
  });
});

describe("clearGuildScopedCommands", () => {
  it("PUTs an empty command list to the guild command endpoint and returns true", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true } as unknown as Response);
    const runtime = makeRuntime();

    const ok = await clearGuildScopedCommands("app-1", "tok", "guild-9", runtime);

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://discord.com/api/v10/applications/app-1/guilds/guild-9/commands",
      expect.objectContaining({
        method: "PUT",
        headers: { Authorization: "Bot tok", "Content-Type": "application/json" },
        body: "[]",
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("returns false and logs (does not throw) on a transport failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const runtime = makeRuntime();

    expect(await clearGuildScopedCommands("app-1", "tok", "guild-9", runtime)).toBe(false);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("guild guild-9"));
  });

  it("returns false on a non-OK Discord response (fetch does not reject on 4xx/5xx)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"message":"rate limited"}',
    } as unknown as Response);
    const runtime = makeRuntime();

    expect(await clearGuildScopedCommands("app-1", "tok", "guild-9", runtime)).toBe(false);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("HTTP 429"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
  });
});
