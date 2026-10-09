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
  /**
   * An out-of-band secret to hand the agent box with this turn (from the
   * `/secret` command). Never coalesced into another turn's content: a turn
   * carrying a secret bypasses the steer path (see enqueue), so it always runs
   * on its own and the secret reaches routeMessage intact.
   */
  secret?: { name: string; value: string };
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
  /**
   * Count of steer attempts queued on {@link steerChain} that have not settled.
   * Keeps outstanding steer work part of the channel's busy lifecycle: state is
   * not cleaned up, and later arrivals keep ordering behind it, until it reaches
   * zero. Without this a steer could outlive its run — cleanup would drop the
   * state and a newer message would run ahead of the older, still-pending one.
   */
  pendingSteers: number;
  /**
   * Bumped by {@link ChannelQueue.clear} (instance removed/replaced). A steer
   * attempt captures the generation when queued and drops its message if the
   * generation changed by the time it settles, so a prior instance's message is
   * never buffered for the replacement.
   */
  generation: number;
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
  // A secret-bearing turn is always drained as its own single-item batch (see
  // ChannelQueue.drain, which splits at secret boundaries), so this coalesce
  // path should never see one. Preserve the first secret defensively so a
  // coalesce can never silently drop it even if that invariant ever changes.
  const secret = batch.find((t) => t.secret)?.secret;
  return {
    authorId: batch[batch.length - 1].authorId,
    messageContent,
    attachments: attachments.length > 0 ? attachments : undefined,
    systemTurn: batch.every((t) => t.systemTurn === true),
    ...(secret ? { secret } : {}),
  };
}

/**
 * Take the next batch to run as a single turn, splitting at secret boundaries so
 * a secret-bearing turn is never coalesced with any other message. If the head
 * of the queue carries a secret, that one turn is taken alone. Otherwise all
 * leading non-secret turns are taken (stopping before the first secret), so each
 * secret runs on its own turn with its reminder text and `systemTurn` flag
 * intact and its value reaches routeMessage undiluted.
 */
export function takeNextBatch(pending: ChannelTurn[]): ChannelTurn[] {
  if (pending.length === 0) {
    return [];
  }
  if (pending[0].secret) {
    return pending.splice(0, 1);
  }
  let count = 1;
  while (count < pending.length && !pending[count].secret) {
    count += 1;
  }
  return pending.splice(0, count);
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
        pendingSteers: 0,
        generation: 0,
      };
      this.channels.set(channelId, state);
    }
    return state;
  }

  /** True when a turn is running, messages are buffered, or a steer is pending. */
  isBusy(channelId: string): boolean {
    const state = this.channels.get(channelId);
    return Boolean(state && (state.running || state.pending.length > 0 || state.pendingSteers > 0));
  }

  /**
   * Accept a message for a channel. When a normal turn is running (or a steer is
   * still in flight) and a steer hook is configured, chain it through the
   * per-channel steer tail so it is tried in arrival order and injected into the
   * live run; otherwise buffer it for a debounced, coalesced turn. A reserved
   * (onboarding-kick) hold never steers — see {@link ChannelState}.
   */
  enqueue(channelId: string, turn: ChannelTurn): void {
    const state = this.state(channelId);
    // A secret-bearing turn must never be steered (steering injects it as plain
    // text into a live run, which would drop the out-of-band secret and leak its
    // intent into the transcript). It must also act as a FIFO barrier: once a
    // secret is queued, every later arrival this run must buffer behind it rather
    // than steer into the active run and overtake it. Set bufferRest so later
    // non-secret arrivals buffer, and when a steer chain is active route the
    // secret through it (as a forced buffer) so it stays ordered after any
    // earlier in-flight steers instead of jumping ahead of them.
    if (turn.secret) {
      state.bufferRest = true;
      if (!state.reserved && this.steer && (state.running || state.pendingSteers > 0)) {
        this.chainForcedBuffer(channelId, turn);
        return;
      }
      this.buffer(channelId, turn);
      return;
    }
    // Route through the steer chain while a turn is running OR an earlier steer
    // is still settling, so a later arrival can never run ahead of it.
    if (!state.reserved && this.steer && (state.running || state.pendingSteers > 0)) {
      state.pendingSteers += 1;
      const generation = state.generation;
      state.steerChain = state.steerChain.then(() =>
        this.steerOrBuffer(channelId, turn, generation),
      );
      return;
    }
    this.buffer(channelId, turn);
  }

  /**
   * Append a turn to the steer chain that is always buffered, never steered
   * (used for secret barriers). It keeps its place in arrival order behind any
   * earlier in-flight steers, honors a clear() via the generation check, and
   * participates in the channel's busy lifecycle like a real steer attempt.
   */
  private chainForcedBuffer(channelId: string, turn: ChannelTurn): void {
    const state = this.state(channelId);
    state.pendingSteers += 1;
    const generation = state.generation;
    state.steerChain = state.steerChain.then(() => {
      try {
        if (state.generation !== generation) {
          return;
        }
        this.buffer(channelId, turn);
      } finally {
        state.pendingSteers = Math.max(0, state.pendingSteers - 1);
        this.cleanup(channelId);
      }
    });
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
  private async steerOrBuffer(
    channelId: string,
    turn: ChannelTurn,
    generation: number,
  ): Promise<void> {
    const state = this.state(channelId);
    try {
      // The channel was cleared/replaced (instance removed or re-registered)
      // after this was queued: drop it rather than deliver it to a new instance.
      if (state.generation !== generation) {
        return;
      }
      // The turn ended while this attempt waited its turn in the chain, or an
      // earlier arrival already had to buffer this run: buffer to keep FIFO (never
      // inject a later message ahead of an already-buffered earlier one).
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
      // Re-check: a clear() may have landed while the steer call was in flight.
      if (state.generation !== generation) {
        return;
      }
      if (accepted) {
        this.log?.(`[router] channel ${channelId} steered message into the active turn`);
        return;
      }
      // Not accepted (run ended, mid-compaction, or carries attachments): run it
      // as the next turn, and keep every later arrival this run in the same backlog.
      state.bufferRest = true;
      this.buffer(channelId, turn);
    } finally {
      state.pendingSteers = Math.max(0, state.pendingSteers - 1);
      this.cleanup(channelId);
    }
  }

  /**
   * Reserve a channel for an exclusive, queue-bypassing turn (the onboarding
   * kick). Returns false if the channel is already busy — the caller should
   * skip, since the in-flight turn will drive onboarding itself. On success the
   * caller MUST call {@link release} when done.
   */
  reserve(channelId: string): boolean {
    const state = this.state(channelId);
    if (state.running || state.pending.length > 0 || state.pendingSteers > 0) {
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
    state.bufferRest = false;
    // Invalidate any in-flight steer: when it settles it will see the changed
    // generation and drop its message instead of buffering it for the new
    // instance. The state object is kept until that outstanding work settles.
    state.generation += 1;
    if (!state.running && state.pendingSteers === 0) {
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
    // Take one batch and run it as a single coalesced turn. takeNextBatch splits
    // at secret boundaries so a secret-bearing turn always runs on its own (never
    // coalesced with other messages, so its value and reminder reach routeMessage
    // intact); any remaining pending turns (e.g. a second secret, or messages
    // after one) are left behind and rescheduled by the `finally`. Messages that
    // arrive mid-turn likewise stay in `pending` and are NOT drained in a loop:
    // the reschedule runs them through the debounce so a late arrival still gets
    // its settle window rather than becoming a lone turn (which could hit the
    // agent's silence-bias). A failing turn is logged and swallowed (runTurn wraps
    // routeMessage, which handles its own errors) so one bad turn never wedges the
    // channel.
    const batch = takeNextBatch(state.pending);
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
    if (
      state &&
      !state.running &&
      state.pending.length === 0 &&
      state.pendingSteers === 0 &&
      !state.timer
    ) {
      this.channels.delete(channelId);
    }
  }
}
