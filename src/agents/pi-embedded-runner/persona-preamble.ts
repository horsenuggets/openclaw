/**
 * Persona/context preamble: delivers the chosen workspace files (plus an optional
 * pointer to withheld files, and on the subscription path the whole OpenClaw
 * system prompt) as a leading `<system-reminder>` user message.
 *
 * Why conversation content instead of the system prompt: on the subscription
 * (OAuth) path the system block must stay a pure Claude Code base to bill on plan
 * quota, so any OpenClaw-divergent content there (identity, persona, operational
 * instructions) spills the request into paid extra usage. Conversation content
 * does NOT affect that billing decision, so the whole OpenClaw prompt plus the
 * workspace files are delivered here instead (see the `systemPrompt` option and
 * subscription-prompt.ts). On the API-key path the operational prompt stays in the
 * system block and only the workspace files ride here. Being byte-stable turn to
 * turn, the preamble rides the cached prefix.
 *
 * Which workspace files land here is decided by workspace-context.ts (per-file
 * delivery mode). The preamble is rebuilt each run and injected into the in-memory
 * message list, so it is never persisted to the transcript, always reflects the
 * latest files, and survives compaction (the post-compact request still leads with
 * it).
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";

// Non-identity framing emitted when SOUL.md/AGENTS.md ride the preamble, so the
// model treats them as its own persona/workspace guide rather than inert reference
// text. Identity itself is asserted by the operational prompt ("actually, you are
// openclaw ...") and by SOUL.md's own content, so this framing deliberately carries
// no identity claim (it only frames the files that follow). The editable source is
// docs/reference/templates/PERSONA_FRAMING.md; this constant is the fallback used
// when that template cannot be read.
const PERSONA_FRAMING_FALLBACK =
  "the files below are yours. treat them as your own persona and workspace guide, and let " +
  "their voice, tone, and conventions shape every reply.";

const PERSONA_FRAMING_TEMPLATE = "PERSONA_FRAMING.md";

let cachedPersonaFraming: string | undefined;

function stripTemplateFrontMatter(raw: string): string {
  // Drop a leading YAML front-matter block (--- ... ---) like the other templates.
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "");
}

// Load the persona framing from the editable template once (cached). Mirrors the
// template-dir candidates in workspace-templates.ts so it resolves in dev, packaged,
// and binary (bun --compile) layouts; falls back to the constant if unreadable.
function getPersonaFramingLine(): string {
  if (cachedPersonaFraming !== undefined) {
    return cachedPersonaFraming;
  }
  const rel = path.join("docs", "reference", "templates", PERSONA_FRAMING_TEMPLATE);
  const candidates = [
    typeof (globalThis as Record<string, unknown>).Bun !== "undefined"
      ? path.join(path.dirname(process.execPath), rel)
      : undefined,
    path.resolve(process.cwd(), rel),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", rel),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      const text = stripTemplateFrontMatter(readFileSync(candidate, "utf-8"))
        .replace(/\s*\n\s*/g, " ")
        .trim();
      if (text) {
        cachedPersonaFraming = text;
        return cachedPersonaFraming;
      }
    } catch {
      // Try the next candidate.
    }
  }
  cachedPersonaFraming = PERSONA_FRAMING_FALLBACK;
  return cachedPersonaFraming;
}

function baseName(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/");
  return (normalized.split("/").pop() ?? normalized).toLowerCase();
}

function hasPersonaFile(files: EmbeddedContextFile[]): boolean {
  return files.some((file) => {
    const base = baseName(file.path);
    return base === "soul.md" || base === "agents.md";
  });
}

export type PersonaPreambleOptions = {
  /** Pointer listing withheld ("off") files so the model can Read them. */
  pointer?: string;
  /**
   * The full OpenClaw system prompt (identity + operational instructions),
   * delivered as the leading block of the reminder instead of the system prompt.
   * Set only on the subscription (OAuth) path, where the system block must stay a
   * pure Claude Code base to bill on plan quota; the probe
   * (scripts/subscription-billing-probe.ts, case "full-prompt-in-reminder")
   * confirms delivering it here stays on plan quota. On the API-key path this is
   * left undefined because the operational prompt lives in the system block.
   */
  systemPrompt?: string;
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
  // The operational system prompt (when provided, i.e. the subscription path)
  // leads the reminder so identity + operating instructions reach the model ahead
  // of the workspace files.
  const systemPrompt = opts?.systemPrompt?.trim();
  if (systemPrompt) {
    blocks.push(systemPrompt);
  }
  // Frame SOUL/AGENTS as the model's own persona/workspace guide (non-identity).
  if (sections.length > 0 && hasPersonaFile(files)) {
    blocks.push(getPersonaFramingLine());
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
