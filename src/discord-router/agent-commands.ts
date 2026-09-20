/**
 * Agent control-command channel.
 *
 * The agent has no way to emit Discord embeds or buttons directly (its gateway
 * replies are plain text). So it triggers host-side actions with a control
 * command: a message that starts with the four dot marker `⁘` (U+2058) followed
 * by a space. A message that is a command is NOT shown to the user; the router
 * runs it and replies to the agent with the result.
 *
 * A normal message that genuinely starts with `⁘` is escaped with a leading
 * backslash (`\⁘`), which renders as `⁘` and is not treated as a command.
 */

/** The command marker: FOUR DOT PUNCTUATION (U+2058). */
export const COMMAND_MARKER = "\u2058";
/** A command message starts with the marker followed by a single space. */
export const COMMAND_PREFIX = `${COMMAND_MARKER} `;

export type AgentCommand = {
  command: string;
  args: string[];
};

/**
 * Parse an agent message as a control command. Returns the command and its
 * arguments when the message begins with an unescaped `⁘ `, otherwise null
 * (meaning it is a normal message to render).
 */
export function parseAgentCommand(rawText: string): AgentCommand | null {
  const text = rawText.trim();
  if (!text.startsWith(COMMAND_PREFIX)) {
    return null;
  }
  const rest = text.slice(COMMAND_PREFIX.length);
  const tokens = tokenize(rest);
  if (tokens.length === 0) {
    return null;
  }
  return { command: tokens[0], args: tokens.slice(1) };
}

/**
 * Unescape a normal (non-command) agent message for rendering. Only the leading
 * run of backslashes before a `⁘` is affected: pairs of backslashes collapse to
 * one, and a single escaping backslash before the marker is consumed. So `\⁘`
 * renders as `⁘`, `\\⁘` renders as `\⁘`, and so on. Text that is not a
 * leading-escaped marker is returned unchanged.
 */
export function unescapeAgentText(rawText: string): string {
  const match = rawText.match(/^(\\+)\u2058/);
  if (!match) {
    return rawText;
  }
  const backslashes = match[1].length;
  const kept = "\\".repeat(Math.floor(backslashes / 2));
  return kept + COMMAND_MARKER + rawText.slice(match[0].length);
}

/**
 * Shell-style tokenizer: whitespace-separated tokens, with double-quoted spans
 * that preserve spaces and support `\"` (literal quote) and `\\` (literal
 * backslash) inside the quotes.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        current += input[i + 1];
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}
