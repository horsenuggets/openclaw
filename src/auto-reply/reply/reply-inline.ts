import { isCommandKeyEnabled } from "../command-policy.js";

// Inline alias -> [canonical command, policy key].
const INLINE_SIMPLE_COMMAND_ALIASES = new Map<string, readonly [string, string]>([
  ["help", ["/help", "help"]],
  ["commands", ["/commands", "commands"]],
  ["whoami", ["/whoami", "whoami"]],
  ["id", ["/whoami", "whoami"]],
]);

const INLINE_STATUS_RE = /(?:^|\s)\/status(?=$|\s|:)(?:\s*:\s*)?/gi;

export function extractInlineSimpleCommand(body?: string): {
  command: string;
  cleaned: string;
} | null {
  if (!body) {
    return null;
  }
  // A disabled command must stay in the prompt untouched, exactly like an unknown "/word".
  const enabled = [...INLINE_SIMPLE_COMMAND_ALIASES]
    .filter(([, [, key]]) => isCommandKeyEnabled(key))
    .map(([alias]) => alias);
  if (enabled.length === 0) {
    return null;
  }
  const match = body.match(new RegExp(`(?:^|\\s)/(${enabled.join("|")})(?=$|\\s|:)`, "i"));
  if (!match || match.index === undefined) {
    return null;
  }
  const command = INLINE_SIMPLE_COMMAND_ALIASES.get(match[1].toLowerCase())?.[0];
  if (!command) {
    return null;
  }
  const cleaned = body.replace(match[0], " ").replace(/\s+/g, " ").trim();
  return { command, cleaned };
}

export function stripInlineStatus(body: string): {
  cleaned: string;
  didStrip: boolean;
} {
  const trimmed = body.trim();
  if (!trimmed) {
    return { cleaned: "", didStrip: false };
  }
  const cleaned = trimmed.replace(INLINE_STATUS_RE, " ").replace(/\s+/g, " ").trim();
  return { cleaned, didStrip: cleaned !== trimmed };
}
