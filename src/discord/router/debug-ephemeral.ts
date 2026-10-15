import type { CommandResultState } from "./embed-categories.js";

/**
 * Resolve the `/debug ephemeral [on|off]` toggle into the message the router
 * renders. Shared by the slash handler and the text-command fallback so both
 * behave identically. Kept pure (no I/O): the caller reads the current value,
 * passes it in, and persists `newValue` when present.
 *
 * A bare `/debug ephemeral` (desired === null) is a status query with no
 * `newValue` to persist; an explicit on/off sets it. `state` is retained for the
 * router's log line (the reply itself renders as a Debug embed, so there is no
 * footer checkbox reflecting it).
 */

export type EphemeralCommandOutcome = {
  /** New value to persist, or undefined for a bare status query. */
  newValue?: boolean;
  description: string;
  state: CommandResultState;
};

export function resolveEphemeralCommand(
  current: boolean,
  desired: boolean | null,
): EphemeralCommandOutcome {
  if (desired === null) {
    return {
      description: current
        ? "Ephemeral command replies are currently `enabled`."
        : "Ephemeral command replies are currently `disabled`.",
      state: current ? "enabled" : "disabled",
    };
  }
  if (desired) {
    return {
      newValue: true,
      description: current
        ? "Ephemeral command replies were already `enabled`, so nothing changed."
        : "Ephemeral command replies are now `enabled`.",
      state: "enabled",
    };
  }
  return {
    newValue: false,
    description: current
      ? "Ephemeral command replies are now `disabled`."
      : "Ephemeral command replies were already `disabled`, so nothing changed.",
    state: "disabled",
  };
}
