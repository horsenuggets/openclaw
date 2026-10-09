/**
 * In-box command policy.
 *
 * This fork keeps only commands it owns. Those (`/lifecycle`, `/channel`, `/secret`,
 * `/connections`) are handled host-side by the Discord router and never enter the
 * auto-reply pipeline, so the in-box pipeline enables nothing by default.
 *
 * A command that is not enabled here must behave exactly like an unknown `/word`: it is
 * not registered natively, not recognized as a text command, not parsed as an inline
 * directive, and not treated as an abort or reset trigger. It reaches the model as
 * ordinary text. Every command entry point consults this module instead of keeping its
 * own list, so enabling a key (for example `"stop"`) turns on all of its surfaces at
 * once.
 *
 * Keys are the `ChatCommandDefinition.key` values from the command registry. Per-skill
 * commands (`/<skill-name>`) are governed by the `"skill"` key.
 */

export const ENABLED_COMMAND_KEYS: ReadonlySet<string> = new Set<string>();

type CommandPolicy = ReadonlySet<string> | "all";

let policy: CommandPolicy = ENABLED_COMMAND_KEYS;

export function isCommandKeyEnabled(key: string): boolean {
  return policy === "all" || policy.has(key);
}

/** Identity of the active policy, so callers can memoize derived data per policy. */
export function getCommandPolicyIdentity(): CommandPolicy {
  return policy;
}

/** Test hook. Pass `null` to restore the shipped policy. */
export function setCommandPolicyForTest(next: CommandPolicy | null): void {
  policy = next ?? ENABLED_COMMAND_KEYS;
}
