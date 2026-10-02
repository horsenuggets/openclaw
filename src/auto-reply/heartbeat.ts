import { SILENT_REPLY_TOKEN } from "./tokens.js";

// Instruction that makes a no-op heartbeat acknowledge with the universal silent-reply token,
// which the auto-reply pipeline suppresses on every channel (see `isSilentReplyText`). It is
// appended to every injected heartbeat turn via `appendHeartbeatAck`, so the ack is present
// even when a custom `heartbeat.prompt` omits it.
export const HEARTBEAT_ACK_INSTRUCTION = `If nothing needs attention, your ENTIRE response must be exactly ${SILENT_REPLY_TOKEN} — no preamble, no status summary, no other text.`;
// Default heartbeat prompt (used when config.agents.defaults.heartbeat.prompt is unset).
// Keep it tight and avoid encouraging the model to invent/rehash "open loops" from prior chat context.
export const HEARTBEAT_PROMPT = `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. ${HEARTBEAT_ACK_INSTRUCTION}`;
// Visible acknowledgment delivered when `channels.*.heartbeat.showOk` is enabled. The agent's
// own no-op reply is the silent token (and is suppressed); this is the opt-in human-readable
// "all good" ping the runtime sends in its place.
export const HEARTBEAT_OK_MESSAGE = "Heartbeat OK";
export const DEFAULT_HEARTBEAT_EVERY = "30m";
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

/**
 * Check if HEARTBEAT.md content is "effectively empty" - meaning it has no actionable tasks.
 * This allows skipping heartbeat API calls when no tasks are configured.
 *
 * A file is considered effectively empty if it contains only:
 * - Whitespace
 * - Comment lines (lines starting with #)
 * - Empty lines
 *
 * Note: A missing file returns false (not effectively empty) so the LLM can still
 * decide what to do. This function is only for when the file exists but has no content.
 */
export function isHeartbeatContentEffectivelyEmpty(content: string | undefined | null): boolean {
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content !== "string") {
    return false;
  }

  // Strip HTML comments (including multi-line blocks) before inspecting lines.
  // The workspace HEARTBEAT.md template keeps its guidance in `<!-- ... -->`
  // blocks and explicitly promises that a file with "only comments" skips
  // heartbeat API calls, so comment-only content must read as empty.
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, "");

  const lines = withoutComments.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines
    if (!trimmed) {
      continue;
    }
    // Skip markdown header lines (# followed by space or EOL, ## etc)
    // This intentionally does NOT skip lines like "#TODO" or "#hashtag" which might be content
    // (Those aren't valid markdown headers - ATX headers require space after #)
    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }
    // Skip empty markdown list items like "- [ ]" or "* [ ]" or just "- "
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }
    // Found a non-empty, non-comment line - there's actionable content
    return false;
  }
  // All lines were either empty or comments
  return true;
}

export function resolveHeartbeatPrompt(raw?: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || HEARTBEAT_PROMPT;
}

/**
 * Guarantee the silent-reply ack instruction on an injected heartbeat turn body. Custom
 * prompts are returned verbatim by `resolveHeartbeatPrompt` and may omit the ack; without it
 * an idle heartbeat could produce a user-visible reply (the system prompt no longer carries a
 * heartbeat section). We detect the exact `HEARTBEAT_ACK_INSTRUCTION` rather than a bare token
 * occurrence — a prompt that merely mentions `⁘ return` for another reason still needs the
 * instruction — so the default prompt (which embeds it) is never duplicated.
 */
export function appendHeartbeatAck(prompt: string): string {
  return prompt.includes(HEARTBEAT_ACK_INSTRUCTION)
    ? prompt
    : `${prompt}\n\n${HEARTBEAT_ACK_INSTRUCTION}`;
}
