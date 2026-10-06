/**
 * Per-channel message queue for the Discord router.
 *
 * Replaces the old `inflight: Set<string>` poll-mutex. Two problems motivated
 * it: (1) every inbound message became its own agent turn, so a short standalone
 * message (e.g. "call me Sam") sent right after another could hit the agent's
 * silence-bias and get no reply at all; (2) three or more queued messages ran in
 * nondeterministic timer-race order rather than FIFO.
 *
 * This queue instead:
 *  - debounces: after a message arrives it waits `debounceMs` for the burst to
 *    settle before starting a turn, so rapid back-to-back messages collapse into
 *    one combined turn;
 *  - coalesces: all messages buffered while a turn is running (or during the
 *    debounce window) are drained together into a single combined turn, in FIFO
 *    order, so nothing is dropped and the agent sees the full context at once;
 *  - serializes: at most one turn per channel runs at a time.
 *
 * The onboarding kick reserves a channel up front (before its readiness probe)
 * via {@link ChannelQueue.reserve}, so a user message sent right after the
 * register embed buffers behind the kick instead of overtaking it.
 */

import type { DiscordAttachment } from "./types.js";

/**
 * The slice of the queue the onboarding kick needs: reserve a channel for an
 * exclusive turn, then release it. Narrowed so the kick stays unit-testable
 * without a full queue.
 */
export type ChannelSlot = {
  reserve(channelId: string): boolean;
  release(channelId: string): void;
};

/** One inbound turn's worth of data, before coalescing. */
export type ChannelTurn = {
  authorId: string;
  messageContent: string;
  attachments?: DiscordAttachment[];
  /** System-injected turn (onboarding kick, container `[System: ...]` note). */
  systemTurn?: boolean;
};

export type ChannelQueueOptions = {
  /** Run one (possibly coalesced) turn to completion. */
  runTurn: (channelId: string, turn: ChannelTurn) => Promise<void>;
  /**
   * How long to wait for a burst to settle before starting a turn. Messages
   * that arrive within this window of each other are coalesced.
   */
  debounceMs: number;
  log?: (message: string) => void;
  /** Injectable timers for deterministic tests. Default to global timers. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

type ChannelState = {
  running: boolean;
  pending: ChannelTurn[];
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * Coalesce a batch of buffered turns into a single turn. Contents are joined in
 * FIFO order, attachments concatenated. The most recent speaker's id is used
 * (in a 1:1 channel every turn shares it anyway). The combined turn counts as a
 * system turn only when every buffered turn was one, so a real user message in
 * the batch is always attributed to the user.
 */
export function coalesceTurns(batch: ChannelTurn[]): ChannelTurn {
  if (batch.length === 1) {
    return batch[0];
  }
  const messageContent = batch
    .map((t) => t.messageContent)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
  const attachments = batch.flatMap((t) => t.attachments ?? []);
  return {
    authorId: batch[batch.length - 1].authorId,
    messageContent,
    attachments: attachments.length > 0 ? attachments : undefined,
    systemTurn: batch.every((t) => t.systemTurn === true),
  };
}

export class ChannelQueue {
  private readonly channels = new Map<string, ChannelState>();
  private readonly runTurn: ChannelQueueOptions["runTurn"];
  private readonly debounceMs: number;
  private readonly log?: (message: string) => void;
  private readonly setTimer: NonNullable<ChannelQueueOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ChannelQueueOptions["clearTimer"]>;

  constructor(options: ChannelQueueOptions) {
    this.runTurn = options.runTurn;
    this.debounceMs = Math.max(0, options.debounceMs);
    this.log = options.log;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  private state(channelId: string): ChannelState {
    let state = this.channels.get(channelId);
    if (!state) {
      state = { running: false, pending: [], timer: null };
      this.channels.set(channelId, state);
    }
    return state;
  }

  /** True when a turn is running or messages are buffered for this channel. */
  isBusy(channelId: string): boolean {
    const state = this.channels.get(channelId);
    return Boolean(state && (state.running || state.pending.length > 0));
  }

  /** Buffer a message and schedule a (debounced) drain. */
  enqueue(channelId: string, turn: ChannelTurn): void {
    const state = this.state(channelId);
    state.pending.push(turn);
    if (state.pending.length > 1) {
      this.log?.(`[router] channel ${channelId} coalescing (${state.pending.length} buffered)`);
    }
    this.scheduleDrain(channelId);
  }

  /**
   * Reserve a channel for an exclusive, queue-bypassing turn (the onboarding
   * kick). Returns false if the channel is already busy — the caller should
   * skip, since the in-flight turn will drive onboarding itself. On success the
   * caller MUST call {@link release} when done.
   */
  reserve(channelId: string): boolean {
    const state = this.state(channelId);
    if (state.running || state.pending.length > 0) {
      return false;
    }
    state.running = true;
    return true;
  }

  /** Release a reserved channel, draining anything buffered during the hold. */
  release(channelId: string): void {
    const state = this.channels.get(channelId);
    if (!state) {
      return;
    }
    state.running = false;
    if (state.pending.length > 0) {
      this.scheduleDrain(channelId);
    } else {
      this.cleanup(channelId);
    }
  }

  /**
   * Drop all buffered messages and cancel the pending drain for a channel. Call
   * this when the channel's instance is removed or replaced (unregister, channel
   * delete, re-registration under a new owner): queued turns resolve the target
   * instance lazily at drain time, so without this a prior owner's buffered
   * messages could be coalesced and delivered to the replacement instance,
   * disclosing their content. A turn already running is left to finish against
   * the instance it started on; only not-yet-run messages are discarded.
   */
  clear(channelId: string): void {
    const state = this.channels.get(channelId);
    if (!state) {
      return;
    }
    if (state.timer) {
      this.clearTimer(state.timer);
      state.timer = null;
    }
    state.pending = [];
    if (!state.running) {
      this.channels.delete(channelId);
    }
  }

  private scheduleDrain(channelId: string): void {
    const state = this.state(channelId);
    // A running turn will drain whatever accumulated when it finishes.
    if (state.running) {
      return;
    }
    if (state.timer) {
      this.clearTimer(state.timer);
    }
    state.timer = this.setTimer(() => {
      state.timer = null;
      void this.drain(channelId);
    }, this.debounceMs);
  }

  private async drain(channelId: string): Promise<void> {
    const state = this.channels.get(channelId);
    if (!state || state.running || state.pending.length === 0) {
      return;
    }
    state.running = true;
    // Take exactly one batch (everything buffered so far) and run it as a single
    // coalesced turn. Messages that arrive mid-turn stay in `pending` and are NOT
    // drained immediately in a loop: the `finally` reschedules them through the
    // debounce instead, so a late arrival that lands just after this turn resolves
    // still gets its settle window and coalesces with the next batch rather than
    // becoming a lone turn (which could hit the agent's silence-bias). A failing
    // turn is logged and swallowed (runTurn wraps routeMessage, which handles its
    // own errors) so one bad turn never wedges the channel.
    const batch = state.pending.splice(0, state.pending.length);
    try {
      await this.runTurn(channelId, coalesceTurns(batch));
    } catch (err) {
      this.log?.(`[router] channel ${channelId} turn failed: ${String(err)}`);
    } finally {
      state.running = false;
      if (state.pending.length > 0) {
        this.scheduleDrain(channelId);
      } else {
        this.cleanup(channelId);
      }
    }
  }

  /** Drop empty, idle channel state so the map doesn't grow unbounded. */
  private cleanup(channelId: string): void {
    const state = this.channels.get(channelId);
    if (state && !state.running && state.pending.length === 0 && !state.timer) {
      this.channels.delete(channelId);
    }
  }
}
