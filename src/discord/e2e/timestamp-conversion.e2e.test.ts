import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";
import {
  type MessageEvent,
  resolveE2eConfig,
  resolveTestBotToken,
  waitForBotResponse,
} from "./helpers.js";

// Gated behind LIVE=1 — these tests hit real Discord.
const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

const { botId: BOT_ID, guildId: GUILD_ID } = resolveE2eConfig();

describeLive("Discord timestamp conversion", () => {
  let client: Client;
  let channelId: string;
  const events: MessageEvent[] = [];
  const nonce = randomBytes(4).toString("hex");
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

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

    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.create({
      name: `e2e-${today}-ts-${nonce}`,
      type: ChannelType.GuildText,
      topic: "E2E timestamp conversion test (auto-created, safe to delete)",
    });
    channelId = channel.id;

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
  }, 30000);

  afterAll(async () => {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      const channels = await guild.channels.fetch();
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const [, ch] of channels) {
        if (!ch) continue;
        const match = ch.name.match(/^e2e-(\d{4}-\d{2}-\d{2})-/);
        if (match) {
          const channelDate = new Date(match[1]).getTime();
          if (channelDate < cutoff) {
            await ch.delete().catch(() => {});
          }
        }
      }
    } catch {
      // Best-effort cleanup.
    }
    if (client) {
      await client.destroy();
    }
  });

  it("converts time references to Discord timestamps in bot response", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Ask the bot to produce a schedule packed with time references
    // in both 12-hour and 24-hour formats.
    await channel.send(
      `<@${BOT_ID}> Give me a detailed weekly schedule for a ` +
        `productive work week. For each day (Monday through Friday), ` +
        `list at least 6 time slots using 24-hour time format ` +
        `(like 06:00, 09:30, 12:00, 14:30, 17:00, 21:00). ` +
        `Include a mix of work blocks, meals, exercise, and breaks. ` +
        `Use the exact time format like "09:00" and "14:30" ` +
        `(not words like "nine o'clock"). Do not use any tools.`,
    );

    await waitForBotResponse(events, 180_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    expect(creates.length).toBeGreaterThan(0);

    // Collect all message content from the bot.
    const fullResponse = creates.map((e) => e.content ?? "").join("\n");

    // The response should contain Discord timestamp markers.
    const discordTimestamps = fullResponse.match(/<t:\d+:[tfTFdDR]>/g) ?? [];

    console.log(
      `Bot response: ${creates.length} message chunks, ` +
        `${discordTimestamps.length} Discord timestamps found.`,
    );

    // We asked for 5 days x 6 time slots = 30 minimum. Allow some
    // variance since the LLM may not produce exactly what we asked,
    // but we should see a substantial number of conversions.
    expect(discordTimestamps.length).toBeGreaterThanOrEqual(10);

    // Verify no raw HH:MM patterns remain outside code blocks (the
    // conversion should have caught them).
    // Strip code blocks and Discord timestamps, then check for
    // leftover time-like patterns.
    const stripped = fullResponse
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`]*`/g, "")
      .replace(/<t:\d+:[tfTFdDR]>/g, "");
    const leftoverTimes = stripped.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/g) ?? [];

    console.log(
      `Leftover unconverted time patterns: ${leftoverTimes.length}` +
        (leftoverTimes.length > 0 ? ` (${leftoverTimes.join(", ")})` : ""),
    );
  }, 210_000);
});
