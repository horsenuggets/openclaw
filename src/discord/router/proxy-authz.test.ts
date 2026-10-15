import { describe, expect, it } from "vitest";
import { authorizeProxySend } from "./proxy-authz.js";

const tokensByChannel = new Map<string, string | undefined>([
  ["chanA", "token-a"],
  ["chanB", "token-b"],
  ["chanC", undefined],
]);
const owners: Record<string, string> = { chanA: "ownerA", chanB: "ownerB" };
const resolveOwner = (channelId: string) => owners[channelId];

function authz(input: { callerToken?: string; channelId?: string; userId?: string }) {
  return authorizeProxySend({ tokensByChannel, resolveOwner, ...input });
}

describe("authorizeProxySend", () => {
  it("allows a channel send to the caller's own channel", () => {
    expect(authz({ callerToken: "token-a", channelId: "chanA" })).toEqual({
      ok: true,
      callerChannel: "chanA",
    });
  });

  it("rejects a cross-instance channel send", () => {
    // Box A presents its own token but targets box B's channel.
    const res = authz({ callerToken: "token-a", channelId: "chanB" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/own channel/);
    }
  });

  it("allows a DM to the caller's registered owner", () => {
    expect(authz({ callerToken: "token-b", userId: "ownerB" })).toEqual({
      ok: true,
      callerChannel: "chanB",
    });
  });

  it("rejects a DM to a user who is not the caller's owner", () => {
    const res = authz({ callerToken: "token-a", userId: "ownerB" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/owner/);
    }
  });

  it("rejects a missing token", () => {
    expect(authz({ channelId: "chanA" })).toEqual({
      ok: false,
      reason: "missing proxy auth token",
    });
  });

  it("rejects an unrecognized token", () => {
    expect(authz({ callerToken: "nope", channelId: "chanA" })).toEqual({
      ok: false,
      reason: "unrecognized proxy auth token",
    });
  });

  it("rejects when no destination is provided", () => {
    const res = authz({ callerToken: "token-a" });
    expect(res.ok).toBe(false);
  });
});
