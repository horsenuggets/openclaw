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
 * gateway-events.ts gates on admin BEFORE deferring, then defers with the
 * channel's resolved ephemeral flag and renders the result. Authorized debug
 * output is ephemeral by default but honors the per-channel `ephemeralCommands`
 * preference (toggled by the `ephemeral` subcommand), so a channel set public via
 * `/debug ephemeral off` keeps results visible for inspection. Permission denials
 * stay ephemeral regardless.
 */

import type { DiscordEmbed, DiscordEmbedField } from "./channel-commands.js";
import {
  type ConnFlowScenario,
  CONNFLOW_SCENARIOS,
  getConnFlowScenario,
} from "./connflow-preview.js";
import { buildEmbed } from "./embed-categories.js";
import { sanitizeSecretName } from "./secret-command.js";
import { buildSubcommandHelpEmbeds } from "./subcommand-fields.js";

/** Upper bound for a user-echoed subcommand name in a notice embed. */
const MAX_ECHOED_NAME_CHARS = 64;
/** Discord message content limit; the `echo` output is clamped to it. */
const MAX_CONTENT_CHARS = 2000;

const HELP_TITLE = "Debug Subcommands";

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
 * case: "the raw text as an individual message"); `secret` asks the router to
 * hand the channel's agent a secret out-of-band (the `secrettest` case) exactly
 * like the `/secret` modal, so the router adapter owns that delivery + ack.
 */
export type DebugResult =
  | { kind: "embeds"; embeds: DiscordEmbed[]; attachments: string[] }
  | { kind: "content"; content: string }
  | { kind: "secret"; name: string; value: string }
  /**
   * The `ephemeral` toggle. `desired` is the requested value (true/false) or
   * null for a bare status query. The router owns the persistence and rendering
   * (it reads the current value, writes `desired`, and picks the embed), so this
   * module stays free of I/O.
   */
  | { kind: "ephemeral"; desired: boolean | null }
  /**
   * The `unregisterflow` preview. Asks the router to walk one posted message
   * through the unregister confirm -> interim -> final render states, mirroring the
   * real two-phase button, so the UX can be inspected without a live click.
   * `channelId` is an explicit target, or null to use the command's own channel.
   */
  | { kind: "unregisterflow"; channelId: string | null }
  /**
   * The `connflow` preview. Asks the router to run the real `/connections` handler
   * against a canned scenario (via `simulateConnFlow`) and send the Debug-skinned
   * embeds. `scenario` is the resolved scenario; `tokens` is the `/connections`
   * subcommand plus its args (e.g. `["add", "notion"]`).
   */
  | { kind: "connflow"; scenario: ConnFlowScenario; tokens: string[] };

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
 * Parse a plain-message `/debug ...` text command (tolerating a `//` prefix) into
 * the raw remainder passed to {@link runDebugCommand}. Returns null when the
 * message is not a `/debug` command at all, and the (possibly empty) remainder
 * string otherwise. This is the text-command sibling of the slash `command`
 * option, letting an automation/tester bot that cannot invoke slash commands
 * drive the admin debug console.
 */
export function parseDebugTextCommand(content: string): string | null {
  const match = content.trim().match(/^\/\/?debug\b\s*([\s\S]*)$/is);
  if (!match) {
    return null;
  }
  return match[1].trim();
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

/**
 * Build a single Debug-category notice embed as an embeds result. Title-less by
 * design: a `/debug` reply carries its identity in the Debug footer, so the
 * description alone says what happened.
 */
function debugNotice(description: string): DebugResult {
  const built = buildEmbed({ category: "debug", description });
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
 *
 * Delegates to the shared {@link buildSubcommandHelpEmbeds}: `/debug` and
 * `/connections` render their help through one builder so the structure never
 * diverges. Subcommands are sorted alphabetically here first (the shared helper
 * preserves input order, so the sort is the caller's job).
 */
export function buildDebugHelpEmbeds(subcommands: DebugSubcommand[]): {
  embeds: DiscordEmbed[];
  attachments: string[];
} {
  return buildSubcommandHelpEmbeds({
    category: "debug",
    title: HELP_TITLE,
    command: "/debug",
    entries: subcommands.toSorted((a, b) => a.name.localeCompare(b.name)),
  });
}

const echoSubcommand: DebugSubcommand = {
  name: "echo",
  usage: "echo <message>",
  description: "Sends the raw text as an individual message.",
  run: ({ args }) => {
    const message = args.join(" ");
    if (!message) {
      return debugNotice('Provide a message, for example `echo "hello world"`.');
    }
    return { kind: "content", content: clamp(message, MAX_CONTENT_CHARS) };
  },
};

const secretTestSubcommand: DebugSubcommand = {
  name: "secrettest",
  usage: "secrettest <secret-value> [secret-name]",
  description:
    "Hand this channel's agent a secret like `/secret`, but passed as plaintext so it stays visible in the channel (for testing purposes). Never use a real secret here; use `/secret` for anything sensitive.",
  run: ({ args }) => {
    // args[0] is the value, args[1] the optional name. A multi-word value must be
    // quoted (the tokenizer splits on whitespace), matching every other debug arg.
    const value = args[0] ?? "";
    if (!value) {
      return debugNotice(
        "Provide a value, for example `secrettest my-test-value my-name`. This is a " +
          "*testing* command » the value is sent as plaintext and stays visible in the channel, " +
          "so never pass anything truly sensitive (use `/secret` for that).",
      );
    }
    return { kind: "secret", name: sanitizeSecretName(args[1] ?? "", value), value };
  },
};

/** Tokens accepted as "turn ephemeral on" and "turn it off", respectively. */
const EPHEMERAL_ON_TOKENS = new Set(["on", "true", "enable", "enabled", "yes"]);
const EPHEMERAL_OFF_TOKENS = new Set(["off", "false", "disable", "disabled", "no"]);

/**
 * Interpret the argument to `ephemeral`: no argument is a status query
 * (`desired: null`), a recognized on/off token sets the value, and anything else
 * is invalid.
 */
export function resolveEphemeralArgs(
  args: string[],
): { desired: boolean | null } | { invalid: string } {
  const raw = args[0];
  if (raw === undefined || raw === "") {
    return { desired: null };
  }
  const token = raw.toLowerCase();
  if (EPHEMERAL_ON_TOKENS.has(token)) {
    return { desired: true };
  }
  if (EPHEMERAL_OFF_TOKENS.has(token)) {
    return { desired: false };
  }
  return { invalid: raw };
}

const ephemeralSubcommand: DebugSubcommand = {
  name: "ephemeral",
  usage: "ephemeral [on|off]",
  // [TODO] `/channel` does not need to be ephemeral. Fix this in a separate worktree and
  // remove this comment.
  description: "Set whether slash command replies are ephemeral or not.",
  run: ({ args }) => {
    const resolved = resolveEphemeralArgs(args);
    if ("invalid" in resolved) {
      return debugNotice(
        `\`${clamp(resolved.invalid, MAX_ECHOED_NAME_CHARS)}\` is not a valid setting. ` +
          "Use `ephemeral on`, `ephemeral off`, or `ephemeral` on its own to see the current status.",
      );
    }
    return { kind: "ephemeral", desired: resolved.desired };
  },
};

/** A Discord snowflake token (17-20 digits), for the optional channel argument. */
const SNOWFLAKE_RE = /^\d{17,20}$/;

// [TODO] Remove the ability to use a specified channel ID in a separate worktree, then
// remove this comment.
const unregisterFlowSubcommand: DebugSubcommand = {
  name: "unregisterflow",
  usage: "unregisterflow",
  description:
    "Preview the unregister flow (confirm → interim → final) in this channel, without actually unregistering anything.",
  run: ({ args }) => {
    const raw = args[0];
    if (raw !== undefined && raw !== "" && !SNOWFLAKE_RE.test(raw)) {
      return debugNotice(
        `\`${clamp(raw, MAX_ECHOED_NAME_CHARS)}\` is not a valid channel id. Pass a 17-20 digit id, or omit it to use this channel.`,
      );
    }
    return { kind: "unregisterflow", channelId: raw && raw !== "" ? raw : null };
  },
};

/**
 * The Debug-category usage notice: a short description plus a fenced usage block,
 * then one non-inline field per canned scenario (name `Scenario #<id>`, value the
 * scenario's one-line description). Driven by {@link CONNFLOW_SCENARIOS} so the
 * fields stay in sync with the catalog.
 */
function connFlowUsage(): DebugResult {
  const description =
    "Preview the `/connections` flow against canned data. Pick a scenario, then the " +
    "subcommand (and args) as if you were running `/connections`.\n" +
    "```sh\n" +
    "# Usage\n" +
    "/debug connflow <scenario> [subcommand] [args]\n" +
    "```";
  const fields: DiscordEmbedField[] = CONNFLOW_SCENARIOS.map((s) => ({
    name: `Scenario #${s.id}`,
    value: s.description,
  }));
  const built = buildEmbed({ category: "debug", description, fields });
  return { kind: "embeds", embeds: [built.embed], attachments: built.attachments };
}

const connFlowSubcommand: DebugSubcommand = {
  name: "connflow",
  usage: "connflow [scenario] [subcommand] [args]",
  description:
    "Preview the `/connections` flow against a canned scenario. Omit the scenario to list them.",
  run: ({ args }) => {
    const raw = args[0];
    if (raw === undefined || raw === "") {
      return connFlowUsage();
    }
    const id = Number(raw);
    const scenario = Number.isInteger(id) ? getConnFlowScenario(id) : null;
    if (!scenario) {
      return debugNotice(
        `\`${clamp(raw, MAX_ECHOED_NAME_CHARS)}\` is not a known connflow scenario. ` +
          "Run `/debug connflow` (no scenario) to list them.",
      );
    }
    return { kind: "connflow", scenario, tokens: args.slice(1) };
  },
};

const helpSubcommand: DebugSubcommand = {
  name: "help",
  usage: "help",
  description: "Displays this help message.",
  run: ({ subcommands }) => ({ kind: "embeds", ...buildDebugHelpEmbeds(subcommands) }),
};

/** Every registered `/debug` subcommand. */
export const DEBUG_SUBCOMMANDS: DebugSubcommand[] = [
  connFlowSubcommand,
  echoSubcommand,
  ephemeralSubcommand,
  secretTestSubcommand,
  unregisterFlowSubcommand,
  helpSubcommand,
];

/**
 * Parse and run a `/debug` command string. An empty string or `help` prints the
 * help embed; an unknown subcommand returns a Debug-category notice pointing at
 * `help`. The returned {@link DebugResult} is rendered by the router, ephemerally
 * by default but honoring the channel's `ephemeralCommands` preference (a channel
 * set public via `/debug ephemeral off` sees results in-channel).
 */
export function runDebugCommand(input: string): DebugResult {
  const { subcommand, args } = parseDebugCommand(input);
  if (!subcommand || subcommand === "help") {
    return helpSubcommand.run({ args, subcommands: DEBUG_SUBCOMMANDS });
  }
  const match = DEBUG_SUBCOMMANDS.find((sub) => sub.name === subcommand);
  if (!match) {
    return debugNotice(
      `There is no \`${clamp(subcommand, MAX_ECHOED_NAME_CHARS)}\` subcommand. ` +
        "Run `/debug help` to see everything available.",
    );
  }
  return match.run({ args, subcommands: DEBUG_SUBCOMMANDS });
}
