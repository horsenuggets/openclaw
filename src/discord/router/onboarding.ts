import fs from "node:fs";
import path from "node:path";
import type { InstanceConfig } from "./config.js";
import type { RouterRuntime } from "./types.js";
import { type BuiltEmbed, buildEmbed } from "./embed-categories.js";

/** Build the first-run welcome card (General category, OpenClaw avatar thumbnail). */
export function buildWelcomeEmbed(): BuiltEmbed {
  return buildEmbed({
    category: "general",
    title: "Welcome to OpenClaw!",
    description:
      "I'm your personal everything-assistant. Let's get you set up! I'll ask you a few quick questions to personalize your experience.",
    thumbnail: "openclaw.png",
  });
}

/** Workspace-relative path of the first-run checklist. */
const BOOTSTRAP_RELATIVE_PATH = "workspace/BOOTSTRAP.md";

/** True once the first-run checklist file is still present (setup in progress). */
export function bootstrapExists(instance: InstanceConfig): boolean {
  try {
    return fs.existsSync(path.join(instance.instanceDir, BOOTSTRAP_RELATIVE_PATH));
  } catch {
    return false;
  }
}

/**
 * First-run onboarding is driven from here, through conversation content,
 * rather than by injecting the checklist into the agent's system prompt. That
 * is deliberate: the anthropic-subscription (OAuth) plan only bills to the free
 * plan quota while the system prompt stays consistent with the Claude Code
 * identity, and workspace persona/first-run text in the system prompt makes
 * requests spill into paid extra usage. Conversation content does not affect
 * that billing, so the router reads the instance's BOOTSTRAP.md (mounted
 * read-only) and prepends it, with a directive, to the user's message while the
 * file exists. Once the agent finishes setup and deletes BOOTSTRAP.md, this
 * returns null and normal chat resumes.
 */
export function readBootstrapDirective(instance: InstanceConfig): string | null {
  try {
    const bootstrapPath = path.join(instance.instanceDir, BOOTSTRAP_RELATIVE_PATH);
    const content = fs.readFileSync(bootstrapPath, "utf-8").trim();
    if (!content) {
      return null;
    }
    return [
      "[first-run setup]",
      "This channel is brand new and not set up yet. Before replying to the user's message below, begin the first-run setup checklist and work through it step by step. This is your BOOTSTRAP.md:",
      "",
      content,
      "",
      "Identity: you are OpenClaw, the user's personal everything-assistant. Always introduce and refer to yourself as OpenClaw, never as Claude, Claude Code, or any other model or product name. If you need a noun, call yourself an assistant or your assistant.",
      "",
      "Follow it exactly, including emitting any control commands it specifies (a message that is only a control command is run by the host and never shown to the user). Tick each item as you complete it and delete BOOTSTRAP.md when every item is done. Now handle the user's message:",
    ].join("\n");
  } catch {
    return null;
  }
}

/** Message routed by {@link runOnboardingKick} into an agent's first turn. */
export type OnboardingKickRoute = (params: {
  channelId: string;
  ownerId: string;
  instance: InstanceConfig;
  systemTurn: true;
  preacquiredInflight: true;
}) => Promise<boolean>;

/**
 * Drive the first onboarding turn for a freshly registered channel, before the
 * owner speaks. Extracted from the router closure so its concurrency/error paths
 * are unit-testable with injected `probe`/`route`.
 *
 * Serialization: reserves the channel's `inflight` slot BEFORE the readiness wait
 * so a user message sent right after the register embed queues behind the kick
 * instead of overtaking it (which would invert ordering and could double the
 * welcome). If a turn is already in flight, the kick is skipped — that turn drives
 * onboarding itself. The slot is always released.
 *
 * Readiness: the provisioner can report ready before the agent gateway accepts
 * connections, and `routeMessage` turns an ECONNREFUSED into a one-shot error
 * with no retry, so the kick is deferred until `probe` succeeds. If it never
 * becomes ready the kick is skipped rather than firing at a dead port.
 *
 * @returns "busy" (already in flight), "not-ready" (gateway never came up), or
 *          "kicked" (the onboarding turn was routed).
 */
export async function runOnboardingKick(params: {
  channelId: string;
  ownerId: string;
  instance: InstanceConfig;
  inflight: Set<string>;
  probe: (port: number) => Promise<boolean>;
  route: OnboardingKickRoute;
  runtime: RouterRuntime;
  attempts?: number;
  intervalMs?: number;
}): Promise<"busy" | "not-ready" | "kicked"> {
  const { channelId, ownerId, instance, inflight, probe, route, runtime } = params;
  const attempts = params.attempts ?? 20;
  const intervalMs = params.intervalMs ?? 1000;

  // A message could already be in flight (e.g. the owner started typing
  // immediately); that turn will drive onboarding itself, so do not kick.
  if (inflight.has(channelId)) {
    return "busy";
  }
  inflight.add(channelId);
  try {
    let ready = false;
    for (let i = 0; i < attempts; i++) {
      if (await probe(instance.port)) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    if (!ready) {
      runtime.error(
        `[router] onboarding kick skipped: agent for channel ${channelId} never became ready`,
      );
      return "not-ready";
    }
    runtime.log(`[router] kicking onboarding for channel ${channelId} (owner ${ownerId})`);
    await route({ channelId, ownerId, instance, systemTurn: true, preacquiredInflight: true });
    return "kicked";
  } finally {
    inflight.delete(channelId);
  }
}
