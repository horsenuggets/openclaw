/**
 * transcript
 *
 * Translation layer from a persisted pi-ai transcript (`AgentMessage[]`) into
 * OpenClaw's abstract chat model (`ChatMessage[]`). This is a presentation /
 * attribution VIEW of the conversation — it is NOT used to reconstruct the wire
 * request (pi-ai owns that). Its job is to answer "what messages were exchanged,
 * and which ones were the human vs system-injected (heartbeat, tool-relay,
 * bootstrap)?"
 *
 * Attribution: OpenClaw injects synthetic user turns wrapped in
 * `<system-reminder>…</system-reminder>` (the same marker the persona preamble
 * uses). A persisted user turn whose content is ENTIRELY such a block is
 * classified `system` (system-injected), not `user` (a real human message).
 * Turns that carry no chat text — tool results, and assistant turns that are pure
 * tool calls / thinking — are internal context, not conversation, so they are
 * dropped from this view.
 *
 * Pure (no I/O, no globals, no clock) so the mapping can be exhaustively tested.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ChatMessage } from "./turns.js";
import { isSystemReminder } from "./system-reminder.js";

/** Join the text of an AgentMessage's content (string or content-block array). */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("");
  }
  return "";
}

/**
 * Classify a persisted transcript into the abstract chat model.
 * > assistant turns with text → `agent`
 * > user turns → `user`, unless the content is a `<system-reminder>` block → `system`
 * > tool results, and assistant turns with no text (pure tool calls/thinking), are dropped
 */
export function toChatMessages(messages: AgentMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const role = (message as { role?: unknown }).role;
    const ts = (message as { timestamp?: unknown }).timestamp;
    const timestamp = typeof ts === "number" ? ts : undefined;

    if (role === "assistant") {
      // Trim only for the emptiness check; preserve the original text so this view
      // does not mutate persisted content (leading/trailing whitespace can be
      // presentation-significant Markdown, e.g. indented code blocks).
      const text = extractText((message as { content?: unknown }).content);
      if (text.trim().length === 0) {
        continue;
      }
      result.push({ role: "agent", text, ...(timestamp !== undefined ? { ts: timestamp } : {}) });
      continue;
    }

    if (role === "user") {
      const text = extractText((message as { content?: unknown }).content);
      if (text.trim().length === 0) {
        continue;
      }
      result.push({
        role: isSystemReminder(text) ? "system" : "user",
        text,
        ...(timestamp !== undefined ? { ts: timestamp } : {}),
      });
      continue;
    }

    // toolResult (and any other role) — internal context, not conversation.
  }
  return result;
}
