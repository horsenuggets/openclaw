/**
 * Diff formatting utilities for tool result display.
 *
 * formatTextDiff  – line-level diff for Edit tool (old_string vs
 *                   new_string)
 * formatConfigDiff – flat key-path diff for Gateway config changes
 */

// Keys that change on every config write and are pure noise in
// diffs.
const IGNORED_CONFIG_PREFIXES = ["meta.lastTouchedVersion", "meta.lastTouchedAt"];

function shouldIgnoreConfigKey(path: string): boolean {
  return IGNORED_CONFIG_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix + "."));
}

// -- Text diff (Edit tool) --------------------------------------------------

/**
 * Produce a simple line-level diff between two text snippets.
 * Old lines are prefixed with `- `, new lines with `+ `.
 *
 * Returns `undefined` when both texts are identical.
 */
export function formatTextDiff(oldText: string, newText: string): string | undefined {
  if (oldText === newText) {
    return undefined;
  }
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lines: string[] = [];
  for (const line of oldLines) {
    lines.push(`- ${line}`);
  }
  for (const line of newLines) {
    lines.push(`+ ${line}`);
  }
  return lines.join("\n");
}

// -- Config diff (Gateway tool) ----------------------------------------------

/**
 * Flatten a nested object to dot-delimited key paths.
 * Arrays are kept as serialised JSON strings rather than
 * recursed into, so the diff stays compact.
 */
function flattenObject(
  obj: unknown,
  prefix: string,
  result: Map<string, unknown>,
): Map<string, unknown> {
  if (obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
    result.set(prefix, obj);
    return result;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = record[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      flattenObject(value, fullKey, result);
    } else {
      result.set(fullKey, value);
    }
  }
  return result;
}

/** Format a value concisely for display in a single diff line. */
function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const json = JSON.stringify(value);
  return json.length > 60 ? `${json.slice(0, 57)}...` : json;
}

type DiffEntry = {
  path: string;
  kind: "added" | "removed" | "changed";
  oldValue?: unknown;
  newValue?: unknown;
};

/**
 * Compute a flat diff between two config objects.
 */
export function computeConfigDiff(oldConfig: unknown, newConfig: unknown): DiffEntry[] {
  const oldFlat = flattenObject(oldConfig, "", new Map());
  const newFlat = flattenObject(newConfig, "", new Map());
  const entries: DiffEntry[] = [];

  for (const [path, oldValue] of oldFlat) {
    if (shouldIgnoreConfigKey(path)) continue;
    if (!newFlat.has(path)) {
      entries.push({ path, kind: "removed", oldValue });
    } else {
      const newValue = newFlat.get(path);
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        entries.push({ path, kind: "changed", oldValue, newValue });
      }
    }
  }

  for (const [path, newValue] of newFlat) {
    if (shouldIgnoreConfigKey(path)) continue;
    if (!oldFlat.has(path)) {
      entries.push({ path, kind: "added", newValue });
    }
  }

  return entries;
}

/**
 * Format a config diff as Discord-compatible diff lines.
 *
 * Example output:
 *   - models.subscription: "pro"
 *   + models.subscription: "cli"
 *   + channels.discord.verbose: true
 *
 * Returns `undefined` when configs are identical (no
 * user-visible changes).
 */
export function formatConfigDiff(oldConfig: unknown, newConfig: unknown): string | undefined {
  const entries = computeConfigDiff(oldConfig, newConfig);
  if (entries.length === 0) return undefined;

  const lines: string[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "changed":
        lines.push(`- ${entry.path}: ${formatValue(entry.oldValue)}`);
        lines.push(`+ ${entry.path}: ${formatValue(entry.newValue)}`);
        break;
      case "removed":
        lines.push(`- ${entry.path}: ${formatValue(entry.oldValue)}`);
        break;
      case "added":
        lines.push(`+ ${entry.path}: ${formatValue(entry.newValue)}`);
        break;
    }
  }
  return lines.join("\n");
}
