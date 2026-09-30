import type { AgentCommand } from "./agent-commands.js";
import type { InstanceConfig } from "./config.js";

export type RouterRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/** Runs a control command emitted by the agent; returns a result string to
 * relay back to the agent, or null for a no-op (no relay). */
export type RunAgentCommand = (
  cmd: AgentCommand,
  ctx: { channelId: string; instance: InstanceConfig; authorId: string },
) => Promise<string | null>;
