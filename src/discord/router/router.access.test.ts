import { describe, expect, it, vi } from "vitest";
import type { InstanceStatus } from "./channel-commands.js";
import {
  type ChannelAuthDeps,
  type ChannelDeletedDeps,
  handleChannelDeleted,
  isAuthorizedForChannel,
} from "./router.js";

const CHANNEL = "123456789012345678";
const OWNER = "111111111111111111";
const OTHER = "222222222222222222";

function status(over: Partial<InstanceStatus> = {}): InstanceStatus {
  return { port: 18795, ownerId: OWNER, onboarded: true, ...over };
}

describe("isAuthorizedForChannel", () => {
  it("allows the channel owner", async () => {
    const deps: ChannelAuthDeps = { describeInstance: () => status() };
    expect(await isAuthorizedForChannel(CHANNEL, OWNER, deps)).toBe(true);
  });

  it("denies a non-owner even if they are a whitelisted admin elsewhere", async () => {
    const deps: ChannelAuthDeps = { describeInstance: () => status() };
    expect(await isAuthorizedForChannel(CHANNEL, OTHER, deps)).toBe(false);
  });

  it("fails closed when the owner is unknown", async () => {
    const deps: ChannelAuthDeps = { describeInstance: () => status({ ownerId: undefined }) };
    expect(await isAuthorizedForChannel(CHANNEL, OWNER, deps)).toBe(false);
  });
});

describe("handleChannelDeleted", () => {
  function makeDeps(over: Partial<ChannelDeletedDeps> = {}): ChannelDeletedDeps {
    return {
      describeInstance: () => status(),
      provisioning: {
        register: vi.fn(async () => ({ ok: true, message: "registered" })),
        unregister: vi.fn(async () => ({ ok: true, message: "removed" })),
      },
      log: () => {},
      error: () => {},
      ...over,
    };
  }

  it("unregisters the instance of a deleted registered channel", async () => {
    const unregister = vi.fn(async () => ({ ok: true, message: "removed" }));
    const onCleaned = vi.fn();
    await handleChannelDeleted(
      CHANNEL,
      "channel_delete",
      makeDeps({
        provisioning: { register: vi.fn(), unregister },
        onCleaned,
      }),
    );
    expect(unregister).toHaveBeenCalledWith({ channelId: CHANNEL });
    expect(onCleaned).toHaveBeenCalledWith(CHANNEL);
  });

  it("is a no-op when the deleted channel had no registered instance", async () => {
    const unregister = vi.fn();
    await handleChannelDeleted(
      CHANNEL,
      "channel_delete",
      makeDeps({
        describeInstance: () => null,
        provisioning: { register: vi.fn(), unregister },
      }),
    );
    expect(unregister).not.toHaveBeenCalled();
  });

  it("does not run onCleaned when provisioning reports failure", async () => {
    const onCleaned = vi.fn();
    await handleChannelDeleted(
      CHANNEL,
      "channel_delete",
      makeDeps({
        provisioning: {
          register: vi.fn(),
          unregister: vi.fn(async () => ({ ok: false, message: "boom" })),
        },
        onCleaned,
      }),
    );
    expect(onCleaned).not.toHaveBeenCalled();
  });

  it("swallows provisioning errors so a delete event cannot crash the router", async () => {
    const onCleaned = vi.fn();
    await expect(
      handleChannelDeleted(
        CHANNEL,
        "channel_delete",
        makeDeps({
          provisioning: {
            register: vi.fn(),
            unregister: vi.fn(async () => {
              throw new Error("network down");
            }),
          },
          onCleaned,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(onCleaned).not.toHaveBeenCalled();
  });
});
