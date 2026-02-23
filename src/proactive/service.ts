import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "../agents/date-time.js";
import { isRoutableChannel } from "../auto-reply/reply/route-reply.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../config/sessions.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId, DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { shouldEvaluateSession, getTodayDateStr } from "./heuristics.js";
import { buildProactivePrompt } from "./prompt.js";
import { PROACTIVE_DEFAULTS } from "./types.js";

export type ProactiveServiceDeps = {
  loadConfig: () => OpenClawConfig;
  runAgentCommand: (opts: {
    message: string;
    sessionKey: string;
    deliver: boolean;
    bestEffortDeliver: boolean;
    thinking: string;
    lane: string;
  }) => Promise<{
    payloads?: Array<{ text?: string }>;
    meta?: unknown;
  } | void>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** Injectable clock for testing. Defaults to Date.now. */
  nowMs?: () => number;
};

export class ProactiveService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly deps: ProactiveServiceDeps;
  private readonly nowMs: () => number;

  constructor(deps: ProactiveServiceDeps) {
    this.deps = deps;
    this.nowMs = deps.nowMs ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    const cfg = this.deps.loadConfig();
    const config = cfg.proactive ?? {};
    const enabled = config.enabled ?? PROACTIVE_DEFAULTS.enabled;
    if (!enabled) {
      this.deps.log.info("proactive: disabled by config");
      return;
    }

    const intervalMs =
      (config.checkIntervalMinutes ?? PROACTIVE_DEFAULTS.checkIntervalMinutes) * 60_000;
    this.deps.log.info(
      `proactive: started (interval ${config.checkIntervalMinutes ?? PROACTIVE_DEFAULTS.checkIntervalMinutes} min)`,
    );
    this.timer = setInterval(() => {
      void this.checkNow().catch((err) => {
        this.deps.log.error(`proactive: check failed: ${formatErrorMessage(err)}`);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single proactive scan across all agent sessions.
   * Can be called on startup or by the periodic timer.
   */
  async checkNow(opts?: { isStartup?: boolean }): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const cfg = this.deps.loadConfig();
      const config = cfg.proactive ?? {};
      const enabled = config.enabled ?? PROACTIVE_DEFAULTS.enabled;
      if (!enabled) {
        return;
      }

      const agentIds = resolveAgentIds(cfg);
      const userTimezone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
      const userTimeFormat = resolveUserTimeFormat(cfg.agents?.defaults?.timeFormat);
      const now = this.nowMs();

      let evaluated = 0;
      let triggered = 0;

      for (const agentId of agentIds) {
        const storePath = resolveStorePath(cfg.session?.store, { agentId });
        let store: Record<string, SessionEntry>;
        try {
          store = loadSessionStore(storePath, { skipCache: true });
        } catch (err) {
          this.deps.log.warn(
            `proactive: failed to load session store for agent "${agentId}": ${formatErrorMessage(err)}`,
          );
          continue;
        }

        for (const [sessionKey, entry] of Object.entries(store)) {
          if (!entry) {
            continue;
          }

          const result = shouldEvaluateSession({
            sessionKey,
            entry,
            config,
            userTimezone,
            nowMs: now,
            isStartup: opts?.isStartup,
          });

          if (!result.eligible) {
            continue;
          }
          evaluated++;

          // Verify the channel is routable
          const channel = entry.deliveryContext?.channel ?? entry.lastChannel;
          if (!isRoutableChannel(channel)) {
            continue;
          }

          // Build the proactive prompt with time context
          const userIdleMs = now - (entry.lastUserMessageAt ?? 0);
          const agentIdleMs = now - (entry.lastAgentResponseAt ?? 0);
          const formattedTime =
            formatUserTime(new Date(now), userTimezone, userTimeFormat) ??
            new Date(now).toISOString();

          const prompt = buildProactivePrompt({
            formattedTime,
            userIdleMs,
            agentIdleMs,
            isStartup: opts?.isStartup,
          });

          // Update lastProactiveCheckAt before the run
          await updateSessionStore(storePath, (s) => {
            const e = s[sessionKey];
            if (e) {
              e.lastProactiveCheckAt = now;
            }
          });

          try {
            const runResult = await this.deps.runAgentCommand({
              message: prompt,
              sessionKey,
              deliver: true,
              bestEffortDeliver: true,
              thinking: "low",
              lane: "proactive",
            });

            // Detect if the agent actually sent something
            const payloads = runResult?.payloads ?? [];
            const didSend = payloads.some(
              (p) => p.text?.trim() && !isSilentReplyText(p.text, SILENT_REPLY_TOKEN),
            );

            if (didSend) {
              triggered++;
              const todayDate = getTodayDateStr(now, userTimezone);
              await updateSessionStore(storePath, (s) => {
                const e = s[sessionKey];
                if (e) {
                  e.lastProactiveMessageSentAt = now;
                  if (e.proactiveMessageCountDate === todayDate) {
                    e.proactiveMessageCountToday = (e.proactiveMessageCountToday ?? 0) + 1;
                  } else {
                    e.proactiveMessageCountDate = todayDate;
                    e.proactiveMessageCountToday = 1;
                  }
                }
              });
            }
          } catch (err) {
            this.deps.log.warn(
              `proactive: agent run failed for session "${sessionKey}": ${formatErrorMessage(err)}`,
            );
          }
        }
      }

      if (evaluated > 0) {
        this.deps.log.info(
          `proactive: evaluated ${evaluated} session${evaluated !== 1 ? "s" : ""}, triggered ${triggered}`,
        );
      }
    } finally {
      this.running = false;
    }
  }
}

/**
 * Resolve the list of agent IDs to scan. Follows the same pattern
 * as startup-recovery.ts.
 */
function resolveAgentIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  ids.add(normalizeAgentId(DEFAULT_AGENT_ID));
  const agentsCfg = cfg.agents;
  if (agentsCfg && typeof agentsCfg === "object") {
    for (const key of Object.keys(agentsCfg)) {
      if (key === "defaults" || key === "scope") {
        continue;
      }
      const normalized = normalizeAgentId(key);
      if (normalized) {
        ids.add(normalized);
      }
    }
  }
  return Array.from(ids);
}
