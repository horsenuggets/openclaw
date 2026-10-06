import { describe, expect, it, vi } from "vitest";
import type { ChannelTurn } from "./channel-queue.js";
import { ChannelQueue, coalesceTurns } from "./channel-queue.js";

/**
 * A controllable timer so debounce behaviour is deterministic: calling flush()
 * fires every pending timer. Mirrors the setTimeout/clearTimeout contract the
 * queue needs.
 */
function fakeTimers() {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    set: (fn: () => void, _ms: number) => {
      const id = ++seq;
      timers.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number);
    },
    /** Fire all currently-scheduled timers (FIFO). */
    flush: () => {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, fn] of pending) {
        fn();
      }
    },
    size: () => timers.size,
  };
}

function textTurn(authorId: string, messageContent: string): ChannelTurn {
  return { authorId, messageContent };
}

describe("coalesceTurns", () => {
  it("returns the single turn unchanged", () => {
    const turn = textTurn("u1", "hi");
    expect(coalesceTurns([turn])).toBe(turn);
  });

  it("joins contents in FIFO order and keeps the most recent author", () => {
    const combined = coalesceTurns([textTurn("u1", "hey there"), textTurn("u1", "call me Sam")]);
    expect(combined.messageContent).toBe("hey there\n\ncall me Sam");
    expect(combined.authorId).toBe("u1");
  });

  it("drops empty contents but still concatenates attachments", () => {
    const att = { id: "a1", filename: "x.png", url: "http://x", size: 1 };
    const combined = coalesceTurns([
      { authorId: "u1", messageContent: "", attachments: [att] },
      textTurn("u1", "look"),
    ]);
    expect(combined.messageContent).toBe("look");
    expect(combined.attachments).toEqual([att]);
  });

  it("is a system turn only when every buffered turn is", () => {
    expect(
      coalesceTurns([
        { authorId: "u1", messageContent: "a", systemTurn: true },
        { authorId: "u1", messageContent: "b", systemTurn: true },
      ]).systemTurn,
    ).toBe(true);
    // A real user message in the batch wins — never attributed as system.
    expect(
      coalesceTurns([
        { authorId: "u1", messageContent: "a", systemTurn: true },
        { authorId: "u1", messageContent: "b" },
      ]).systemTurn,
    ).toBe(false);
  });
});

describe("ChannelQueue", () => {
  it("coalesces a debounced burst into one turn", async () => {
    const timers = fakeTimers();
    const runTurn = vi.fn(async () => {});
    const queue = new ChannelQueue({
      runTurn,
      debounceMs: 500,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });

    queue.enqueue("c1", textTurn("u1", "hey"));
    queue.enqueue("c1", textTurn("u1", "call me Sam"));
    queue.enqueue("c1", textTurn("u1", "please"));
    // Nothing runs until the debounce window elapses.
    expect(runTurn).not.toHaveBeenCalled();

    timers.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[0][1].messageContent).toBe("hey\n\ncall me Sam\n\nplease");
  });

  it("coalesces messages that arrive while a turn is running into the next turn", async () => {
    const timers = fakeTimers();
    let release!: () => void;
    const firstTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runTurn = vi
      .fn<(channelId: string, turn: ChannelTurn) => Promise<void>>()
      .mockImplementationOnce(async () => firstTurn)
      .mockImplementation(async () => {});
    const queue = new ChannelQueue({
      runTurn,
      debounceMs: 0,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });

    queue.enqueue("c1", textTurn("u1", "first"));
    timers.flush();
    await Promise.resolve();
    expect(runTurn).toHaveBeenCalledTimes(1);

    // These land while the first turn is still awaiting — they must buffer.
    queue.enqueue("c1", textTurn("u1", "second"));
    queue.enqueue("c1", textTurn("u1", "third"));
    expect(runTurn).toHaveBeenCalledTimes(1);

    // Finish the first turn; the drain loop should pick up the buffered two.
    release();
    await firstTurn;
    await Promise.resolve();
    await Promise.resolve();

    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[1][1].messageContent).toBe("second\n\nthird");
  });

  it("processes channels independently", async () => {
    const timers = fakeTimers();
    const runTurn = vi.fn(async () => {});
    const queue = new ChannelQueue({
      runTurn,
      debounceMs: 10,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });

    queue.enqueue("c1", textTurn("u1", "a"));
    queue.enqueue("c2", textTurn("u2", "b"));
    timers.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(runTurn).toHaveBeenCalledTimes(2);
    const channels = runTurn.mock.calls.map((c) => c[0]).toSorted((a, b) => a.localeCompare(b));
    expect(channels).toEqual(["c1", "c2"]);
  });

  describe("reserve/release (onboarding kick)", () => {
    it("reserve succeeds on an idle channel and blocks the enqueued drain until release", async () => {
      const timers = fakeTimers();
      const runTurn = vi.fn(async () => {});
      const queue = new ChannelQueue({
        runTurn,
        debounceMs: 0,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });

      expect(queue.reserve("c1")).toBe(true);
      expect(queue.isBusy("c1")).toBe(true);

      // A user message sent during the hold must buffer, not run.
      queue.enqueue("c1", textTurn("u1", "hi during kick"));
      timers.flush();
      await Promise.resolve();
      expect(runTurn).not.toHaveBeenCalled();

      queue.release("c1");
      timers.flush();
      await Promise.resolve();
      await Promise.resolve();

      expect(runTurn).toHaveBeenCalledTimes(1);
      expect(runTurn.mock.calls[0][1].messageContent).toBe("hi during kick");
    });

    it("reserve fails when the channel is already busy", () => {
      const queue = new ChannelQueue({ runTurn: async () => {}, debounceMs: 0 });
      expect(queue.reserve("c1")).toBe(true);
      expect(queue.reserve("c1")).toBe(false);
    });

    it("reserve fails when messages are already buffered", () => {
      const timers = fakeTimers();
      const queue = new ChannelQueue({
        runTurn: async () => {},
        debounceMs: 1000,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });
      queue.enqueue("c1", textTurn("u1", "pending"));
      expect(queue.reserve("c1")).toBe(false);
    });

    it("release is a no-op on an unknown channel", () => {
      const queue = new ChannelQueue({ runTurn: async () => {}, debounceMs: 0 });
      expect(() => queue.release("never-seen")).not.toThrow();
    });
  });

  it("keeps running after a turn throws (does not wedge the channel)", async () => {
    const timers = fakeTimers();
    const runTurn = vi
      .fn<(channelId: string, turn: ChannelTurn) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const queue = new ChannelQueue({
      runTurn,
      debounceMs: 0,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });

    queue.enqueue("c1", textTurn("u1", "first"));
    timers.flush();
    await Promise.resolve();
    await Promise.resolve();
    // The channel is not stuck busy after the throw.
    expect(queue.isBusy("c1")).toBe(false);

    queue.enqueue("c1", textTurn("u1", "second"));
    timers.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(runTurn).toHaveBeenCalledTimes(2);
  });
});
