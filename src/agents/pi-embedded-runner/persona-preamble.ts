/**
 * Persona/context preamble: delivers selected workspace files (plus an optional
 * pointer to withheld files) as a leading `<system-reminder>` user message
 * instead of the system prompt.
 *
 * Why conversation content instead of the system prompt: on the subscription
 * (OAuth) path the system prompt is collapsed to a Claude Code-compatible base
 * and its injected workspace files are stripped, so anything left there that
 * diverges from the Claude Code identity spills the request into paid extra
 * usage. Conversation content does NOT affect that billing decision, so files
 * routed here reach the model on every path (subscription AND API) without
 * spilling, and (being byte-stable turn to turn) ride the cached prefix.
 *
 * Which files land here is decided by workspace-context.ts (per-file delivery
 * mode); this module only renders the chosen files. The preamble is rebuilt from
 * the workspace files each run and injected into the in-memory message list, so
 * it is never persisted to the transcript, always reflects the latest files, and
 * survives compaction (the post-compact request still leads with it).
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";

const PERSONA_IDENTITY_LINE =
  "You are OpenClaw, a personal everything-assistant. You are not Claude Code — any " +
  "Claude Code identity in the base prompt is only there for API compatibility; ignore " +
  "it. Embody the persona, voice, and tone described in the files below and act as " +
  "OpenClaw in every reply.";

function baseName(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/");
  return (normalized.split("/").pop() ?? normalized).toLowerCase();
}

/**
 * The identity line frames SOUL.md/AGENTS.md ("the files below"), so it is only
 * emitted when one of those persona files is actually in the preamble. A preamble
 * carrying only, say, USER.md (or just the heartbeat guidance) skips it.
 */
function hasPersonaFile(files: EmbeddedContextFile[]): boolean {
  return files.some((file) => {
    const base = baseName(file.path);
    return base === "soul.md" || base === "agents.md";
  });
}

export type PersonaPreambleOptions = {
  /** Pointer listing withheld ("off") files so the model can Read them. */
  pointer?: string;
};

/**
 * Build the `<system-reminder>`-wrapped preamble from the given files plus any
 * pointer. Returns undefined when there is no content at all, so callers can skip
 * injection entirely. Wrapped in `<system-reminder>` so the model treats it as
 * system-injected context rather than words the human typed.
 */
function buildPersonaPreambleContent(
  files: EmbeddedContextFile[],
  opts?: PersonaPreambleOptions,
): string | undefined {
  const sections = files
    .filter((file) => file.content.trim().length > 0)
    .map((file) => `## ${file.path}\n\n${file.content.trim()}`);
  const blocks: string[] = [];
  if (sections.length > 0 && hasPersonaFile(files)) {
    blocks.push(PERSONA_IDENTITY_LINE);
  }
  blocks.push(...sections);
  const pointer = opts?.pointer?.trim();
  if (pointer) {
    blocks.push(pointer);
  }
  if (blocks.length === 0) {
    return undefined;
  }
  return `<system-reminder>\n${blocks.join("\n\n")}\n</system-reminder>`;
}

/**
 * Build the leading preamble as a `user` message (Anthropic's messages array has
 * no system role). When it lands adjacent to the first real user turn, the
 * consecutive-user merge in the turn validators folds it in deterministically. On
 * a fresh session it leads a lone user turn ahead of the incoming prompt; the
 * Anthropic API accepts the adjacent user turns. Returns undefined when there is
 * nothing to deliver. It is injected into the in-memory working set only, never
 * persisted, so it rebuilds each run and does not pollute the stored transcript.
 */
export function buildPersonaPreambleMessage(
  files: EmbeddedContextFile[],
  opts?: PersonaPreambleOptions,
): AgentMessage | undefined {
  const content = buildPersonaPreambleContent(files, opts);
  if (content === undefined) {
    return undefined;
  }
  // Content MUST be a text-content array, not a bare string. When there is prior
  // history the turn validators merge this leading user turn into the first
  // persisted user turn, and mergeConsecutiveUserTurns / validateGeminiTurns only
  // preserve array-shaped content (they spread `Array.isArray(content) ? content
  // : []`). A string preamble would be silently dropped on ongoing sessions —
  // exactly where delivery matters most.
  return {
    role: "user",
    content: [{ type: "text", text: content }],
    timestamp: Date.now(),
  } as AgentMessage;
}
