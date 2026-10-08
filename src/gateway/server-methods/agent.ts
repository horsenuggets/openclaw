import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import type { GatewayRequestHandlers } from "./types.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { queueEmbeddedPiMessage } from "../../agents/pi-embedded.js";
import { resolveSandboxContext } from "../../agents/sandbox/context.js";
import { execDocker } from "../../agents/sandbox/docker.js";
import { agentCommand } from "../../commands/agent.js";
import { loadConfig } from "../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveExplicitAgentSessionKey,
  resolveAgentMainSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { resolveAssistantIdentity } from "../assistant-identity.js";
import { parseMessageWithAttachments } from "../chat-attachments.js";
import { resolveAssistantAvatarUrl } from "../control-ui-shared.js";
import { GATEWAY_CLIENT_CAPS, hasGatewayClientCap } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentIdentityParams,
  validateAgentParams,
  validateAgentSteerParams,
  validateAgentWaitParams,
} from "../protocol/index.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { waitForAgentJob } from "./agent-job.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";

/**
 * Directory a secret is readable at *inside the agent box* (the path the agent
 * is told to `cat`). In a Docker sandbox this is a path inside the container; in
 * direct mode it is on the host, under the gateway user.
 */
export const AGENT_SECRETS_DIR = "/tmp/secrets";

/** Validate a sanitized secret name can never escape the secrets directory. */
function assertSafeSecretName(name: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`invalid secret name: ${JSON.stringify(name)}`);
  }
}

/**
 * Write a secret to a host path with hardened, symlink-safe semantics: the
 * containing dir must be a real directory (not a symlink), and the target is
 * opened `O_NOFOLLOW` so a pre-planted symlink errors instead of redirecting the
 * write/chmod. Returns the path written. Used for both the direct-mode box path
 * and the transient host staging file that is `docker cp`-ed into a sandbox.
 */
function writeSecretFileHardened(dir: string, name: string, value: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir(recursive) is a no-op when the path already exists, so it cannot catch
  // a pre-planted symlink; lstat (does not follow the final component) does.
  if (!fs.lstatSync(dir).isDirectory()) {
    throw new Error(`secrets dir is not a real directory: ${dir}`);
  }
  const target = `${dir}/${name}`;
  // O_NOFOLLOW: a symlink at the target errors (ELOOP) rather than being
  // followed. fchmod on the open fd enforces 0600 even when overwriting an
  // existing regular file and can never be redirected by a swapped symlink.
  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, value);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return target;
}

/**
 * Deliver a secret into a running Docker sandbox at `/tmp/secrets/<name>`
 * (mode 0600). The value is staged in a 0600 host temp file and `docker cp`-ed
 * in (never passed as a process argument, so it does not leak via `ps`), then
 * the host staging file is removed. The in-container file is chmod 0600 after
 * copy. `docker cp` does not create intermediate dirs on a tmpfs root, so the
 * secrets dir is created first.
 */
async function writeAgentSecretToSandbox(
  containerName: string,
  name: string,
  value: string,
): Promise<string> {
  const target = `${AGENT_SECRETS_DIR}/${name}`;
  const staging = fs.mkdtempSync(`${os.tmpdir()}/openclaw-secret-`);
  const stagingFile = `${staging}/${name}`;
  try {
    writeSecretFileHardened(staging, name, value);
    await execDocker(["exec", containerName, "mkdir", "-p", "-m", "700", AGENT_SECRETS_DIR]);
    await execDocker(["cp", stagingFile, `${containerName}:${target}`]);
    await execDocker(["exec", containerName, "chmod", "600", target]);
  } finally {
    // Shred the host staging copy; the value must not linger on the host.
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

/**
 * Write an out-of-band secret so the channel's agent can read it at
 * `/tmp/secrets/<name>` (mode 0600). The name is already sanitized router-side;
 * a final guard rejects anything with a path separator. Re-writing the same name
 * overwrites in place. The value is never logged.
 *
 * Delivery depends on how the target session runs:
 * - **Sandboxed** (Docker): the agent's `/tmp` is a private tmpfs inside its
 *   container, so a host write would be invisible. The secret is copied into the
 *   session's own container (resolved from `sessionKey`), keeping it scoped to
 *   that agent and visible at the path the reminder names.
 * - **Direct mode**: the agent shares the gateway user's filesystem, so the
 *   secret is written to the host `/tmp/secrets/<name>` with symlink-safe,
 *   0600 semantics.
 *
 * `/tmp` is world-writable, so both paths defend against a hostile co-tenant
 * pre-planting a symlink at the dir or target (see {@link writeSecretFileHardened}).
 */
export async function writeAgentSecret(params: {
  name: string;
  value: string;
  sessionKey?: string;
  cfg?: ReturnType<typeof loadConfig>;
}): Promise<string> {
  const { name, value, sessionKey, cfg } = params;
  assertSafeSecretName(name);
  // Sandboxed sessions get the secret inside their own container; a host write
  // would land in the gateway's /tmp, which the container's tmpfs /tmp shadows.
  const sandbox = sessionKey
    ? await resolveSandboxContext({ config: cfg, sessionKey }).catch(() => null)
    : null;
  if (sandbox?.containerName) {
    return writeAgentSecretToSandbox(sandbox.containerName, name, value);
  }
  return writeSecretFileHardened(AGENT_SECRETS_DIR, name, value);
}

export const agentHandlers: GatewayRequestHandlers = {
  agent: async ({ params, respond, context, client }) => {
    const p = params;
    if (!validateAgentParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: ${formatValidationErrors(validateAgentParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      message: string;
      agentId?: string;
      to?: string;
      replyTo?: string;
      sessionId?: string;
      sessionKey?: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      channel?: string;
      replyChannel?: string;
      accountId?: string;
      replyAccountId?: string;
      threadId?: string;
      groupId?: string;
      groupChannel?: string;
      groupSpace?: string;
      lane?: string;
      extraSystemPrompt?: string;
      idempotencyKey: string;
      timeout?: number;
      label?: string;
      spawnedBy?: string;
      secret?: { name: string; value: string };
    };
    const cfg = loadConfig();
    const idem = request.idempotencyKey;
    const groupIdRaw = typeof request.groupId === "string" ? request.groupId.trim() : "";
    const groupChannelRaw =
      typeof request.groupChannel === "string" ? request.groupChannel.trim() : "";
    const groupSpaceRaw = typeof request.groupSpace === "string" ? request.groupSpace.trim() : "";
    let resolvedGroupId: string | undefined = groupIdRaw || undefined;
    let resolvedGroupChannel: string | undefined = groupChannelRaw || undefined;
    let resolvedGroupSpace: string | undefined = groupSpaceRaw || undefined;
    let spawnedByValue =
      typeof request.spawnedBy === "string" ? request.spawnedBy.trim() : undefined;
    const cached = context.dedupe.get(`agent:${idem}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const normalizedAttachments =
      request.attachments
        ?.map((a) => ({
          type: typeof a?.type === "string" ? a.type : undefined,
          mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined,
          fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
          content:
            typeof a?.content === "string"
              ? a.content
              : ArrayBuffer.isView(a?.content)
                ? Buffer.from(
                    a.content.buffer,
                    a.content.byteOffset,
                    a.content.byteLength,
                  ).toString("base64")
                : undefined,
        }))
        .filter((a) => a.content) ?? [];

    let message = request.message.trim();
    let images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    if (normalizedAttachments.length > 0) {
      try {
        const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
        });
        message = parsed.message.trim();
        images = parsed.images;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }

    // Inject timestamp into messages that don't already have one.
    // Channel messages (Discord, Telegram, etc.) get timestamps via envelope
    // formatting in a separate code path — they never reach this handler.
    // See: https://github.com/moltbot/moltbot/issues/3658
    message = injectTimestamp(message, timestampOptsFromConfig(cfg));

    const isKnownGatewayChannel = (value: string): boolean => isGatewayMessageChannel(value);
    const channelHints = [request.channel, request.replyChannel]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const rawChannel of channelHints) {
      const normalized = normalizeMessageChannel(rawChannel);
      if (normalized && normalized !== "last" && !isKnownGatewayChannel(normalized)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: unknown channel: ${String(normalized)}`,
          ),
        );
        return;
      }
    }

    const agentIdRaw = typeof request.agentId === "string" ? request.agentId.trim() : "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
    if (agentId) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: unknown agent id "${request.agentId}"`,
          ),
        );
        return;
      }
    }

    const requestedSessionKeyRaw =
      typeof request.sessionKey === "string" && request.sessionKey.trim()
        ? request.sessionKey.trim()
        : undefined;
    const requestedSessionKey =
      requestedSessionKeyRaw ??
      resolveExplicitAgentSessionKey({
        cfg,
        agentId,
      });
    if (agentId && requestedSessionKeyRaw) {
      const sessionAgentId = resolveAgentIdFromSessionKey(requestedSessionKeyRaw);
      if (sessionAgentId !== agentId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: agent "${request.agentId}" does not match session key agent "${sessionAgentId}"`,
          ),
        );
        return;
      }
    }
    let resolvedSessionId = request.sessionId?.trim() || undefined;
    let sessionEntry: SessionEntry | undefined;
    let bestEffortDeliver = false;
    let cfgForAgent: ReturnType<typeof loadConfig> | undefined;

    if (requestedSessionKey) {
      const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(requestedSessionKey);
      cfgForAgent = cfg;
      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      const labelValue = request.label?.trim() || entry?.label;
      spawnedByValue = spawnedByValue || entry?.spawnedBy;
      let inheritedGroup:
        | { groupId?: string; groupChannel?: string; groupSpace?: string }
        | undefined;
      if (spawnedByValue && (!resolvedGroupId || !resolvedGroupChannel || !resolvedGroupSpace)) {
        try {
          const parentEntry = loadSessionEntry(spawnedByValue)?.entry;
          inheritedGroup = {
            groupId: parentEntry?.groupId,
            groupChannel: parentEntry?.groupChannel,
            groupSpace: parentEntry?.space,
          };
        } catch {
          inheritedGroup = undefined;
        }
      }
      resolvedGroupId = resolvedGroupId || inheritedGroup?.groupId;
      resolvedGroupChannel = resolvedGroupChannel || inheritedGroup?.groupChannel;
      resolvedGroupSpace = resolvedGroupSpace || inheritedGroup?.groupSpace;
      const deliveryFields = normalizeSessionDeliveryFields(entry);
      const nextEntry: SessionEntry = {
        sessionId,
        updatedAt: now,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        systemSent: entry?.systemSent,
        sendPolicy: entry?.sendPolicy,
        skillsSnapshot: entry?.skillsSnapshot,
        deliveryContext: deliveryFields.deliveryContext,
        lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
        lastTo: deliveryFields.lastTo ?? entry?.lastTo,
        lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
        modelOverride: entry?.modelOverride,
        providerOverride: entry?.providerOverride,
        label: labelValue,
        spawnedBy: spawnedByValue,
        channel: entry?.channel ?? request.channel?.trim(),
        groupId: resolvedGroupId ?? entry?.groupId,
        groupChannel: resolvedGroupChannel ?? entry?.groupChannel,
        space: resolvedGroupSpace ?? entry?.space,
        cliSessionIds: entry?.cliSessionIds,
        claudeCliSessionId: entry?.claudeCliSessionId,
      };
      sessionEntry = nextEntry;
      const sendPolicy = resolveSendPolicy({
        cfg,
        entry,
        sessionKey: requestedSessionKey,
        channel: entry?.channel,
        chatType: entry?.chatType,
      });
      if (sendPolicy === "deny") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
        );
        return;
      }
      resolvedSessionId = sessionId;
      const canonicalSessionKey = canonicalKey;
      const agentId = resolveAgentIdFromSessionKey(canonicalSessionKey);
      const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
      if (storePath) {
        await updateSessionStore(storePath, (store) => {
          store[canonicalSessionKey] = nextEntry;
        });
      }
      if (canonicalSessionKey === mainSessionKey || canonicalSessionKey === "global") {
        context.addChatRun(idem, {
          sessionKey: requestedSessionKey,
          clientRunId: idem,
        });
        bestEffortDeliver = true;
      }
      registerAgentRunContext(idem, { sessionKey: requestedSessionKey });
    }

    const runId = idem;
    const connId = typeof client?.connId === "string" ? client.connId : undefined;
    const wantsToolEvents = hasGatewayClientCap(
      client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
    );
    if (connId && wantsToolEvents) {
      context.registerToolEventRecipient(runId, connId);
    }

    const wantsDelivery = request.deliver === true;
    const explicitTo =
      typeof request.replyTo === "string" && request.replyTo.trim()
        ? request.replyTo.trim()
        : typeof request.to === "string" && request.to.trim()
          ? request.to.trim()
          : undefined;
    const explicitThreadId =
      typeof request.threadId === "string" && request.threadId.trim()
        ? request.threadId.trim()
        : undefined;
    const deliveryPlan = resolveAgentDeliveryPlan({
      sessionEntry,
      requestedChannel: request.replyChannel ?? request.channel,
      explicitTo,
      explicitThreadId,
      accountId: request.replyAccountId ?? request.accountId,
      wantsDelivery,
    });

    const resolvedChannel = deliveryPlan.resolvedChannel;
    const deliveryTargetMode = deliveryPlan.deliveryTargetMode;
    const resolvedAccountId = deliveryPlan.resolvedAccountId;
    let resolvedTo = deliveryPlan.resolvedTo;

    if (!resolvedTo && isDeliverableMessageChannel(resolvedChannel)) {
      const cfgResolved = cfgForAgent ?? cfg;
      const fallback = resolveAgentOutboundTarget({
        cfg: cfgResolved,
        plan: deliveryPlan,
        targetMode: "implicit",
        validateExplicitTarget: false,
      });
      if (fallback.resolvedTarget?.ok) {
        resolvedTo = fallback.resolvedTo;
      }
    }

    const deliver = request.deliver === true && resolvedChannel !== INTERNAL_MESSAGE_CHANNEL;

    const accepted = {
      runId,
      status: "accepted" as const,
      acceptedAt: Date.now(),
    };
    // Store an in-flight ack so retries do not spawn a second run.
    context.dedupe.set(`agent:${idem}`, {
      ts: Date.now(),
      ok: true,
      payload: accepted,
    });
    respond(true, accepted, undefined, { runId });

    const resolvedThreadId = explicitThreadId ?? deliveryPlan.resolvedThreadId;

    // Out-of-band secret delivery (/secret command): make the value readable at
    // the agent box's /tmp/secrets/<name> (0600) BEFORE the turn runs, so the
    // accompanying system-reminder can point the agent at a file that already
    // exists. For sandboxed sessions this copies into the session's own
    // container (a host write would be shadowed by the container's tmpfs /tmp);
    // for direct sessions it writes the host path. Awaited so the file is in
    // place before agentCommand dispatches. The value is never logged. A failed
    // write is logged and the turn still proceeds (the reminder will be
    // inaccurate, but that degrades gracefully rather than wedging the run).
    if (request.secret) {
      try {
        await writeAgentSecret({
          name: request.secret.name,
          value: request.secret.value,
          sessionKey: requestedSessionKey,
          cfg: cfgForAgent ?? cfg,
        });
      } catch (err) {
        context.logGateway.warn(
          `agent: failed to write secret "${request.secret.name}": ${String(err)}`,
        );
      }
    }

    void agentCommand(
      {
        message,
        images,
        to: resolvedTo,
        sessionId: resolvedSessionId,
        sessionKey: requestedSessionKey,
        thinking: request.thinking,
        deliver,
        deliveryTargetMode,
        channel: resolvedChannel,
        accountId: resolvedAccountId,
        threadId: resolvedThreadId,
        runContext: {
          messageChannel: resolvedChannel,
          accountId: resolvedAccountId,
          groupId: resolvedGroupId,
          groupChannel: resolvedGroupChannel,
          groupSpace: resolvedGroupSpace,
          currentThreadTs: resolvedThreadId != null ? String(resolvedThreadId) : undefined,
        },
        groupId: resolvedGroupId,
        groupChannel: resolvedGroupChannel,
        groupSpace: resolvedGroupSpace,
        spawnedBy: spawnedByValue,
        timeout: request.timeout?.toString(),
        bestEffortDeliver,
        messageChannel: resolvedChannel,
        runId,
        lane: request.lane,
        extraSystemPrompt: request.extraSystemPrompt,
      },
      defaultRuntime,
      context.deps,
    )
      .then((result) => {
        const payload = {
          runId,
          status: "ok" as const,
          summary: "completed",
          result,
        };
        context.dedupe.set(`agent:${idem}`, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        // Send a second res frame (same id) so TS clients with expectFinal can wait.
        // Swift clients will typically treat the first res as the result and ignore this.
        respond(true, payload, undefined, { runId });
      })
      .catch((err) => {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
        const payload = {
          runId,
          status: "error" as const,
          summary: String(err),
        };
        context.dedupe.set(`agent:${idem}`, {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        });
        respond(false, payload, error, {
          runId,
          error: formatForLog(err),
        });
      });
  },
  "agent.identity.get": ({ params, respond }) => {
    if (!validateAgentIdentityParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.identity.get params: ${formatValidationErrors(
            validateAgentIdentityParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params;
    const agentIdRaw = typeof p.agentId === "string" ? p.agentId.trim() : "";
    const sessionKeyRaw = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
    let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
    if (sessionKeyRaw) {
      const resolved = resolveAgentIdFromSessionKey(sessionKeyRaw);
      if (agentId && resolved !== agentId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent.identity.get params: agent "${agentIdRaw}" does not match session key agent "${resolved}"`,
          ),
        );
        return;
      }
      agentId = resolved;
    }
    const cfg = loadConfig();
    const identity = resolveAssistantIdentity({ cfg, agentId });
    const avatarValue =
      resolveAssistantAvatarUrl({
        avatar: identity.avatar,
        agentId: identity.agentId,
        basePath: cfg.gateway?.controlUi?.basePath,
      }) ?? identity.avatar;
    respond(true, { ...identity, avatar: avatarValue }, undefined);
  },
  "agent.wait": async ({ params, respond }) => {
    if (!validateAgentWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.wait params: ${formatValidationErrors(validateAgentWaitParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const runId = p.runId.trim();
    const timeoutMs =
      typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs)
        ? Math.max(0, Math.floor(p.timeoutMs))
        : 30_000;

    const snapshot = await waitForAgentJob({
      runId,
      timeoutMs,
    });
    if (!snapshot) {
      respond(true, {
        runId,
        status: "timeout",
      });
      return;
    }
    respond(true, {
      runId,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
      error: snapshot.error,
    });
  },
  "agent.steer": ({ params, respond }) => {
    if (!validateAgentSteerParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.steer params: ${formatValidationErrors(validateAgentSteerParams.errors)}`,
        ),
      );
      return;
    }
    // Inject a message into the session's in-flight run (if one is actively
    // streaming) so the agent sees it mid-turn instead of only on the next turn.
    // `accepted` is false when there is no active streaming run for the session —
    // the caller then falls back to starting a normal turn. The injected
    // message's reply is delivered through the already-running turn, so this
    // handler never produces output itself.
    const sessionKey = params.sessionKey.trim();
    const { cfg, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    // Honor the session send policy, like the `agent` / `chat.send` paths: never
    // inject into a disabled session. Decline (accepted:false) rather than error
    // so the caller's fallback turn hits the same check and is rejected there.
    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    // "steer" mode: deliver at the next tool boundary and skip the agent's
    // remaining planned tools so it reacts to this message promptly, rather than
    // only after the whole in-flight turn finishes (that is the point of a steer).
    const accepted =
      sessionId && sendPolicy !== "deny"
        ? queueEmbeddedPiMessage(sessionId, params.message, "steer")
        : false;
    respond(true, { accepted });
  },
};
