import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** Wait until we see at least one bot message, indicating the run
 * has started. Gives up after `maxWaitMs`. */
async function waitForFirstBotMessage(events: MessageEvent[], maxWaitMs: number): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 500));
    if (events.some((e) => e.type === "create")) {
      return true;
    }
  }
  return false;
}

describeLive("Discord mid-turn messaging (steer mode)", () => {
  let client: Client;
  const nonce = randomBytes(4).toString("hex");

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

    // Create an isolated channel for this test.
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.create({
      name: e2eChannelName(),
      type: ChannelType.GuildText,
      topic: `E2E mid-turn messaging test (auto-created, safe to delete)`,
    });
    channelId = channel.id;

    // Route message events to our event list.
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

  /** Helper to fetch the channel and assert it is text-based. */
  async function fetchTextChannel() {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }
    return channel;
  }

  /** Helper to log captured messages for debugging. */
  function logEvents(label: string): void {
    const creates = events.filter((e) => e.type === "create");
    console.log(`[E2E:${label}] Captured ${creates.length} messages from Claw bot:`);
    for (const e of creates) {
      const preview = (e.content ?? "").slice(0, 120);
      console.log(`  [${e.type} t=${e.timestamp}] ${preview}`);
    }
  }

  // ---------------------------------------------------------------
  // Test: Main agent addresses follow-up after tool calls complete
  // ---------------------------------------------------------------
  it("responds to follow-up while tool is still running", async () => {
    events.length = 0;

    const channel = await fetchTextChannel();

    // Use sleep 20 to create a long window where the tool is running.
    // The follow-up is injected via followUp() and addressed by the
    // main agent after the bash command completes.
    await channel.send(
      `<@${CLAW_BOT_ID}> Run this exact bash command and tell me the output: ` +
        `sleep 20 && echo "SLOW_TASK_DONE_${nonce}"`,
    );

    // Wait for the bot to start processing (tool feedback message).
    const started = await waitForFirstBotMessage(events, 30_000);
    expect(started).toBe(true);

    // Send a follow-up while the sleep is running.
    await channel.send(`<@${CLAW_BOT_ID}> Quick question while you're working: what is 7 * 13?`);

    // Wait for the full task to complete (sleep 20 + agent processing).
    await waitForBotResponse(events, 120_000, 20_000);

    logEvents("mid-turn");

    const creates = events.filter((e) => e.type === "create");
    expect(creates.length).toBeGreaterThanOrEqual(1);

    // Tool results may be edited into status messages, so include
    // both creates and updates when checking content.
    const updates = events.filter((e) => e.type === "update");
    const allContent = [
      ...creates.map((e) => e.content ?? ""),
      ...updates.map((e) => e.content ?? ""),
    ].join("\n");

    // The original task should still complete.
    expect(allContent).toContain(`SLOW_TASK_DONE_${nonce}`);

    // The follow-up was answered by the main agent.
    expect(allContent).toContain("91");
  }, 300_000);
});
