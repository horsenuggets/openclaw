/**
 * Persona preamble: delivers OpenClaw's identity + persona files (SOUL.md,
 * AGENTS.md) as a leading conversation message instead of the system prompt.
 *
 * Why conversation content instead of the system prompt: on the subscription
 * (OAuth) path the system prompt is collapsed to a Claude Code-compatible base
 * (see wrapForSubscription) and the injected workspace files are stripped, so
 * anything left in the system prompt that diverges from the Claude Code identity
 * spills the request into paid extra usage. Conversation content does NOT affect
 * that billing decision, so persona delivered as a leading `user` message reaches
 * the model on every path (subscription AND API) without spilling — and, being
 * byte-stable turn to turn, it rides inside the cached prefix.
 *
 * The preamble is rebuilt from the workspace files each run and injected into the
 * in-memory message list, so it is never persisted to the transcript, always
 * reflects the latest SOUL.md/AGENTS.md, and survives compaction (the post-compact
 * request still leads with it).
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";

/**
 * Workspace files (by lowercased basename) that carry OpenClaw's identity/persona
 * and are delivered via the preamble rather than the system-prompt Project Context
 * block. Order here is the order they appear in the preamble.
 */
export const PERSONA_PREAMBLE_FILENAMES = ["soul.md", "agents.md"] as const;

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
 * Split loaded context files into the persona files (delivered via the preamble)
 * and the remaining files (which still go into the system-prompt Project Context
 * block). Persona files are returned in PERSONA_PREAMBLE_FILENAMES order so the
 * preamble content is deterministic (stable for prompt caching); the remaining
 * files keep their original order.
 */
export function splitPersonaContextFiles(contextFiles: EmbeddedContextFile[]): {
  personaFiles: EmbeddedContextFile[];
  remainingFiles: EmbeddedContextFile[];
} {
  const personaFiles: EmbeddedContextFile[] = [];
  const remainingFiles: EmbeddedContextFile[] = [];
  for (const file of contextFiles) {
    if ((PERSONA_PREAMBLE_FILENAMES as readonly string[]).includes(baseName(file.path))) {
      continue;
    }
    remainingFiles.push(file);
  }
  // Emit persona files in the canonical order regardless of load order.
  for (const target of PERSONA_PREAMBLE_FILENAMES) {
    const match = contextFiles.find((file) => baseName(file.path) === target);
    if (match) {
      personaFiles.push(match);
    }
  }
  return { personaFiles, remainingFiles };
}

/**
 * Build the `<system-reminder>`-wrapped preamble content from persona files and,
 * optionally, the heartbeat guidance block. Returns undefined when there is no
 * content at all (e.g. a brand-new workspace before SOUL.md exists and no heartbeat
 * guidance), so callers can skip injection entirely. Wrapped in `<system-reminder>`
 * so the model treats it as system-injected context rather than words the human
 * typed.
 *
 * `heartbeatGuidance` is the "## Heartbeats" block (see buildHeartbeatGuidance). On
 * the subscription path it is delivered here as conversation content instead of in
 * the system prompt, where its proactive-messaging content would spill the request
 * to paid extra usage.
 */
function buildPersonaPreambleContent(
  personaFiles: EmbeddedContextFile[],
  heartbeatGuidance?: string,
): string | undefined {
  const personaSections = personaFiles
    .filter((file) => file.content.trim().length > 0)
    .map((file) => `## ${file.path}\n\n${file.content.trim()}`);
  const blocks: string[] = [];
  // The identity line frames the persona files ("the files below"), so only emit it
  // when there are persona files; a heartbeat-only preamble skips it.
  if (personaSections.length > 0) {
    blocks.push(PERSONA_IDENTITY_LINE, ...personaSections);
  }
  const heartbeat = heartbeatGuidance?.trim();
  if (heartbeat) {
    blocks.push(heartbeat);
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
 * no persona content and no heartbeat guidance. It is injected into the in-memory
 * working set only, never persisted, so it rebuilds each run and does not pollute
 * the stored transcript.
 */
export function buildPersonaPreambleMessage(
  personaFiles: EmbeddedContextFile[],
  opts?: { heartbeatGuidance?: string },
): AgentMessage | undefined {
  const content = buildPersonaPreambleContent(personaFiles, opts?.heartbeatGuidance);
  if (content === undefined) {
    return undefined;
  }
  // Content MUST be a text-content array, not a bare string. When there is prior
  // history the turn validators merge this leading user turn into the first
  // persisted user turn, and mergeConsecutiveUserTurns / validateGeminiTurns only
  // preserve array-shaped content (they spread `Array.isArray(content) ? content
  // : []`). A string preamble would be silently dropped on ongoing sessions —
  // exactly where persona delivery matters most.
  return {
    role: "user",
    content: [{ type: "text", text: content }],
    timestamp: Date.now(),
  } as AgentMessage;
}
