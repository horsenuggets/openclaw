import type { AgentStreamEvent } from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("auto-reply/smart-status");

const DEFAULT_MIN_INTERVAL_MS = 3000;
const DEFAULT_MAX_STATUS_LENGTH = 100;

export type SmartStatusConfig = {
  /** Minimum interval between status updates (ms). Default: 3000. */
  minIntervalMs?: number;
  /** Maximum length of status text. Default: 100. */
  maxStatusLength?: number;
};

/**
 * Create a smart status tracker that generates instant, deterministic status
 * updates from streaming events. Uses tool-display formatting for tool events
 * and truncated thinking excerpts for reasoning events. No model call needed.
 */
export function createSmartStatus(params: {
  userMessage: string;
  onUpdate: (text: string) => void;
  config?: SmartStatusConfig;
}): {
  push: (event: AgentStreamEvent) => void;
  dispose: () => void;
  /** Suppress updates for the given duration (e.g. after smart ack delivery). */
  suppress: (durationMs: number) => void;
} {
  const minIntervalMs = params.config?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const maxStatusLength = params.config?.maxStatusLength ?? DEFAULT_MAX_STATUS_LENGTH;

  let disposed = false;
  let suppressedUntil = 0;
  let lastUpdateTime = 0;
  let lastStatusText = "";
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  function emitStatus(text: string) {
    if (disposed || text === lastStatusText) {
      return;
    }
    lastStatusText = text;
    lastUpdateTime = Date.now();
    log.debug(`smart-status: emitting "${text}"`);
    params.onUpdate(text);
  }

  function scheduleOrEmit(candidate: string) {
    if (disposed) {
      return;
    }
    if (Date.now() < suppressedUntil) {
      return;
    }
    const elapsed = Date.now() - lastUpdateTime;
    if (elapsed >= minIntervalMs) {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
      }
      emitStatus(candidate);
    } else {
      // Debounce: schedule for the next eligible time.
      if (pendingTimer) {
        clearTimeout(pendingTimer);
      }
      const saved = candidate;
      pendingTimer = setTimeout(() => {
        pendingTimer = undefined;
        if (!disposed) {
          emitStatus(saved);
        }
      }, minIntervalMs - elapsed);
    }
  }

  function push(event: AgentStreamEvent) {
    if (disposed) {
      return;
    }

    switch (event.type) {
      case "tool_start":
        // No status for tool starts. Rich result blocks
        // (formatToolResultBlockDiscord) fire when the tool
        // completes with output, making start messages redundant.
        break;
      case "thinking": {
        // Show a truncated thinking excerpt as the status.
        const trimmed = event.text.trim();
        if (trimmed) {
          const maxExcerpt = maxStatusLength - 3;
          const excerpt =
            trimmed.length > maxExcerpt ? `${trimmed.slice(0, maxExcerpt)}...` : trimmed;
          scheduleOrEmit(`*${excerpt}...*`);
        }
        break;
      }
      case "tool_result":
      case "text":
        // No status update for tool results (tool already finished) or text
        // (the actual text arrives as a block reply).
        break;
    }
  }

  function suppress(durationMs: number) {
    suppressedUntil = Date.now() + durationMs;
  }

  function dispose() {
    disposed = true;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
  }

  return { push, dispose, suppress };
}
