import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import { afterAll, beforeAll, describe, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";
import {
  type MessageEvent,
  e2eChannelName,
  resolveTestBotToken,
  waitForBotResponse,
} from "./helpers.js";

// Gated behind LIVE=1 — these tests hit real Discord.
const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

// The Claw bot's Discord user ID.
const CLAW_BOT_ID = process.env.DISCORD_E2E_CLAW_BOT_ID ?? "1468764779471700133";
// Guild where the E2E tester bot can create channels.
const GUILD_ID = process.env.DISCORD_E2E_GUILD_ID ?? "1471323114418733261";

describeLive("Discord chunk splitting observation", () => {
  let client: Client;
  let channelId: string;
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

    // Create a dedicated test channel.
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.create({
      name: e2eChannelName(),
      type: ChannelType.GuildText,
      topic: "E2E chunk splitting observation (auto-created, safe to delete)",
    });
    channelId = channel.id;

    // Track message events from the Claw bot.
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

    client.on(Events.MessageUpdate, (_oldMsg, newMsg) => {
      if (newMsg.author?.id === CLAW_BOT_ID && newMsg.channelId === channelId) {
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
    // Clean up old test channels (>7 days).
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
  }, 30000);

  it("observe chunk splitting on a complex response", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Prompt that should generate a long, structured response with
    // markdown formatting likely to trigger the splitting issue.
    await channel.send(
      `<@${CLAW_BOT_ID}> Explain the key differences between REST, ` +
        `GraphQL, and gRPC APIs. For each one, cover: the core ` +
        `philosophy, typical use cases, advantages, disadvantages, ` +
        `and when you would choose it over the others. Use **bold** ` +
        `for key terms and include code examples where helpful. ` +
        `Be thorough and detailed. Do not use any tools.`,
    );

    // Wait for the full response.
    await waitForBotResponse(events, 180_000, 15_000);

    const creates = events.filter((e) => e.type === "create");

    console.log(`\n${"=".repeat(60)}`);
    console.log(`CHUNK SPLITTING OBSERVATION`);
    console.log(`Total messages: ${creates.length}`);
    console.log(`${"=".repeat(60)}\n`);

    for (let i = 0; i < creates.length; i++) {
      const content = creates[i].content ?? "";
      const lines = content.split("\n").length;
      const chars = content.length;
      const lastLine = content.split("\n").pop() ?? "";
      const firstLine = content.split("\n")[0] ?? "";

      console.log(`--- Chunk ${i + 1}/${creates.length} ---`);
      console.log(`  Characters: ${chars}`);
      console.log(`  Lines: ${lines}`);
      console.log(`  Under 2000 chars: ${chars < 2000 ? "YES" : "no"}`);
      console.log(`  First line: ${firstLine.slice(0, 80)}`);
      console.log(`  Last line:  ${lastLine.slice(0, 80)}`);

      // Check if last line looks like a mid-sentence split
      const endsCleanly =
        content.trimEnd().endsWith(".") ||
        content.trimEnd().endsWith(":") ||
        content.trimEnd().endsWith("```") ||
        content.trimEnd().endsWith("*") ||
        content.trimEnd().endsWith("!") ||
        content.trimEnd().endsWith("?") ||
        i === creates.length - 1;
      if (!endsCleanly) {
        console.log(`  ** POSSIBLE MID-SENTENCE SPLIT **`);
      }

      console.log("");
    }

    console.log(`Channel: https://discord.com/channels/${GUILD_ID}/${channelId}`);
    console.log(`\nVisit the channel above to manually verify the splitting.\n`);
  }, 210_000);
});
