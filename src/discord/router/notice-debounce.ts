/**
 * Coalescing debounce for the per-user "not authorized" notice. When a non-owner
 * keeps messaging a channel they do not own, replying to every message floods the
 * channel. This batches those replies per user+channel: the first message is
 * answered immediately (leading edge), and any messages that arrive during the
 * window collapse into a single reply sent when the window elapses (trailing
 * edge). A continued stream keeps paced at one reply per window; once a full
 * window passes with no new message, the key goes idle and the next message is
 * answered immediately again.
 *
 * Kept transport-agnostic and timer-injectable so it can be unit-tested with fake
 * timers: callers pass the actual `send` closure (which knows the channel, owner,
 * and message to reply to) on every trigger, and the latest one is used for the
 * trailing send so the batched reply threads under the most recent offense.
 */

type TimerHandle = ReturnType<typeof setTimeout>;

type Entry = {
  timer: TimerHandle;
  /** A message arrived during the window; one trailing reply is owed. */
  pending: boolean;
  /** The most recent send closure, used for the trailing reply. */
  send: () => void;
};

export type NoticeDebouncer = {
  /**
   * Register a denial for `key` (typically `channelId:userId`). Sends `send`
   * immediately when the key is idle, otherwise marks a trailing reply owed and
   * remembers this `send` as the latest.
   */
  trigger: (key: string, send: () => void) => void;
  /** Drop any pending timer for a key (e.g. when its channel is torn down). */
  cancel: (key: string) => void;
  /** Number of keys with an active window. Exposed for tests. */
  activeCount: () => number;
};

export function createNoticeDebouncer(opts: {
  windowMs: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}): NoticeDebouncer {
  const windowMs = opts.windowMs;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle));
  const entries = new Map<string, Entry>();

  const onElapse = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) {
      return;
    }
    if (entry.pending) {
      // Flush the single batched reply and keep the window open so a sustained
      // spam stays paced at one reply per window rather than going idle.
      entry.pending = false;
      entry.timer = setTimer(() => onElapse(key), windowMs);
      entry.send();
      return;
    }
    // A full quiet window passed: go idle so the next message leads again.
    entries.delete(key);
  };

  return {
    trigger: (key, send) => {
      const entry = entries.get(key);
      if (!entry) {
        entries.set(key, { timer: setTimer(() => onElapse(key), windowMs), pending: false, send });
        send();
        return;
      }
      // Within an open window: coalesce. Keep the latest send so the trailing
      // reply threads under the most recent offending message.
      entry.pending = true;
      entry.send = send;
    },
    cancel: (key) => {
      const entry = entries.get(key);
      if (entry) {
        clearTimer(entry.timer);
        entries.delete(key);
      }
    },
    activeCount: () => entries.size,
  };
}
