import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import type { RouterConfig, InstanceConfig } from "./config.js";
import type { RouterRuntime, RunAgentCommand } from "./types.js";
import { parseBooleanValue } from "../../utils/boolean.js";
import { runAgentCommandDispatch } from "./agent-command-dispatch.js";
import { connectionEmojiFromMap, fetchAppEmojiMap } from "./app-emojis.js";
import {
  CHANNEL_COMMAND_SPEC,
  type ChannelCommandDeps,
  type InstanceStatus,
  type ProvisioningClient,
} from "./channel-commands.js";
import { ChannelQueue } from "./channel-queue.js";
import { loadRouterConfig, refreshToken, resolveProxyBindHost } from "./config.js";
import {
  CONNECTIONS_COMMAND_SPECS,
  type ConnectCommandDeps,
  type ConnectionStore,
} from "./connect-commands.js";
import {
  getConnection,
  listConnections,
  removeConnection,
  saveConnection,
} from "./connections-store.js";
import { connectorRegistry } from "./connectors.js";
import { startContainerProxyServer } from "./container-proxy.js";
import {
  DISCORD_API,
  discordSend,
  openDMChannel,
  probePort,
  sendEmbedMessage,
} from "./discord-api.js";
import { buildEmbed } from "./embed-categories.js";
import { initAppEmojis } from "./emojis.js";
import { callGatewaySimple } from "./gateway-call.js";
import {
  type GatewayContext,
  handleChannelDelete,
  handleComponentInteraction,
  handleGuildDelete,
  handleMessageCreate,
  handleModalSubmit,
  handleSlashInteraction,
} from "./gateway-events.js";
import { createSharedAuthTokenResolver, startModelProxyServer } from "./model-proxy.js";
import { bootstrapExists, runOnboardingKick } from "./onboarding.js";
import { createHttpProvisioningClient } from "./provisioning.js";
import { channelSessionKey, routeMessage } from "./route-message.js";
import { isConversationalBot, isLifecycleBanner } from "./router-filters.js";
import { SECRET_COMMAND_SPEC } from "./secret-command.js";
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

  // Load this bot's application emojis in the background so embeds can reference
  // them by name (prod and mirror self-resolve to their own ids). Non-blocking
  // and non-fatal: resolveEmoji falls back to plain glyphs until this resolves,
  // and a stalled emoji endpoint must never gate router startup.
  void initAppEmojis(discordToken, applicationId)
    .then((count) => runtime.log(`[router] loaded ${count} application emoji(s)`))
    .catch(() => {});

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

  // Register the /secret command: hand the channel's agent a sensitive value
  // privately (collected via a modal, never shown in the channel).
  await fetch(`${DISCORD_API}/applications/${applicationId}/commands`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${discordToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(SECRET_COMMAND_SPEC),
  }).catch((err) => runtime.error(`[router] failed to register /secret command: ${String(err)}`));

  // Register the /connections command plus its /conn alias (list/add/remove).
  for (const spec of CONNECTIONS_COMMAND_SPECS) {
    await fetch(`${DISCORD_API}/applications/${applicationId}/commands`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${discordToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(spec),
    }).catch((err) =>
      runtime.error(`[router] failed to register /${spec.name} command: ${String(err)}`),
    );
  }

  // Get gateway URL
  const gatewayInfo = (await fetch(`${DISCORD_API}/gateway/bot`, {
    headers: { Authorization: `Bot ${discordToken}` },
  }).then((r) => r.json())) as { url?: string };
  const gatewayUrl = gatewayInfo?.url ?? "wss://gateway.discord.gg";

  // Interface the loopback proxies bind. Unset (dev/tests) keeps the loopback
  // default. In prod the agent boxes run on the `oc-agents` bridge instead of the
  // host network, so boot.sh passes that bridge's gateway IP here: boxes reach the
  // proxies over the bridge while they stay off the public NIC. resolveProxyBindHost
  // rejects a wildcard or public value (fail-closed) so the credential-bearing
  // proxies can never be exposed beyond loopback or the private bridge.
  const proxyBindHost = resolveProxyBindHost(process.env.OPENCLAW_PROXY_BIND);

  // Start the container proxy server: agent containers POST here to send/read
  // Discord messages via the router.
  const proxy = startContainerProxyServer({
    runtime,
    bindHost: proxyBindHost,
    discordToken,
    discordSend: async (channelId, content) => {
      await discordSend(discordToken, channelId, content);
      return {};
    },
    openDMChannel: (userId) => openDMChannel(discordToken, userId),
    sendSystemEmbed: async (channelId, message) => {
      const built = buildEmbed({
        category: "system",
        title: "Injected System Prompt",
        description: message,
      });
      await sendEmbedMessage(discordToken, channelId, {
        embeds: [built.embed],
        attachments: built.attachments,
      });
    },
    routeMessage: (userId, channelId, message) => {
      if (!instances.has(channelId)) {
        return Promise.resolve();
      }
      channelQueue.enqueue(channelId, { authorId: userId, messageContent: message });
      return Promise.resolve();
    },
  });

  // Start the model proxy: token-free agent containers POST model requests here
  // and the router injects the real (refreshed) OAuth token, so no provider
  // credential ever lives inside an agent box.
  const modelProxy = startModelProxyServer({
    runtime,
    bindHost: proxyBindHost,
    resolveAccessToken: createSharedAuthTokenResolver(config.instancesDir),
  });

  // Debounce window for coalescing a burst of messages into one turn. Overridable
  // via OPENCLAW_ROUTER_DEBOUNCE_MS; falls back to a short settle window.
  const debounceMs = (() => {
    const raw = Number(process.env.OPENCLAW_ROUTER_DEBOUNCE_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 500;
  })();

  // Per-channel queue: debounces + coalesces + serializes inbound turns. Replaces
  // the old inflight mutex so rapid messages collapse into one combined turn (the
  // agent sees the full context instead of a bare line it might silently ignore)
  // and nothing is dropped or reordered.
  const channelQueue = new ChannelQueue({
    debounceMs,
    log: (message) => runtime.log(message),
    runTurn: async (channelId, turn) => {
      const instance = instances.get(channelId);
      if (!instance) {
        runtime.log(`[router] skipping queued turn for unregistered channel ${channelId}`);
        return;
      }
      await routeMessage({
        authorId: turn.authorId,
        channelId,
        messageContent: turn.messageContent,
        attachments: turn.attachments,
        instance,
        discordToken,
        runtime,
        agentTimeoutMs,
        runCommand: runAgentCommand,
        systemTurn: turn.systemTurn,
        secret: turn.secret,
      });
    },
    // Mid-turn steering: inject a text message into the live run via the agent's
    // `agent.steer` gateway method. Returns true when there was an actively
    // streaming run that accepted it (its reply then carries the response through
    // the turn already in flight), false to fall back to a normal queued turn.
    steer: async (channelId, turn) => {
      // Only plain text can be injected mid-run; a message carrying attachments
      // (image/voice) needs routeMessage's full attachment pipeline, so buffer it.
      if ((turn.attachments?.length ?? 0) > 0) {
        return false;
      }
      const text = turn.messageContent.trim();
      if (!text) {
        return false;
      }
      const instance = instances.get(channelId);
      if (!instance) {
        return false;
      }
      try {
        // agent.steer replies once with the payload directly (callGatewaySimple
        // resolves to msg.payload), so `accepted` is top-level, not under result.
        const result = await callGatewaySimple<{ accepted?: boolean }>({
          url: `ws://127.0.0.1:${instance.port}`,
          token: refreshToken(instance) || undefined,
          method: "agent.steer",
          params: { sessionKey: channelSessionKey(channelId), message: text },
          timeoutMs: 10_000,
        });
        return result?.accepted === true;
      } catch (err) {
        runtime.log(`[router] steer failed for channel ${channelId}: ${String(err)}`);
        return false;
      }
    },
  });
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

  // Trusted bot id (OPENCLAW_MOCK_USER_BOT_ID) that may hold normal conversations
  // with the agent, not just run /channel commands. This is the single mock-user
  // bot that drives end-to-end tests; every other bot stays filtered out below to
  // prevent bot-to-bot reply loops.
  const mockUserBotId = process.env.OPENCLAW_MOCK_USER_BOT_ID?.trim();
  const allowedBotIds = new Set(mockUserBotId ? [mockUserBotId] : []);

  // Test-only: bot ids subject to the same channel-owner access gate as humans,
  // instead of bypassing it as trusted conversational bots do. A real human
  // non-owner is the only thing that normally reaches the unauthorized-access
  // denial (untrusted bots are dropped by the bot filter; trusted bots bypass
  // ownership), so there is no way to exercise that denial from an E2E driver
  // bot. Listing a driver bot here makes it hit the denial when it is not the
  // channel owner, so the unauthorized path can be tested end to end. Empty by
  // default, so prod and the normal E2E suite are unaffected.
  const ownerGatedBotIds = new Set(
    (process.env.OPENCLAW_ROUTER_OWNER_GATED_BOT_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );

  // When a non-owner messages a registered channel, reply with a Log-embed
  // notice (enabled by default) explaining the channel belongs to someone else.
  // The reply is threaded under the offending message and persists. Set
  // OPENCLAW_ROUTER_UNAUTHORIZED_NOTICE to a falsy value to deny silently (log
  // only, no message).
  const unauthorizedNoticeEnabled =
    parseBooleanValue(process.env.OPENCLAW_ROUTER_UNAUTHORIZED_NOTICE) !== false;

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
        const existing = instances.get(id);
        // A channel re-registered under a new instance (e.g. different owner)
        // keeps the same id but gets a fresh instanceDir. Drop any messages still
        // buffered for the old instance so they can't be delivered to the new one.
        if (existing && existing.instanceDir !== inst.instanceDir) {
          channelQueue.clear(id);
        }
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
        // The instance is gone; discard its buffered messages rather than leaving
        // them to coalesce into a future registration of the same channel.
        channelQueue.clear(id);
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
        slot: channelQueue,
        probe: (port) => probePort(port),
        runtime,
        route: ({ channelId: cId, ownerId: oId, instance: inst, systemTurn }) =>
          routeMessage({
            authorId: oId,
            channelId: cId,
            // Neutral trigger only: routeMessage prepends BOOTSTRAP.md (which
            // carries the first-run instructions) ahead of this, and the shared
            // prompt's "first-run setup" section tells the agent how to act on
            // it. No behavioral prose belongs here.
            messageContent:
              "(this channel was just registered; the user has not sent a message yet)",
            instance: inst,
            discordToken,
            runtime,
            agentTimeoutMs,
            runCommand: runAgentCommand,
            systemTurn,
          }),
      });
    },
    log: (message) => runtime.log(message),
  };

  // `/connect` store, backed by each instance's `.connections.json`. Resolving
  // the channel's instance dir here keeps the command handler free of fs access.
  // `null` from `list` means the channel has no instance (not registered), which
  // the handler turns into a "register first" reply.
  const connectionStore: ConnectionStore = {
    list: (channelId) => {
      const inst = instances.get(channelId);
      return inst ? listConnections(inst.instanceDir) : null;
    },
    get: (channelId, connectorId) => {
      const inst = instances.get(channelId);
      return inst ? getConnection(inst.instanceDir, connectorId) : null;
    },
    // The instance dir is the stable identity: it changes (or disappears) when a
    // channel is unregistered or re-registered, which is exactly what the save
    // guard below needs to detect across a slow token validation.
    instanceKey: (channelId) => instances.get(channelId)?.instanceDir ?? null,
    save: (channelId, connection, expectedKey) => {
      const inst = instances.get(channelId);
      if (!inst || inst.instanceDir !== expectedKey) {
        return false;
      }
      saveConnection(inst.instanceDir, connection);
      return true;
    },
    remove: (channelId, connectorId) => {
      const inst = instances.get(channelId);
      return inst ? removeConnection(inst.instanceDir, connectorId) : false;
    },
  };
  // Resolve this bot's own custom application emoji (connected/not-connected
  // glyphs) by name, so the /connections list table renders them. Falls back to
  // unicode when the emoji are not present on the app.
  const connectionEmoji = connectionEmojiFromMap(await fetchAppEmojiMap(discordToken));
  const connectCommandDeps: ConnectCommandDeps = {
    store: connectionStore,
    registry: connectorRegistry,
    emoji: connectionEmoji,
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
  // cannot do itself (posting welcome/log embeds). The branch logic lives in
  // runAgentCommandDispatch so it is unit-testable with an injected sender.
  const runAgentCommand: RunAgentCommand = (cmd, ctx) =>
    runAgentCommandDispatch(cmd, ctx.channelId, {
      sendEmbed: (channelId, message) => sendEmbedMessage(discordToken, channelId, message),
    });

  // Bundle the closed-over state the DISPATCH handlers need, assembled once.
  // The socket lifecycle (connect/reconnect/heartbeat/close) stays below; only
  // the event bodies live in gateway-events.ts (see GatewayContext).
  const gatewayCtx: GatewayContext = {
    discordToken,
    applicationId,
    runtime,
    instances,
    channelQueue,
    channelGuild,
    allowedBotIds,
    ownerGatedBotIds,
    unauthorizedNoticeEnabled,
    describeInstance,
    channelCommandDeps,
    connectCommandDeps,
    cleanupDeletedChannel,
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
                channelQueue,
                recoveredMessageIds,
                allowedBotIds,
                ownerGatedBotIds,
                // Apply the same guild access control as live messages so a
                // non-owner's message in a shared guild channel is not replayed
                // to the agent on restart.
                (channelId, userId) =>
                  isAuthorizedForChannel(channelId, userId, {
                    describeInstance,
                  }),
              );
            }, 10_000);
          }

          if (t === "MESSAGE_CREATE") {
            handleMessageCreate(gatewayCtx, d);
          }

          // Slash-command interactions (/lifecycle, /channel).
          if (t === "INTERACTION_CREATE" && d.type === 2) {
            handleSlashInteraction(gatewayCtx, d);
          }

          // Message-component interactions (buttons): /channel unregister confirm.
          if (t === "INTERACTION_CREATE" && d.type === 3) {
            handleComponentInteraction(gatewayCtx, d);
          }

          // Modal submissions (type 5): the /secret popup.
          if (t === "INTERACTION_CREATE" && d.type === 5) {
            handleModalSubmit(gatewayCtx, d);
          }

          // A guild channel (or thread) was deleted; tear down any registered
          // instance so we don't keep a dead route around.
          if (t === "CHANNEL_DELETE" || t === "THREAD_DELETE") {
            handleChannelDelete(gatewayCtx, d, t);
          }

          // The bot was removed from a guild (or the guild was deleted). Tear
          // down every registered instance that lived in that guild. GUILD_DELETE
          // with `unavailable: true` is a transient outage, not a removal, so we
          // ignore it and keep the instances.
          if (t === "GUILD_DELETE" && d?.unavailable !== true) {
            handleGuildDelete(gatewayCtx, d);
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
      modelProxy.server.close((err) => {
        if (err) {
          runtime.error(`[router] failed to close model proxy server: ${String(err)}`);
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
};

/**
 * Decide whether a user may converse with a registered channel's agent. Allowed
 * ONLY for the channel owner (recorded at registration). Whitelisted admins can
 * still manage channels via `/channel` commands, but they do not get to converse
 * in a channel they do not own, so another member (even an admin) cannot hijack
 * someone else's agent. Fails closed: if the owner is unknown, access is denied.
 * Used to gate ordinary messages in shared guild channels.
 */
export async function isAuthorizedForChannel(
  channelId: string,
  userId: string,
  deps: ChannelAuthDeps,
): Promise<boolean> {
  const status = deps.describeInstance(channelId);
  return Boolean(status?.ownerId && status.ownerId === userId);
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
  channelQueue: ChannelQueue,
  /** Message IDs already attempted this process, to avoid re-recovery loops. */
  recoveredMessageIds: Set<string>,
  /**
   * Trusted bot id (OPENCLAW_MOCK_USER_BOT_ID) whose messages are
   * conversational, matching the live path. Its unanswered messages are
   * recoverable; every other bot's message is treated as a reply/banner.
   */
  allowedBotIds: Set<string>,
  /**
   * Test-only owner-gated bot ids (OPENCLAW_ROUTER_OWNER_GATED_BOT_IDS). These are
   * also trusted conversational bots, but the live path subjects them to the
   * channel-owner gate rather than letting them bypass it. Recovery mirrors that:
   * their unanswered messages are still recoverable, but they face the owner check
   * instead of bypassing it as an ordinary trusted bot does, so a message that
   * would be denied live is not routed after a reconnect.
   */
  ownerGatedBotIds: Set<string>,
  /** Same guild access control applied to live messages (owner only). */
  isAuthorized?: (channelId: string, userId: string) => Promise<boolean>,
): Promise<void> {
  const botId = (
    (await fetch(`${DISCORD_API}/applications/@me`, {
      headers: { Authorization: `Bot ${discordToken}` },
    }).then((r) => r.json())) as { id?: string }
  )?.id;

  for (const channelId of instances.keys()) {
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
        embeds?: Array<{ description?: string }>;
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
      // (the "agent is starting up/shutting down" diagnostics embeds, plus legacy
      // "*Back online.*"/"*Shutting down...*" ones), which are not replies to a
      // user message; any other bot message — including an error reply — means the
      // newest user message was already handled, so stop and do not re-run it.
      // (Previously all italic text was skipped, swallowing error replies and
      // re-attempting the same failing message on every reconnect.) Authorship is
      // checked first so a user literally typing a banner phrase is not mistaken
      // for a banner.
      let lastUserMsg: (typeof messages)[0] | undefined;
      let lastUserMsgIsTrustedBot = false;
      let lastUserMsgIsOwnerGated = false;
      for (const msg of messages) {
        // A trusted bot (allowlisted, and not the router itself) converses like a
        // human on the live path, so its unanswered message is recoverable too.
        const isTrustedBot = Boolean(
          msg.author.bot && isConversationalBot(msg.author.id, botId, allowedBotIds),
        );
        // An owner-gated bot is also recoverable (independent of the allowlist, so
        // it mirrors the live path regardless of whether it is additionally a
        // trusted bot), but — like a human — it must still face the owner check
        // below rather than bypassing it as an ordinary trusted bot does. Exclude
        // the router itself, as the live path does.
        const isOwnerGatedBot = Boolean(
          msg.author.bot &&
          msg.author.id &&
          msg.author.id !== botId &&
          ownerGatedBotIds.has(msg.author.id),
        );
        const isBotMsg =
          (msg.author.bot || msg.author.id === botId) && !isTrustedBot && !isOwnerGatedBot;
        if (isBotMsg) {
          if (isLifecycleBanner(msg)) {
            continue;
          }
          break;
        }
        lastUserMsg = msg;
        lastUserMsgIsTrustedBot = isTrustedBot;
        lastUserMsgIsOwnerGated = isOwnerGatedBot;
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

      // In a shared guild channel, only recover a message from the channel
      // owner, matching the live MESSAGE_CREATE gate. Fail closed.
      if (isGuildChannel && isAuthorized && (!lastUserMsgIsTrustedBot || lastUserMsgIsOwnerGated)) {
        const allowed = await isAuthorized(channelId, lastUserMsg.author.id);
        if (!allowed) {
          runtime.log(
            `[router] skipping recovery in guild channel ${channelId}: ${lastUserMsg.author.id} not the channel owner`,
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

      channelQueue.enqueue(channelId, {
        authorId: lastUserMsg.author.id,
        messageContent: content ?? "",
        attachments: msgAttachments,
      });
    } catch (err) {
      runtime.log(`[router] recovery failed for channel ${channelId}: ${String(err)}`);
    }
  }
}
