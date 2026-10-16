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

import type { DiscordEmbed, DiscordEmbedField } from "./channel-commands.js";
import type { EmbedCategoryKey } from "./embed-categories.js";
import { MAX_FIELD_NAME_CHARS, MAX_FIELD_VALUE_CHARS } from "./embed-limits.js";
import { buildPaginatedEmbeds } from "./embed-pagination.js";

/** One subcommand entry: its ``usage`` (sans prefix) and one-line description. */
export interface SubcommandEntry {
  usage: string;
  description: string;
}

/**
 * The shared "subcommand help" description sentence, parameterized by the command
 * name (e.g. `/debug` or `/connections`). Both the `/debug` and `/connections`
 * help embeds open with this exact sentence, so it lives here once rather than as a
 * duplicated literal in each command module.
 */
export function subcommandHelpDescription(command: string): string {
  return `Below are all of the currently-registered subcommands under the \`${command}\` command...`;
}

/** The truncation note appended when a help embed overruns Discord's message budget. */
const HELP_TRUNCATION_FIELD: DiscordEmbedField = {
  name: "...",
  value: "Some subcommands were omitted because the list exceeded Discord's message limit.",
};

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

/**
 * Build a command's "subcommand help" embed(s): a title (`"<X> Subcommands"`), the
 * shared {@link subcommandHelpDescription} sentence as the description, and one field
 * per `entries` (rendered via {@link buildSubcommandFields} with `command` as the
 * prefix). Fields pack via {@link buildPaginatedEmbeds} honoring Discord's 25-field,
 * 6000-char, and 10-embed caps, with the help truncation note appended if the budget
 * is exhausted. Input order is preserved, so callers that want an alphabetical list
 * (like `/debug`) sort their entries before calling. Both `/debug` and `/connections`
 * render their help through this one helper so their structure never diverges.
 */
export function buildSubcommandHelpEmbeds(input: {
  category: EmbedCategoryKey;
  title: string;
  command: string;
  entries: readonly SubcommandEntry[];
}): { embeds: DiscordEmbed[]; attachments: string[] } {
  const fields = buildSubcommandFields(input.command, input.entries);
  return buildPaginatedEmbeds({
    category: input.category,
    title: input.title,
    description: subcommandHelpDescription(input.command),
    groups: [fields],
    truncationField: HELP_TRUNCATION_FIELD,
  });
}
