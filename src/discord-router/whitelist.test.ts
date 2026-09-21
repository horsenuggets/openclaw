import { describe, expect, it, vi } from "vitest";
import { createWhitelistChecker, memberHasRole } from "./whitelist.js";

describe("memberHasRole", () => {
  it("detects the role in the member's role list", () => {
    expect(memberHasRole(["a", "role1", "b"], "role1")).toBe(true);
    expect(memberHasRole(["a", "b"], "role1")).toBe(false);
    expect(memberHasRole(undefined, "role1")).toBe(false);
  });
});

describe("createWhitelistChecker", () => {
  it("fails closed and does not call Discord when unconfigured", async () => {
    const fetchImpl = vi.fn();
    const checker = createWhitelistChecker({
      discordToken: "t",
      guildId: undefined,
      roleId: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(checker.isConfigured()).toBe(false);
    expect(await checker.isWhitelisted("u1")).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns true when the member holds the role", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ roles: ["other", "ROLE"] }),
    }));
    const checker = createWhitelistChecker({
      discordToken: "t",
      guildId: "G",
      roleId: "ROLE",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await checker.isWhitelisted("u1")).toBe(true);
  });

  it("returns false for a non-member (404) without throwing", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const checker = createWhitelistChecker({
      discordToken: "t",
      guildId: "G",
      roleId: "ROLE",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await checker.isWhitelisted("u1")).toBe(false);
  });

  it("caches results within the TTL", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ roles: ["ROLE"] }),
    }));
    let t = 1000;
    const checker = createWhitelistChecker({
      discordToken: "t",
      guildId: "G",
      roleId: "ROLE",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => t,
    });
    expect(await checker.isWhitelisted("u1")).toBe(true);
    t += 5_000;
    expect(await checker.isWhitelisted("u1")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    t += 120_000; // past TTL
    expect(await checker.isWhitelisted("u1")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
