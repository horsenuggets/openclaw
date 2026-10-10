import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterRuntime } from "./types.js";
import { clearGuildScopedCommands } from "./router.js";

function makeRuntime(): RouterRuntime {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RouterRuntime;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clearGuildScopedCommands", () => {
  it("PUTs an empty command list to the guild command endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true } as unknown as Response);
    const runtime = makeRuntime();

    await clearGuildScopedCommands("app-1", "tok", "guild-9", runtime);

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

  it("logs and swallows a fetch failure instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const runtime = makeRuntime();

    await expect(
      clearGuildScopedCommands("app-1", "tok", "guild-9", runtime),
    ).resolves.toBeUndefined();

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("guild guild-9"));
  });

  it("logs a non-OK Discord response (fetch does not reject on 4xx/5xx)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"message":"rate limited"}',
    } as unknown as Response);
    const runtime = makeRuntime();

    await clearGuildScopedCommands("app-1", "tok", "guild-9", runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("HTTP 429"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("rate limited"));
  });
});
