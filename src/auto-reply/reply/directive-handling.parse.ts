import type { OpenClawConfig } from "../../config/config.js";
import type { ExecAsk, ExecHost, ExecSecurity } from "../../infra/exec-approvals.js";
import type { MsgContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "./directives.js";
import type { QueueDropPolicy, QueueMode } from "./queue.js";
import { isCommandKeyEnabled } from "../command-policy.js";
import { extractModelDirective } from "../model.js";
import {
  extractElevatedDirective,
  extractExecDirective,
  extractReasoningDirective,
  extractStatusDirective,
  extractThinkDirective,
  extractVerboseDirective,
} from "./directives.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { extractQueueDirective } from "./queue.js";

export type InlineDirectives = {
  cleaned: string;
  hasThinkDirective: boolean;
  thinkLevel?: ThinkLevel;
  rawThinkLevel?: string;
  hasVerboseDirective: boolean;
  verboseLevel?: VerboseLevel;
  rawVerboseLevel?: string;
  hasReasoningDirective: boolean;
  reasoningLevel?: ReasoningLevel;
  rawReasoningLevel?: string;
  hasElevatedDirective: boolean;
  elevatedLevel?: ElevatedLevel;
  rawElevatedLevel?: string;
  hasExecDirective: boolean;
  execHost?: ExecHost;
  execSecurity?: ExecSecurity;
  execAsk?: ExecAsk;
  execNode?: string;
  rawExecHost?: string;
  rawExecSecurity?: string;
  rawExecAsk?: string;
  rawExecNode?: string;
  hasExecOptions: boolean;
  invalidExecHost: boolean;
  invalidExecSecurity: boolean;
  invalidExecAsk: boolean;
  invalidExecNode: boolean;
  hasStatusDirective: boolean;
  hasModelDirective: boolean;
  rawModelDirective?: string;
  rawModelProfile?: string;
  hasQueueDirective: boolean;
  queueMode?: QueueMode;
  queueReset: boolean;
  rawQueueMode?: string;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
  rawDebounce?: string;
  rawCap?: string;
  rawDrop?: string;
  hasQueueOptions: boolean;
};

/**
 * Run `extract` only when the command policy enables `key`. A disabled directive is
 * left in the text untouched and reports "not present", which is exactly what an
 * unrecognized `/word` looks like to the parser.
 */
function whenEnabled<T extends { cleaned: string }>(
  key: string,
  body: string,
  extract: (body: string) => T,
  absent: Omit<T, "cleaned">,
): T {
  return isCommandKeyEnabled(key) ? extract(body) : ({ ...absent, cleaned: body } as T);
}

export function parseInlineDirectives(
  body: string,
  options?: {
    modelAliases?: string[];
    disableElevated?: boolean;
    allowStatusDirective?: boolean;
  },
): InlineDirectives {
  const {
    cleaned: thinkCleaned,
    thinkLevel,
    rawLevel: rawThinkLevel,
    hasDirective: hasThinkDirective,
  } = whenEnabled("think", body, extractThinkDirective, { hasDirective: false });
  const {
    cleaned: verboseCleaned,
    verboseLevel,
    rawLevel: rawVerboseLevel,
    hasDirective: hasVerboseDirective,
  } = whenEnabled("verbose", thinkCleaned, extractVerboseDirective, { hasDirective: false });
  const {
    cleaned: reasoningCleaned,
    reasoningLevel,
    rawLevel: rawReasoningLevel,
    hasDirective: hasReasoningDirective,
  } = whenEnabled("reasoning", verboseCleaned, extractReasoningDirective, {
    hasDirective: false,
  });
  const {
    cleaned: elevatedCleaned,
    elevatedLevel,
    rawLevel: rawElevatedLevel,
    hasDirective: hasElevatedDirective,
  } = options?.disableElevated
    ? {
        cleaned: reasoningCleaned,
        elevatedLevel: undefined,
        rawLevel: undefined,
        hasDirective: false,
      }
    : whenEnabled("elevated", reasoningCleaned, extractElevatedDirective, {
        hasDirective: false,
      });
  const {
    cleaned: execCleaned,
    execHost,
    execSecurity,
    execAsk,
    execNode,
    rawExecHost,
    rawExecSecurity,
    rawExecAsk,
    rawExecNode,
    hasExecOptions,
    invalidHost: invalidExecHost,
    invalidSecurity: invalidExecSecurity,
    invalidAsk: invalidExecAsk,
    invalidNode: invalidExecNode,
    hasDirective: hasExecDirective,
  } = whenEnabled("exec", elevatedCleaned, extractExecDirective, {
    hasExecOptions: false,
    invalidHost: false,
    invalidSecurity: false,
    invalidAsk: false,
    invalidNode: false,
    hasDirective: false,
  });
  const allowStatusDirective =
    options?.allowStatusDirective !== false && isCommandKeyEnabled("status");
  const { cleaned: statusCleaned, hasDirective: hasStatusDirective } = allowStatusDirective
    ? extractStatusDirective(execCleaned)
    : { cleaned: execCleaned, hasDirective: false };
  const {
    cleaned: modelCleaned,
    rawModel,
    rawProfile,
    hasDirective: hasModelDirective,
  } = whenEnabled(
    "model",
    statusCleaned,
    (text) => extractModelDirective(text, { aliases: options?.modelAliases }),
    { hasDirective: false },
  );
  const {
    cleaned: queueCleaned,
    queueMode,
    queueReset,
    rawMode,
    debounceMs,
    cap,
    dropPolicy,
    rawDebounce,
    rawCap,
    rawDrop,
    hasDirective: hasQueueDirective,
    hasOptions: hasQueueOptions,
  } = whenEnabled("queue", modelCleaned, extractQueueDirective, {
    queueReset: false,
    hasDirective: false,
    hasOptions: false,
  });

  return {
    cleaned: queueCleaned,
    hasThinkDirective,
    thinkLevel,
    rawThinkLevel,
    hasVerboseDirective,
    verboseLevel,
    rawVerboseLevel,
    hasReasoningDirective,
    reasoningLevel,
    rawReasoningLevel,
    hasElevatedDirective,
    elevatedLevel,
    rawElevatedLevel,
    hasExecDirective,
    execHost,
    execSecurity,
    execAsk,
    execNode,
    rawExecHost,
    rawExecSecurity,
    rawExecAsk,
    rawExecNode,
    hasExecOptions,
    invalidExecHost,
    invalidExecSecurity,
    invalidExecAsk,
    invalidExecNode,
    hasStatusDirective,
    hasModelDirective,
    rawModelDirective: rawModel,
    rawModelProfile: rawProfile,
    hasQueueDirective,
    queueMode,
    queueReset,
    rawQueueMode: rawMode,
    debounceMs,
    cap,
    dropPolicy,
    rawDebounce,
    rawCap,
    rawDrop,
    hasQueueOptions,
  };
}

export function isDirectiveOnly(params: {
  directives: InlineDirectives;
  cleanedBody: string;
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): boolean {
  const { directives, cleanedBody, ctx, cfg, agentId, isGroup } = params;
  if (
    !directives.hasThinkDirective &&
    !directives.hasVerboseDirective &&
    !directives.hasReasoningDirective &&
    !directives.hasElevatedDirective &&
    !directives.hasExecDirective &&
    !directives.hasModelDirective &&
    !directives.hasQueueDirective
  ) {
    return false;
  }
  const stripped = stripStructuralPrefixes(cleanedBody ?? "");
  const noMentions = isGroup ? stripMentions(stripped, ctx, cfg, agentId) : stripped;
  return noMentions.length === 0;
}
