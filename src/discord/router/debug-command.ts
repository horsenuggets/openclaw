/**
 * `/debug` command: an admin-only console for inspecting and poking the bot's
 * internal state. Unlike the normal Discord slash commands, every debug action
 * is a SUBCOMMAND entered as free text into the single `command` option (for
 * example `echo "hello world"`), parsed here by our own small command-string
 * parser. Keeping the subcommands behind one opaque text field (rather than
 * registering each as a real Discord slash command) means we can add internal
 * debugging tools freely without exposing them to regular users in the slash
 * command picker.
 *
 * This module performs no Discord I/O: it only parses the command string, runs
 * the matched subcommand, and returns a {@link DebugResult} describing what to
 * reply with. That result is still Discord-shaped, though (embed payloads and
 * attachment names, or raw message content). The router adapter in
 * gateway-events.ts gates on admin, defers the interaction ephemerally, and
 * renders the result. Everything the command produces is delivered ephemerally,
 * so debug output never leaks to the channel.
 */

import type { DiscordEmbed, DiscordEmbedField } from "./channel-commands.js";
import { EMBED_CATEGORIES, attachmentRef, buildEmbed } from "./embed-categories.js";

/** Discord embed limits the help overflow must respect. */
const MAX_FIELDS_PER_EMBED = 25;
/**
 * Discord caps the combined text of ALL embeds in one message at 6000
 * characters (title + description + every field name/value + footer text), not
 * per embed, and allows at most 10 embeds. Overflowing to more embeds only buys
 * room past the 25-field-per-embed cap; it does not raise this message-wide
 * budget. Packing stops at whichever limit comes first and appends a truncation
 * note so an oversized registry still renders instead of 400-ing.
 */
const MAX_MESSAGE_TOTAL_CHARS = 6000;
const MAX_EMBEDS_PER_MESSAGE = 10;
/** Characters reserved from the message budget for the truncation note. */
const TRUNCATION_RESERVE = 160;
const MAX_FIELD_NAME_CHARS = 256;
const MAX_FIELD_VALUE_CHARS = 1024;
/** Upper bound for a user-echoed subcommand name in a notice embed. */
const MAX_ECHOED_NAME_CHARS = 64;
/** Discord message content limit; the `echo` output is clamped to it. */
const MAX_CONTENT_CHARS = 2000;

const HELP_TITLE = "Debug Subcommands";
const HELP_DESCRIPTION =
  "Below are all of the currently-registered subcommands under the `/debug` command...";
const TRUNCATION_FIELD: DiscordEmbedField = {
  name: "...",
  value: "Some subcommands were omitted because the list exceeded Discord's message limit.",
};

/** Slash-command registration body for Discord. */
export const DEBUG_COMMAND_SPEC = {
  name: "debug",
  description:
    "Admin only: run an internal debug subcommand (omit the input or pass help for a list).",
  type: 1, // CHAT_INPUT
  // Usable in guilds (0), bot DMs (1), and group DMs (2): access is gated purely
  // on the caller's admin identity, not on the channel, so any surface is fine.
  contexts: [0, 1, 2],
  options: [
    {
      name: "command",
      description: 'The debug command to run, e.g. echo "hello world" (omit for help).',
      type: 3, // STRING
      required: false,
      max_length: MAX_CONTENT_CHARS,
    },
  ],
};

/**
 * What a subcommand wants the router to reply with. `embeds` carries one or more
 * category embeds plus the icon filenames they reference (uploaded by the
 * sender); `content` carries raw message text with no embed wrapper (the `echo`
 * case: "the raw text as an individual message").
 */
export type DebugResult =
  | { kind: "embeds"; embeds: DiscordEmbed[]; attachments: string[] }
  | { kind: "content"; content: string };

/** Inputs handed to a subcommand's `run`. */
export type DebugRunContext = {
  /** Positional arguments after the subcommand name, quote-aware. */
  args: string[];
  /** The full registry, so `help` can enumerate every subcommand. */
  subcommands: DebugSubcommand[];
};

/** A single `/debug` subcommand. */
export type DebugSubcommand = {
  /** Lowercase name matched against the first parsed token. */
  name: string;
  /** Usage signature shown (backtick-wrapped) as the help field name. */
  usage: string;
  /** One-line description shown as the help field value. */
  description: string;
  run: (ctx: DebugRunContext) => DebugResult;
};

/** Truncate `text` to `max` characters, appending an ellipsis when clipped. */
function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/**
 * Tokenize a debug command string into whitespace-separated tokens, treating
 * single- or double-quoted spans as one token so `echo "hello world"` yields
 * `["echo", "hello world"]`. Quotes are stripped; there is no escape syntax
 * (debug input is simple and admin-only). An unterminated quote runs to the end
 * of the string.
 */
export function tokenizeDebugCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  // Tracks whether `current` holds a token (so `""` yields an empty-string token
  // rather than being dropped as if no token were present).
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Parse a debug command string into its subcommand (first token, lowercased) and
 * the remaining arguments. An empty or whitespace-only string yields a null
 * subcommand (treated as `help` by {@link runDebugCommand}).
 */
export function parseDebugCommand(input: string): { subcommand: string | null; args: string[] } {
  const tokens = tokenizeDebugCommand(input ?? "");
  if (tokens.length === 0) {
    return { subcommand: null, args: [] };
  }
  return { subcommand: tokens[0].toLowerCase(), args: tokens.slice(1) };
}

/**
 * A short, log-safe label for a debug command. Only ever a registered
 * subcommand name (fixed, control-char-free strings), `(help)` for empty input,
 * or `(unknown)` for anything unrecognized. Crucially, unrecognized input is NOT
 * echoed into the log: an admin who accidentally pastes a credential as the
 * command does not match a registered name, so the raw value never persists.
 */
export function debugSubcommandLabel(input: string): string {
  const { subcommand } = parseDebugCommand(input);
  if (!subcommand) {
    return "(help)";
  }
  return DEBUG_SUBCOMMANDS.some((sub) => sub.name === subcommand) ? subcommand : "(unknown)";
}

/** Build a single Debug-category notice embed as an embeds result. */
function debugNotice(title: string, description: string): DebugResult {
  const built = buildEmbed({ category: "debug", title, description });
  return { kind: "embeds", embeds: [built.embed], attachments: built.attachments };
}

/**
 * Build the `/debug help` embed(s). Subcommands are listed alphabetically, one
 * field each (``usage`` as the name, description as the value). Fields pack into
 * as few embeds as needed: an embed holds at most 25 fields, and the whole
 * message is capped at Discord's shared 6000-character budget (title +
 * description + every field + footer) across at most 10 embeds. Once a field
 * would breach the message budget or the embed count, packing stops and a final
 * truncation note is appended, so an oversized registry still renders rather
 * than being rejected. The first embed carries the title and description, middle
 * embeds carry only fields, and the last embed carries the footer and timestamp.
 * Every embed shares the category color, and only the footer-bearing last embed
 * references the icon, so one attachment is returned.
 */
export function buildDebugHelpEmbeds(subcommands: DebugSubcommand[]): {
  embeds: DiscordEmbed[];
  attachments: string[];
} {
  const category = EMBED_CATEGORIES.debug;
  const fields: DiscordEmbedField[] = subcommands
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((sub) => ({
      name: clamp(`\`${sub.usage}\``, MAX_FIELD_NAME_CHARS),
      value: clamp(sub.description, MAX_FIELD_VALUE_CHARS),
    }));

  // Pack fields across pages against the shared message budget. `used` counts
  // the whole message (title + description + footer appear once), so it is never
  // reset per page. A fixed slice is reserved up front for the truncation note
  // so there is always room to append it if we stop early.
  const pages: DiscordEmbedField[][] = [[]];
  let used = HELP_TITLE.length + HELP_DESCRIPTION.length + category.footerText.length;
  const budget = MAX_MESSAGE_TOTAL_CHARS - TRUNCATION_RESERVE;
  let truncated = false;
  for (const field of fields) {
    const cost = field.name.length + field.value.length;
    if (used + cost > budget) {
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

  if (truncated) {
    const last = pages[pages.length - 1];
    // Replace the final field when the last embed is already full, so appending
    // the note never pushes the embed past the 25-field cap.
    if (last.length >= MAX_FIELDS_PER_EMBED) {
      last.pop();
    }
    last.push(TRUNCATION_FIELD);
  }

  const lastIndex = pages.length - 1;
  const embeds: DiscordEmbed[] = pages.map((pageFields, index) => {
    const embed: DiscordEmbed = { color: category.color };
    if (index === 0) {
      embed.title = HELP_TITLE;
      embed.description = HELP_DESCRIPTION;
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

const echoSubcommand: DebugSubcommand = {
  name: "echo",
  usage: "echo <message>",
  description: "Sends the raw text as an individual message.",
  run: ({ args }) => {
    const message = args.join(" ");
    if (!message) {
      return debugNotice("Nothing to Echo", 'Provide a message, for example `echo "hello world"`.');
    }
    return { kind: "content", content: clamp(message, MAX_CONTENT_CHARS) };
  },
};

const helpSubcommand: DebugSubcommand = {
  name: "help",
  usage: "help",
  description: "Prints this help message.",
  run: ({ subcommands }) => ({ kind: "embeds", ...buildDebugHelpEmbeds(subcommands) }),
};

/** Every registered `/debug` subcommand. */
export const DEBUG_SUBCOMMANDS: DebugSubcommand[] = [echoSubcommand, helpSubcommand];

/**
 * Parse and run a `/debug` command string. An empty string or `help` prints the
 * help embed; an unknown subcommand returns a Debug-category notice pointing at
 * `help`. The returned {@link DebugResult} is rendered ephemerally by the router.
 */
export function runDebugCommand(input: string): DebugResult {
  const { subcommand, args } = parseDebugCommand(input);
  if (!subcommand || subcommand === "help") {
    return helpSubcommand.run({ args, subcommands: DEBUG_SUBCOMMANDS });
  }
  const match = DEBUG_SUBCOMMANDS.find((sub) => sub.name === subcommand);
  if (!match) {
    return debugNotice(
      "Unknown Subcommand",
      `There is no \`${clamp(subcommand, MAX_ECHOED_NAME_CHARS)}\` subcommand. ` +
        "Run `/debug help` to see everything available.",
    );
  }
  return match.run({ args, subcommands: DEBUG_SUBCOMMANDS });
}
