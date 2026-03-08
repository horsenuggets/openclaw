import { Client, Events, GatewayIntentBits } from "discord.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";
import {
  type MessageEvent,
  createE2eChannel,
  resolveE2eConfig,
  resolveTestBotToken,
  waitForBotResponse,
} from "./helpers.js";

// Gated behind LIVE=1 — these tests hit real Discord.
const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

const { botId: BOT_ID, guildId: GUILD_ID } = resolveE2eConfig();

describeLive("Discord block streaming (multi-tool separate messages)", () => {
  let client: Client;
  let channelId: string;
  let events: MessageEvent[];

  beforeAll(async () => {
    const token = resolveTestBotToken();
    events = [];

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    client.on(Events.MessageCreate, (msg) => {
      if (msg.author.id === BOT_ID && msg.channelId === channelId) {
        events.push({
          type: "create",
          messageId: msg.id,
          content: msg.content,
          timestamp: Date.now(),
        });
      }
    });

    client.on(Events.MessageUpdate, (_oldMsg, newMsg) => {
      if (newMsg.author?.id === BOT_ID && newMsg.channelId === channelId) {
        events.push({
          type: "update",
          messageId: newMsg.id,
          content: newMsg.content ?? undefined,
          timestamp: Date.now(),
        });
      }
    });

    await client.login(token);
    await new Promise<void>((resolve) => {
      if (client.isReady()) {
        resolve();
      } else {
        client.once(Events.ClientReady, () => resolve());
      }
    });

    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await createE2eChannel(guild, "block-streaming E2E test");
    channelId = channel.id;
  }, 30_000);

  afterAll(async () => {
    if (client) {
      await client.destroy();
    }
  });

  it("multi-tool response sends separate messages, not one concatenated block", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Prompt that forces multiple tool calls with text between
    // them, so the bot produces acknowledgment text before each
    // tool invocation. Each text segment should arrive as its
    // own Discord message.
    await channel.send(
      `<@${BOT_ID}> Do these steps one at a time, acknowledging ` +
        `each step before proceeding:\n` +
        `1. Run: echo "step-one-alpha"\n` +
        `2. Run: echo "step-two-bravo"\n` +
        `3. Tell me the outputs of both commands.`,
    );

    // Wait for the bot to finish (long quiet period since
    // multi-tool responses can take a while).
    await waitForBotResponse(events, 120_000, 15_000);

    const creates = events.filter((e) => e.type === "create");

    console.log(`[E2E:block-streaming] Captured ${creates.length} messages:`);
    for (const e of creates) {
      const preview = (e.content ?? "").slice(0, 120);
      console.log(`  [${e.type}] ${preview}`);
    }

    // The bot should have sent more than 1 message. With block
    // streaming working, each text segment between tool calls
    // arrives as a separate message.
    expect(creates.length).toBeGreaterThan(1);

    // The outputs from both commands should appear somewhere in
    // the response messages.
    const allContent = creates.map((e) => e.content ?? "").join("\n");
    expect(allContent).toContain("step-one-alpha");
    expect(allContent).toContain("step-two-bravo");

    // Regression guard: no single message should contain ALL of
    // the text content concatenated together. If block streaming
    // is broken, one message will hold everything.
    const uniqueMessageIds = new Set(creates.map((e) => e.messageId));
    expect(uniqueMessageIds.size).toBeGreaterThan(1);
  }, 150_000);
});
