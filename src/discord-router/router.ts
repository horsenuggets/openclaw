import { Routes } from "discord-api-types/v10";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import WebSocket from "ws";
import type { RouterConfig, InstanceConfig } from "./config.js";
import { stripHorizontalRules } from "../discord/markdown-strip.js";
import { convertTimesToDiscordTimestamps } from "../discord/timestamps.js";
import { convertMarkdownTables } from "../markdown/tables.js";
import { refreshToken, setOnboardingState, setUserPreference } from "./config.js";
import { callGatewaySimple } from "./gateway-call.js";
import { startOAuthCallbackServer } from "./oauth-callback.js";

export type RouterRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const TYPING_INTERVAL_MS = 8_000;
const DISCORD_API = "https://discord.com/api/v10";

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

        // Mark onboarding complete
        setOnboardingState(instance, "complete");
        pendingGoogleAuth.delete(discordUserId);

        // Notify agent via Discord
        await discordSend(
          discordToken,
          channelId,
          "Google account connected successfully! Here are some things I can help you with:\n\n" +
            "📅 **Calendar** — Check your schedule, create events, set reminders\n" +
            "📧 **Email** — Read and summarize your inbox, draft replies\n" +
            "📁 **Drive** — Search and manage your files\n" +
            "✅ **Tasks** — Manage your to-do lists\n" +
            "🔄 **Recurring tasks** — Set up heartbeats and automated check-ins\n\n" +
            "What would you like to try first?",
        );

        // Also tell the agent via the gateway
        void routeMessage({
          authorId: discordUserId,
          channelId,
          messageContent:
            "[System: The user just successfully connected their Google account. Acknowledge this briefly and enthusiastically. You now have access to their Google Calendar, Gmail, Drive, Contacts, Tasks, Sheets, and Docs via the gog command. Do NOT list what you can do — that was already sent.]",
          instance,
          discordToken,
          runtime,
          agentTimeoutMs,
          inflight,
        });
      } catch (err) {
        runtime.error(`[router] post-auth error: ${String(err)}`);
      }
    },
  });

  const inflight = new Set<string>();
  const pendingGoogleAuth = new Map<string, { channelId: string; authUrl: string }>();
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  let lastSequence: number | null = null;
  let sessionId: string | undefined;
  let resumeGatewayUrl: string | undefined;
  let shuttingDown = false;

  function connect(resume = false) {
    const url = resume && resumeGatewayUrl ? resumeGatewayUrl : gatewayUrl;
    const ws = new WebSocket(`${url}/?v=10&encoding=json`);

    ws.on("open", () => {
      runtime.log(`[router] WebSocket connected to ${url}`);
    });

    ws.on("message", (raw: Buffer) => {
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
          if (t === "READY") {
            sessionId = d.session_id;
            resumeGatewayUrl = d.resume_gateway_url;
            const botUser = d.user;
            runtime.log(`[router] logged in as ${botUser?.id ?? "unknown"} (${botUser?.username})`);

            // Lifecycle messages ("Back online") handled by health-monitor sidecar.

            // Startup recovery: check for unanswered DMs and respond
            // Delay to let containers finish starting before connecting.
            setTimeout(async () => {
              // Onboard new users first
              await onboardNewChannels(
                discordToken,
                instances,
                config,
                runtime,
                agentTimeoutMs,
                inflight,
              );
              // Then recover unanswered messages
              await recoverUnansweredMessages(
                discordToken,
                instances,
                runtime,
                agentTimeoutMs,
                inflight,
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
                  });
                }
              });
              return;
            }

            // Onboarding state machine: inject context based on state
            const state = instance.onboardingState;
            if (state === "greeted") {
              // User is responding with their name
              content = `[System: The user just told you their name. Acknowledge it warmly in ONE short sentence only (e.g. "Nice to meet you, {name}! 👋"). Do NOT ask any questions or offer help. Just the name acknowledgment.]\n${content}`;
            } else if (state === "named") {
              // Named but auth link wasn't sent (e.g. router restarted mid-flow).
              // Re-send the Google auth link now.
              void (async () => {
                try {
                  const { authUrl } = oauth.requestAuth({
                    discordUserId: authorId,
                    email: "user",
                  });
                  pendingGoogleAuth.set(authorId, { channelId, authUrl });
                  await discordSend(
                    discordToken,
                    channelId,
                    `Would you like to connect your Google account? This lets me help with your calendar, email, files, and more.\n\nClick [here](${authUrl}) to connect your Google account.`,
                  );
                  setOnboardingState(instance, "google_pending");
                  runtime.log(
                    `[router] re-sent Google auth link to ${authorId} (was in named state)`,
                  );
                } catch (err) {
                  runtime.log(`[router] failed to send Google auth link: ${String(err)}`);
                  setOnboardingState(instance, "complete");
                }
              })();
              // Still route the message to the agent
            } else if (state === "google_pending") {
              // User responding to Google auth prompt — check if they declined
              const declined = /no|nah|skip|later|not now|don't|dont/i.test(content.trim());
              if (declined) {
                setOnboardingState(instance, "complete");
                runtime.log(`[router] user ${authorId} declined Google auth, onboarding complete`);
              }
              // Otherwise let the message through normally (they might be chatting)
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
            }).then(async (success) => {
              if (!success) {
                return;
              }

              // State transitions after successful agent response
              if (state === "greeted") {
                // Name acknowledged → send Google auth link
                setOnboardingState(instance, "named");
                try {
                  const { authUrl } = oauth.requestAuth({
                    discordUserId: authorId,
                    email: "user",
                  });
                  // Store auth URL for this user so the callback can find them
                  pendingGoogleAuth.set(authorId, { channelId, authUrl });
                  await discordSend(
                    discordToken,
                    channelId,
                    `Would you like to connect your Google account? This lets me help with your calendar, email, files, and more.\n\nClick [here](${authUrl}) to connect your Google account.`,
                  );
                  setOnboardingState(instance, "google_pending");
                  runtime.log(`[router] sent Google auth link to ${authorId}`);
                } catch (err) {
                  runtime.log(`[router] failed to send Google auth link: ${String(err)}`);
                  setOnboardingState(instance, "complete");
                }
              }
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
          }
          break;
        }
        case 7:
          // Reconnect requested
          runtime.log("[router] reconnect requested by Discord");
          ws.close();
          setTimeout(() => connect(true), 1000);
          break;
        case 9:
          // Invalid session
          runtime.log("[router] invalid session, re-identifying");
          sessionId = undefined;
          ws.close();
          setTimeout(() => connect(false), 5000);
          break;
      }
    });

    ws.on("close", (code: number) => {
      runtime.log(`[router] WebSocket closed (${code})`);
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = undefined;
      }
      // Always reconnect — Discord sends 1000/1001 for routine reconnects.
      // Only process exit (SIGINT/SIGTERM) should stop the router.
      if (!shuttingDown) {
        const delay = code === 4004 ? 0 : 5000; // 4004 = auth failed, don't retry
        if (code === 4004) {
          runtime.error("[router] authentication failed (4004), not reconnecting");
          return;
        }
        setTimeout(() => connect(!!sessionId), delay);
      }
    });

    ws.on("error", (err: Error) => {
      runtime.error(`[router] WebSocket error: ${err.message}`);
    });
  }

  connect(false);

  // Keep running until process exit
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      shuttingDown = true;
      // Lifecycle messages ("Shutting down") handled by health-monitor sidecar.
      resolve();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
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
      const idempotencyKey = randomUUID();
      const result = await callGatewaySimple({
        url: `ws://127.0.0.1:${instance.port}`,
        token: freshToken || undefined,
        method: "agent",
        params: {
          message: messageContent || "<media>",
          channel: "discord",
          deliver: false,
          idempotencyKey,
          sessionKey: `agent:main:discord:default:channel:${channelId}`,
          timeout: Math.floor(agentTimeoutMs / 1000),
          ...(gatewayAttachments.length > 0 ? { attachments: gatewayAttachments } : {}),
        },
        expectFinal: true,
        timeoutMs: agentTimeoutMs + 30_000,
      });

      // Stop typing as soon as we have the response
      clearInterval(typingInterval);

      const payloads = result?.result?.payloads ?? [];
      if (payloads.length === 0) {
        runtime.log(`[router] empty response for channel ${channelId}`);
        await discordSend(
          discordToken,
          channelId,
          "*I processed your message but wasn't able to generate a response. Please try again.*",
        );
        return false;
      }

      for (const payload of payloads) {
        let text = payload.text?.trim() ?? "";

        // Filter out raw JS/system errors that leaked into agent output.
        // These should never be shown to the user as normal text.
        if (isLeakedError(text)) {
          runtime.log(`[router] suppressed leaked error: ${text.slice(0, 100)}`);
          continue;
        }

        // Apply Discord text formatting pipeline
        if (text) {
          text = convertMarkdownTables(text, "code");
          text = stripHorizontalRules(text);
          text = convertTimesToDiscordTimestamps(text);
        }
        if (text) {
          const chunks = chunkText(text, 2000);
          for (const chunk of chunks) {
            await discordSend(discordToken, channelId, chunk);
          }
        }
        const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        for (const url of mediaUrls) {
          await discordSend(discordToken, channelId, url);
        }
      }

      runtime.log(`[router] delivered ${payloads.length} payload(s) to channel ${channelId}`);
      return true;
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
): Promise<void> {
  const botId = (
    (await fetch(`${DISCORD_API}/applications/@me`, {
      headers: { Authorization: `Bot ${discordToken}` },
    }).then((r) => r.json())) as { id?: string }
  )?.id;

  for (const [channelId, instance] of instances) {
    if (instance.onboardingState !== "complete") {
      continue;
    }

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
      });
    } catch (err) {
      runtime.log(`[router] recovery failed for channel ${channelId}: ${String(err)}`);
    }
  }
}

async function onboardNewChannels(
  discordToken: string,
  instances: Map<string, InstanceConfig>,
  config: RouterConfig,
  runtime: RouterRuntime,
  agentTimeoutMs: number,
  inflight: Set<string>,
): Promise<void> {
  for (const [channelId, instance] of instances) {
    if (instance.onboardingState !== "none") {
      continue;
    }

    runtime.log(`[router] proactive onboarding for channel ${channelId}`);

    // Send welcome embed
    await discordSendEmbed(discordToken, channelId, {
      title: "Welcome to OpenClaw!",
      description:
        "I'm your personal AI assistant. Let's get you set up!\nI'll ask you a few quick questions to personalize your experience.",
      color: 0xff8080,
    });

    // Route through the agent for the greeting
    void routeMessage({
      authorId: "system",
      channelId,
      messageContent:
        "[System: This is a brand new user who just joined. You are OpenClaw, a personal AI assistant. Do NOT refer to yourself as Claude Code or Claude — you are OpenClaw. Greet them warmly, introduce yourself as OpenClaw, and ask what they'd like to be called. Keep it brief and friendly — 2-3 sentences max. Do not mention Docker, containers, Google, OAuth, or any technical infrastructure. Just greet and ask their name.]",
      instance,
      discordToken,
      runtime,
      agentTimeoutMs,
      inflight,
    }).then((success) => {
      if (success) {
        setOnboardingState(instance, "greeted");
        runtime.log(`[router] onboarding greeting sent for channel ${channelId}, waiting for name`);
      } else {
        runtime.log(
          `[router] onboarding failed for channel ${channelId}, will retry on next restart`,
        );
      }
    });
  }
}
