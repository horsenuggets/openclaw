import { describe, expect, it, vi } from "vitest";
import type { InstanceConfig } from "./config";
import { ChannelQueue } from "./channel-queue.js";
import { runOnboardingKick } from "./onboarding.js";

function makeInstance(port = 18790): InstanceConfig {
  return { channelId: "C1", port, instanceDir: "/tmp/does-not-matter" } as InstanceConfig;
}

const quietRuntime = { log: () => {}, error: () => {} };

/** A queue whose turns never auto-run, so reserve/release state is observable. */
function makeSlot() {
  return new ChannelQueue({ runTurn: async () => {}, debounceMs: 1000 });
}

describe("runOnboardingKick", () => {
  it("skips when a turn is already in flight (that turn drives onboarding)", async () => {
    const slot = makeSlot();
    // Simulate an in-flight turn by reserving the channel up front.
    slot.reserve("C1");
    const route = vi.fn();
    const probe = vi.fn(async () => true);

    const result = await runOnboardingKick({
      channelId: "C1",
      ownerId: "U1",
      instance: makeInstance(),
      slot,
      probe,
      route,
      runtime: quietRuntime,
    });

    expect(result).toBe("busy");
    expect(probe).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    // The pre-existing reservation is left untouched.
    expect(slot.isBusy("C1")).toBe(true);
  });

  it("reserves the slot for the whole wait so a concurrent message queues behind it", async () => {
    const slot = makeSlot();
    let heldDuringProbe = false;
    const probe = vi.fn(async () => {
      // While we are waiting on readiness, the channel must already be reserved.
      heldDuringProbe = slot.isBusy("C1");
      return true;
    });
    const route = vi.fn(async () => true);

    const result = await runOnboardingKick({
      channelId: "C1",
      ownerId: "U1",
      instance: makeInstance(),
      slot,
      probe,
      route,
      runtime: quietRuntime,
    });

    expect(result).toBe("kicked");
    expect(heldDuringProbe).toBe(true);
    // Released once done so normal routing can proceed.
    expect(slot.isBusy("C1")).toBe(false);
  });

  it("routes the onboarding turn as a system turn once the agent is ready", async () => {
    const slot = makeSlot();
    // Not ready for the first two probes, then ready.
    const probe = vi
      .fn<(port: number) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const route = vi.fn(async () => true);

    const result = await runOnboardingKick({
      channelId: "C1",
      ownerId: "U1",
      instance: makeInstance(18791),
      slot,
      probe,
      route,
      runtime: quietRuntime,
      intervalMs: 0,
    });

    expect(result).toBe("kicked");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe).toHaveBeenCalledWith(18791);
    expect(route).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C1",
        ownerId: "U1",
        systemTurn: true,
      }),
    );
    expect(slot.isBusy("C1")).toBe(false);
  });

  it("gives up (and never routes) when the agent never becomes ready, releasing the slot", async () => {
    const slot = makeSlot();
    const probe = vi.fn(async () => false);
    const route = vi.fn(async () => true);

    const result = await runOnboardingKick({
      channelId: "C1",
      ownerId: "U1",
      instance: makeInstance(),
      slot,
      probe,
      route,
      runtime: quietRuntime,
      attempts: 3,
      intervalMs: 0,
    });

    expect(result).toBe("not-ready");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(route).not.toHaveBeenCalled();
    expect(slot.isBusy("C1")).toBe(false);
  });

  it("releases the slot even when routing throws", async () => {
    const slot = makeSlot();
    const probe = vi.fn(async () => true);
    const route = vi.fn(async () => {
      throw new Error("gateway blew up");
    });

    await expect(
      runOnboardingKick({
        channelId: "C1",
        ownerId: "U1",
        instance: makeInstance(),
        slot,
        probe,
        route,
        runtime: quietRuntime,
      }),
    ).rejects.toThrow("gateway blew up");

    expect(slot.isBusy("C1")).toBe(false);
  });
});
