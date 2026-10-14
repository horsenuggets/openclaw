import { afterEach, describe, expect, it, vi } from "vitest";
import type { LabDiscord } from "./discord.js";
import { addEveryoneToThread, remainingDebounceMs } from "./create_new_thread.js";

/** A minimal LabDiscord stub exposing only the two methods addEveryoneToThread uses. */
function stubClient(over: {
  listGuildMembers: () => Promise<Array<{ user?: { id: string; bot?: boolean } }>>;
  addThreadMember: (threadId: string, userId: string) => Promise<void>;
}): LabDiscord {
  return over as unknown as LabDiscord;
}

describe("remainingDebounceMs", () => {
  it("returns 0 when there is no recorded last timestamp", () => {
    expect(remainingDebounceMs(null, 10_000, 3000)).toBe(0);
  });

  it("returns the positive remainder for a recent last timestamp", () => {
    // 1 second elapsed of a 3 second interval leaves 2 seconds.
    expect(remainingDebounceMs(9000, 10_000, 3000)).toBe(2000);
  });

  it("returns 0 for an old last timestamp", () => {
    expect(remainingDebounceMs(1000, 10_000, 3000)).toBe(0);
  });

  it("returns 0 when exactly the interval has elapsed", () => {
    expect(remainingDebounceMs(7000, 10_000, 3000)).toBe(0);
  });
});

describe("addEveryoneToThread", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("still adds the whitelist ids when the member listing fails", async () => {
    vi.stubEnv("OPENCLAW_LAB_EXTRA_THREAD_MEMBER_IDS", "111, 222");
    const addThreadMember = vi.fn(async () => {});
    const client = stubClient({
      listGuildMembers: async () => {
        throw new Error("403 Forbidden");
      },
      addThreadMember,
    });
    vi.useFakeTimers();
    const done = addEveryoneToThread(client, "thread1");
    await vi.runAllTimersAsync();
    await done;
    // The human listing threw, but the whitelist ids are still added (no early return).
    expect(addThreadMember.mock.calls).toEqual([
      ["thread1", "111"],
      ["thread1", "222"],
    ]);
  });

  it("adds humans plus the whitelist, deduped and bots-from-the-scan excluded", async () => {
    vi.stubEnv("OPENCLAW_LAB_EXTRA_THREAD_MEMBER_IDS", "222, 333");
    const addThreadMember = vi.fn(async () => {});
    const client = stubClient({
      listGuildMembers: async () => [
        { user: { id: "111", bot: false } },
        { user: { id: "222", bot: false } }, // also in the whitelist -> deduped
        { user: { id: "999", bot: true } }, // a bot the human scan drops
      ],
      addThreadMember,
    });
    vi.useFakeTimers();
    const done = addEveryoneToThread(client, "thread1");
    await vi.runAllTimersAsync();
    await done;
    expect(addThreadMember.mock.calls.map((call) => call[1])).toEqual(["111", "222", "333"]);
  });
});
