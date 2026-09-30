import { describe, expect, it, vi } from "vitest";
import type { InstanceConfig } from "./config";
import { runOnboardingKick } from "./onboarding.js";

function makeInstance(port = 18790): InstanceConfig {
  return { channelId: "C1", port, instanceDir: "/tmp/does-not-matter" } as InstanceConfig;
}

const quietRuntime = { log: () => {}, error: () => {} };

describe("runOnboardingKick", () => {
  it("skips when a turn is already in flight (that turn drives onboarding)", async () => {
    const inflight = new Set<string>(["C1"]);
    const route = vi.fn();
    const probe = vi.fn(async () => true);

    const result = await runOnboardingKick({
      channelId: "C1",
      ownerId: "U1",
      instance: makeInstance(),
      inflight,
      probe,
      route,
      runtime: quietRuntime,
    });

    expect(result).toBe("busy");
    expect(probe).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    // The pre-existing slot is left untouched.
    expect(inflight.has("C1")).toBe(true);
  });

  it("reserves inflight for the whole wait so a concurrent message queues behind it", async () => {
    const inflight = new Set<string>();
    let heldDuringProbe = false;
    const probe = vi.fn(async () => {
      // While we are waiting on readiness, the channel must already be reserved.
      heldDuringProbe = inflight.has("C1");
      return true;
    });
    const route = vi.fn(async () => true);

    const result = await runOnboardingKick({
      channelId: "C1",
      ownerId: "U1",
      instance: makeInstance(),
      inflight,
      probe,
      route,
      runtime: quietRuntime,
    });

    expect(result).toBe("kicked");
    expect(heldDuringProbe).toBe(true);
    // Released once done so normal routing can proceed.
    expect(inflight.has("C1")).toBe(false);
  });

  it("routes the onboarding turn as a pre-acquired system turn once the agent is ready", async () => {
    const inflight = new Set<string>();
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
      inflight,
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
        preacquiredInflight: true,
      }),
    );
    expect(inflight.has("C1")).toBe(false);
  });

  it("gives up (and never routes) when the agent never becomes ready, releasing the slot", async () => {
    const inflight = new Set<string>();
    const probe = vi.fn(async () => false);
    const route = vi.fn(async () => true);

    const result = await runOnboardingKick({
      channelId: "C1",
      ownerId: "U1",
      instance: makeInstance(),
      inflight,
      probe,
      route,
      runtime: quietRuntime,
      attempts: 3,
      intervalMs: 0,
    });

    expect(result).toBe("not-ready");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(route).not.toHaveBeenCalled();
    expect(inflight.has("C1")).toBe(false);
  });

  it("releases the inflight slot even when routing throws", async () => {
    const inflight = new Set<string>();
    const probe = vi.fn(async () => true);
    const route = vi.fn(async () => {
      throw new Error("gateway blew up");
    });

    await expect(
      runOnboardingKick({
        channelId: "C1",
        ownerId: "U1",
        instance: makeInstance(),
        inflight,
        probe,
        route,
        runtime: quietRuntime,
      }),
    ).rejects.toThrow("gateway blew up");

    expect(inflight.has("C1")).toBe(false);
  });
});
