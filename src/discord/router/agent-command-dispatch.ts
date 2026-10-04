import type { AgentCommand } from "./agent-commands.js";
import type { DiscordEmbed } from "./channel-commands.js";
import { buildLogEmbed } from "./log-embed.js";
import { buildWelcomeEmbed } from "./onboarding.js";

/**
 * Host-side execution of the agent's `⁘` control commands, extracted from the
 * router closure so each branch is unit-testable with an injected sender. The
 * agent emits these as plain-text messages the router intercepts; a command is
 * never shown to the user, and the returned string (or null) is relayed back to
 * the agent as the command result.
 */

export type AgentCommandSender = (
  channelId: string,
  message: { embeds: DiscordEmbed[]; attachments?: string[] },
) => Promise<{ ok: boolean; status: number }>;

export type AgentCommandDispatchDeps = {
  /** Post an embed (uploading referenced icons) and report the HTTP outcome. */
  sendEmbed: AgentCommandSender;
};

/**
 * Run one parsed agent command. Returns the result string to relay to the agent,
 * or null for a deliberate no-op (the silent-reply `return` token).
 */
export async function runAgentCommandDispatch(
  cmd: AgentCommand,
  channelId: string,
  deps: AgentCommandDispatchDeps,
): Promise<string | null> {
  if (cmd.command === "return") {
    return null; // deliberate no-op, nothing to relay
  }
  if (cmd.command === "send_hook_embed") {
    const name = cmd.args[0];
    if (name === "welcome") {
      const welcome = buildWelcomeEmbed();
      await deps.sendEmbed(channelId, {
        embeds: [welcome.embed],
        attachments: welcome.attachments,
      });
      return "welcome card sent";
    }
    return `error: unknown embed "${name ?? ""}"`;
  }
  if (cmd.command === "log") {
    // The agent emits `⁘ log "<text>"` for a log-category notice (e.g. a status
    // or error line). Rendered as a Log embed and dropped from chat.
    const text = cmd.args.join(" ").trim();
    if (!text) {
      return "error: log requires a message";
    }
    const log = buildLogEmbed(text);
    const res = await deps.sendEmbed(channelId, {
      embeds: [log.embed],
      attachments: log.attachments,
    });
    // Report a rejection back to the agent so it is not told the log sent.
    return res.ok ? "log sent" : `error: log embed rejected (${res.status})`;
  }
  return `error: unknown command "${cmd.command}"`;
}
