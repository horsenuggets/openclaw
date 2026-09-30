/**
 * workspace-context
 *
 * Config-driven routing of workspace context files (SOUL/AGENTS/IDENTITY/USER/
 * TOOLS/HEARTBEAT/BOOTSTRAP/MEMORY) to one of three delivery channels:
 *
 *  - "inline":   full content in the system-prompt Project Context block. This is
 *    the historical behavior; note the subscription path strips that block, so
 *    inline files do NOT reach the model on OAuth requests.
 *  - "preamble": full content in the leading `<system-reminder>` user message.
 *    Reaches the model on every path (API and subscription) without spilling
 *    billing, and rides the cached prefix.
 *  - "off":      content not sent. If the pointer is enabled the file is still
 *    listed by name so the model can Read it on demand with its file tools.
 *
 * Mode precedence per file: explicit per-file config > global config default >
 * built-in per-file default (below) > "inline".
 */

import type {
  WorkspaceContextConfig,
  WorkspaceContextMode,
} from "../../config/types.agent-defaults.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";

/**
 * Out-of-the-box mode per workspace file (keyed by lowercased basename). Applied
 * only when the config sets neither a per-file override nor a global default.
 *
 * Rationale: persona/identity/profile ride the preamble so they reach the model
 * on the subscription path (where inline is stripped) without spilling; the
 * larger, situational files stay off and are pointed at so they are read on
 * demand instead of re-sent in full every turn. MEMORY is off because it is
 * already reachable via the memory_search / memory_get tools. BOOTSTRAP defaults
 * to preamble (not off) so first-run onboarding content is guaranteed in front of
 * the model rather than depending on the model choosing to Read it.
 */
export const DEFAULT_WORKSPACE_CONTEXT_MODES: Record<string, WorkspaceContextMode> = {
  "soul.md": "preamble",
  "agents.md": "preamble",
  "identity.md": "preamble",
  "user.md": "preamble",
  "bootstrap.md": "preamble",
  "tools.md": "off",
  "heartbeat.md": "off",
  "memory.md": "off",
};

const DEFAULT_POINTER_PLACEMENT: "inline" | "preamble" | "off" = "preamble";

function normalizedBase(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/");
  return normalized.split("/").pop() ?? normalized;
}

function lowerBase(filePath: string): string {
  return normalizedBase(filePath).toLowerCase();
}

/** Resolve the delivery mode for a single workspace file. */
export function resolveWorkspaceContextMode(
  filePath: string,
  config?: WorkspaceContextConfig,
): WorkspaceContextMode {
  const base = lowerBase(filePath);
  return (
    config?.files?.[base] ?? config?.default ?? DEFAULT_WORKSPACE_CONTEXT_MODES[base] ?? "inline"
  );
}

export type WorkspaceContextDelivery = {
  /** Files to inline into the system-prompt Project Context block. */
  inlineFiles: EmbeddedContextFile[];
  /** Files to deliver via the `<system-reminder>` preamble. */
  preambleFiles: EmbeddedContextFile[];
  /** Files withheld (content not sent); surfaced via the pointer. */
  offFiles: EmbeddedContextFile[];
  /** Where the pointer listing the off files should be placed. */
  pointerPlacement: "inline" | "preamble" | "off";
};

/** Split loaded context files into inline / preamble / off buckets per config. */
export function resolveWorkspaceContextDelivery(
  contextFiles: EmbeddedContextFile[],
  config?: WorkspaceContextConfig,
): WorkspaceContextDelivery {
  const inlineFiles: EmbeddedContextFile[] = [];
  const preambleFiles: EmbeddedContextFile[] = [];
  const offFiles: EmbeddedContextFile[] = [];
  for (const file of contextFiles) {
    const mode = resolveWorkspaceContextMode(file.path, config);
    if (mode === "preamble") {
      preambleFiles.push(file);
    } else if (mode === "off") {
      offFiles.push(file);
    } else {
      inlineFiles.push(file);
    }
  }
  return {
    inlineFiles,
    preambleFiles,
    offFiles,
    pointerPlacement: config?.pointer ?? DEFAULT_POINTER_PLACEMENT,
  };
}

/**
 * Build the pointer block listing withheld ("off") files by name so the model
 * knows they exist and can Read them on demand. Returns undefined when there are
 * no off files (nothing to point at).
 */
export function buildWorkspaceContextPointer(offFiles: EmbeddedContextFile[]): string | undefined {
  const names = offFiles.map((file) => normalizedBase(file.path)).filter((name) => name.length > 0);
  if (names.length === 0) {
    return undefined;
  }
  return [
    "## Workspace Files",
    `These files exist in your workspace and may hold relevant context: ${names.join(", ")}. ` +
      "Read them with your file tools when a task needs them.",
  ].join("\n");
}
