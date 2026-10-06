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

    // Finish the first turn. Mid-turn arrivals are rescheduled through the
    // debounce (not drained inline), so the next batch runs after a timer fires.
    release();
    await firstTurn;
    await Promise.resolve();
    timers.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[1][1].messageContent).toBe("second\n\nthird");
  });

  describe("mid-turn steering", () => {
    /** Start a turn and keep it running until the returned release() is called. */
    function startHeldTurn() {
      const timers = fakeTimers();
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      const runTurn = vi
        .fn<(channelId: string, turn: ChannelTurn) => Promise<void>>()
        .mockImplementationOnce(async () => held)
        .mockImplementation(async () => {});
      return { timers, runTurn, release, held };
    }

    it("injects a mid-turn message into the live run instead of buffering it", async () => {
      const { timers, runTurn, release, held } = startHeldTurn();
      const steer = vi.fn(async () => true);
      const queue = new ChannelQueue({
        runTurn,
        steer,
        debounceMs: 0,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });

      queue.enqueue("c1", textTurn("u1", "first"));
      timers.flush();
      await Promise.resolve();
      expect(runTurn).toHaveBeenCalledTimes(1);

      // Arrives while the first turn is still running -> steered, not buffered.
      queue.enqueue("c1", textTurn("u1", "also do X"));
      await Promise.resolve();
      expect(steer).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ messageContent: "also do X" }),
      );

      release();
      await held;
      await Promise.resolve();
      timers.flush();
      await Promise.resolve();
      // No second turn: the steered message rode the active run.
      expect(runTurn).toHaveBeenCalledTimes(1);
    });

    it("keeps FIFO: once a mid-turn message buffers, later ones buffer too (no overtaking)", async () => {
      const { timers, runTurn, release, held } = startHeldTurn();
      // Simulate the router's steer closure declining a message (e.g. it carries
      // an attachment) by returning false for "att" and true otherwise.
      const steer = vi.fn(async (_c: string, turn: ChannelTurn) => turn.messageContent !== "att");
      const queue = new ChannelQueue({
        runTurn,
        steer,
        debounceMs: 0,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });

      queue.enqueue("c1", textTurn("u1", "first"));
      timers.flush();
      await Promise.resolve();
      expect(runTurn).toHaveBeenCalledTimes(1);

      // "att" can't steer -> buffers; "text" arrives after and must NOT overtake it.
      queue.enqueue("c1", textTurn("u1", "att"));
      queue.enqueue("c1", textTurn("u1", "text"));
      for (let i = 0; i < 6; i++) {
        await Promise.resolve();
      }
      // Only "att" was offered to steer; "text" was forced to buffer behind it.
      expect(steer).toHaveBeenCalledTimes(1);
      expect(steer).toHaveBeenCalledWith("c1", expect.objectContaining({ messageContent: "att" }));

      release();
      await held;
      await Promise.resolve();
      timers.flush();
      await Promise.resolve();
      await Promise.resolve();
      // The two buffered messages run together, in arrival order.
      expect(runTurn).toHaveBeenCalledTimes(2);
      expect(runTurn.mock.calls[1][1].messageContent).toBe("att\n\ntext");
    });

    it("falls back to a buffered next turn when the run does not accept the steer", async () => {
      const { timers, runTurn, release, held } = startHeldTurn();
      const steer = vi.fn(async () => false);
      const queue = new ChannelQueue({
        runTurn,
        steer,
        debounceMs: 0,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });

      queue.enqueue("c1", textTurn("u1", "first"));
      timers.flush();
      await Promise.resolve();

      queue.enqueue("c1", textTurn("u1", "late"));
      await Promise.resolve();
      await Promise.resolve();
      expect(steer).toHaveBeenCalledTimes(1);

      release();
      await held;
      await Promise.resolve();
      timers.flush();
      await Promise.resolve();
      await Promise.resolve();
      // Rejected steer -> ran as the next turn.
      expect(runTurn).toHaveBeenCalledTimes(2);
      expect(runTurn.mock.calls[1][1].messageContent).toBe("late");
    });

    it("never steers while the channel is reserved for the onboarding kick", async () => {
      const timers = fakeTimers();
      const runTurn = vi.fn(async () => {});
      const steer = vi.fn(async () => true);
      const queue = new ChannelQueue({
        runTurn,
        steer,
        debounceMs: 0,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });

      expect(queue.reserve("c1")).toBe(true);
      queue.enqueue("c1", textTurn("u1", "typed during onboarding"));
      await Promise.resolve();
      // Reserved hold: the message queues behind the kick rather than injecting.
      expect(steer).not.toHaveBeenCalled();

      queue.release("c1");
      timers.flush();
      await Promise.resolve();
      await Promise.resolve();
      expect(runTurn).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ messageContent: "typed during onboarding" }),
      );
    });

    it("does not steer an idle channel (no active run)", async () => {
      const timers = fakeTimers();
      const runTurn = vi.fn(async () => {});
      const steer = vi.fn(async () => true);
      const queue = new ChannelQueue({
        runTurn,
        steer,
        debounceMs: 0,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });

      queue.enqueue("c1", textTurn("u1", "hello"));
      timers.flush();
      await Promise.resolve();
      expect(steer).not.toHaveBeenCalled();
      expect(runTurn).toHaveBeenCalledTimes(1);
    });
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

  describe("clear", () => {
    it("drops buffered messages so a replaced instance never receives them", async () => {
      const timers = fakeTimers();
      const runTurn = vi.fn(async () => {});
      const queue = new ChannelQueue({
        runTurn,
        debounceMs: 500,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });

      // Prior owner's messages are buffered (debounce not yet elapsed).
      queue.enqueue("c1", textTurn("owner-a", "secret one"));
      queue.enqueue("c1", textTurn("owner-a", "secret two"));
      expect(queue.isBusy("c1")).toBe(true);

      // Channel re-registered under a new owner -> clear.
      queue.clear("c1");
      expect(queue.isBusy("c1")).toBe(false);

      // The debounce timer must not fire a stale drain after clearing.
      timers.flush();
      await Promise.resolve();
      expect(runTurn).not.toHaveBeenCalled();
    });

    it("is a no-op on an unknown channel", () => {
      const queue = new ChannelQueue({ runTurn: async () => {}, debounceMs: 0 });
      expect(() => queue.clear("never-seen")).not.toThrow();
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
