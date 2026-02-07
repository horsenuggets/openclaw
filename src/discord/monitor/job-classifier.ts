import type { OpenClawConfig } from "../../config/config.js";
import type { JobClassification, JobClassifierConfig } from "../jobs/types.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandWithTimeout } from "../../process/exec.js";

const log = createSubsystemLogger("discord/job-classifier");

const DEFAULT_CLASSIFIER_MODEL = "haiku";
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 8000;

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
    return trimmed || null;
  }
}

/**
 * Classify an incoming message as NEW topic or CONTINUE previous conversation.
 * Uses Haiku via Claude CLI for fast, cheap classification.
 * Defaults to NEW on timeout/error (matches 99% use case).
 */
export async function classifyMessageTopic(params: {
  message: string;
  senderName?: string;
  previousJobSummary?: string;
  cfg: OpenClawConfig;
  config?: JobClassifierConfig;
  signal?: AbortSignal;
}): Promise<JobClassification> {
  const { message, senderName, previousJobSummary, config, signal } = params;
  const defaultResult: JobClassification = { decision: "NEW", reason: "default" };

  if (signal?.aborted) {
    return defaultResult;
  }

  // No previous job means this is always a new topic.
  if (!previousJobSummary) {
    return { decision: "NEW", reason: "no active job" };
  }

  const model = config?.model ?? DEFAULT_CLASSIFIER_MODEL;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;

  const nameContext = senderName ? `The user's name is ${senderName}. ` : "";

  const prompt =
    `You are classifying a Discord DM to determine if it's a new topic or continuing the previous conversation. ${nameContext}\n\n` +
    `Previous conversation: "${previousJobSummary}"\n\n` +
    `New message: "${message}"\n\n` +
    `Rules:\n` +
    `- NEW: Different subject, unrelated question, topic change, greeting, or clearly unrelated\n` +
    `- CONTINUE: Follow-up, clarification, "also"/"and", references previous work, asks about same topic\n` +
    `- When uncertain, choose NEW\n\n` +
    `Respond with ONLY one line:\n` +
    `NEW: <brief reason>\n` +
    `or\n` +
    `CONTINUE: <brief reason>`;

  const args = ["--model", model, "-p", prompt, "--output-format", "json", "--max-turns", "1"];

  try {
    logVerbose(`job-classifier: running claude --model ${model}`);

    const result = await runCommandWithTimeout(["claude", ...args], {
      timeoutMs,
    });

    if (signal?.aborted) {
      logVerbose("job-classifier: aborted after CLI returned");
      return defaultResult;
    }

    if (result.code !== 0) {
      const err = result.stderr || result.stdout || "CLI failed";
      log.warn(`CLI exited with code ${result.code}: ${err}`);
      return defaultResult;
    }

    const raw = parseCliResponse(result.stdout);
    if (!raw) {
      logVerbose("job-classifier: empty response from CLI");
      return defaultResult;
    }

    const isContinue = raw.startsWith("CONTINUE: ") || raw.startsWith("CONTINUE:");
    const isNew = raw.startsWith("NEW: ") || raw.startsWith("NEW:");
    const reason = isContinue
      ? raw.replace(/^CONTINUE:\s*/, "")
      : isNew
        ? raw.replace(/^NEW:\s*/, "")
        : raw;

    const decision = isContinue ? "CONTINUE" : "NEW";
    logVerbose(`job-classifier: ${decision} (${reason})`);
    log.info(`${decision}: ${reason}`);

    return { decision, reason: reason || undefined };
  } catch (err) {
    if (signal?.aborted) {
      logVerbose("job-classifier: aborted");
    } else {
      log.warn(`classification failed: ${formatErrorMessage(err)}`);
    }
    return defaultResult;
  }
}

export type JobClassificationController = {
  cancel: () => void;
  result: Promise<JobClassification>;
};

/**
 * Start job classification immediately. Returns a controller
 * that can be cancelled if the result is no longer needed.
 */
export function startJobClassification(params: {
  message: string;
  senderName?: string;
  previousJobSummary?: string;
  cfg: OpenClawConfig;
  config?: JobClassifierConfig;
}): JobClassificationController {
  const abortController = new AbortController();
  let cancelled = false;
  let resolveResult: (value: JobClassification) => void;

  const result = new Promise<JobClassification>((resolve) => {
    resolveResult = resolve;
  });

  const generationPromise = classifyMessageTopic({
    ...params,
    signal: abortController.signal,
  });

  void generationPromise
    .then((classification) => {
      if (!cancelled) {
        resolveResult(classification);
      } else {
        resolveResult({ decision: "NEW", reason: "cancelled" });
      }
    })
    .catch(() => {
      resolveResult({ decision: "NEW", reason: "error" });
    });

  return {
    cancel: () => {
      cancelled = true;
      abortController.abort();
      resolveResult({ decision: "NEW", reason: "cancelled" });
    },
    result,
  };
}
