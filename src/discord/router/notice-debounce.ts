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
  /**
   * Drop every pending window for a channel. Keys are `channelId:userId`, so this
   * cancels all per-user windows under `channelId`. Call it when a channel is torn
   * down (unregister) or deleted so a queued trailing notice cannot fire
   * afterward and post to a now-ownerless or deleted channel.
   */
  cancelChannel: (channelId: string) => void;
  /** Drop every pending window (e.g. on router shutdown). */
  cancelAll: () => void;
  /**
   * Suppress a channel while its teardown is in progress: cancels its current
   * windows AND makes {@link trigger} a no-op for its keys until
   * {@link unsuppressChannel}. The instance stays in the router's `instances` map
   * until unregister completes, so an unauthorized message during a slow purge
   * could otherwise open a NEW window whose trailing send fires after teardown
   * using the former owner. Suppressing closes that window.
   */
  suppressChannel: (channelId: string) => void;
  /** Lift a channel's teardown suppression (also cancels any residual windows). */
  unsuppressChannel: (channelId: string) => void;
  /** Number of keys with an active window. Exposed for tests. */
  activeCount: () => number;
};

export function createNoticeDebouncer(opts: {
  windowMs: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}): NoticeDebouncer {
  const windowMs = opts.windowMs;
  // Default timers are unref'd: a pending denial window is a best-effort
  // notification and must never keep the process alive during shutdown (an active
  // window could otherwise hold the event loop open for up to a window, or fire
  // another Discord request mid-shutdown). An injected setTimer (tests) decides
  // its own ref behavior.
  const setTimer =
    opts.setTimer ??
    ((fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    });
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle));
  const entries = new Map<string, Entry>();
  // Channels whose teardown is in progress; trigger is a no-op for their keys.
  // Reference-counted, not a plain Set: overlapping unregisters (e.g. an explicit
  // confirm racing a channel-delete) each suppress/unsuppress, and suppression must
  // persist until the LAST one completes. A plain Set would let the first finisher
  // lift it while a second teardown is still awaiting the provisioner, re-opening
  // the stale-notice window this guards.
  const suppressed = new Map<string, number>();

  // Keys are `channelId:userId`; the channel is the part before the first colon.
  const channelOf = (key: string): string => {
    const idx = key.indexOf(":");
    return idx === -1 ? key : key.slice(0, idx);
  };

  const cancelChannel = (channelId: string): void => {
    const prefix = `${channelId}:`;
    for (const [key, entry] of entries) {
      if (key.startsWith(prefix)) {
        clearTimer(entry.timer);
        entries.delete(key);
      }
    }
  };

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
      // Ignore denials for a channel whose teardown is in progress: its instance
      // is about to disappear, so a reply (and especially a trailing one that
      // could fire after teardown) would use a stale owner/status.
      if (suppressed.has(channelOf(key))) {
        return;
      }
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
    cancelChannel,
    cancelAll: () => {
      for (const entry of entries.values()) {
        clearTimer(entry.timer);
      }
      entries.clear();
    },
    suppressChannel: (channelId) => {
      suppressed.set(channelId, (suppressed.get(channelId) ?? 0) + 1);
      cancelChannel(channelId);
    },
    unsuppressChannel: (channelId) => {
      // Decrement the ref count; only the final outstanding teardown lifts
      // suppression. An unbalanced call (count already 0/absent) is a no-op.
      const count = suppressed.get(channelId);
      if (count === undefined) {
        return;
      }
      if (count <= 1) {
        suppressed.delete(channelId);
      } else {
        suppressed.set(channelId, count - 1);
      }
      cancelChannel(channelId);
    },
    activeCount: () => entries.size,
  };
}
