/**
 * Shared rendering of a command's subcommand list as Discord embed fields. Both
 * the `/debug help` embed and the `/connections` subcommand previews list a
 * command's subcommands one field each: a backtick-wrapped ``<prefix> <usage>``
 * name and the subcommand's one-line description as the value. This module owns
 * that single-field shape so the two call sites stay byte-for-byte identical
 * without duplicating the formatting (and clamping) logic.
 *
 * Sorting is intentionally the caller's responsibility: `/debug` lists its
 * subcommands alphabetically, while `/connections` keeps a fixed authored order
 * (add before remove). The helper therefore preserves input order and leaves any
 * sort to the caller, so both behaviors are expressible without an extra option.
 */

import type { DiscordEmbedField } from "./channel-commands.js";
import { MAX_FIELD_NAME_CHARS, MAX_FIELD_VALUE_CHARS } from "./embed-limits.js";

/** One subcommand entry: its ``usage`` (sans prefix) and one-line description. */
export interface SubcommandEntry {
  usage: string;
  description: string;
}

/** Truncate `text` to `max` characters, appending an ellipsis when clipped. */
function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/**
 * Map subcommand `entries` to one {@link DiscordEmbedField} each: the name is the
 * backtick-wrapped ``<prefix> <usage>`` clamped to the field-name cap, and the
 * value is the description clamped to the field-value cap. Input order is
 * preserved (the caller sorts if it wants to), so an empty list yields an empty
 * array.
 */
export function buildSubcommandFields(
  prefix: string,
  entries: readonly SubcommandEntry[],
): DiscordEmbedField[] {
  return entries.map((entry) => ({
    name: clamp(`\`${prefix} ${entry.usage}\``, MAX_FIELD_NAME_CHARS),
    value: clamp(entry.description, MAX_FIELD_VALUE_CHARS),
  }));
}
