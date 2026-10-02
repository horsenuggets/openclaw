// Silent-reply token. This is the `⁘ return` control command (marker U+2058 +
// " return"): on the Discord router it is a host-side no-op command, and on every
// other channel the auto-reply path detects it here and suppresses the message
// pre-send. One token means a single silent-reply convention across all channels.
export const SILENT_REPLY_TOKEN = "\u2058 return";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isSilentReplyText(
  text: string | undefined,
  token: string = SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  const escaped = escapeRegExp(token);
  const prefix = new RegExp(`^\\s*${escaped}(?=$|\\W)`);
  if (prefix.test(text)) {
    return true;
  }
  // Trailing token: allow the token at the very end of the text, preceded by
  // start-of-string or any whitespace. We cannot rely on a leading `\b` word
  // boundary because the token may begin with a non-word marker (e.g. `⁘`),
  // which never forms a boundary against a preceding space and would miss cases
  // like `note ⁘ return`.
  const suffix = new RegExp(`(?:^|\\s)${escaped}\\W*$`);
  return suffix.test(text);
}
