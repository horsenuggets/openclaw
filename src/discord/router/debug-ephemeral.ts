import type { CommandResultState } from "./embed-categories.js";

/**
 * Resolve the `/debug ephemeral [on|off]` toggle into the message the router
 * renders. Shared by the slash handler and the text-command fallback so both
 * behave identically. Kept pure (no I/O): the caller reads the current value,
 * passes it in, and persists `newValue` when present.
 *
 * A bare `/debug ephemeral` (desired === null) is a status query, rendered as a
 * plain Log message. An explicit on/off is a toggle, rendered as a Command
 * Result embed whose footer checkbox reflects the new state.
 */

export type EphemeralCommandOutcome =
  | { kind: "status"; description: string }
  | { kind: "set"; newValue: boolean; description: string; state: CommandResultState };

const ON =
  "Command replies in this channel will be ephemeral, visible only to the person who ran them.";
const OFF =
  "Command replies in this channel will be posted normally so they stay visible for everyone.";

export function resolveEphemeralCommand(
  current: boolean,
  desired: boolean | null,
): EphemeralCommandOutcome {
  if (desired === null) {
    return {
      kind: "status",
      description: current
        ? "Ephemeral command replies are currently `enabled`. Use `/debug ephemeral off` to disable."
        : "Ephemeral command replies are currently `disabled`. Use `/debug ephemeral on` to enable.",
    };
  }
  if (desired) {
    return {
      kind: "set",
      newValue: true,
      description: current
        ? `Ephemeral command replies are already \`enabled\`. ${ON}`
        : `Ephemeral command replies are now \`enabled\`. ${ON}`,
      state: "enabled",
    };
  }
  return {
    kind: "set",
    newValue: false,
    description: current
      ? `Ephemeral command replies are now \`disabled\`. ${OFF}`
      : `Ephemeral command replies are already \`disabled\`. ${OFF}`,
    state: "disabled",
  };
}
