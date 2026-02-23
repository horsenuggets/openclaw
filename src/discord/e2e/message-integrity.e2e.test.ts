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

describeLive("Discord message integrity", () => {
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

    // Track all message events from the bot in the test channel.
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

    client.on(Events.MessageDelete, (msg) => {
      if (msg.channelId === channelId) {
        // We cannot always check author on deleted messages (partial),
        // so we check if this message ID was one we saw created by the
        // bot. If we never saw it, we still record the delete for
        // safety.
        events.push({
          type: "delete",
          messageId: msg.id,
          timestamp: Date.now(),
        });
      }
    });

    await client.login(token);

    // Wait for the client to be fully ready.
    await new Promise<void>((resolve) => {
      if (client.isReady()) {
        resolve();
      } else {
        client.once(Events.ClientReady, () => resolve());
      }
    });

    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await createE2eChannel(guild, "message-integrity E2E test");
    channelId = channel.id;
  }, 30000);

  afterAll(async () => {
    if (client) {
      await client.destroy();
    }
  });

  it("bot never edits or deletes messages during a response", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Mention the bot so it responds in the guild channel.
    await channel.send(`<@${BOT_ID}> Hello! What's your name?`);

    await waitForBotResponse(events, 60000, 10000);

    const creates = events.filter((e) => e.type === "create");
    const updates = events.filter((e) => e.type === "update");
    const deletes = events.filter((e) => e.type === "delete");

    // The bot must have responded.
    expect(creates.length).toBeGreaterThan(0);

    // No message should have been edited.
    expect(updates).toHaveLength(0);

    // No message should have been deleted.
    expect(deletes).toHaveLength(0);
  }, 90000);

  it("bot never edits or deletes messages for a complex request", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Mention the bot with a complex request that would trigger
    // smart-ack and tool usage, where the edit/delete bug was most
    // visible.
    await channel.send(
      `<@${BOT_ID}> Can you explain the difference between TCP and UDP ` +
        `protocols? Include some real-world examples of when you'd use each one.`,
    );

    await waitForBotResponse(events, 90000, 10000);

    const creates = events.filter((e) => e.type === "create");
    const updates = events.filter((e) => e.type === "update");
    const deletes = events.filter((e) => e.type === "delete");

    expect(creates.length).toBeGreaterThan(0);
    expect(updates).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  }, 120000);
});
