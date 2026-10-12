import type { CommandResultState } from "./embed-categories.js";

/**
 * Resolve the `/debug ephemeral [on|off]` toggle into the message the router
 * renders. Shared by the slash handler and the text-command fallback so both
 * behave identically. Kept pure (no I/O): the caller reads the current value,
 * passes it in, and persists `newValue` when present.
 *
 * Every outcome is a Command Result (matching `/lifecycle`): the footer checkbox
 * reflects the resulting state. A bare `/debug ephemeral` (desired === null) is a
 * status query with no `newValue` to persist; an explicit on/off sets it.
 */

export type EphemeralCommandOutcome = {
  /** New value to persist, or undefined for a bare status query. */
  newValue?: boolean;
  description: string;
  state: CommandResultState;
};

const ON =
  "`/debug`, `/lifecycle`, and `/connections` replies in this channel will be ephemeral, visible only to the person who ran them (`/channel` and `/secret` are always ephemeral).";
const OFF =
  "`/debug`, `/lifecycle`, and `/connections` replies in this channel will be posted normally so they stay visible for everyone (`/channel` and `/secret` stay ephemeral).";

export function resolveEphemeralCommand(
  current: boolean,
  desired: boolean | null,
): EphemeralCommandOutcome {
  if (desired === null) {
    return {
      description: current
        ? "Ephemeral command replies are currently `enabled`. Use `/debug ephemeral off` to disable."
        : "Ephemeral command replies are currently `disabled`. Use `/debug ephemeral on` to enable.",
      state: current ? "enabled" : "disabled",
    };
  }
  if (desired) {
    return {
      newValue: true,
      description: current
        ? `Ephemeral command replies were already \`enabled\`, so nothing changed. ${ON}`
        : `Ephemeral command replies are now \`enabled\`. ${ON}`,
      state: "enabled",
    };
  }
  return {
    newValue: false,
    description: current
      ? `Ephemeral command replies are now \`disabled\`. ${OFF}`
      : `Ephemeral command replies were already \`disabled\`, so nothing changed. ${OFF}`,
    state: "disabled",
  };
}
