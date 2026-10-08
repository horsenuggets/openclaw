import { describe, expect, it, vi } from "vitest";
import type { ChannelTurn } from "./channel-queue.js";
import { ChannelQueue, coalesceTurns, takeNextBatch } from "./channel-queue.js";

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

function secretTurn(name: string): ChannelTurn {
  return {
    authorId: "u1",
    messageContent: `reminder:${name}`,
    systemTurn: true,
    secret: { name, value: `val-${name}` },
  };
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

describe("takeNextBatch", () => {
  it("returns an empty batch for an empty queue", () => {
    expect(takeNextBatch([])).toEqual([]);
  });

  it("takes a lone secret at the head by itself, leaving the rest", () => {
    const pending = [secretTurn("a"), textTurn("u1", "hi")];
    expect(takeNextBatch(pending)).toEqual([secretTurn("a")]);
    expect(pending).toEqual([textTurn("u1", "hi")]);
  });

  it("takes leading non-secret turns, stopping before the first secret", () => {
    const pending = [textTurn("u1", "one"), textTurn("u1", "two"), secretTurn("a")];
    expect(takeNextBatch(pending)).toEqual([textTurn("u1", "one"), textTurn("u1", "two")]);
    expect(pending).toEqual([secretTurn("a")]);
  });

  it("never coalesces two secrets together", () => {
    const pending = [secretTurn("a"), secretTurn("b")];
    expect(takeNextBatch(pending)).toEqual([secretTurn("a")]);
    expect(pending).toEqual([secretTurn("b")]);
  });
});

describe("ChannelQueue secret isolation", () => {
  it("runs each secret as its own turn (never coalesced) and keeps a trailing user turn separate", async () => {
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

    // First secret starts running and holds the channel open.
    queue.enqueue("c1", secretTurn("a"));
    timers.flush();
    await Promise.resolve();
    expect(runTurn).toHaveBeenCalledTimes(1);

    // A second secret and a plain user message buffer behind it.
    queue.enqueue("c1", secretTurn("b"));
    queue.enqueue("c1", textTurn("u1", "hello"));
    expect(runTurn).toHaveBeenCalledTimes(1);

    release();
    await firstTurn;
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      timers.flush();
    }
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }

    // Three separate turns: secret a, secret b, then the user text — the two
    // secrets are never merged with each other or with the user message, and
    // each secret turn keeps its value and systemTurn flag.
    expect(runTurn).toHaveBeenCalledTimes(3);
    expect(runTurn.mock.calls[0][1].secret).toEqual({ name: "a", value: "val-a" });
    expect(runTurn.mock.calls[0][1].systemTurn).toBe(true);
    expect(runTurn.mock.calls[1][1].secret).toEqual({ name: "b", value: "val-b" });
    expect(runTurn.mock.calls[1][1].messageContent).toBe("reminder:b");
    expect(runTurn.mock.calls[2][1].secret).toBeUndefined();
    expect(runTurn.mock.calls[2][1].messageContent).toBe("hello");
  });

  it("never steers a secret turn into a live run, even when a steer hook is set", async () => {
    const timers = fakeTimers();
    let release!: () => void;
    const firstTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runTurn = vi
      .fn<(channelId: string, turn: ChannelTurn) => Promise<void>>()
      .mockImplementationOnce(async () => firstTurn)
      .mockImplementation(async () => {});
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

    // Secret arrives mid-run: must buffer (not steer) so the value survives.
    queue.enqueue("c1", secretTurn("a"));
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }
    expect(steer.mock.calls.some((c) => c[1].secret)).toBe(false);

    release();
    await firstTurn;
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      timers.flush();
    }
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
    }
    const secretRun = runTurn.mock.calls.find((c) => c[1].secret);
    expect(secretRun?.[1].secret).toEqual({ name: "a", value: "val-a" });
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

    it("orders a later arrival behind an in-flight steer that outlived its run", async () => {
      // Regression: arrivals first, A, B must stay first, A, B even when A's steer
      // call is still pending after the run ends (previously cleanup could drop the
      // state and let B run ahead, producing first, B, A).
      const { timers, runTurn, release, held } = startHeldTurn();
      let settleSteer!: (accepted: boolean) => void;
      const steer = vi.fn(
        () =>
          new Promise<boolean>((r) => {
            settleSteer = r;
          }),
      );
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

      // A arrives mid-turn; its steer call starts but does not resolve yet.
      queue.enqueue("c1", textTurn("u1", "A"));
      await Promise.resolve();
      await Promise.resolve();
      expect(steer).toHaveBeenCalledTimes(1);

      // The first turn finishes while A's steer is still in flight.
      release();
      await held;
      await Promise.resolve();
      // The channel stays busy because a steer is outstanding.
      expect(queue.isBusy("c1")).toBe(true);

      // B arrives now — it must queue behind A, not run as an idle channel.
      queue.enqueue("c1", textTurn("u1", "B"));
      await Promise.resolve();

      // A's steer finally resolves false (run had ended) -> A buffers, then B.
      settleSteer(false);
      for (let i = 0; i < 6; i++) {
        await Promise.resolve();
      }
      timers.flush();
      await Promise.resolve();
      await Promise.resolve();

      expect(runTurn).toHaveBeenCalledTimes(2);
      expect(runTurn.mock.calls[1][1].messageContent).toBe("A\n\nB");
    });

    it("drops an in-flight steer's fallback when clear() changes the instance", async () => {
      const { timers, runTurn, release, held } = startHeldTurn();
      let settleSteer!: (accepted: boolean) => void;
      const steer = vi.fn(
        () =>
          new Promise<boolean>((r) => {
            settleSteer = r;
          }),
      );
      const queue = new ChannelQueue({
        runTurn,
        steer,
        debounceMs: 0,
        setTimer: timers.set,
        clearTimer: timers.clear,
      });

      queue.enqueue("c1", textTurn("owner-a", "first"));
      timers.flush();
      await Promise.resolve();

      queue.enqueue("c1", textTurn("owner-a", "secret"));
      await Promise.resolve();
      await Promise.resolve();
      release();
      await held;
      await Promise.resolve();

      // Instance removed/replaced while the steer is in flight.
      queue.clear("c1");

      // The steer resolves false afterward -> must be dropped, not buffered.
      settleSteer(false);
      for (let i = 0; i < 6; i++) {
        await Promise.resolve();
      }
      timers.flush();
      await Promise.resolve();

      // Only the first turn ever ran; the cleared message never became a turn.
      expect(runTurn).toHaveBeenCalledTimes(1);
      expect(queue.isBusy("c1")).toBe(false);
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
