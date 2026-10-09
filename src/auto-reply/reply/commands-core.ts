import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { isCommandKeyEnabled } from "../command-policy.js";
import { shouldHandleTextCommands } from "../commands-registry.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { handleApproveCommand } from "./commands-approve.js";
import { handleBashCommand } from "./commands-bash.js";
import { handleCompactCommand } from "./commands-compact.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import {
  handleCommandsListCommand,
  handleContextCommand,
  handleHelpCommand,
  handleStatusCommand,
  handleWhoamiCommand,
} from "./commands-info.js";
import { handleModelsCommand } from "./commands-models.js";
import { handlePluginCommand } from "./commands-plugin.js";
import {
  handleAbortTrigger,
  handleActivationCommand,
  handleRestartCommand,
  handleSendPolicyCommand,
  handleStopCommand,
  handleToolFeedbackCommand,
  handleUsageCommand,
} from "./commands-session.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import { handleTtsCommands } from "./commands-tts.js";
import { routeReply } from "./route-reply.js";

/**
 * Built-in handlers paired with the command keys they implement. A handler runs only if
 * the command policy enables at least one of its keys; plugin commands (no key) always
 * run. Keeping the pairing here means a handler cannot stay live after its command is
 * disabled.
 */
// Built lazily: some handler modules import back into this one, so reading them at module
// load would see undefined bindings.
function listHandlerEntries(): Array<{ keys: string[]; handler: CommandHandler }> {
  return [
    // Plugin commands are processed first, before built-in commands
    { keys: [], handler: handlePluginCommand },
    { keys: ["bash"], handler: handleBashCommand },
    { keys: ["toolfeedback"], handler: handleToolFeedbackCommand },
    { keys: ["activation"], handler: handleActivationCommand },
    { keys: ["send"], handler: handleSendPolicyCommand },
    { keys: ["usage"], handler: handleUsageCommand },
    { keys: ["restart"], handler: handleRestartCommand },
    { keys: ["tts"], handler: handleTtsCommands },
    { keys: ["help"], handler: handleHelpCommand },
    { keys: ["commands"], handler: handleCommandsListCommand },
    { keys: ["status"], handler: handleStatusCommand },
    { keys: ["allowlist"], handler: handleAllowlistCommand },
    { keys: ["approve"], handler: handleApproveCommand },
    { keys: ["context"], handler: handleContextCommand },
    { keys: ["whoami"], handler: handleWhoamiCommand },
    { keys: ["subagents"], handler: handleSubagentsCommand },
    { keys: ["config"], handler: handleConfigCommand },
    { keys: ["debug"], handler: handleDebugCommand },
    { keys: ["models"], handler: handleModelsCommand },
    { keys: ["stop"], handler: handleStopCommand },
    { keys: ["compact"], handler: handleCompactCommand },
    { keys: ["stop"], handler: handleAbortTrigger },
  ];
}

export function listEnabledCommandHandlers(): CommandHandler[] {
  return listHandlerEntries()
    .filter(
      ({ keys, handler }) =>
        handler === handlePluginCommand || keys.some((key) => isCommandKeyEnabled(key)),
    )
    .map(({ handler }) => handler);
}

export async function handleCommands(params: HandleCommandsParams): Promise<CommandHandlerResult> {
  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
  const resetRequested = Boolean(resetMatch) && isCommandKeyEnabled(resetMatch?.[1] ?? "");
  if (resetRequested && !params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Trigger internal hook for reset/new commands
  if (resetRequested && params.command.isAuthorizedSender) {
    const commandAction = resetMatch?.[1] ?? "new";
    const hookEvent = createInternalHookEvent("command", commandAction, params.sessionKey ?? "", {
      sessionEntry: params.sessionEntry,
      previousSessionEntry: params.previousSessionEntry,
      commandSource: params.command.surface,
      senderId: params.command.senderId,
      cfg: params.cfg, // Pass config for LLM slug generation
    });
    await triggerInternalHook(hookEvent);

    // Send hook messages immediately if present
    if (hookEvent.messages.length > 0) {
      // Use OriginatingChannel/To if available, otherwise fall back to command channel/from
      // oxlint-disable-next-line typescript/no-explicit-any
      const channel = params.ctx.OriginatingChannel || (params.command.channel as any);
      // For replies, use 'from' (the sender) not 'to' (which might be the bot itself)
      const to = params.ctx.OriginatingTo || params.command.from || params.command.to;

      if (channel && to) {
        const hookReply = { text: hookEvent.messages.join("\n\n") };
        await routeReply({
          payload: hookReply,
          channel: channel,
          to: to,
          sessionKey: params.sessionKey,
          accountId: params.ctx.AccountId,
          threadId: params.ctx.MessageThreadId,
          cfg: params.cfg,
        });
      }
    }
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: params.command.surface,
    commandSource: params.ctx.CommandSource,
  });

  for (const handler of listEnabledCommandHandlers()) {
    const result = await handler(params, allowTextCommands);
    if (result) {
      return result;
    }
  }

  const sendPolicy = resolveSendPolicy({
    cfg: params.cfg,
    entry: params.sessionEntry,
    sessionKey: params.sessionKey,
    channel: params.sessionEntry?.channel ?? params.command.channel,
    chatType: params.sessionEntry?.chatType,
  });
  if (sendPolicy === "deny") {
    logVerbose(`Send blocked by policy for session ${params.sessionKey ?? "unknown"}`);
    return { shouldContinue: false };
  }

  return { shouldContinue: true };
}
