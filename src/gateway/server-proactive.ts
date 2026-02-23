import type { CliDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { loadConfig } from "../config/config.js";
import { getChildLogger } from "../logging.js";
import { ProactiveService } from "../proactive/service.js";
import { defaultRuntime } from "../runtime.js";

export type GatewayProactiveState = {
  proactive: ProactiveService;
  proactiveEnabled: boolean;
};

export function buildGatewayProactiveService(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
}): GatewayProactiveState {
  const proactiveLogger = getChildLogger({ module: "proactive" });
  const proactiveEnabled =
    process.env.OPENCLAW_SKIP_PROACTIVE !== "1" && params.cfg.proactive?.enabled !== false;

  const silentRuntime = {
    log: () => {},
    error: (message: string) => proactiveLogger.error(String(message)),
    exit: defaultRuntime.exit,
  };

  const proactive = new ProactiveService({
    loadConfig,
    runAgentCommand: async (opts) => {
      const result = await agentCommand(
        {
          message: opts.message,
          sessionKey: opts.sessionKey,
          deliver: opts.deliver,
          bestEffortDeliver: opts.bestEffortDeliver,
          thinking: opts.thinking,
          lane: opts.lane,
        },
        silentRuntime,
        params.deps,
      );
      return result ?? undefined;
    },
    log: {
      info: (msg) => proactiveLogger.info(msg),
      warn: (msg) => proactiveLogger.warn(msg),
      error: (msg) => proactiveLogger.error(msg),
    },
  });

  return { proactive, proactiveEnabled };
}
