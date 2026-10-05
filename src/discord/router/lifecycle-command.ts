import type { CommandResultState } from "./embed-categories.js";

/**
 * Resolve the `/lifecycle [on|off]` command into the command-result message the
 * router renders. Shared by the text-command fallback and the slash handler so
 * both word identically and cover the same edge cases (toggling when already in
 * the requested state, and the bare status query).
 */

export type LifecycleCommandResult = {
  /** New `lifecycleMessages` value to persist, or undefined for a status query. */
  newValue?: boolean;
  description: string;
  state: CommandResultState;
};

const SEE = "You will see startup/shutdown notification messages in this channel.";
const NO_SEE = "You will no longer see startup/shutdown notification messages in this channel.";

export function resolveLifecycleCommand(
  current: boolean,
  arg: string | undefined,
): LifecycleCommandResult {
  if (arg === "on") {
    return {
      newValue: true,
      description: current
        ? `Lifecycle messages are already \`enabled\`. ${SEE}`
        : `Lifecycle messages are now \`enabled\`. ${SEE}`,
      state: "enabled",
    };
  }
  if (arg === "off") {
    return {
      newValue: false,
      description: current
        ? `Lifecycle messages are now \`disabled\`. ${NO_SEE}`
        : `Lifecycle messages are already \`disabled\`. ${NO_SEE}`,
      state: "disabled",
    };
  }
  return {
    description: current
      ? "Lifecycle messages are currently `enabled`. Use `/lifecycle off` to disable."
      : "Lifecycle messages are currently `disabled`. Use `/lifecycle on` to enable.",
    state: current ? "enabled" : "disabled",
  };
}
