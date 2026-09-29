/**
 * system-reminder
 *
 * Shared marker for system-injected conversation turns. OpenClaw injects several
 * synthetic turns that are NOT the human speaking — the persona preamble, the
 * heartbeat prompt, tool-relay results, first-run bootstrap. Wrapping them in
 * `<system-reminder>…</system-reminder>` does double duty: the model treats the
 * block as system-injected context (not words its human typed), and the
 * transcript classifier can attribute the turn as `system` rather than `user`.
 *
 * This is the shared source of truth for the marker so the write-site that
 * produces it here (the heartbeat) and the classifier that reads it can never
 * drift apart. Other pre-existing writers (`turns.ts`, the persona preamble)
 * still inline the literal and are being migrated onto this helper separately.
 */

export const SYSTEM_REMINDER_OPEN = "<system-reminder>";
export const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

/** Wrap text as a system-reminder block (the form the classifier recognizes). */
export function wrapSystemReminder(text: string): string {
  return `${SYSTEM_REMINDER_OPEN}\n${text}\n${SYSTEM_REMINDER_CLOSE}`;
}

/**
 * True when text is ENTIRELY a system-reminder block — i.e. a fully
 * system-injected turn (a wrapped heartbeat/tool-relay prompt), not a real human
 * message. Text that merely STARTS with a reminder but has trailing human content
 * (e.g. a persona preamble prepended to a real user turn) is a genuine user turn
 * and returns false.
 */
export function isSystemReminder(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith(SYSTEM_REMINDER_OPEN) &&
    trimmed.endsWith(SYSTEM_REMINDER_CLOSE) &&
    trimmed.length > SYSTEM_REMINDER_OPEN.length + SYSTEM_REMINDER_CLOSE.length
  );
}
