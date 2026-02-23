import { Client, Events, GatewayIntentBits } from "discord.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";
import { createE2eChannel, resolveTestBotToken, waitForBotResponse } from "./helpers.js";

// Gated behind LIVE=1 — these tests hit real Discord.
const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

const CLAW_BOT_ID = process.env.DISCORD_E2E_CLAW_BOT_ID ?? "1468764779471700133";
const GUILD_ID = process.env.DISCORD_E2E_GUILD_ID ?? "1471323114418733261";

// Short, unrelated questions the bot should answer quickly.
// Each has unique keywords so we can verify the response covers
// every topic, even when the debouncer coalesces messages into a
// single combined response.
const RAPID_FIRE_PROMPTS = [
  {
    prompt: "What is the capital of Japan?",
    keywords: ["tokyo"],
  },
  {
    prompt: "What color do you get when you mix red and blue?",
    keywords: ["purple", "violet"],
  },
  {
    prompt: "How many legs does a spider have?",
    keywords: ["eight", "8"],
  },
  {
    prompt: "What planet is closest to the sun?",
    keywords: ["mercury"],
  },
  {
    prompt: "What is the boiling point of water in Celsius?",
    keywords: ["100", "hundred"],
  },
];

type BotEvent = {
  type: "create" | "update";
  messageId: string;
  content?: string;
  referenceMessageId?: string;
  timestamp: number;
};

/**
 * Run a rapid-fire burst: send all prompts as fast as possible,
 * wait for the bot to respond, then verify every prompt was
 * answered. The bot's debouncer may coalesce rapid messages into
 * a single combined response, so we check against the aggregate
 * bot output rather than requiring 1-to-1 prompt-to-response
 * mapping.
 */
async function runBurst(
  client: Client,
  channelId: string,
  clawBotId: string,
  prompts: { prompt: string; keywords: string[] }[],
  events: BotEvent[],
  label: string,
): Promise<void> {
  events.length = 0;

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !("send" in channel)) {
    throw new Error(`Channel ${channelId} not found or not text-based`);
  }

  // Send all messages as fast as possible.
  const sentAt = Date.now();
  const sentIds: string[] = [];
  console.log(`\n[${label}] Sending ${prompts.length} messages in rapid succession...\n`);

  for (const { prompt } of prompts) {
    const sent = await channel.send(`<@${clawBotId}> ${prompt}`);
    sentIds.push(sent.id);
    console.log(`[${label}] Sent "${prompt}" (${sent.id})`);
  }

  const sendDuration = Date.now() - sentAt;
  console.log(`[${label}] All ${prompts.length} messages sent in ${sendDuration}ms\n`);

  // Wait for the bot to finish responding. The debouncer may
  // coalesce all messages into one job, so we use a generous
  // quiet period.
  await waitForBotResponse(events, 300_000, 20_000);

  // Collect all bot output.
  const creates = events.filter((e) => e.type === "create");
  const firstResponseAt = creates.length > 0 ? creates[0]!.timestamp : null;
  const allBotContent = creates.map((e) => e.content ?? "").join("\n");
  const allBotContentLower = allBotContent.toLowerCase();

  // Diagnostic output.
  console.log(
    `[${label}] Captured ${creates.length} bot message(s), ` +
      `${allBotContent.length} chars total\n`,
  );
  for (const e of creates) {
    const preview = (e.content ?? "").slice(0, 150);
    const sentIdSet = new Set(sentIds);
    const refNote = e.referenceMessageId
      ? `ref=${e.referenceMessageId} (${sentIdSet.has(e.referenceMessageId) ? "OURS" : "NOT OURS"})`
      : "no ref";
    console.log(`  [${e.messageId}] ${refNote}`);
    console.log(`    "${preview}"\n`);
  }

  // Check that every prompt's keywords appear somewhere in the
  // combined bot output.
  const answeredPrompts: string[] = [];
  const unansweredPrompts: string[] = [];

  for (const { prompt, keywords } of prompts) {
    const found = keywords.some((kw) => allBotContentLower.includes(kw));
    if (found) {
      answeredPrompts.push(prompt);
      console.log(`  PASS  "${prompt}"`);
    } else {
      unansweredPrompts.push(prompt);
      console.log(`  FAIL  "${prompt}" (expected: ${keywords.join(", ")})`);
    }
  }

  const latency = firstResponseAt ? firstResponseAt - sentAt : null;
  console.log(`\n[${label}] Summary:`);
  console.log(`  Sent          ${prompts.length} messages`);
  console.log(`  Bot messages  ${creates.length}`);
  console.log(`  Answered      ${answeredPrompts.length}/${prompts.length}`);
  console.log(`  First reply   ${latency !== null ? `${latency}ms` : "none"}`);
  if (unansweredPrompts.length > 0) {
    console.log(`  Unanswered:`);
    for (const p of unansweredPrompts) {
      console.log(`    - "${p}"`);
    }
  }
  console.log();

  // The bot must have sent at least one message.
  expect(creates.length, "Bot sent zero messages in response to rapid-fire burst").toBeGreaterThan(
    0,
  );

  // Every prompt must be answered (keywords found in aggregate
  // output). The debouncer may combine them into fewer messages,
  // but the content must still cover every topic.
  expect(
    unansweredPrompts,
    `Bot failed to answer ${unansweredPrompts.length} of ` +
      `${prompts.length} prompts: ${unansweredPrompts.join(", ")}`,
  ).toHaveLength(0);
}

describeLive("Discord rapid-fire stress test", () => {
  let client: Client;
  let channelId: string;
  const allEvents: BotEvent[] = [];

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

    // Create a dedicated channel for the stress test.
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await createE2eChannel(
      guild,
      "E2E rapid-fire stress test (auto-created, safe to delete)",
    );
    channelId = channel.id;

    // Track all bot messages in this channel.
    client.on(Events.MessageCreate, (msg) => {
      if (msg.author.id === CLAW_BOT_ID && msg.channelId === channelId) {
        allEvents.push({
          type: "create",
          messageId: msg.id,
          content: msg.content,
          referenceMessageId: msg.reference?.messageId,
          timestamp: Date.now(),
        });
      }
    });

    client.on(Events.MessageUpdate, (_oldMsg, newMsg) => {
      if (newMsg.author?.id === CLAW_BOT_ID && newMsg.channelId === channelId) {
        allEvents.push({
          type: "update",
          messageId: newMsg.id,
          content: newMsg.content ?? undefined,
          referenceMessageId: newMsg.reference?.messageId,
          timestamp: Date.now(),
        });
      }
    });
  }, 30_000);

  afterAll(async () => {
    // Prune E2E channels older than 7 days.
    if (client) {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
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
      await client.destroy();
    }
  });

  it("answers every prompt in a 5-message rapid-fire burst", async () => {
    await runBurst(client, channelId, CLAW_BOT_ID, RAPID_FIRE_PROMPTS, allEvents, "rapid-fire");
  }, 360_000);

  it("answers every prompt in a second burst after the first completes", async () => {
    await runBurst(
      client,
      channelId,
      CLAW_BOT_ID,
      [
        {
          prompt: "What is the square root of 144?",
          keywords: ["12", "twelve"],
        },
        {
          prompt: "Who wrote Romeo and Juliet?",
          keywords: ["shakespeare"],
        },
        {
          prompt: "What gas do plants absorb from the air?",
          keywords: ["carbon dioxide", "co2"],
        },
      ],
      allEvents,
      "rapid-fire-2",
    );
  }, 360_000);
});
