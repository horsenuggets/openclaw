import { Routes } from "discord-api-types/v10";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
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
  type InstanceStatus,
  type ProvisioningClient,
  handleChannelCommand,
  parseChannelTextCommand,
} from "./channel-commands.js";
import { loadRouterConfig, refreshToken, setUserPreference } from "./config.js";
import { callGatewaySimple } from "./gateway-call.js";
import { startOAuthCallbackServer } from "./oauth-callback.js";
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
  color: 0xff8080,
};

const GOOGLE_CONNECT_EMBED = {
  title: "Connect your Google account",
  description:
    "Link your Google account so I can help with your calendar, email, and files. Click the button below to connect. You can skip this if you'd rather not.",
  color: 0xff8080,
};

export type RouterRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/** Workspace-relative path of the first-run checklist. */
const BOOTSTRAP_RELATIVE_PATH = "workspace/BOOTSTRAP.md";
/** Workspace-relative path of the user profile. */
const USER_RELATIVE_PATH = "workspace/USER.md";

/** True once the first-run checklist file is still present (setup in progress). */
function bootstrapExists(instance: InstanceConfig): boolean {
  try {
    return fs.existsSync(path.join(instance.instanceDir, BOOTSTRAP_RELATIVE_PATH));
  } catch {
    return false;
  }
}

/**
 * True once USER.md has a real name filled in. The template ships with an empty
 * `- **Name:**` line; the agent reliably fills it during the name step. The
 * router uses this as the trigger to post the Google card itself, because the
 * model reliably saves the name but does not reliably emit the Google control
 * command mid-conversation (it narrates a card instead of sending one).
 */
function userHasName(instance: InstanceConfig): boolean {
  try {
    const content = fs.readFileSync(path.join(instance.instanceDir, USER_RELATIVE_PATH), "utf-8");
    // Match the Name line only; [ \t] (not \s) so it cannot span into the next
    // line, and \S requires real content after the label (empty template = no
    // match).
    const match = content.match(/^[ \t]*-?[ \t]*\*\*Name:\*\*[ \t]*(\S.*)$/m);
    return Boolean(match && match[1].trim().length > 0);
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
      "Follow it exactly, including emitting any control commands it specifies (a message that is only a control command is run by the host and never shown to the user). Tick each item as you complete it and delete BOOTSTRAP.md when every item is done. Now handle the user's message:",
    ].join("\n");
  } catch {
    return null;
  }
}

const TYPING_INTERVAL_MS = 8_000;
const DISCORD_API = "https://discord.com/api/v10";

/**
 * Bot authors are normally ignored (the router only serves humans). For
 * end-to-end testing, a designated tester bot may drive the router: any author
 * id listed in the comma-separated `OPENCLAW_E2E_TEST_BOT_IDS` env var is
 * treated as a human. Unset (the production default) means every bot is
 * ignored, so this has no effect unless explicitly opted into.
 */
const TEST_BOT_IDS = new Set(
  (process.env.OPENCLAW_E2E_TEST_BOT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
);

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

  // Start OAuth callback server for Google auth relay + Discord send proxy
  const oauth = startOAuthCallbackServer({
    instancesDir: config.instancesDir,
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
        onboardingGoogleSent,
      }).then(() => {});
    },
    onAuthComplete: async ({ discordUserId, code }) => {
      // Find the channel instance for this user's pending auth
      const pending = pendingGoogleAuth.get(discordUserId);
      const channelId = pending?.channelId ?? (await openDMChannel(discordToken, discordUserId));
      if (!channelId) {
        runtime.error(`[router] could not resolve channel for ${discordUserId} after auth`);
        return;
      }
      const instance = instances.get(channelId);
      if (!instance) {
        return;
      }

      runtime.log(
        `[router] Google auth complete for ${discordUserId} (channel ${channelId}), exchanging code`,
      );

      // Exchange code for tokens
      try {
        const credsPath = `${config.instancesDir}/credentials-web.json`;
        const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
        const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            redirect_uri: creds.redirect_uri,
            grant_type: "authorization_code",
          }),
        });
        const tokens = (await tokenResp.json()) as {
          refresh_token?: string;
          access_token?: string;
          error?: string;
        };
        if (tokens.error || !tokens.refresh_token) {
          runtime.error(`[router] token exchange failed: ${tokens.error}`);
          return;
        }

        // Ensure gogcli credentials exist for this instance
        const gogDir = `${config.instancesDir}/${channelId}/gogcli`;
        if (!fs.existsSync(gogDir)) {
          fs.mkdirSync(gogDir, { recursive: true });
        }
        // Copy shared gogcli credentials (OAuth client config) if not yet present.
        // Look in shared/gogcli/ first, then fall back to any existing instance.
        const instanceCreds = `${gogDir}/credentials.json`;
        if (!fs.existsSync(instanceCreds)) {
          const sharedGog = `${config.instancesDir}/shared/gogcli/credentials.json`;
          let sourceDir: string | undefined;
          if (fs.existsSync(sharedGog)) {
            sourceDir = `${config.instancesDir}/shared/gogcli`;
          } else {
            // Fall back: find any instance that has gogcli credentials
            for (const [cid] of instances) {
              const candidate = `${config.instancesDir}/${cid}/gogcli/credentials.json`;
              if (fs.existsSync(candidate)) {
                sourceDir = `${config.instancesDir}/${cid}/gogcli`;
                break;
              }
            }
          }
          if (sourceDir) {
            try {
              fs.copyFileSync(`${sourceDir}/credentials.json`, instanceCreds);
              const srcConfig = `${sourceDir}/config.json`;
              if (fs.existsSync(srcConfig)) {
                fs.copyFileSync(srcConfig, `${gogDir}/config.json`);
              }
            } catch (copyErr) {
              runtime.error(`[router] failed to copy gogcli credentials: ${String(copyErr)}`);
            }
          }
        }

        // Import tokens into the user's container via docker exec
        const tokenFile = `/tmp/gog-import-${channelId}.json`;
        const tokenData = {
          email: "default",
          client: "default",
          refresh_token: tokens.refresh_token,
        };
        fs.writeFileSync(tokenFile, JSON.stringify(tokenData));

        // Copy token file into container and import
        const { execSync } = await import("node:child_process");
        const container = `agents.channel-${channelId}`;
        try {
          execSync(`docker cp ${tokenFile} ${container}:/tmp/gog-token.json`, { stdio: "pipe" });
          execSync(
            `docker exec -e GOG_KEYRING_PASSWORD=openclaw ${container} gog auth tokens import /tmp/gog-token.json`,
            { stdio: "pipe" },
          );
          execSync(`docker exec ${container} rm /tmp/gog-token.json`, { stdio: "pipe" });
          runtime.log(`[router] Google tokens imported into container for channel ${channelId}`);
        } catch (importErr) {
          runtime.error(`[router] gogcli import failed: ${String(importErr)}`);
        }
        fs.unlinkSync(tokenFile);

        pendingGoogleAuth.delete(discordUserId);

        // Show the capabilities card.
        await discordSend(
          discordToken,
          channelId,
          "Google account connected successfully! Here are some things I can help you with:\n\n" +
            "📅 **Calendar**: check your schedule, create events, set reminders\n" +
            "📧 **Email**: read and summarize your inbox, draft replies\n" +
            "📁 **Drive**: search and manage your files\n" +
            "✅ **Tasks**: manage your to-do lists\n" +
            "🔄 **Recurring tasks**: set up heartbeats and automated check-ins\n\n" +
            "What would you like to try first?",
        );

        // Tell the agent so it can tick the Google item on its BOOTSTRAP.md
        // checklist and continue.
        void routeMessage({
          authorId: discordUserId,
          channelId,
          messageContent:
            "[system] The user just connected their Google account. You now have access to their Google Calendar, Gmail, Drive, Contacts, Tasks, Sheets, and Docs via the gog command. If BOOTSTRAP.md exists, tick the Google item (and delete BOOTSTRAP.md if setup is now complete). The capabilities message was already sent, so acknowledge briefly without repeating it.",
          instance,
          discordToken,
          runtime,
          agentTimeoutMs,
          inflight,
          runCommand: runAgentCommand,
          onboardingGoogleSent,
        });
      } catch (err) {
        runtime.error(`[router] post-auth error: ${String(err)}`);
      }
    },
  });

  const inflight = new Set<string>();
  const pendingGoogleAuth = new Map<string, { channelId: string; authUrl: string }>();
  // Channels for which the onboarding Google card has already been posted, so
  // the deterministic first-run trigger fires at most once per channel.
  const onboardingGoogleSent = new Set<string>();

  // --- /channel command wiring ---
  const whitelist = createWhitelistChecker({
    discordToken,
    guildId: process.env.OPENCLAW_AUTH_GUILD_ID,
    roleId: process.env.OPENCLAW_WHITELIST_ROLE_ID,
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
    whitelistConfigured: whitelist.isConfigured,
    describeInstance,
    provisioning,
    log: (message) => runtime.log(message),
  };

  // Dispatches the agent's `⁘` control commands to host-side actions the agent
  // cannot do itself (posting official Discord embeds and buttons).
  const runAgentCommand: RunAgentCommand = async (cmd, ctx) => {
    const { channelId, authorId } = ctx;
    if (cmd.command === "return") {
      return null; // deliberate no-op, nothing to relay
    }
    if (cmd.command === "send_hook_embed") {
      const name = cmd.args[0];
      if (name === "welcome") {
        await discordSendEmbed(discordToken, channelId, WELCOME_EMBED);
        return "welcome card sent";
      }
      if (name === "google") {
        const { authUrl } = oauth.requestAuth({ discordUserId: authorId, email: "user" });
        pendingGoogleAuth.set(authorId, { channelId, authUrl });
        await discordSendEmbedWithLinkButton(discordToken, channelId, GOOGLE_CONNECT_EMBED, {
          label: "Connect Google",
          url: authUrl,
        });
        return "google connect card sent; waiting for the user to click the button and authorize";
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
              );
            }, 10_000);
          }

          if (t === "MESSAGE_CREATE") {
            const authorId = d.author?.id;
            const isBot = d.author?.bot === true;
            const guildId = d.guild_id;
            let content = d.content ?? "";
            const channelId = d.channel_id;

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

            if (
              !authorId ||
              (isBot && !TEST_BOT_IDS.has(authorId)) ||
              (!content.trim() && !hasAttachments)
            ) {
              return;
            }

            // `/channel` management commands must work even when the channel is
            // not registered yet (register is the whole point), so handle them
            // before the registered-instance gate below.
            const channelCmd = parseChannelTextCommand(content);
            if (channelCmd) {
              const commandMessageId = d.id;
              void handleChannelCommand(
                {
                  subcommand: channelCmd.subcommand,
                  args: channelCmd.args,
                  channelId,
                  userId: authorId,
                  isDM: !guildId,
                  reply: (text) => discordSend(discordToken, channelId, text),
                },
                channelCommandDeps,
              );
              runtime.log(
                `[router] /channel ${channelCmd.subcommand ?? ""} from ${authorId} in ${channelId} (msg ${commandMessageId})`,
              );
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

            // Text command fallback: handle /command and //command prefixes
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
                    onboardingGoogleSent,
                  });
                }
              });
              return;
            }

            // Route to the agent. Onboarding (including offering Google) is
            // driven by the agent's BOOTSTRAP.md checklist and the `⁘` command
            // channel, not by a router-side state machine.
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
              onboardingGoogleSent,
            });
          }

          // Handle slash command interactions
          if (t === "INTERACTION_CREATE" && d.type === 2) {
            const interactionData = d.data;
            const interactionChannelId = d.channel_id;
            const interactionToken = d.token;
            const interactionId = d.id;

            // Helper to respond to interactions (always ephemeral)
            const respondToInteraction = (text: string) => {
              void fetch(
                `${DISCORD_API}/interactions/${interactionId}/${interactionToken}/callback`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    type: 4,
                    data: { content: text, flags: 64 },
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
                  | Array<{ name: string; options?: Array<{ name: string; value: unknown }> }>
                  | undefined
              )?.[0];
              const args: string[] = [];
              const confirm = subOpt?.options?.find((o) => o.name === "confirm")?.value;
              if (confirm !== undefined) {
                args.push(String(confirm));
              }
              const userId = (d.member?.user?.id ?? d.user?.id) as string | undefined;
              if (userId) {
                void handleChannelCommand(
                  {
                    subcommand: subOpt?.name ?? null,
                    args,
                    channelId: interactionChannelId,
                    userId,
                    isDM: !d.guild_id,
                    reply: (text) => respondToInteraction(text),
                  },
                  channelCommandDeps,
                );
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
      oauth.server.close((err) => {
        if (err) {
          runtime.error(`[router] failed to close oauth callback server: ${String(err)}`);
        }
      });
      // Lifecycle messages ("Shutting down") handled by health-monitor sidecar.
      resolve();
    };
    process.once("SIGINT", () => shutdown());
    process.once("SIGTERM", () => shutdown());
  });
}

type DiscordAttachment = {
  id: string;
  filename: string;
  content_type?: string;
  url: string;
  size: number;
};

/** Returns true if the agent responded successfully. */
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
  onboardingGoogleSent?: Set<string>;
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
            for (const chunk of chunkText(text, 2000)) {
              await discordSend(discordToken, channelId, chunk);
            }
            deliveredAnything = true;
            handled = true;
          }
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          for (const url of mediaUrls) {
            await discordSend(discordToken, channelId, url);
            deliveredAnything = true;
            handled = true;
          }
        }

        runtime.log(`[router] processed ${payloads.length} payload(s) for channel ${channelId}`);

        // If a command produced a result, relay it back to the agent for a
        // follow-up turn (bounded by the depth cap).
        if (ranCommand && commandResult !== null && commandDepth < MAX_COMMAND_ROUNDTRIPS) {
          commandDepth += 1;
          agentMessage = `[system] Command result: ${commandResult}`;
          continue;
        }
        break;
      }

      // Deterministic onboarding step: once the agent has saved the user's name
      // (USER.md filled in) during first-run setup, post the Google connect card
      // ourselves. The model reliably writes the name but does not reliably emit
      // the `⁘ send_hook_embed google` command mid-conversation, so the router
      // owns this step. Guarded by an in-memory set so it fires at most once per
      // channel per router lifetime.
      if (
        params.runCommand &&
        params.onboardingGoogleSent &&
        !params.onboardingGoogleSent.has(channelId) &&
        bootstrapExists(instance) &&
        userHasName(instance)
      ) {
        params.onboardingGoogleSent.add(channelId);
        try {
          await params.runCommand(
            { command: "send_hook_embed", args: ["google"] },
            { channelId, instance, authorId },
          );
          runtime.log(`[router] posted onboarding Google card for channel ${channelId}`);
        } catch (err) {
          params.onboardingGoogleSent.delete(channelId);
          runtime.error(`[router] failed to post onboarding Google card: ${String(err)}`);
        }
      }

      return handled || deliveredAnything;
    } finally {
      clearInterval(typingInterval);
    }
  } catch (err) {
    const errMsg = String(err);
    runtime.error(`[router] error for channel ${channelId}: ${errMsg}`);

    const isConnectionRefused =
      errMsg.includes("ECONNREFUSED") || errMsg.includes("connect ECONNREFUSED");
    const isTimeout = errMsg.includes("timeout") || errMsg.includes("ETIMEDOUT");
    const isAuthError =
      errMsg.includes("unauthorized") ||
      errMsg.includes("token_mismatch") ||
      errMsg.includes("pairing");

    if (isConnectionRefused) {
      await discordSend(
        discordToken,
        channelId,
        "*Your agent is not running. Please contact the admin to start your instance.*",
      ).catch(() => {});
    } else if (isAuthError) {
      // Don't send error to user for auth issues — admin problem
      runtime.error(`[router] auth error for channel ${channelId}, container may need restart`);
    } else if (isTimeout) {
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

/** Send an embed with a single Discord link-style button (opens `url`). */
/** Discord rejects link-button URLs longer than this, so we fall back to an
 * in-embed markdown link for longer URLs (e.g. Google OAuth URLs with many
 * scopes). */
const DISCORD_BUTTON_URL_MAX = 512;

async function discordSendEmbedWithLinkButton(
  token: string,
  channelId: string,
  embed: { title: string; description: string; color?: number },
  button: { label: string; url: string },
): Promise<void> {
  // A link button carries the URL cleanly, but Discord caps button URLs at 512
  // chars. When the URL is longer, drop the button and put a markdown link in
  // the embed description instead, so the card still works.
  const useButton = button.url.length <= DISCORD_BUTTON_URL_MAX;
  const body = useButton
    ? {
        embeds: [embed],
        components: [
          {
            type: 1, // action row
            components: [
              { type: 2, style: 5, label: button.label, url: button.url }, // link button
            ],
          },
        ],
      }
    : {
        embeds: [
          { ...embed, description: `${embed.description}\n\n**[${button.label}](${button.url})**` },
        ],
      };
  try {
    const resp = await fetch(`${DISCORD_API}${Routes.channelMessages(channelId)}`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error(
        `[router] embed+link send failed ${resp.status} for ${channelId}: ${detail.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error(`[router] embed+link send error for ${channelId}: ${String(err)}`);
  }
}

/**
 * Proactively message all non-onboarded users on startup.
 * Sends a welcome DM and triggers the agent to greet them.
 */
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
): Promise<void> {
  const botId = (
    (await fetch(`${DISCORD_API}/applications/@me`, {
      headers: { Authorization: `Bot ${discordToken}` },
    }).then((r) => r.json())) as { id?: string }
  )?.id;

  for (const [channelId, instance] of instances) {
    try {
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

      // Skip italic lifecycle messages (*Back online.*, *Shutting down...*)
      const isLifecycle = (c: string) => /^\*[^*]+\*$/.test(c?.trim() ?? "");

      let lastUserMsg: (typeof messages)[0] | undefined;
      for (const msg of messages) {
        if (isLifecycle(msg.content)) {
          continue;
        }
        if (msg.author.bot || msg.author.id === botId) {
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
