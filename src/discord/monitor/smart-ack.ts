import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { runCommandWithTimeout } from "../../process/exec.js";

// Default to Haiku via CLI for fast acknowledgments using Max subscription
const DEFAULT_ACK_MODEL = "haiku";
const DEFAULT_ACK_TIMEOUT_MS = 8000;
const DEFAULT_ACK_DELAY_MS = 30000;

export type SmartAckConfig = {
  /** Enable smart contextual acknowledgments. */
  enabled?: boolean;
  /**
   * Delay in milliseconds before sending acknowledgment.
   * Only sends if main response hasn't arrived. Default: 30000 (30 seconds).
   */
  delayMs?: number;
  /** Model for acknowledgment generation via Claude CLI. Default: haiku. */
  model?: string;
  /** Timeout for acknowledgment generation in ms. Default: 8000. */
  timeoutMs?: number;
};

type ClaudeCliResponse = {
  result?: string;
  is_error?: boolean;
  session_id?: string;
};

function parseCliResponse(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as ClaudeCliResponse;
    if (parsed.is_error) {
      return null;
    }
    return parsed.result?.trim() || null;
  } catch {
    // If not JSON, treat as plain text response
    return trimmed || null;
  }
}

/**
 * Generate a contextual acknowledgment message using Claude CLI with Haiku.
 * Uses the Max subscription instead of per-token API charges.
 * Returns null if generation fails or times out.
 */
export async function generateSmartAck(params: {
  message: string;
  senderName?: string;
  cfg: OpenClawConfig;
  config?: SmartAckConfig;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { message, senderName, config, signal } = params;

  if (signal?.aborted) {
    return null;
  }

  const model = config?.model ?? DEFAULT_ACK_MODEL;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

  const nameContext = senderName ? `The user's name is ${senderName}. ` : "";

  const prompt =
    `You are a helpful AI assistant. Generate a brief, friendly acknowledgment (1-2 sentences) ` +
    `that shows you understand what the user is asking for. ${nameContext}` +
    `The acknowledgment should be specific to their request, not generic. ` +
    `Start with something like "I see you want to..." or "Working on..." or "Let me help you with...". ` +
    `Keep it warm but concise. Do NOT actually answer the request, just acknowledge it.\n\n` +
    `User's message:\n${message}`;

  // Build CLI args for claude command
  const args = ["--model", model, "-p", prompt, "--output-format", "json", "--max-turns", "1"];

  try {
    logVerbose(`smart-ack: running claude --model ${model}`);

    const result = await runCommandWithTimeout(["claude", ...args], {
      timeoutMs,
    });

    if (signal?.aborted) {
      logVerbose("smart-ack: aborted after CLI returned");
      return null;
    }

    if (result.code !== 0) {
      const err = result.stderr || result.stdout || "CLI failed";
      logVerbose(`smart-ack: CLI exited with code ${result.code}: ${err}`);
      return null;
    }

    const ack = parseCliResponse(result.stdout);
    if (!ack) {
      logVerbose("smart-ack: empty response from CLI");
      return null;
    }

    logVerbose(`smart-ack: generated acknowledgment (${ack.length} chars)`);

    // Format as italics for Discord
    return `*${ack}*`;
  } catch (err) {
    if (signal?.aborted) {
      logVerbose("smart-ack: generation aborted (main response arrived first or timeout)");
    } else {
      logVerbose(`smart-ack: generation failed: ${formatErrorMessage(err)}`);
    }
    return null;
  }
}

export type SmartAckController = {
  /** Cancel the smart ack (e.g., when main response arrives). */
  cancel: () => void;
  /** Wait for the smart ack result (if delay passed and not cancelled). */
  result: Promise<string | null>;
};

/**
 * Start a smart acknowledgment generation with delay.
 * Returns a controller that can be cancelled when the main response arrives.
 */
export function startSmartAck(params: {
  message: string;
  senderName?: string;
  cfg: OpenClawConfig;
  config?: SmartAckConfig;
}): SmartAckController {
  const delayMs = params.config?.delayMs ?? DEFAULT_ACK_DELAY_MS;
  const abortController = new AbortController();
  let cancelled = false;
  let resolveResult: (value: string | null) => void;

  const result = new Promise<string | null>((resolve) => {
    resolveResult = resolve;
  });

  // Start generation immediately but hold result until delay passes
  const generationPromise = generateSmartAck({
    ...params,
    signal: abortController.signal,
  });

  // Set up the delay timer
  const delayTimer = setTimeout(async () => {
    if (cancelled) {
      resolveResult(null);
      return;
    }

    try {
      const ack = await generationPromise;
      if (!cancelled) {
        resolveResult(ack);
      } else {
        resolveResult(null);
      }
    } catch {
      resolveResult(null);
    }
  }, delayMs);

  return {
    cancel: () => {
      cancelled = true;
      abortController.abort();
      clearTimeout(delayTimer);
      resolveResult(null);
    },
    result,
  };
}

export { DEFAULT_ACK_DELAY_MS };
