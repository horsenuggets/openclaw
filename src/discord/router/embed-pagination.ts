/**
 * Shared multi-embed builder. Several commands render a list that can outgrow a
 * single Discord embed (the `/debug help` subcommand list, the `/connections list`
 * status) and must split across embeds honoring Discord's caps (see
 * embed-limits.ts): at most 25 fields per embed and 10 embeds per message, with
 * the combined text of ALL embeds under 6000 characters. This module centralizes
 * that packing so each caller only supplies its fields.
 *
 * Fields are supplied as ordered GROUPS. Every group after the first starts a new
 * embed (a forced section break), so a caller can keep, say, a header block on the
 * first embed and the list body on the next. Within a group, fields pack onto the
 * current embed until the 25-field cap, then spill onto a further embed (though the
 * shared 6000-char message budget usually bites first). The first embed carries the
 * title and description, the last carries the footer/icon/timestamp, every embed
 * shares the category color, and a truncation note is appended if the content
 * exhausts the message budget or the embed count. Every field is clamped to the
 * per-field name/value caps so a caller can never emit a payload Discord rejects.
 */

import type { DiscordEmbed, DiscordEmbedField } from "./channel-commands.js";
import { type EmbedCategoryKey, EMBED_CATEGORIES, attachmentRef } from "./embed-categories.js";
import {
  MAX_EMBEDS_PER_MESSAGE,
  MAX_FIELD_NAME_CHARS,
  MAX_FIELD_VALUE_CHARS,
  MAX_FIELDS_PER_EMBED,
  MAX_MESSAGE_TOTAL_CHARS,
} from "./embed-limits.js";

/** One ordered run of fields. Each group after the first begins a new embed. */
export type EmbedFieldGroup = DiscordEmbedField[];

const DEFAULT_TRUNCATION_FIELD: DiscordEmbedField = {
  name: "\u2026",
  value: "Some entries were omitted because the list exceeded Discord's message limit.",
};

/** Clamp `text` to `max`, replacing the trailing character with an ellipsis. */
function clampWithEllipsis(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}

/** Clamp a field's name/value to Discord's per-field caps so it is always valid. */
function clampField(field: DiscordEmbedField): DiscordEmbedField {
  const name = clampWithEllipsis(field.name, MAX_FIELD_NAME_CHARS);
  const value = clampWithEllipsis(field.value, MAX_FIELD_VALUE_CHARS);
  return name === field.name && value === field.value ? field : { ...field, name, value };
}

/**
 * Pack `groups` of fields into category-styled embeds. Returns the embeds plus the
 * single icon filename the footer-bearing last embed references.
 */
export function buildPaginatedEmbeds(input: {
  category: EmbedCategoryKey;
  title?: string;
  description?: string;
  groups: EmbedFieldGroup[];
  /** Field appended when packing stops early; defaults to a generic note. */
  truncationField?: DiscordEmbedField;
}): { embeds: DiscordEmbed[]; attachments: string[] } {
  const category = EMBED_CATEGORIES[input.category];
  const title = input.title ?? "";
  const description = input.description ?? "";

  // Clamp the truncation note to the per-field caps up front so, if appended, it can
  // never breach the 1024/256 field caps itself.
  const truncationField = clampField(input.truncationField ?? DEFAULT_TRUNCATION_FIELD);
  const noteCost = truncationField.name.length + truncationField.value.length;

  // `used` tracks the whole message cost (title + description + footer appear once),
  // so it is never reset per page. We pack against the FULL 6000-char limit, not a
  // pre-reserved budget: content that fits exactly is never needlessly dropped. Only
  // when a field genuinely does not fit (or an embed/field cap is hit) do we flip
  // `truncated` and, below, pop enough trailing content to make room for the note.
  const pages: DiscordEmbedField[][] = [[]];
  let used = title.length + description.length + category.footerText.length;
  let truncated = false;

  for (let g = 0; g < input.groups.length && !truncated; g += 1) {
    const group = input.groups[g];
    if (group.length === 0) {
      continue;
    }
    // Force every non-first group onto its own embed, unless the current page is
    // still empty (e.g. a preceding group was empty), to avoid a blank embed.
    if (g > 0 && pages[pages.length - 1].length > 0) {
      if (pages.length >= MAX_EMBEDS_PER_MESSAGE) {
        truncated = true;
        break;
      }
      pages.push([]);
    }
    for (const rawField of group) {
      // Clamp each field to the per-field caps before measuring/pushing, so a caller
      // cannot emit a field that breaches the 1024/256 caps and gets the payload
      // rejected; `used` then tracks the real (clamped) message cost against 6000.
      const field = clampField(rawField);
      const cost = field.name.length + field.value.length;
      if (used + cost > MAX_MESSAGE_TOTAL_CHARS) {
        truncated = true;
        break;
      }
      let page = pages[pages.length - 1];
      if (page.length >= MAX_FIELDS_PER_EMBED) {
        if (pages.length >= MAX_EMBEDS_PER_MESSAGE) {
          truncated = true;
          break;
        }
        page = [];
        pages.push(page);
      }
      page.push(field);
      used += cost;
    }
  }

  if (truncated) {
    // Make room for the note: pop trailing fields until it fits the 6000 budget AND
    // the last embed is under the 25-field cap. Each pop decrements `used` so the
    // final appended message is always valid.
    let last = pages[pages.length - 1];
    while (
      last.length > 0 &&
      (used + noteCost > MAX_MESSAGE_TOTAL_CHARS || last.length >= MAX_FIELDS_PER_EMBED)
    ) {
      const dropped = last.pop();
      if (dropped) {
        used -= dropped.name.length + dropped.value.length;
      }
      // Drop a now-empty trailing page (never the first) so the note lands on a page
      // that still has room for it.
      if (last.length === 0 && pages.length > 1) {
        pages.pop();
        last = pages[pages.length - 1];
      }
    }
    last.push(truncationField);
  }

  const lastIndex = pages.length - 1;
  const embeds: DiscordEmbed[] = pages.map((pageFields, index) => {
    const embed: DiscordEmbed = { color: category.color };
    if (index === 0) {
      if (title) {
        embed.title = title;
      }
      if (description) {
        embed.description = description;
      }
    }
    if (pageFields.length > 0) {
      embed.fields = pageFields;
    }
    if (index === lastIndex) {
      embed.footer = { text: category.footerText, icon_url: attachmentRef(category.icon) };
      embed.timestamp = new Date().toISOString();
    }
    return embed;
  });

  return { embeds, attachments: [category.icon] };
}

/**
 * Split `lines` into as many fields (all sharing `name`) as the per-field value cap
 * requires, so a long single-column list (e.g. the connections Services column) can
 * span several repeated-header fields. A line longer than `max` on its own is
 * truncated with an ellipsis to fit rather than dropped, so every returned field
 * value stays within `max` and the payload is never rejected by Discord.
 */
export function chunkLinesIntoFields(
  name: string,
  lines: string[],
  max: number = MAX_FIELD_VALUE_CHARS,
): DiscordEmbedField[] {
  const fields: DiscordEmbedField[] = [];
  let current: string[] = [];
  let length = 0;
  for (const rawLine of lines) {
    // Clamp any single over-long line so one line can never breach the field cap.
    const line =
      rawLine.length > max ? `${rawLine.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026` : rawLine;
    const addition = current.length === 0 ? line.length : line.length + 1; // +1 for the newline
    if (current.length > 0 && length + addition > max) {
      fields.push({ name, value: current.join("\n") });
      current = [];
      length = 0;
    }
    current.push(line);
    length += current.length === 1 ? line.length : line.length + 1;
  }
  if (current.length > 0) {
    fields.push({ name, value: current.join("\n") });
  }
  return fields;
}
