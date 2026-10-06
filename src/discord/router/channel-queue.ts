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
  /**
   * Optional mid-turn steering: when a turn is already running, try to inject
   * the message into the live run instead of buffering it for the next turn.
   * Resolves true when the agent accepted it (there was an actively streaming
   * run, and its reply will carry the response), false when it must fall back to
   * the normal queued path. Omitted (or a rejected promise) => always buffer.
   */
  steer?: (channelId: string, turn: ChannelTurn) => Promise<boolean>;
  log?: (message: string) => void;
  /** Injectable timers for deterministic tests. Default to global timers. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

type ChannelState = {
  running: boolean;
  /**
   * The channel is held by an exclusive {@link ChannelQueue.reserve} (the
   * onboarding kick) rather than a normal drained turn. Steering is skipped
   * while reserved so a user message sent during onboarding queues behind the
   * kick (preserving its ordering) instead of being injected into it.
   */
  reserved: boolean;
  pending: ChannelTurn[];
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * Serializes mid-turn steer attempts so they are tried in arrival order (two
   * concurrent steer calls could otherwise reach the agent over separate
   * connections out of order). Each mid-turn message chains onto this tail.
   */
  steerChain: Promise<void>;
  /**
   * Once a mid-turn message during the current run falls back to buffering
   * (e.g. an attachment, or the run stopped streaming), every later arrival in
   * this run must also buffer — otherwise a steerable text could overtake an
   * already-buffered earlier message and break FIFO. Reset when the next turn
   * starts.
   */
  bufferRest: boolean;
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
  private readonly steer?: ChannelQueueOptions["steer"];
  private readonly log?: (message: string) => void;
  private readonly setTimer: NonNullable<ChannelQueueOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ChannelQueueOptions["clearTimer"]>;

  constructor(options: ChannelQueueOptions) {
    this.runTurn = options.runTurn;
    this.debounceMs = Math.max(0, options.debounceMs);
    this.steer = options.steer;
    this.log = options.log;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  private state(channelId: string): ChannelState {
    let state = this.channels.get(channelId);
    if (!state) {
      state = {
        running: false,
        reserved: false,
        pending: [],
        timer: null,
        steerChain: Promise.resolve(),
        bufferRest: false,
      };
      this.channels.set(channelId, state);
    }
    return state;
  }

  /** True when a turn is running or messages are buffered for this channel. */
  isBusy(channelId: string): boolean {
    const state = this.channels.get(channelId);
    return Boolean(state && (state.running || state.pending.length > 0));
  }

  /**
   * Accept a message for a channel. When a normal turn is already running and a
   * steer hook is configured, try to inject it into the live run (so the agent
   * sees it mid-turn); otherwise buffer it for a debounced, coalesced turn. A
   * reserved (onboarding-kick) hold never steers — see {@link ChannelState}.
   */
  enqueue(channelId: string, turn: ChannelTurn): void {
    const state = this.state(channelId);
    if (state.running && !state.reserved && this.steer) {
      // Chain onto the per-channel steer tail so attempts run in arrival order.
      state.steerChain = state.steerChain.then(() => this.steerOrBuffer(channelId, turn));
      return;
    }
    this.buffer(channelId, turn);
  }

  /** Buffer a message and schedule a (debounced) drain. */
  private buffer(channelId: string, turn: ChannelTurn): void {
    const state = this.state(channelId);
    state.pending.push(turn);
    if (state.pending.length > 1) {
      this.log?.(`[router] channel ${channelId} coalescing (${state.pending.length} buffered)`);
    }
    this.scheduleDrain(channelId);
  }

  /** Try mid-turn injection; fall back to buffering if the run didn't accept it. */
  private async steerOrBuffer(channelId: string, turn: ChannelTurn): Promise<void> {
    const state = this.state(channelId);
    // The turn ended while this attempt waited its turn in the chain, or an
    // earlier arrival already had to buffer this run: either way, buffer to keep
    // FIFO (never inject a later message ahead of an already-buffered earlier one).
    if (!state.running || state.bufferRest) {
      this.buffer(channelId, turn);
      return;
    }
    let accepted = false;
    try {
      accepted = await this.steer!(channelId, turn);
    } catch {
      accepted = false;
    }
    if (accepted) {
      this.log?.(`[router] channel ${channelId} steered message into the active turn`);
      return;
    }
    // Not accepted (run ended, or mid-compaction, or carries attachments): run it
    // as the next turn, and keep every later arrival this run in the same backlog.
    state.bufferRest = true;
    this.buffer(channelId, turn);
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
    state.reserved = true;
    return true;
  }

  /** Release a reserved channel, draining anything buffered during the hold. */
  release(channelId: string): void {
    const state = this.channels.get(channelId);
    if (!state) {
      return;
    }
    state.running = false;
    state.reserved = false;
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
    // Fresh run: mid-turn arrivals may steer again until one has to buffer.
    state.bufferRest = false;
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
