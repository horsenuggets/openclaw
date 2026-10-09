import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isChatStopCommandText } from "../gateway/chat-abort.js";
import { hasControlCommand, hasInlineCommandTokens } from "./command-detection.js";
import {
  ENABLED_COMMAND_KEYS,
  getCommandPolicyIdentity,
  isCommandKeyEnabled,
  setCommandPolicyForTest,
} from "./command-policy.js";
import { getChatCommands } from "./commands-registry.data.js";
import {
  findCommandByNativeName,
  listChatCommands,
  listChatCommandsForConfig,
  listNativeCommandSpecsForConfig,
  resolveTextCommand,
  shouldHandleTextCommands,
} from "./commands-registry.js";
import { isAbortTrigger } from "./reply/abort.js";
import { listEnabledCommandHandlers } from "./reply/commands-core.js";
import { parseInlineDirectives } from "./reply/directive-handling.parse.js";
import { extractInlineSimpleCommand } from "./reply/reply-inline.js";

const cfg = { commands: { text: true, config: true, debug: true, bash: true } } as OpenClawConfig;

const DIRECTIVE_BODIES = [
  "/think high hello",
  "/verbose on hello",
  "/reasoning on hello",
  "/elevated on hello",
  "/exec host=sandbox hello",
  "/model gpt hello",
  "/queue steer hello",
  "/status hello",
] as const;

const TEXT_COMMAND_BODIES = ["/help", "/status", "/stop", "/new", "/reset", "/model gpt"] as const;

const ABORT_BODIES = ["stop", "esc", "abort", "wait", "exit", "interrupt"] as const;

afterEach(() => {
  setCommandPolicyForTest("all");
});

describe("shipped policy", () => {
  it("enables no in-box command keys", () => {
    expect(ENABLED_COMMAND_KEYS.size).toBe(0);
  });

  it("restores the shipped policy when the test override is cleared", () => {
    setCommandPolicyForTest("all");
    setCommandPolicyForTest(null);
    expect(getCommandPolicyIdentity()).toBe(ENABLED_COMMAND_KEYS);
  });

  it("is a pure lookup that gives the same answer twice", () => {
    setCommandPolicyForTest(new Set(["help"]));
    expect(isCommandKeyEnabled("help")).toBe(isCommandKeyEnabled("help"));
    expect(isCommandKeyEnabled("stop")).toBe(isCommandKeyEnabled("stop"));
  });
});

describe("empty policy behaves like an unknown /word", () => {
  it("registers no commands, native or text", () => {
    setCommandPolicyForTest(null);
    expect(listChatCommands()).toEqual([]);
    expect(listChatCommandsForConfig(cfg)).toEqual([]);
    expect(listNativeCommandSpecsForConfig(cfg)).toEqual([]);
    expect(findCommandByNativeName("help")).toBeUndefined();
    expect(findCommandByNativeName("status", "discord")).toBeUndefined();
  });

  it.each(TEXT_COMMAND_BODIES)("does not resolve %s as a text command", (body) => {
    setCommandPolicyForTest(null);
    expect(resolveTextCommand(body, cfg)).toBeNull();
    expect(hasControlCommand(body, cfg)).toBe(false);
  });

  it.each(DIRECTIVE_BODIES)("leaves %s untouched by directive parsing", (body) => {
    setCommandPolicyForTest(null);
    const parsed = parseInlineDirectives(body);
    expect(parsed.cleaned).toBe(body);
    expect(parsed.hasThinkDirective).toBe(false);
    expect(parsed.hasVerboseDirective).toBe(false);
    expect(parsed.hasReasoningDirective).toBe(false);
    expect(parsed.hasElevatedDirective).toBe(false);
    expect(parsed.hasExecDirective).toBe(false);
    expect(parsed.hasModelDirective).toBe(false);
    expect(parsed.hasQueueDirective).toBe(false);
    expect(parsed.hasStatusDirective).toBe(false);
  });

  it.each(ABORT_BODIES)("does not treat the bare word %s as an abort trigger", (body) => {
    setCommandPolicyForTest(null);
    expect(isAbortTrigger(body)).toBe(false);
    expect(isChatStopCommandText(body)).toBe(false);
  });

  it("does not treat /stop as a chat stop command", () => {
    setCommandPolicyForTest(null);
    expect(isChatStopCommandText("/stop")).toBe(false);
  });

  it("runs only plugin command handlers", () => {
    setCommandPolicyForTest(null);
    expect(listEnabledCommandHandlers()).toHaveLength(1);
  });

  it("gives an unknown word the same answers as a disabled command", () => {
    setCommandPolicyForTest(null);
    const unknown = "/definitely-not-a-command";
    for (const body of TEXT_COMMAND_BODIES) {
      expect(resolveTextCommand(body, cfg)).toEqual(resolveTextCommand(unknown, cfg));
      expect(hasControlCommand(body, cfg)).toBe(hasControlCommand(unknown, cfg));
    }
  });
});

describe("full policy keeps upstream behavior", () => {
  it("registers every command", () => {
    setCommandPolicyForTest("all");
    expect(listChatCommands().length).toBe(getChatCommands().length);
    expect(findCommandByNativeName("help")).toBeDefined();
  });

  it.each(["/help", "/status", "/stop"] as const)("resolves %s as a text command", (body) => {
    setCommandPolicyForTest("all");
    expect(resolveTextCommand(body, cfg)).not.toBeNull();
  });

  it("parses a think directive", () => {
    setCommandPolicyForTest("all");
    expect(parseInlineDirectives("/think high hello").hasThinkDirective).toBe(true);
  });

  it.each(ABORT_BODIES)("treats the bare word %s as an abort trigger", (body) => {
    setCommandPolicyForTest("all");
    expect(isAbortTrigger(body)).toBe(true);
  });
});

describe("single-key policy enables exactly that command", () => {
  const KEYS = ["help", "status", "stop", "think", "model"] as const;

  it.each(KEYS)("with only %s enabled, every other key is off", (enabled) => {
    setCommandPolicyForTest(new Set([enabled]));
    for (const key of KEYS) {
      expect(isCommandKeyEnabled(key)).toBe(key === enabled);
    }
  });

  it("keeps /stop and its bare-word aliases tied together", () => {
    setCommandPolicyForTest(new Set(["stop"]));
    expect(isAbortTrigger("stop")).toBe(true);
    expect(isChatStopCommandText("/stop")).toBe(true);
    expect(resolveTextCommand("/help", cfg)).toBeNull();
    expect(parseInlineDirectives("/think high hello").hasThinkDirective).toBe(false);
  });

  it("enables only the think directive when only think is on", () => {
    setCommandPolicyForTest(new Set(["think"]));
    expect(parseInlineDirectives("/think high hello").hasThinkDirective).toBe(true);
    expect(parseInlineDirectives("/verbose on hello").hasVerboseDirective).toBe(false);
    expect(isAbortTrigger("stop")).toBe(false);
  });

  it("keeps only the enabled handler's command resolvable", () => {
    setCommandPolicyForTest(new Set(["help"]));
    expect(resolveTextCommand("/help", cfg)?.command.key).toBe("help");
    expect(resolveTextCommand("/status", cfg)).toBeNull();
    expect(listEnabledCommandHandlers()).toHaveLength(2);
  });
});

describe("text command gating", () => {
  it("still sees slash tokens syntactically, so only the registry decides", () => {
    setCommandPolicyForTest(null);
    expect(hasInlineCommandTokens("/help")).toBe(true);
    expect(hasControlCommand("/help", cfg)).toBe(false);
  });

  it("does not depend on the policy for non-command text", () => {
    for (const policy of [null, "all"] as const) {
      setCommandPolicyForTest(policy);
      expect(resolveTextCommand("hello there", cfg)).toBeNull();
      expect(isAbortTrigger("")).toBe(false);
      expect(shouldHandleTextCommands({ cfg, surface: "discord", commandSource: "text" })).toBe(
        true,
      );
    }
  });
});

describe("inline command extraction", () => {
  const INLINE_BODIES = ["hello /help", "hello /commands", "hello /whoami", "hello /id"] as const;

  it("leaves every disabled inline command in the prompt", () => {
    setCommandPolicyForTest(null);
    for (const body of INLINE_BODIES) {
      expect(extractInlineSimpleCommand(body)).toBeNull();
    }
  });

  it("extracts inline commands when the policy enables them", () => {
    setCommandPolicyForTest("all");
    expect(extractInlineSimpleCommand("hello /help")?.cleaned).toBe("hello");
    expect(extractInlineSimpleCommand("hello /id")?.command).toBe("/whoami");
  });

  it("skips a disabled command and still finds an enabled one", () => {
    setCommandPolicyForTest(new Set(["whoami"]));
    expect(extractInlineSimpleCommand("/help then /whoami")?.command).toBe("/whoami");
    expect(extractInlineSimpleCommand("/help only")).toBeNull();
  });

  it("is pure for the same policy", () => {
    setCommandPolicyForTest("all");
    expect(extractInlineSimpleCommand("hello /help")).toEqual(
      extractInlineSimpleCommand("hello /help"),
    );
  });

  it("keeps a disabled inline /status in the parsed body", () => {
    setCommandPolicyForTest(null);
    expect(parseInlineDirectives("hello /status", { allowStatusDirective: true }).cleaned).toBe(
      "hello /status",
    );
  });
});
