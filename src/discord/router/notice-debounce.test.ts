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
});
