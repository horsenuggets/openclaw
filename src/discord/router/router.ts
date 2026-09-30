import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import type { RouterConfig, InstanceConfig } from "./config.js";
import type { RouterRuntime, RunAgentCommand } from "./types.js";
import {
  CHANNEL_COMMAND_SPEC,
  type ChannelCommandDeps,
  type ChannelReplyPayload,
  type DiscordActionRow,
  type InstanceStatus,
  type ProvisioningClient,
  handleChannelCommand,
  handleUnregisterButtonClick,
  parseChannelTextCommand,
  parseUnregisterCustomId,
} from "./channel-commands.js";
import { loadRouterConfig, setUserPreference } from "./config.js";
import { startContainerProxyServer } from "./container-proxy.js";
import {
  DISCORD_API,
  discordSend,
  discordSendEmbed,
  discordSendEphemeral,
  discordSendReply,
  openDMChannel,
  probePort,
} from "./discord-api.js";
import { WELCOME_EMBED, bootstrapExists, runOnboardingKick } from "./onboarding.js";
import { createHttpProvisioningClient } from "./provisioning.js";
import { handleTextCommand, routeMessage } from "./route-message.js";
import { isConversationalBot, isLifecycleBanner } from "./router-filters.js";
import { createWhitelistChecker } from "./whitelist.js";

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
    discordToken,
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
  // User/bot ids (comma-separated OPENCLAW_ADMIN_OVERRIDE_IDS) granted admin +
  // whitelist without the auth-guild role lookup. For test/lab rigs whose router
  // bot is not a member of the auth server; empty => no override (fail closed).
  const overrideAdminIds = new Set(
    (process.env.OPENCLAW_ADMIN_OVERRIDE_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );

  const whitelist = createWhitelistChecker({
    discordToken,
    guildId: process.env.OPENCLAW_AUTH_GUILD_ID,
    roleId: process.env.OPENCLAW_WHITELIST_ROLE_ID,
    adminRoleId: process.env.OPENCLAW_ADMIN_ROLE_ID,
    overrideAdminIds,
    log: (message) => runtime.log(message),
  });

  // Trusted bot ids (comma-separated OPENCLAW_ROUTER_ALLOW_BOT_IDS) that may hold
  // normal conversations with the agent, not just run /channel commands. Intended
  // for an automated tester bot driving end-to-end tests; every other bot stays
  // filtered out below to prevent bot-to-bot reply loops.
  const allowedBotIds = new Set(
    (process.env.OPENCLAW_ROUTER_ALLOW_BOT_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );

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
    // Kick the agent's first turn right after a successful register so the
    // welcome card + greeting appear immediately, before the owner speaks.
    // routeMessage prepends the BOOTSTRAP directive as conversation content
    // (billing-safe) while BOOTSTRAP.md exists, so a synthetic system message is
    // enough to drive onboarding. Fire-and-forget; the register embed was
    // already sent by the command handler, so ordering stays correct.
    kickOnboarding: (channelId, ownerId) => {
      const instance = instances.get(channelId);
      if (!instance || !bootstrapExists(instance)) {
        return;
      }
      void runOnboardingKick({
        channelId,
        ownerId,
        instance,
        inflight,
        probe: (port) => probePort(port),
        runtime,
        route: ({
          channelId: cId,
          ownerId: oId,
          instance: inst,
          systemTurn,
          preacquiredInflight,
        }) =>
          routeMessage({
            authorId: oId,
            channelId: cId,
            messageContent:
              "This channel was just registered and the user has not spoken yet. Begin first-run setup now: send the welcome card as your very first message, then greet them warmly and start the checklist.",
            instance: inst,
            discordToken,
            runtime,
            agentTimeoutMs,
            inflight,
            runCommand: runAgentCommand,
            systemTurn,
            preacquiredInflight,
          }),
      });
    },
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
  // cannot do itself (posting the official Discord welcome embed).
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
                allowedBotIds,
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

            // Normal agent messages: ignore untrusted bots and empty messages.
            // Channel commands were already handled above so bots can still drive
            // them. Trusted bots (OPENCLAW_ROUTER_ALLOW_BOT_IDS) may converse, but
            // never the router's own bot (self-routing would loop).
            const botAllowed = isBot
              ? isConversationalBot(authorId, applicationId, allowedBotIds)
              : false;
            if (!authorId || (isBot && !botAllowed) || (!content.trim() && !hasAttachments)) {
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
  /**
   * Trusted bot ids (OPENCLAW_ROUTER_ALLOW_BOT_IDS) whose messages are
   * conversational, matching the live path. Their unanswered messages are
   * recoverable; every other bot's message is treated as a reply/banner.
   */
  allowedBotIds: Set<string>,
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
        // A trusted bot (allowlisted, and not the router itself) converses like a
        // human on the live path, so its unanswered message is recoverable too.
        const isTrustedBot =
          msg.author.bot && isConversationalBot(msg.author.id, botId, allowedBotIds);
        const isBotMsg = (msg.author.bot || msg.author.id === botId) && !isTrustedBot;
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
