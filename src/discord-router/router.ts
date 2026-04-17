import { Client, MessageCreateListener } from "@buape/carbon";
import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import { Routes } from "discord-api-types/v10";
import { randomUUID } from "node:crypto";
import type { RouterConfig, InstanceConfig } from "./config.js";
import { getDiscordGatewayEmitter, waitForDiscordGatewayStop } from "../discord/monitor.gateway.js";
import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";

type AgentResult = {
  runId: string;
  status: string;
  result?: {
    payloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
  };
};

export type RouterRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

const TYPING_INTERVAL_MS = 8_000;

/**
 * Start the Discord router. Connects to Discord, listens for DMs,
 * and forwards them to per-user Docker containers via gateway API.
 */
export async function startRouter(config: RouterConfig, runtime: RouterRuntime): Promise<void> {
  const { discordToken, instances, agentTimeoutMs } = config;

  // Resolve application ID
  const appIdResponse = (await fetch("https://discord.com/api/v10/applications/@me", {
    headers: { Authorization: `Bot ${discordToken}` },
  }).then((r) => r.json())) as { id?: string };
  const applicationId = appIdResponse?.id;
  if (!applicationId) {
    throw new Error("Failed to resolve Discord application ID");
  }
  runtime.log(`[router] application id: ${applicationId}`);
  runtime.log(`[router] instances: ${instances.size}`);
  for (const [userId, inst] of instances) {
    runtime.log(`  ${userId} → localhost:${inst.port}`);
  }

  // Track in-flight requests per user
  const inflight = new Set<string>();

  const messageListener = new RouterMessageListener({
    instances,
    inflight,
    config,
    runtime,
    agentTimeoutMs,
  });

  const client = new Client(
    {
      baseUrl: "http://localhost",
      deploySecret: "a",
      clientId: applicationId,
      publicKey: "a",
      token: discordToken,
      autoDeploy: false,
    },
    { commands: [], listeners: [messageListener], components: [] },
    [
      new GatewayPlugin({
        reconnect: { maxAttempts: Number.POSITIVE_INFINITY },
        intents:
          GatewayIntents.Guilds |
          GatewayIntents.GuildMessages |
          GatewayIntents.MessageContent |
          GatewayIntents.DirectMessages |
          GatewayIntents.DirectMessageReactions,
        autoInteractions: false,
      }),
    ],
  );

  // Fetch bot user info
  try {
    const botUser = await client.fetchUser("@me");
    runtime.log(`[router] logged in as ${botUser?.id ?? "unknown"}`);
  } catch (err) {
    runtime.error(`[router] failed to fetch bot identity: ${formatErrorMessage(err)}`);
  }

  const gateway = client.getPlugin<GatewayPlugin>("gateway");
  const gatewayEmitter = getDiscordGatewayEmitter(gateway);

  // Keep running until gateway stops or signal
  const abortController = new AbortController();
  const onExit = () => abortController.abort();
  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);

  try {
    await waitForDiscordGatewayStop({
      gateway: gateway
        ? { emitter: gatewayEmitter, disconnect: () => gateway.disconnect() }
        : undefined,
      abortSignal: abortController.signal,
      onGatewayError: (err) => {
        runtime.error(`[router] gateway error: ${String(err)}`);
      },
      shouldStopOnError: (err) => {
        const message = String(err);
        return (
          message.includes("Max reconnect attempts") || message.includes("Fatal Gateway error")
        );
      },
    });
  } finally {
    process.removeListener("SIGINT", onExit);
    process.removeListener("SIGTERM", onExit);
  }
}

class RouterMessageListener extends MessageCreateListener {
  private instances: Map<string, InstanceConfig>;
  private inflight: Set<string>;
  private config: RouterConfig;
  private runtime: RouterRuntime;
  private agentTimeoutMs: number;

  constructor(opts: {
    instances: Map<string, InstanceConfig>;
    inflight: Set<string>;
    config: RouterConfig;
    runtime: RouterRuntime;
    agentTimeoutMs: number;
  }) {
    super();
    this.instances = opts.instances;
    this.inflight = opts.inflight;
    this.config = opts.config;
    this.runtime = opts.runtime;
    this.agentTimeoutMs = opts.agentTimeoutMs;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handle(data: any, client: Client): Promise<void> {
    const authorId = data.author?.id;
    const isBot = data.author?.bot === true;
    if (!authorId || isBot) {
      return;
    }

    // Only handle DMs (no guild = direct message)
    const isDM = !data.guild?.id && !data.guildId;
    if (!isDM) {
      return;
    }

    const messageContent = data.content ?? "";
    if (!messageContent.trim()) {
      return;
    }

    const channelId = data.channelId;
    const instance = this.instances.get(authorId);

    if (!instance) {
      this.runtime.log(`[router] no instance for user ${authorId}, ignoring DM`);
      await sendDM(client.rest, channelId, "No agent is configured for your account.").catch(
        () => {},
      );
      return;
    }

    // Serialize per-user requests
    if (this.inflight.has(authorId)) {
      this.runtime.log(`[router] user ${authorId} already has in-flight request, queuing`);
    }
    while (this.inflight.has(authorId)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    this.inflight.add(authorId);
    try {
      await handleDM({
        discordUserId: authorId,
        channelId,
        messageContent,
        instance,
        client,
        runtime: this.runtime,
        agentTimeoutMs: this.agentTimeoutMs,
      });
    } catch (err) {
      this.runtime.error(`[router] error handling DM from ${authorId}: ${formatErrorMessage(err)}`);
      await sendDM(
        client.rest,
        channelId,
        "Sorry, something went wrong processing your message.",
      ).catch(() => {});
    } finally {
      this.inflight.delete(authorId);
    }
  }
}

async function handleDM(params: {
  discordUserId: string;
  channelId: string;
  messageContent: string;
  instance: InstanceConfig;
  client: Client;
  runtime: RouterRuntime;
  agentTimeoutMs: number;
}): Promise<void> {
  const { discordUserId, channelId, messageContent, instance, client, runtime, agentTimeoutMs } =
    params;

  runtime.log(`[router] DM from ${discordUserId}: ${messageContent.slice(0, 80)}...`);

  // Start typing indicator
  const typingInterval = setInterval(() => {
    sendTyping(client.rest, channelId).catch(() => {});
  }, TYPING_INTERVAL_MS);
  await sendTyping(client.rest, channelId).catch(() => {});

  try {
    const idempotencyKey = randomUUID();
    const result = await callGateway<AgentResult>({
      url: `ws://127.0.0.1:${instance.port}`,
      token: instance.token || undefined,
      method: "agent",
      params: {
        message: messageContent,
        channel: "internal",
        deliver: false,
        idempotencyKey,
        timeout: Math.floor(agentTimeoutMs / 1000),
      },
      expectFinal: true,
      timeoutMs: agentTimeoutMs + 30_000,
      clientName: "cli",
      mode: "backend",
    });

    const payloads = result?.result?.payloads ?? [];
    if (payloads.length === 0) {
      runtime.log(`[router] empty response from container for ${discordUserId}`);
      return;
    }

    for (const payload of payloads) {
      const text = payload.text?.trim();
      if (text) {
        const chunks = chunkText(text, 2000);
        for (const chunk of chunks) {
          await sendDM(client.rest, channelId, chunk);
        }
      }
      const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      for (const url of mediaUrls) {
        await sendDM(client.rest, channelId, url);
      }
    }

    runtime.log(`[router] delivered ${payloads.length} payload(s) to ${discordUserId}`);
  } finally {
    clearInterval(typingInterval);
  }
}

/** Simple text chunking for Discord's 2000-char limit. */
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

async function sendDM(rest: Client["rest"], channelId: string, content: string): Promise<void> {
  await rest.post(Routes.channelMessages(channelId), {
    body: { content },
  });
}

async function sendTyping(rest: Client["rest"], channelId: string): Promise<void> {
  await rest.post(Routes.channelTyping(channelId), {});
}
