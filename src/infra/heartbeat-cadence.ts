/**
 * Pure cadence math for the proactive heartbeat scheduler.
 *
 * The heartbeat runner wakes the agent on a schedule to let it decide whether to
 * proactively reach out. Two mechanical concerns live here (kept pure so they are
 * exhaustively unit-testable, with no clock or I/O):
 *
 * > jitter    - spread wakes around the base interval (e.g. 60m -> 50-70m) so the
 * >             cadence feels natural rather than robotically on-the-hour.
 * > backoff   - widen the interval for a user who is not engaging, so a dormant
 * >             conversation does not cost a full model call every hour. The
 * >             streak resets to 0 the moment the user replies, snapping the
 * >             cadence back to the base interval.
 *
 * The decision of whether to actually send (and the tone/escalation of any
 * message) is the model's job, driven by HEARTBEAT.md and recent context — not
 * this module. This only decides *when the next wake happens*.
 */

export type CadenceState = {
  /** Base interval in milliseconds (resolved from the `every` config). */
  baseIntervalMs: number;
  /**
   * Number of consecutive wakes since the user last engaged. 0 means the user is
   * active (or we have never backed off), so the base interval applies.
   */
  quietStreak: number;
};

export type BackoffOptions = {
  /** Multiplier applied per quiet-streak step (e.g. 2 doubles each dormant wake). */
  factor: number;
  /** Hard ceiling on the widened interval (e.g. 7 days), in milliseconds. */
  maxIntervalMs: number;
};

export type CadenceOptions = {
  /** Fractional jitter, 0..1. 0.17 spreads a 60m base to ~50-70m. Default 0. */
  jitterPct?: number;
  /** Backoff for dormant users. Omit to keep a flat interval. */
  backoff?: BackoffOptions;
  /** Injectable RNG in [0,1) for deterministic tests. Default Math.random. */
  rng?: () => number;
};

/** Clamp a fractional jitter into the sane [0, 1) range. */
function normalizeJitterPct(jitterPct: number | undefined): number {
  if (!Number.isFinite(jitterPct) || !jitterPct || jitterPct <= 0) {
    return 0;
  }
  return Math.min(jitterPct, 0.99);
}

/**
 * Widen the base interval by the backoff curve for the current quiet streak,
 * before jitter. Pure and monotonic in `quietStreak`.
 */
export function applyBackoff(
  baseIntervalMs: number,
  quietStreak: number,
  backoff: BackoffOptions | undefined,
): number {
  if (!backoff || quietStreak <= 0 || backoff.factor <= 1) {
    return baseIntervalMs;
  }
  const widened = baseIntervalMs * backoff.factor ** quietStreak;
  return Math.min(widened, backoff.maxIntervalMs);
}

/**
 * Compute the delay (ms) until the next heartbeat wake, applying backoff for
 * dormant users and then jitter. Never returns less than 1000ms.
 */
export function computeNextIntervalMs(state: CadenceState, opts: CadenceOptions = {}): number {
  const rng = opts.rng ?? Math.random;
  const backedOff = applyBackoff(state.baseIntervalMs, state.quietStreak, opts.backoff);

  const jitterPct = normalizeJitterPct(opts.jitterPct);
  // Jitter is symmetric: factor in [1 - jitterPct, 1 + jitterPct).
  const jittered = jitterPct > 0 ? backedOff * (1 + (rng() * 2 - 1) * jitterPct) : backedOff;

  return Math.max(1000, Math.round(jittered));
}
