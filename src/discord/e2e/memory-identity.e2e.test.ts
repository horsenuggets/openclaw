import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";

// Gated behind LIVE=1 — these tests hit real Discord.
const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

const CLAW_BOT_ID = process.env.DISCORD_E2E_CLAW_BOT_ID ?? "1468764779471700133";
const GUILD_ID = process.env.DISCORD_E2E_GUILD_ID ?? "1471323114418733261";

function resolveTestBotToken(): string {
  if (process.env.DISCORD_E2E_BOT_TOKEN) {
    return process.env.DISCORD_E2E_BOT_TOKEN;
  }
  const keyPath = path.join(os.homedir(), ".keys", "discord-e2e-bot-token");
  try {
    return fs.readFileSync(keyPath, "utf-8").trim();
  } catch {
    throw new Error(
      `Discord E2E bot token not found. Set DISCORD_E2E_BOT_TOKEN or ` +
        `create ${keyPath} with the token.`,
    );
  }
}

type MessageEvent = {
  type: "create" | "update" | "delete";
  messageId: string;
  content?: string;
  timestamp: number;
};

async function waitForBotResponse(
  events: MessageEvent[],
  maxWaitMs: number,
  quietPeriodMs: number,
): Promise<void> {
  const startTime = Date.now();
  let lastEventTime = startTime;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 1000));

    const latestEvent = events[events.length - 1];
    if (latestEvent) {
      lastEventTime = latestEvent.timestamp;
    }

    const creates = events.filter((e) => e.type === "create");
    if (creates.length > 0 && Date.now() - lastEventTime >= quietPeriodMs) {
      break;
    }
  }
}

describeLive("Discord memory identity", () => {
  let client: Client;
  const nonce = randomBytes(4).toString("hex");
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let channelId = "";
  const events: MessageEvent[] = [];

  beforeAll(async () => {
    const token = resolveTestBotToken();

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    await client.login(token);

    await new Promise<void>((resolve) => {
      if (client.isReady()) {
        resolve();
      } else {
        client.once(Events.ClientReady, () => resolve());
      }
    });

    // Create a test channel.
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.create({
      name: `e2e-${today}-memory-identity-${nonce}`,
      type: ChannelType.GuildText,
      topic: "E2E memory identity test (auto-created, safe to delete)",
    });
    channelId = channel.id;

    // Track bot messages.
    client.on(Events.MessageCreate, (msg) => {
      if (msg.author.id === CLAW_BOT_ID && msg.channelId === channelId) {
        events.push({
          type: "create",
          messageId: msg.id,
          content: msg.content,
          timestamp: Date.now(),
        });
      }
    });

    // Prune E2E channels older than 7 days.
    try {
      const channels = await guild.channels.fetch();
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const [, ch] of channels) {
        if (!ch) {
          continue;
        }
        const match = ch.name.match(/^e2e-(\d{4}-\d{2}-\d{2})-/);
        if (!match) {
          continue;
        }
        const channelDate = new Date(match[1]).getTime();
        if (Number.isNaN(channelDate) || channelDate >= cutoff) {
          continue;
        }
        try {
          await ch.delete();
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* best effort */
    }
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.destroy();
    }
  });

  it("responds with OpenClaw workspace paths, not Claude Code paths", async () => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error("Channel not found or not text-based");
    }

    // Ask the bot where it stores memories.
    await channel.send(
      `<@${CLAW_BOT_ID}> If I ask you to remember something, where ` +
        `exactly do you store it? Give me the full file path.`,
    );

    // Wait for the bot to respond (up to 90s, 15s quiet period).
    await waitForBotResponse(events, 90_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    console.log(`[E2E:memory-identity] Captured ${creates.length} messages:`);
    for (const e of creates) {
      console.log(`  ${(e.content ?? "").slice(0, 200)}`);
    }

    expect(creates.length).toBeGreaterThan(0);

    // Combine all bot response text.
    const fullResponse = creates.map((e) => e.content ?? "").join("\n");
    const responseLower = fullResponse.toLowerCase();

    // Must mention OpenClaw workspace paths.
    expect(responseLower).toMatch(/\.openclaw/);
    expect(responseLower).toMatch(/memory\.md/);

    // Must NOT mention Claude Code internal paths.
    expect(responseLower).not.toMatch(/\.claude\/projects/);
    expect(responseLower).not.toMatch(/\.claude\/.*memory/);

    // Should not identify as Claude Code.
    expect(fullResponse).not.toMatch(/I am Claude Code|I'm Claude Code|running.*Claude Code/);
  }, 100_000);
});
