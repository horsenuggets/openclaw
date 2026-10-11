import { describe, expect, it, vi } from "vitest";
import { createNoticeDebouncer } from "./notice-debounce.js";

/**
 * Controllable timer harness: setTimer records the callback and returns a handle;
 * `fire()` runs every currently-scheduled callback once (callbacks that reschedule
 * are picked up by the next `fire()`), matching real setTimeout semantics closely
 * enough to exercise the leading/trailing logic deterministically.
 */
function harness() {
  let nextId = 1;
  let scheduled = new Map<number, () => void>();
  const setTimer = (fn: () => void): number => {
    const id = nextId++;
    scheduled.set(id, fn);
    return id;
  };
  const clearTimer = (handle: number): void => {
    scheduled.delete(handle);
  };
  const fire = (): void => {
    const callbacks = [...scheduled.values()];
    scheduled = new Map();
    for (const cb of callbacks) {
      cb();
    }
  };
  return { setTimer, clearTimer, fire };
}

describe("createNoticeDebouncer", () => {
  it("sends immediately on the first trigger (leading edge)", () => {
    const h = harness();
    const d = createNoticeDebouncer({
      windowMs: 5000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const send = vi.fn();
    d.trigger("k", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(d.activeCount()).toBe(1);
  });

  it("coalesces a burst within the window into a single trailing reply", () => {
    const h = harness();
    const d = createNoticeDebouncer({
      windowMs: 5000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const send = vi.fn();
    d.trigger("k", send); // leading
    d.trigger("k", send); // coalesced
    d.trigger("k", send); // coalesced
    expect(send).toHaveBeenCalledTimes(1);
    h.fire(); // window elapses: one trailing reply for the whole burst
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("goes idle after a quiet window so the next message leads again", () => {
    const h = harness();
    const d = createNoticeDebouncer({
      windowMs: 5000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const send = vi.fn();
    d.trigger("k", send); // leading (1)
    h.fire(); // nothing pending -> idle, no extra send
    expect(send).toHaveBeenCalledTimes(1);
    expect(d.activeCount()).toBe(0);
    d.trigger("k", send); // leads again (2)
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps pacing at one reply per window while the spam continues", () => {
    const h = harness();
    const d = createNoticeDebouncer({
      windowMs: 5000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const send = vi.fn();
    d.trigger("k", send); // leading (1)
    d.trigger("k", send); // coalesced
    h.fire(); // trailing (2), window stays open
    d.trigger("k", send); // coalesced again
    h.fire(); // trailing (3)
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("uses the most recent send for the trailing reply", () => {
    const h = harness();
    const d = createNoticeDebouncer({
      windowMs: 5000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const first = vi.fn();
    const second = vi.fn();
    d.trigger("k", first); // leading uses first
    d.trigger("k", second); // coalesced; latest send is second
    h.fire();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keys independently so two users do not share a window", () => {
    const h = harness();
    const d = createNoticeDebouncer({
      windowMs: 5000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const a = vi.fn();
    const b = vi.fn();
    d.trigger("chan:A", a);
    d.trigger("chan:B", b);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(d.activeCount()).toBe(2);
  });

  it("cancel drops a pending window", () => {
    const h = harness();
    const d = createNoticeDebouncer({
      windowMs: 5000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const send = vi.fn();
    d.trigger("k", send);
    d.cancel("k");
    expect(d.activeCount()).toBe(0);
    h.fire();
    expect(send).toHaveBeenCalledTimes(1); // only the leading send, no trailing
  });

  it("cancelChannel drops every per-user window for a channel without touching others", () => {
    const h = harness();
    const d = createNoticeDebouncer({
      windowMs: 5000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const u1 = vi.fn();
    const u2 = vi.fn();
    const other = vi.fn();
    // Two users offending in channel A, plus one in channel B. Keys are
    // `channelId:userId`, and each key owes a trailing reply after its leading one.
    d.trigger("A:u1", u1);
    d.trigger("A:u1", u1);
    d.trigger("A:u2", u2);
    d.trigger("A:u2", u2);
    d.trigger("B:u1", other);
    d.trigger("B:u1", other);
    expect(d.activeCount()).toBe(3);
    // Tearing down channel A drops both of A's windows; B is untouched.
    d.cancelChannel("A");
    expect(d.activeCount()).toBe(1);
    h.fire();
    // A's trailing replies never fire (still just their leading send); B's does.
    expect(u1).toHaveBeenCalledTimes(1);
    expect(u2).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it("suppressChannel no-ops triggers for the channel until unsuppressed", () => {
    const h = harness();
    const d = createNoticeDebouncer({
      windowMs: 5000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const a = vi.fn();
    const other = vi.fn();
    // Open a window, then suppress the channel (teardown begins): the existing
    // window is cancelled and further triggers for the channel do nothing.
    d.trigger("A:u1", a);
    expect(a).toHaveBeenCalledTimes(1);
    d.suppressChannel("A");
    expect(d.activeCount()).toBe(0);
    d.trigger("A:u1", a); // suppressed: no send, no window
    d.trigger("A:u2", a); // suppressed too
    expect(a).toHaveBeenCalledTimes(1);
    expect(d.activeCount()).toBe(0);
    // A different channel is unaffected.
    d.trigger("B:u1", other);
    expect(other).toHaveBeenCalledTimes(1);
    // Lifting suppression lets the channel trigger again.
    d.unsuppressChannel("A");
    d.trigger("A:u1", a);
    expect(a).toHaveBeenCalledTimes(2);
  });

  it("reference-counts suppression so overlapping teardowns only lift it on the last", () => {
    const h = harness();
    const d = createNoticeDebouncer({
      windowMs: 5000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const a = vi.fn();
    // Two overlapping unregisters both suppress the same channel.
    d.suppressChannel("A");
    d.suppressChannel("A");
    // The first teardown finishes and lifts its suppression, but the second is
    // still running, so the channel must STAY suppressed.
    d.unsuppressChannel("A");
    d.trigger("A:u1", a);
    expect(a).not.toHaveBeenCalled();
    // The second teardown finishes: now suppression is fully lifted.
    d.unsuppressChannel("A");
    d.trigger("A:u1", a);
    expect(a).toHaveBeenCalledTimes(1);
    // An unbalanced extra unsuppress is a harmless no-op.
    expect(() => d.unsuppressChannel("A")).not.toThrow();
  });

  it("cancelAll drops every pending window (shutdown)", () => {
    const h = harness();
    const d = createNoticeDebouncer({
      windowMs: 5000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    const a = vi.fn();
    const b = vi.fn();
    d.trigger("A:u1", a);
    d.trigger("A:u1", a);
    d.trigger("B:u2", b);
    d.trigger("B:u2", b);
    expect(d.activeCount()).toBe(2);
    d.cancelAll();
    expect(d.activeCount()).toBe(0);
    h.fire();
    // No trailing replies fire after cancelAll; only the earlier leading sends.
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
