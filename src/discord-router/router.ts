import { Routes } from "discord-api-types/v10";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";
import type { AgentCommand } from "./agent-commands.js";
import type { RouterConfig, InstanceConfig } from "./config.js";
import { stripHorizontalRules } from "../discord/markdown-strip.js";
import { convertTimesToDiscordTimestamps } from "../discord/timestamps.js";
import { convertMarkdownTables } from "../markdown/tables.js";
import { parseAgentCommand, unescapeAgentText } from "./agent-commands.js";
import {
  CHANNEL_COMMAND_SPEC,
  type ChannelCommandDeps,
  type ChannelReplyPayload,
  type DiscordActionRow,
  type DiscordEmbed,
  type InstanceStatus,
  type ProvisioningClient,
  handleChannelCommand,
  handleUnregisterButtonClick,
  parseChannelTextCommand,
  parseUnregisterCustomId,
} from "./channel-commands.js";
import { loadRouterConfig, refreshToken, setUserPreference } from "./config.js";
import { startContainerProxyServer } from "./container-proxy.js";
import { callGatewaySimple } from "./gateway-call.js";
import { createHttpProvisioningClient } from "./provisioning.js";
import { createWhitelistChecker } from "./whitelist.js";

/** Runs a control command emitted by the agent; returns a result string to
 * relay back to the agent, or null for a no-op (no relay). */
export type RunAgentCommand = (
  cmd: AgentCommand,
  ctx: { channelId: string; instance: InstanceConfig; authorId: string },
) => Promise<string | null>;

const WELCOME_EMBED = {
  title: "Welcome to OpenClaw!",
  description:
    "I'm your personal everything-assistant. Let's get you set up!\nI'll ask you a few quick questions to personalize your experience.",
  color: 0xffff80,
};

export type RouterRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/** Workspace-relative path of the first-run checklist. */
const BOOTSTRAP_RELATIVE_PATH = "workspace/BOOTSTRAP.md";

/** True once the first-run checklist file is still present (setup in progress). */
function bootstrapExists(instance: InstanceConfig): boolean {
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
function readBootstrapDirective(instance: InstanceConfig): string | null {
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

const TYPING_INTERVAL_MS = 8_000;
const DISCORD_API = "https://discord.com/api/v10";

/**
 * The only bot-authored channel messages that are NOT replies to a user message:
 * the health-monitor sidecar's lifecycle banners (gated behind the per-instance
 * `lifecycleMessages` preference). Recovery skips exactly these so it can find a
 * genuinely-unanswered user message beneath them. Every OTHER bot message —
 * including error replies like "*Something went wrong...*" — means the user's
 * message was already handled and must NOT be skipped; otherwise recovery
 * re-runs the same failing message on every reconnect (an endless error loop).
 */
export const LIFECYCLE_BANNERS = ["*Back online.*", "*Shutting down...*"];

export function isLifecycleBanner(content: string | undefined): boolean {
  return LIFECYCLE_BANNERS.includes((content ?? "").trim());
}

export type RouterErrorKind = "connection-refused" | "auth" | "timeout" | "generic";

/**
 * Classify an error thrown while routing a message to an agent container so the
 * router can respond appropriately. Auth/config failures (missing key, expired
 * or rotated OAuth token) are admin problems, NOT something the user can fix by
 * retrying, so they are surfaced as "auth" (logged, not echoed to the user as a
 * generic "try again") rather than falling through to "generic".
 */
export function classifyRouterError(errMsg: string): RouterErrorKind {
  if (errMsg.includes("ECONNREFUSED")) {
    return "connection-refused";
  }
  if (
    errMsg.includes("unauthorized") ||
    errMsg.includes("token_mismatch") ||
    errMsg.includes("pairing") ||
    errMsg.includes("No API key") ||
    errMsg.includes("invalid_grant") ||
    errMsg.includes("OAuth token refresh failed") ||
    errMsg.includes("re-authenticate")
  ) {
    return "auth";
  }
  if (errMsg.includes("timeout") || errMsg.includes("ETIMEDOUT")) {
    return "timeout";
  }
  return "generic";
}

/**
 * Start the Discord router using raw WebSocket connection to Discord gateway.
 * Listens for DMs and forwards them to per-user Docker containers via gateway API.
 */
export async function startRouter(config: RouterConfig, runtime: RouterRuntime): Promise<void> {
  const { discordToken, instances, agentTimeoutMs } = config;

  // Resolve application ID
  const appIdResponse = (await fetch(`${DISCORD_API}/applications/@me`, {
    headers: { Authorization: `Bot ${discordToken}` },
  }).then((r) => r.json())) as { id?: string };
  const applicationId = appIdResponse?.id;
  if (!applicationId) {
    throw new Error("Failed to resolve Discord application ID");
  }
  runtime.log(`[router] application id: ${applicationId}`);
  runtime.log(`[router] instances: ${instances.size}`);
  for (const [channelId, inst] of instances) {
    runtime.log(`  channel ${channelId} → localhost:${inst.port}`);
  }

  // Register slash commands
  await fetch(`${DISCORD_API}/applications/${applicationId}/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${discordToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "lifecycle",
      description: "Show or set startup/shutdown notification messages",
      type: 1,
      options: [
        {
          name: "setting",
          description: "on, off, or omit to see current status",
          type: 3, // STRING
          required: false,
          choices: [
            { name: "on", value: "on" },
            { name: "off", value: "off" },
          ],
        },
      ],
    }),
  }).catch((err) =>
    runtime.error(`[router] failed to register /lifecycle command: ${String(err)}`),
  );

  // Register the /channel management command (register/status/unregister).
  await fetch(`${DISCORD_API}/applications/${applicationId}/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${discordToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(CHANNEL_COMMAND_SPEC),
  }).catch((err) => runtime.error(`[router] failed to register /channel command: ${String(err)}`));

  // Get gateway URL
  const gatewayInfo = (await fetch(`${DISCORD_API}/gateway/bot`, {
    headers: { Authorization: `Bot ${discordToken}` },
  }).then((r) => r.json())) as { url?: string };
  const gatewayUrl = gatewayInfo?.url ?? "wss://gateway.discord.gg";

  // Start the container proxy server: agent containers POST here to send/read
  // Discord messages via the router (network_mode host, loopback only).
  const proxy = startContainerProxyServer({
    runtime,
    discordSend: async (channelId, content) => {
      await discordSend(discordToken, channelId, content);
      return {};
    },
    openDMChannel: (userId) => openDMChannel(discordToken, userId),
    discordSendEmbed: (channelId, embed) => discordSendEmbed(discordToken, channelId, embed),
    routeMessage: (userId, channelId, message) => {
      const instance = instances.get(channelId);
      if (!instance) {
        return Promise.resolve();
      }
      return routeMessage({
        authorId: userId,
        channelId,
        messageContent: message,
        instance,
        discordToken,
        runtime,
        agentTimeoutMs,
        inflight,
        runCommand: runAgentCommand,
      }).then(() => {});
    },
  });

  const inflight = new Set<string>();
  // Best-effort channel -> guild map, learned from message/interaction events.
  // Used to tear down a guild's instances on GUILD_DELETE, where Discord does
  // not emit a CHANNEL_DELETE per channel and instances carry no guild id.
  const channelGuild = new Map<string, string>();
  // Discord message IDs that recovery has already attempted this process. Auth/
  // config failures intentionally post no reply, so without this the same
  // message would look "unanswered" and be silently re-run on every reconnect.
  // A process restart legitimately re-attempts once (the set starts empty).
  const recoveredMessageIds = new Set<string>();

  // --- /channel command wiring ---
  const whitelist = createWhitelistChecker({
    discordToken,
    guildId: process.env.OPENCLAW_AUTH_GUILD_ID,
    roleId: process.env.OPENCLAW_WHITELIST_ROLE_ID,
    adminRoleId: process.env.OPENCLAW_ADMIN_ROLE_ID,
    log: (message) => runtime.log(message),
  });

  // Read-only view of an instance for `/channel status`. Owner is stored by the
  // provisioner in .onboarding.json; onboarded == first-run BOOTSTRAP.md gone.
  const describeInstance = (channelId: string): InstanceStatus | null => {
    const inst = instances.get(channelId);
    if (!inst) {
      return null;
    }
    let ownerId: string | undefined;
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(inst.instanceDir, ".onboarding.json"), "utf-8"),
      );
      ownerId = typeof raw?.ownerId === "string" ? raw.ownerId : undefined;
    } catch {
      // no owner recorded yet
    }
    return { port: inst.port, ownerId, onboarded: !bootstrapExists(inst) };
  };

  // Reconcile the in-memory instance map with disk. The map is built once at
  // startup, so after the daemon creates/removes an instance we re-scan so the
  // channel becomes (or stops being) routable immediately, without a restart.
  const reloadInstances = () => {
    try {
      const fresh = loadRouterConfig({ instancesDir: config.instancesDir, discordToken });
      for (const [id, inst] of fresh.instances) {
        instances.set(id, inst);
      }
      const removed: string[] = [];
      for (const id of instances.keys()) {
        if (!fresh.instances.has(id)) {
          removed.push(id);
        }
      }
      for (const id of removed) {
        instances.delete(id);
      }
      runtime.log(`[router] instances reloaded: ${instances.size}`);
    } catch (err) {
      runtime.error(`[router] instance reload failed: ${String(err)}`);
    }
  };

  // Provisioning needs host/Docker access the router lacks, so register/
  // unregister go to the host daemon (discord-provisioner) over loopback when
  // it is configured. Without the daemon env, it fails closed (unavailable).
  const provisionerPort = process.env.OPENCLAW_PROVISIONER_PORT;
  const provisionerToken = process.env.OPENCLAW_PROVISIONER_TOKEN;
  const stubProvisioning: ProvisioningClient = {
    register: async () => ({
      ok: false,
      message: "Registration is not available on this deployment (provisioning service not wired).",
    }),
    unregister: async () => ({
      ok: false,
      message:
        "Unregistration is not available on this deployment (provisioning service not wired).",
    }),
  };
  const daemonProvisioning =
    provisionerPort && provisionerToken
      ? createHttpProvisioningClient({
          baseUrl: `http://127.0.0.1:${provisionerPort}`,
          token: provisionerToken,
          log: (message) => runtime.log(message),
        })
      : null;
  // Reconcile the instance map after any successful provisioning change.
  const provisioning: ProvisioningClient = daemonProvisioning
    ? {
        register: async (p) => {
          const result = await daemonProvisioning.register(p);
          if (result.ok) {
            reloadInstances();
          }
          return result;
        },
        unregister: async (p) => {
          const result = await daemonProvisioning.unregister(p);
          if (result.ok) {
            reloadInstances();
          }
          return result;
        },
      }
    : stubProvisioning;

  const channelCommandDeps: ChannelCommandDeps = {
    isWhitelisted: whitelist.isWhitelisted,
    isAdmin: whitelist.isAdmin,
    whitelistConfigured: whitelist.isConfigured,
    describeInstance,
    // The router shares the host network, so the agent container's port is
    // reachable on loopback; a quick TCP connect tells `/channel status`
    // whether the agent is actually up.
    probeRunning: (port) => probePort(port),
    provisioning,
    log: (message) => runtime.log(message),
  };

  // When a Discord channel with a registered instance is deleted (or the bot is
  // removed from a guild), tear the instance down through the same provisioning
  // path `/channel unregister` uses.
  const cleanupDeletedChannel = (channelId: string, reason: string): void => {
    void handleChannelDeleted(channelId, reason, {
      describeInstance,
      provisioning,
      log: (message) => runtime.log(message),
      error: (message) => runtime.error(message),
    });
  };

  // Dispatches the agent's `⁘` control commands to host-side actions the agent
  // cannot do itself (posting official Discord embeds and buttons).
  const runAgentCommand: RunAgentCommand = async (cmd, ctx) => {
    const { channelId } = ctx;
    if (cmd.command === "return") {
      return null; // deliberate no-op, nothing to relay
    }
    if (cmd.command === "send_hook_embed") {
      const name = cmd.args[0];
      if (name === "welcome") {
        await discordSendEmbed(discordToken, channelId, WELCOME_EMBED);
        return "welcome card sent";
      }
      return `error: unknown embed "${name ?? ""}"`;
    }
    return `error: unknown command "${cmd.command}"`;
  };

  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let lastSequence: number | null = null;
  let sessionId: string | undefined;
  let resumeGatewayUrl: string | undefined;
  let shuttingDown = false;

  // Observability for the gateway reconnect path. `connectionSeq` counts how
  // many sockets we have opened; `liveSockets` counts how many are currently
  // open. If a single disconnect ever pushes `liveSockets` above 1, we are
  // running concurrent gateway connections and will trip Discord's IDENTIFY
  // rate limit.
  let connectionSeq = 0;
  let liveSockets = 0;

  // Reconnect is owned by a single scheduler: the authoritative socket's
  // "close" handler. op 7 / op 9 only close the socket, and the close path
  // funnels through `scheduleReconnect`, which is idempotent: if a reconnect
  // is already pending it does nothing. This prevents the double-schedule
  // that used to open two concurrent sockets per disconnect and spiral past
  // Discord's IDENTIFY rate limit.
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempts = 0;
  // The socket the router currently considers authoritative. Events from any
  // earlier socket (e.g. a lingering close after we already moved on) are
  // ignored so a stale socket can't drive reconnect logic.
  let currentWs: WebSocket | undefined;

  function scheduleReconnect(resume: boolean, reason: string) {
    if (shuttingDown) {
      return;
    }
    if (reconnectTimer) {
      runtime.log(`[router] reconnect already pending, ignoring (reason=${reason})`);
      return;
    }
    // Jittered exponential backoff. Discord allows one IDENTIFY per 5s, so the
    // base is floored at 5s and jitter is added *on top* (never subtracted) so
    // the delay can never dip below 5s. The final value is clamped to 30s.
    const base = Math.min(30_000, 5_000 * 2 ** reconnectAttempts);
    const jitter = Math.floor(Math.random() * 5_000);
    const delay = Math.min(30_000, base + jitter);
    reconnectAttempts += 1;
    runtime.log(`[router] scheduling reconnect (reason=${reason}, resume=${resume}) in ${delay}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      // Re-check in case SIGINT/SIGTERM arrived while the timer was pending;
      // we must not open a fresh socket after shutdown has begun.
      if (shuttingDown) {
        return;
      }
      connect(resume);
    }, delay);
  }

  function connect(resume = false) {
    connectionSeq += 1;
    liveSockets += 1;
    const attempt = connectionSeq;
    runtime.log(
      `[router] connect() attempt #${attempt} (resume=${resume}, liveSockets=${liveSockets})`,
    );
    const url = resume && resumeGatewayUrl ? resumeGatewayUrl : gatewayUrl;
    const ws = new WebSocket(`${url}/?v=10&encoding=json`);
    currentWs = ws;

    ws.on("open", () => {
      runtime.log(`[router] WebSocket connected to ${url}`);
    });

    ws.on("message", (raw: Buffer) => {
      // Ignore anything arriving on a socket we've already superseded.
      if (ws !== currentWs) {
        return;
      }
      const payload = JSON.parse(raw.toString());
      const { op, d, s, t } = payload;

      if (s !== null && s !== undefined) {
        lastSequence = s;
      }

      switch (op) {
        case 10: {
          // Hello — start heartbeating
          const interval = d.heartbeat_interval;
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
          }
          heartbeatInterval = setInterval(() => {
            ws.send(JSON.stringify({ op: 1, d: lastSequence }));
          }, interval);
          // Send initial heartbeat
          ws.send(JSON.stringify({ op: 1, d: lastSequence }));

          if (resume && sessionId) {
            // Resume
            ws.send(
              JSON.stringify({
                op: 6,
                d: { token: `Bot ${discordToken}`, session_id: sessionId, seq: lastSequence },
              }),
            );
          } else {
            // Identify
            ws.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: `Bot ${discordToken}`,
                  intents:
                    (1 << 0) | // GUILDS
                    (1 << 9) | // GUILD_MESSAGES
                    (1 << 12) | // DIRECT_MESSAGES
                    (1 << 15), // MESSAGE_CONTENT
                  properties: {
                    os: "linux",
                    browser: "openclaw-router",
                    device: "openclaw-router",
                  },
                },
              }),
            );
          }
          break;
        }
        case 11:
          // Heartbeat ACK
          break;
        case 0: {
          // Dispatch
          // Both READY (fresh identify) and RESUMED (successful resume) mean the
          // connection is healthy again — reset backoff so the next disconnect
          // retries promptly rather than inheriting a long stale delay. RESUMED
          // does not carry session fields, so only READY (re)initializes them.
          if (t === "READY" || t === "RESUMED") {
            reconnectAttempts = 0;
          }
          if (t === "READY") {
            sessionId = d.session_id;
            resumeGatewayUrl = d.resume_gateway_url;
            const botUser = d.user;
            runtime.log(`[router] logged in as ${botUser?.id ?? "unknown"} (${botUser?.username})`);

            // Lifecycle messages ("Back online") handled by health-monitor sidecar.

            // Startup recovery: answer any DM messages left unanswered while the
            // router was down. Delay to let containers finish starting.
            setTimeout(async () => {
              await recoverUnansweredMessages(
                discordToken,
                instances,
                runtime,
                agentTimeoutMs,
                inflight,
                runAgentCommand,
                recoveredMessageIds,
                // Apply the same guild access control as live messages so a
                // non-owner's message in a shared guild channel is not replayed
                // to the agent on restart.
                (channelId, userId) =>
                  isAuthorizedForChannel(channelId, userId, {
                    describeInstance,
                    isWhitelisted: whitelist.isWhitelisted,
                  }),
              );
            }, 10_000);
          }

          if (t === "MESSAGE_CREATE") {
            const authorId = d.author?.id;
            const isBot = d.author?.bot === true;
            const guildId = d.guild_id;
            let content = d.content ?? "";
            const channelId = d.channel_id;

            // Learn the channel's guild so GUILD_DELETE can tear down its
            // instances (see channelGuild above).
            if (channelId && guildId) {
              channelGuild.set(channelId, guildId);
            }

            // Collect attachments (voice messages, images, files)
            const rawAttachments = (d.attachments ?? []) as Array<{
              id: string;
              filename: string;
              content_type?: string;
              url: string;
              size: number;
            }>;
            const hasAttachments = rawAttachments.length > 0;

            // Include reply context so the agent knows what message is being responded to
            const ref = d.referenced_message;
            if (ref && typeof ref === "object") {
              const refAuthor = ref.author?.username ?? "unknown";
              const refContent = (ref.content ?? "").slice(0, 500);
              if (refContent) {
                content = `[Replying to ${refAuthor}: "${refContent}"]\n${content}`;
              }
            }

            runtime.log(
              `[router] MESSAGE_CREATE: author=${authorId} guild=${guildId ?? "dm"} reply=${!!ref} attachments=${rawAttachments.length} content=${content.slice(0, 60)}`,
            );

            // `/channel` management commands must work even when the channel is
            // not registered yet (register is the whole point) AND even when the
            // author is a bot (e.g. an automated tester bot, which cannot invoke
            // slash commands), so handle them before both the bot filter and the
            // registered-instance gate below. register/unregister stay
            // whitelist-gated inside handleChannelCommand: authorization is the
            // configured auth-guild role, applied uniformly to bots and humans.
            // A bot can therefore provision only if it has been granted that
            // role (the intended setup for a trusted tester/automation bot);
            // untrusted bots without the role are rejected exactly like
            // untrusted humans. status stays open to everyone.
            const channelCmd = authorId ? parseChannelTextCommand(content) : null;
            if (channelCmd && authorId) {
              const commandMessageId = d.id;
              void handleChannelCommand(
                {
                  subcommand: channelCmd.subcommand,
                  args: channelCmd.args,
                  channelId,
                  userId: authorId,
                  isDM: !guildId,
                  // Bots cannot send true ephemeral messages outside an
                  // interaction. Reply as a real Discord reply (referencing the
                  // command message) so status/denials thread under the command
                  // and embeds render. Ephemeral hints still fall back to an
                  // auto-deleting plain message (only strings can auto-delete
                  // cleanly; embeds are always full replies).
                  reply: (payload, opts) =>
                    opts?.ephemeral && typeof payload === "string"
                      ? discordSendEphemeral(discordToken, channelId, payload)
                      : discordSendReply(discordToken, channelId, commandMessageId, payload),
                },
                channelCommandDeps,
              );
              runtime.log(
                `[router] /channel ${channelCmd.subcommand ?? ""} from ${authorId} in ${channelId} (msg ${commandMessageId})`,
              );
              return;
            }

            // Normal agent messages: ignore bots and empty messages. Channel
            // commands were already handled above so bots can still drive them.
            if (!authorId || isBot || (!content.trim() && !hasAttachments)) {
              return;
            }

            const instance = instances.get(channelId);
            if (!instance) {
              // Only respond in DMs (no guild_id), silently ignore unregistered guild channels
              if (!guildId) {
                void discordSendEphemeral(
                  discordToken,
                  channelId,
                  "*This channel is not registered.*",
                );
              }
              return;
            }

            // Route the message to the instance (text-command fallback first,
            // then the agent). Onboarding (including offering Google) is driven
            // by the agent's BOOTSTRAP.md checklist and the `⁘` command channel,
            // not by a router-side state machine.
            const routeInstanceMessage = (): void => {
              const commandMatch = content.trim().match(/^\/\/?(\w+)(?:\s+(.*))?$/);
              if (commandMatch) {
                const cmdName = commandMatch[1].toLowerCase();
                const cmdArg = commandMatch[2]?.trim().toLowerCase();
                const messageId = d.id;
                void handleTextCommand({
                  cmdName,
                  cmdArg,
                  userId: authorId,
                  channelId,
                  messageId,
                  instance,
                  discordToken,
                  runtime,
                }).then((handled) => {
                  if (!handled) {
                    void routeMessage({
                      authorId,
                      channelId,
                      messageContent: content,
                      attachments: rawAttachments,
                      instance,
                      discordToken,
                      runtime,
                      agentTimeoutMs,
                      inflight,
                      runCommand: runAgentCommand,
                    });
                  }
                });
                return;
              }

              void routeMessage({
                authorId,
                channelId,
                messageContent: content,
                attachments: rawAttachments,
                instance,
                discordToken,
                runtime,
                agentTimeoutMs,
                inflight,
                runCommand: runAgentCommand,
              });
            };

            // Access control. DMs are inherently 1:1 with the owner, so they
            // pass through untouched (onboarding a brand-new user happens here).
            // In a shared guild channel, restrict conversation to the channel
            // owner (the user it was registered for) or a whitelisted admin, so
            // other members cannot hijack someone else's agent. Fail closed.
            if (guildId) {
              void isAuthorizedForChannel(channelId, authorId, {
                describeInstance,
                isWhitelisted: whitelist.isWhitelisted,
              }).then((allowed) => {
                if (!allowed) {
                  runtime.log(
                    `[router] denied message from ${authorId} in channel ${channelId} (not owner or whitelisted)`,
                  );
                  void discordSendEphemeral(
                    discordToken,
                    channelId,
                    "*You are not authorized to use this channel's agent.*",
                  );
                  return;
                }
                routeInstanceMessage();
              });
              return;
            }

            routeInstanceMessage();
          }

          // Handle slash command interactions
          if (t === "INTERACTION_CREATE" && d.type === 2) {
            const interactionData = d.data;
            const interactionChannelId = d.channel_id;
            const interactionToken = d.token;
            const interactionId = d.id;

            // Learn the channel's guild from interactions too (e.g. a channel
            // registered via `/channel register` before any message is sent), so
            // GUILD_DELETE can still tear its instance down (see channelGuild).
            if (interactionChannelId && d.guild_id) {
              channelGuild.set(interactionChannelId, d.guild_id);
            }

            // Helper to respond to interactions (always ephemeral). Accepts a
            // plain string (content) or an embeds payload from a channel
            // command; either way keeps the ephemeral flag (64).
            const respondToInteraction = (payload: ChannelReplyPayload) => {
              const data =
                typeof payload === "string"
                  ? { content: payload, flags: 64 }
                  : {
                      embeds: payload.embeds,
                      ...(payload.components ? { components: payload.components } : {}),
                      flags: 64,
                    };
              void fetch(
                `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    type: 4,
                    data,
                  }),
                },
              )
                .then((resp) => {
                  if (!resp.ok) {
                    runtime.error(`[router] interaction response failed (${resp.status})`);
                  }
                })
                .catch((err) =>
                  runtime.error(`[router] interaction response failed: ${String(err)}`),
                );
            };

            if (interactionData?.name === "lifecycle" && interactionChannelId) {
              const instance = instances.get(interactionChannelId);
              if (!instance) {
                respondToInteraction("*This channel is not registered.*");
                return;
              }

              const current = instance.preferences.lifecycleMessages ?? false;
              const setting = (
                interactionData.options as Array<{ name: string; value: string }> | undefined
              )?.find((o: { name: string }) => o.name === "setting")?.value;

              let statusText: string;
              if (setting === "on") {
                setUserPreference(instance, "lifecycleMessages", true);
                statusText =
                  "Lifecycle messages **enabled**. You'll see *Back online.* and *Shutting down...* messages.";
              } else if (setting === "off") {
                setUserPreference(instance, "lifecycleMessages", false);
                statusText =
                  "Lifecycle messages **disabled**. You won't see startup/shutdown notifications.";
              } else {
                statusText = current
                  ? "Lifecycle messages are currently **enabled**. Use `/lifecycle off` to disable."
                  : "Lifecycle messages are currently **disabled**. Use `/lifecycle on` to enable.";
              }

              respondToInteraction(statusText);
              runtime.log(
                `[router] lifecycle for channel ${interactionChannelId}: setting=${setting ?? "status"} result=${setting === "on" ? "true" : setting === "off" ? "false" : String(current)}`,
              );
            }

            if (interactionData?.name === "channel" && interactionChannelId) {
              // Subcommand + its options (e.g. unregister confirm) live one level
              // down in the interaction options tree.
              const subOpt = (
                interactionData.options as
                  | Array<{
                      name: string;
                      options?: Array<{ name: string; value: string | number | boolean }>;
                    }>
                  | undefined
              )?.[0];
              // A subcommand carries at most one relevant option: register's
              // optional `owner` (a user id) or unregister's optional `confirm`.
              // Either becomes args[0], interpreted per subcommand downstream.
              const args: string[] = [];
              const owner = subOpt?.options?.find((o) => o.name === "owner")?.value;
              if (owner !== undefined) {
                args.push(String(owner));
              }
              const confirm = subOpt?.options?.find((o) => o.name === "confirm")?.value;
              if (confirm !== undefined) {
                args.push(String(confirm));
              }
              const userId = (d.member?.user?.id ?? d.user?.id) as string | undefined;
              if (userId) {
                // Acknowledge immediately with a deferred (ephemeral) response:
                // register can take up to the daemon's command timeout plus
                // readiness polling, well beyond Discord's ~3s window. The
                // result is then delivered by editing the deferred reply.
                void fetch(
                  `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ type: 5, data: { flags: 64 } }),
                  },
                ).catch((err) => runtime.error(`[router] channel defer failed: ${String(err)}`));
                const editReply = (payload: ChannelReplyPayload) => {
                  const body =
                    typeof payload === "string"
                      ? { content: payload }
                      : {
                          embeds: payload.embeds,
                          // Always send components so an updated reply can also
                          // clear a previous action row (e.g. the confirm button).
                          components: payload.components ?? [],
                        };
                  void fetch(
                    `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
                    {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(body),
                    },
                  )
                    .then((resp) => {
                      if (!resp.ok) {
                        runtime.error(`[router] channel followup failed (${resp.status})`);
                      }
                    })
                    .catch((err) =>
                      runtime.error(`[router] channel followup failed: ${String(err)}`),
                    );
                };
                void handleChannelCommand(
                  {
                    subcommand: subOpt?.name ?? null,
                    args,
                    channelId: interactionChannelId,
                    userId,
                    isDM: !d.guild_id,
                    reply: (payload) => editReply(payload),
                  },
                  channelCommandDeps,
                );
              }
            }
          }

          // Handle message-component interactions (buttons). Currently only the
          // `/channel unregister` confirmation buttons.
          if (t === "INTERACTION_CREATE" && d.type === 3) {
            const customId = d.data?.custom_id as string | undefined;
            const parsed = customId ? parseUnregisterCustomId(customId) : null;
            const clickerId = (d.member?.user?.id ?? d.user?.id) as string | undefined;
            const interactionId = d.id;
            const interactionToken = d.token;
            if (d.channel_id && d.guild_id) {
              channelGuild.set(d.channel_id, d.guild_id);
            }

            if (parsed && clickerId && customId) {
              if (parsed.initiatorId !== clickerId) {
                // Someone other than the initiator clicked: reply ephemerally
                // and leave the original confirmation message untouched.
                void fetch(
                  `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      type: 4,
                      data: { content: "This confirmation isn't for you.", flags: 64 },
                    }),
                  },
                ).catch((err) => runtime.error(`[router] button response failed: ${String(err)}`));
              } else {
                // Defer the message update (type 6) so a slow unregister does
                // not blow Discord's ~3s response window, then edit the original
                // confirmation message with the result and drop the buttons.
                void fetch(
                  `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ type: 6 }),
                  },
                ).catch((err) => runtime.error(`[router] button defer failed: ${String(err)}`));
                void handleUnregisterButtonClick({ customId, clickerId }, channelCommandDeps).then(
                  (result) => {
                    if (!result.update) {
                      return;
                    }
                    void fetch(
                      `${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
                      {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          embeds: result.update.embeds,
                          components: result.update.components satisfies DiscordActionRow[],
                        }),
                      },
                    )
                      .then((resp) => {
                        if (!resp.ok) {
                          runtime.error(`[router] button followup failed (${resp.status})`);
                        }
                      })
                      .catch((err) =>
                        runtime.error(`[router] button followup failed: ${String(err)}`),
                      );
                  },
                );
              }
            }
          }

          // A guild channel (or thread) was deleted. If it had a registered
          // instance, tear it down so we don't keep a dead route around.
          if (t === "CHANNEL_DELETE" || t === "THREAD_DELETE") {
            const deletedChannelId = d.id;
            if (deletedChannelId) {
              // Drop the learned guild mapping so deleted channels don't
              // accumulate as stale entries on a long-lived router.
              channelGuild.delete(deletedChannelId);
              cleanupDeletedChannel(deletedChannelId, t.toLowerCase());
            }
          }

          // The bot was removed from a guild (or the guild was deleted). Tear
          // down every registered instance that lived in that guild. GUILD_DELETE
          // with `unavailable: true` is a transient outage, not a removal, so we
          // ignore it and keep the instances.
          if (t === "GUILD_DELETE" && d?.unavailable !== true) {
            const deletedGuildId = d.id;
            if (deletedGuildId) {
              for (const [channelId, guildId] of channelGuild) {
                if (guildId === deletedGuildId) {
                  channelGuild.delete(channelId);
                  cleanupDeletedChannel(channelId, "guild_delete");
                }
              }
            }
          }
          break;
        }
        case 7:
          // Reconnect requested. Just close; the "close" handler owns the
          // single reconnect. sessionId stays set so it resumes.
          runtime.log(`[router] reconnect requested by Discord (attempt #${attempt})`);
          ws.close();
          break;
        case 9:
          // Invalid session. Discord's `d` indicates whether the session is
          // still resumable. Preserve resumable sessions; otherwise drop
          // session/sequence so the reconnect re-identifies from scratch.
          if (d === false) {
            sessionId = undefined;
            lastSequence = null;
          }
          runtime.log(
            `[router] invalid session (resumable=${d === true}), reconnecting (attempt #${attempt})`,
          );
          ws.close();
          break;
      }
    });

    ws.on("close", (code: number) => {
      liveSockets = Math.max(0, liveSockets - 1);
      runtime.log(
        `[router] WebSocket closed (${code}) (attempt #${attempt}, liveSockets=${liveSockets})`,
      );
      // Ignore a close from a socket we've already superseded — only the
      // authoritative socket may drive reconnection. Guarding *before* the
      // heartbeat cleanup is essential: `heartbeatInterval` is shared and owned
      // by the current socket, so a late close from a stale socket must not
      // clear it or the live connection would silently stop heartbeating.
      if (ws !== currentWs) {
        return;
      }
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
      }
      // Always reconnect — Discord sends 1000/1001 for routine reconnects.
      // Only process exit (SIGINT/SIGTERM) should stop the router.
      if (!shuttingDown) {
        if (code === 4004) {
          runtime.error("[router] authentication failed (4004), not reconnecting");
          return;
        }
        // Resume when we still hold a session (routine reconnect / op 7);
        // re-identify when op 9 cleared it.
        scheduleReconnect(!!sessionId, `close-${code}`);
      }
    });

    ws.on("error", (err: Error) => {
      runtime.error(`[router] WebSocket error: ${err.message}`);
    });
  }

  connect(false);

  // Keep running until process exit
  await new Promise<void>((resolve) => {
    let shutdownStarted = false;
    const shutdown = () => {
      if (shutdownStarted) {
        return;
      }
      shutdownStarted = true;
      shuttingDown = true;
      // Cancel any pending reconnect so we don't open a socket post-shutdown.
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
      }
      if (currentWs) {
        currentWs.close();
      }
      proxy.server.close((err) => {
        if (err) {
          runtime.error(`[router] failed to close container proxy server: ${String(err)}`);
        }
      });
      // Lifecycle messages ("Shutting down") handled by health-monitor sidecar.
      resolve();
    };
    process.once("SIGINT", () => shutdown());
    process.once("SIGTERM", () => shutdown());
  });
}

/** Deps for {@link isAuthorizedForChannel}; kept minimal for unit testing. */
export type ChannelAuthDeps = {
  describeInstance: (channelId: string) => InstanceStatus | null;
  isWhitelisted: (userId: string) => Promise<boolean>;
};

/**
 * Decide whether a user may converse with a registered channel's agent. Allowed
 * when the user is the channel owner (recorded at registration) or a whitelisted
 * admin. Fails closed: if the owner is unknown and the user is not whitelisted,
 * access is denied. Used to gate ordinary messages in shared guild channels.
 */
export async function isAuthorizedForChannel(
  channelId: string,
  userId: string,
  deps: ChannelAuthDeps,
): Promise<boolean> {
  const status = deps.describeInstance(channelId);
  if (status?.ownerId && status.ownerId === userId) {
    return true;
  }
  return deps.isWhitelisted(userId);
}

/** Deps for {@link handleChannelDeleted}; kept minimal so it is unit-testable. */
export type ChannelDeletedDeps = {
  /** Returns the channel's instance status, or null when not registered. */
  describeInstance: (channelId: string) => InstanceStatus | null;
  /** Same provisioning client `/channel unregister` uses (reloads on success). */
  provisioning: ProvisioningClient;
  /** Invoked after a successful teardown so callers can drop related state. */
  onCleaned?: (channelId: string) => void;
  log: (message: string) => void;
  error: (message: string) => void;
};

/**
 * Tear down the agent instance for a deleted Discord channel. No-op when the
 * channel had no registered instance. Uses the same provisioning path as
 * `/channel unregister`, so the instance map is reconciled on success.
 */
export async function handleChannelDeleted(
  channelId: string,
  reason: string,
  deps: ChannelDeletedDeps,
): Promise<void> {
  if (!deps.describeInstance(channelId)) {
    return; // nothing registered for this channel
  }
  deps.log(`[router] channel ${channelId} deleted (${reason}); unregistering instance`);
  try {
    const result = await deps.provisioning.unregister({ channelId });
    if (result.ok) {
      deps.onCleaned?.(channelId);
      deps.log(`[router] instance for deleted channel ${channelId} unregistered`);
    } else {
      deps.error(`[router] failed to unregister deleted channel ${channelId}: ${result.message}`);
    }
  } catch (err) {
    deps.error(`[router] error unregistering deleted channel ${channelId}: ${String(err)}`);
  }
}

type DiscordAttachment = {
  id: string;
  filename: string;
  content_type?: string;
  url: string;
  size: number;
};

/** Returns true if the agent responded successfully. */
/**
 * Decide whether an internal command result should be relayed back to the agent
 * for a follow-up turn. Relaying happens only when the turn was purely internal
 * (a command ran and produced a result but nothing user-visible was delivered)
 * and the roundtrip budget is not exhausted. When the agent both ran a command
 * and spoke to the user in the same turn, relaying would spawn a duplicate reply
 * (e.g. "Great to meet you" followed by "Got it, what can I help you with"), so
 * this returns false.
 */
export function shouldRelayCommandResult(params: {
  ranCommand: boolean;
  commandResult: string | null;
  deliveredThisTurn: boolean;
  commandDepth: number;
  maxRoundtrips: number;
}): boolean {
  return (
    params.ranCommand &&
    params.commandResult !== null &&
    !params.deliveredThisTurn &&
    params.commandDepth < params.maxRoundtrips
  );
}

async function routeMessage(params: {
  authorId: string;
  channelId: string;
  messageContent: string;
  attachments?: DiscordAttachment[];
  instance: InstanceConfig;
  discordToken: string;
  runtime: RouterRuntime;
  agentTimeoutMs: number;
  inflight: Set<string>;
  /** Handler for `⁘` control commands emitted by the agent. */
  runCommand?: RunAgentCommand;
}): Promise<boolean> {
  const {
    authorId,
    channelId,
    attachments,
    instance,
    discordToken,
    runtime,
    agentTimeoutMs,
    inflight,
  } = params;
  let messageContent = params.messageContent;

  // Serialize per-channel
  if (inflight.has(channelId)) {
    runtime.log(`[router] channel ${channelId} already in-flight, queuing`);
  }
  while (inflight.has(channelId)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  inflight.add(channelId);
  try {
    runtime.log(
      `[router] routing message from ${authorId} in channel ${channelId}: ${messageContent.slice(0, 80)}`,
    );

    // Typing indicator
    const typingInterval = setInterval(() => {
      void discordTyping(discordToken, channelId);
    }, TYPING_INTERVAL_MS);
    void discordTyping(discordToken, channelId);

    try {
      // Process attachments: transcribe audio locally, pass images to gateway
      const WHISPER_URL = process.env.OPENCLAW_WHISPER_URL ?? "http://127.0.0.1:8787/inference";
      let gatewayAttachments: Array<{
        type: string;
        mimeType: string;
        fileName: string;
        content: string;
      }> = [];
      if (attachments && attachments.length > 0) {
        const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB
        for (const att of attachments) {
          if (att.size > MAX_ATTACHMENT_BYTES) {
            runtime.log(`[router] skipping large attachment ${att.filename} (${att.size} bytes)`);
            continue;
          }
          try {
            const resp = await fetch(att.url);
            if (!resp.ok) {
              continue;
            }
            const buf = Buffer.from(await resp.arrayBuffer());
            const mime = att.content_type ?? "application/octet-stream";

            if (mime.startsWith("audio/")) {
              // Transcribe audio locally via whisper server
              runtime.log(
                `[router] transcribing ${att.filename} (${mime}, ${buf.length} bytes)...`,
              );
              try {
                const form = new FormData();
                form.append("file", new Blob([buf], { type: mime }), att.filename);
                form.append("response_format", "json");
                form.append("temperature", "0.0");
                const whisperResp = await fetch(WHISPER_URL, {
                  method: "POST",
                  body: form,
                });
                if (whisperResp.ok) {
                  const result = (await whisperResp.json()) as { text?: string };
                  const transcript = result.text?.trim();
                  if (transcript) {
                    runtime.log(`[router] transcribed: ${transcript.slice(0, 80)}`);
                    // Prepend transcript to message content
                    messageContent = messageContent
                      ? `${messageContent}\n\n[Voice message transcript]: ${transcript}`
                      : `[Voice message transcript]: ${transcript}`;
                  } else {
                    runtime.log(`[router] transcription returned empty text`);
                  }
                } else {
                  runtime.error(
                    `[router] whisper failed (${whisperResp.status}): ${await whisperResp.text().catch(() => "")}`,
                  );
                }
              } catch (whisperErr) {
                runtime.error(`[router] whisper error: ${String(whisperErr)}`);
              }
            } else if (mime.startsWith("image/")) {
              // Pass images to gateway as attachments
              gatewayAttachments.push({
                type: "image",
                mimeType: mime,
                fileName: att.filename,
                content: buf.toString("base64"),
              });
              runtime.log(
                `[router] downloaded image ${att.filename} (${mime}, ${buf.length} bytes)`,
              );
            } else {
              runtime.log(`[router] skipping unsupported attachment ${att.filename} (${mime})`);
            }
          } catch (dlErr) {
            runtime.error(
              `[router] failed to download attachment ${att.filename}: ${String(dlErr)}`,
            );
          }
        }
      }

      // Re-read token from disk so we never use a stale cached value
      const freshToken = refreshToken(instance);

      // Drive the agent, processing any `⁘` control commands it emits and
      // relaying their results back so it can continue. A depth cap prevents a
      // command/result loop from running forever.
      let agentMessage = messageContent || "<media>";

      // On a brand-new channel, steer the agent through its first-run checklist
      // by prepending BOOTSTRAP.md (as conversation content, to keep the system
      // prompt billing-safe). Only affects the first turn of this call; command
      // result relays below reuse agentMessage without it.
      const bootstrapDirective = readBootstrapDirective(instance);
      if (bootstrapDirective) {
        agentMessage = `${bootstrapDirective}\n\n${agentMessage}`;
      }
      let attachmentsForCall = gatewayAttachments;
      let commandDepth = 0;
      const MAX_COMMAND_ROUNDTRIPS = 5;
      let deliveredAnything = false;
      let handled = false;

      while (true) {
        const idempotencyKey = randomUUID();
        const result = await callGatewaySimple({
          url: `ws://127.0.0.1:${instance.port}`,
          token: freshToken || undefined,
          method: "agent",
          params: {
            message: agentMessage,
            channel: "discord",
            deliver: false,
            idempotencyKey,
            sessionKey: `agent:main:discord:default:channel:${channelId}`,
            timeout: Math.floor(agentTimeoutMs / 1000),
            ...(attachmentsForCall.length > 0 ? { attachments: attachmentsForCall } : {}),
          },
          expectFinal: true,
          timeoutMs: agentTimeoutMs + 30_000,
        });
        attachmentsForCall = []; // attachments belong to the first turn only

        const payloads = result?.result?.payloads ?? [];
        if (payloads.length === 0) {
          if (!handled) {
            runtime.log(`[router] empty response for channel ${channelId}`);
            await discordSend(
              discordToken,
              channelId,
              "*I processed your message but wasn't able to generate a response. Please try again.*",
            );
          }
          break;
        }

        let commandResult: string | null = null;
        let ranCommand = false;
        // Whether this specific turn already delivered user-visible text/media.
        // Used to decide if an internal command result warrants a follow-up
        // turn (see the relay gate below).
        let deliveredThisTurn = false;

        for (const payload of payloads) {
          const raw = payload.text ?? "";

          // Control command? Never rendered to Discord; run it and capture a
          // result to relay back to the agent.
          const cmd = params.runCommand ? parseAgentCommand(raw) : null;
          if (cmd) {
            ranCommand = true;
            handled = true;
            try {
              const res = await params.runCommand!(cmd, { channelId, instance, authorId });
              if (res !== null) {
                commandResult = res;
              }
            } catch (cmdErr) {
              commandResult = `error running ${cmd.command}: ${String(cmdErr)}`;
              runtime.error(`[router] command ${cmd.command} failed: ${String(cmdErr)}`);
            }
            continue;
          }

          // Normal message: unescape a leading `\⁘`, filter leaked errors, then
          // format and send.
          let text = unescapeAgentText(raw).trim();
          if (isLeakedError(text)) {
            runtime.log(`[router] suppressed leaked error: ${text.slice(0, 100)}`);
            continue;
          }
          if (text) {
            text = convertMarkdownTables(text, "code");
            text = stripHorizontalRules(text);
            text = convertTimesToDiscordTimestamps(text);
            text = stripDashes(text);
            for (const chunk of chunkText(text, 2000)) {
              await discordSend(discordToken, channelId, chunk);
            }
            deliveredAnything = true;
            deliveredThisTurn = true;
            handled = true;
          }
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          for (const url of mediaUrls) {
            await discordSend(discordToken, channelId, url);
            deliveredAnything = true;
            deliveredThisTurn = true;
            handled = true;
          }
        }

        runtime.log(`[router] processed ${payloads.length} payload(s) for channel ${channelId}`);

        // If a command produced a result, relay it back to the agent for a
        // follow-up turn (bounded by the depth cap) ONLY when this turn was
        // purely internal (no user-visible text/media). When the agent both
        // ran a command and spoke to the user in the same turn, the turn is
        // already complete: relaying the internal command result would spawn a
        // second user-visible reply (e.g. "Great to meet you" followed by "Got
        // it, what can I help you with"). Internal-only command turns (ticking
        // the checklist, saving a name, `return` no-ops) still relay so the
        // agent can continue.
        if (
          shouldRelayCommandResult({
            ranCommand,
            commandResult,
            deliveredThisTurn,
            commandDepth,
            maxRoundtrips: MAX_COMMAND_ROUNDTRIPS,
          })
        ) {
          commandDepth += 1;
          agentMessage = `[system] Command result: ${commandResult}`;
          continue;
        }
        break;
      }

      return handled || deliveredAnything;
    } finally {
      clearInterval(typingInterval);
    }
  } catch (err) {
    const errMsg = String(err);
    runtime.error(`[router] error for channel ${channelId}: ${errMsg}`);

    const kind = classifyRouterError(errMsg);
    if (kind === "connection-refused") {
      await discordSend(
        discordToken,
        channelId,
        "*Your agent is not running. Please contact the admin to start your instance.*",
      ).catch(() => {});
    } else if (kind === "auth") {
      // Auth/config failure is an admin problem the user cannot fix by retrying,
      // so don't echo a misleading "try again" — just log for the admin.
      runtime.error(
        `[router] auth/config error for channel ${channelId}, needs admin attention (re-auth or restart)`,
      );
    } else if (kind === "timeout") {
      await discordSend(
        discordToken,
        channelId,
        "*Your agent is taking too long to respond. Please try again later.*",
      ).catch(() => {});
    } else {
      await discordSend(
        discordToken,
        channelId,
        "*Something went wrong processing your message. Please try again.*",
      ).catch(() => {});
    }
    return false;
  } finally {
    inflight.delete(channelId);
  }
}

/**
 * Detect raw JS/system errors that leaked into agent output.
 * These are tool execution errors that got captured as response text
 * instead of being handled internally.
 */
function isLeakedError(text: string): boolean {
  if (!text) {
    return false;
  }
  const t = text.trim();
  // Common JS error patterns that should never appear in user-facing text
  return (
    /^Cannot read propert(y|ies) of (undefined|null)/.test(t) ||
    t.startsWith("TypeError:") ||
    t.startsWith("ReferenceError:") ||
    t.startsWith("SyntaxError:") ||
    t.startsWith("RangeError:") ||
    /^Error: (ENOENT|EACCES|EPERM|ECONNREFUSED)/.test(t) ||
    /^Command exited with code \d+/.test(t) ||
    t.startsWith("[tools] exec failed:") ||
    /^at\s+\S+\s+\(.*:\d+:\d+\)/.test(t)
  );
}

/**
 * Handle text-based slash commands (fallback for when Discord slash commands
 * haven't propagated yet). Returns true if the command was handled.
 */
async function handleTextCommand(params: {
  cmdName: string;
  cmdArg: string | undefined;
  userId: string;
  channelId: string;
  messageId: string;
  instance: InstanceConfig;
  discordToken: string;
  runtime: RouterRuntime;
}): Promise<boolean> {
  const { cmdName, cmdArg, userId, channelId, messageId, instance, discordToken, runtime } = params;

  // Reply to the user's command message
  async function reply(text: string): Promise<void> {
    const resp = await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${discordToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: text,
        message_reference: { message_id: messageId },
      }),
    });
    if (!resp.ok) {
      runtime.error(`[router] text command reply failed (${resp.status})`);
    }
  }

  switch (cmdName) {
    case "lifecycle": {
      const current = instance.preferences.lifecycleMessages ?? false;
      if (cmdArg === "on") {
        setUserPreference(instance, "lifecycleMessages", true);
        await reply(
          "Lifecycle messages **enabled**. You'll see *Back online.* and *Shutting down...* messages.",
        );
      } else if (cmdArg === "off") {
        setUserPreference(instance, "lifecycleMessages", false);
        await reply(
          "Lifecycle messages **disabled**. You won't see startup/shutdown notifications.",
        );
      } else {
        await reply(
          current
            ? "Lifecycle messages are currently **enabled**. Use `/lifecycle off` to disable."
            : "Lifecycle messages are currently **disabled**. Use `/lifecycle on` to enable.",
        );
      }
      runtime.log(`[router] text command /lifecycle for ${userId}: arg=${cmdArg ?? "status"}`);
      return true;
    }
    default:
      return false;
  }
}

/**
 * Deterministically remove em (—) and en (–) dashes from outgoing agent text.
 * The model still emits them despite prompt rules, so this is a belt-and-braces
 * post-process applied only to user-facing reply text (never control commands
 * or embeds). A dash used as punctuation (surrounded by spaces) collapses to a
 * comma; a bare dash becomes ", " so joined clauses stay readable. Regular
 * hyphens (-) in compound words, CLI flags, and filenames are untouched.
 */
function stripDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ").replace(/,\s+,/g, ",");
}

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.3) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < limit * 0.3) {
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

/**
 * Quick liveness check: resolve true if a TCP connection to 127.0.0.1:port
 * succeeds within the timeout, false otherwise. Used by `/channel status` to
 * report whether the agent container is actually up.
 */
function probePort(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function discordSend(token: string, channelId: string, content: string): Promise<void> {
  await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
}

/**
 * Post a real Discord reply that references the triggering command message
 * (threads under it in the client). Accepts a plain string (content) or an
 * embeds payload. Bots cannot send true ephemeral replies, so callers that
 * want an auto-deleting notice use `discordSendEphemeral` instead.
 */
export async function discordSendReply(
  token: string,
  channelId: string,
  commandMessageId: string,
  payload: ChannelReplyPayload,
): Promise<void> {
  const message_reference = {
    message_id: commandMessageId,
    channel_id: channelId,
    fail_if_not_exists: false,
  };
  const body =
    typeof payload === "string"
      ? { content: payload, message_reference }
      : {
          embeds: payload.embeds satisfies DiscordEmbed[],
          ...(payload.components ? { components: payload.components } : {}),
          message_reference,
        };
  await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Send a message that looks ephemeral (italic, low-key).
 * True ephemeral messages require interaction responses — for regular messages
 * we send a normal message that auto-deletes after a few seconds.
 */
async function discordSendEphemeral(
  token: string,
  channelId: string,
  content: string,
): Promise<void> {
  const resp = await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  if (resp.ok) {
    // Auto-delete after 10 seconds
    const msg = (await resp.json()) as { id?: string };
    if (msg.id) {
      setTimeout(() => {
        void fetch(`${DISCORD_API}${Routes.channelMessage(channelId, msg.id!)}`, {
          method: "DELETE",
          headers: { Authorization: `Bot ${token}` },
        }).catch(() => {});
      }, 10_000);
    }
  }
}

async function discordTyping(token: string, channelId: string): Promise<void> {
  await fetch(`${DISCORD_API}${Routes.channelTyping(channelId)}`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
  }).catch(() => {});
}

// Lifecycle messages moved to health-monitor sidecar.
// The monitor sends "Back online" / "Shutting down" via Discord REST API
// based on the router process state, respecting per-channel preferences.

/** Open a DM channel with a user and return the channel ID. */
async function openDMChannel(token: string, userId: string): Promise<string | null> {
  const resp = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!resp.ok) {
    return null;
  }
  const data = (await resp.json()) as { id?: string };
  return data.id ?? null;
}

/** Send a Discord embed message. */
async function discordSendEmbed(
  token: string,
  channelId: string,
  embed: { title: string; description: string; color?: number },
): Promise<void> {
  await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

/**
 * Check each onboarded user's DM for unanswered messages.
 * If the most recent message is from the user (not the bot), route it to the agent.
 */
async function recoverUnansweredMessages(
  discordToken: string,
  instances: Map<string, InstanceConfig>,
  runtime: RouterRuntime,
  agentTimeoutMs: number,
  inflight: Set<string>,
  runCommand: RunAgentCommand,
  /** Message IDs already attempted this process, to avoid re-recovery loops. */
  recoveredMessageIds: Set<string>,
  /** Same guild access control applied to live messages (owner/admin only). */
  isAuthorized?: (channelId: string, userId: string) => Promise<boolean>,
): Promise<void> {
  const botId = (
    (await fetch(`${DISCORD_API}/applications/@me`, {
      headers: { Authorization: `Bot ${discordToken}` },
    }).then((r) => r.json())) as { id?: string }
  )?.id;

  for (const [channelId, instance] of instances) {
    try {
      // Determine whether this is a guild channel (has a guild_id) or a DM. DMs
      // are inherently 1:1 with the owner, so they recover without a gate; guild
      // channels reuse the live access control below. Fail closed: if the lookup
      // errors we cannot tell DM from guild, so we skip the channel rather than
      // risk recovering an unauthorized message into a shared guild channel.
      const channelResp = await fetch(`${DISCORD_API}/channels/${channelId}`, {
        headers: { Authorization: `Bot ${discordToken}` },
      }).catch(() => null);
      if (!channelResp || !channelResp.ok) {
        runtime.log(`[router] skipping recovery for ${channelId}: channel lookup failed`);
        continue;
      }
      const channelInfo = (await channelResp.json().catch(() => null)) as {
        guild_id?: string;
      } | null;
      if (!channelInfo) {
        runtime.log(`[router] skipping recovery for ${channelId}: channel lookup unparseable`);
        continue;
      }
      const isGuildChannel = Boolean(channelInfo.guild_id);

      // Fetch last 10 messages to look past lifecycle messages
      const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages?limit=10`, {
        headers: { Authorization: `Bot ${discordToken}` },
      });
      if (!resp.ok) {
        continue;
      }
      const messages = (await resp.json()) as Array<{
        id: string;
        author: { id: string; bot?: boolean };
        content: string;
        attachments?: Array<{
          id: string;
          filename: string;
          content_type?: string;
          url: string;
          size: number;
        }>;
      }>;
      if (messages.length === 0) {
        continue;
      }

      // Walk newest-first. For a BOT message, skip ONLY genuine lifecycle banners
      // (*Back online.*, *Shutting down...*), which are not replies to a user
      // message; any other bot message — including an error reply — means the
      // newest user message was already handled, so stop and do not re-run it.
      // (Previously all italic text was skipped, swallowing error replies and
      // re-attempting the same failing message on every reconnect.) Authorship is
      // checked first so a user literally typing "*Back online.*" is not mistaken
      // for a banner.
      let lastUserMsg: (typeof messages)[0] | undefined;
      for (const msg of messages) {
        const isBotMsg = msg.author.bot || msg.author.id === botId;
        if (isBotMsg) {
          if (isLifecycleBanner(msg.content)) {
            continue;
          }
          break;
        }
        lastUserMsg = msg;
        break;
      }

      if (!lastUserMsg) {
        continue;
      }
      const content = lastUserMsg.content?.trim();
      const msgAttachments = lastUserMsg.attachments ?? [];
      if (!content && msgAttachments.length === 0) {
        continue;
      }

      // In a shared guild channel, only recover a message from the owner or a
      // whitelisted admin, matching the live MESSAGE_CREATE gate. Fail closed.
      if (isGuildChannel && isAuthorized) {
        const allowed = await isAuthorized(channelId, lastUserMsg.author.id);
        if (!allowed) {
          runtime.log(
            `[router] skipping recovery in guild channel ${channelId}: ${lastUserMsg.author.id} not owner or whitelisted`,
          );
          continue;
        }
      }

      // Attempt each message at most once per process. A persistently-failing
      // agent (e.g. bad auth) posts no reply, so this message would otherwise
      // stay "unanswered" and be silently re-run on every reconnect.
      if (recoveredMessageIds.has(lastUserMsg.id)) {
        continue;
      }
      recoveredMessageIds.add(lastUserMsg.id);

      runtime.log(
        `[router] recovering unanswered message in channel ${channelId}: ${content?.slice(0, 60) || `(${msgAttachments.length} attachment(s))`}`,
      );

      void routeMessage({
        authorId: lastUserMsg.author.id,
        channelId,
        messageContent: content ?? "",
        attachments: msgAttachments,
        instance,
        discordToken,
        runtime,
        agentTimeoutMs,
        inflight,
        runCommand,
      });
    } catch (err) {
      runtime.log(`[router] recovery failed for channel ${channelId}: ${String(err)}`);
    }
  }
}
