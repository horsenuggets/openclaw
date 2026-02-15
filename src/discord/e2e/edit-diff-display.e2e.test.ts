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

// The Claw bot's Discord user ID.
const CLAW_BOT_ID = process.env.DISCORD_E2E_CLAW_BOT_ID ?? "1468764779471700133";
// Guild where the E2E tester bot can create channels.
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

describeLive("Discord Edit diff display", () => {
  let client: Client;
  let channelId: string;
  const events: MessageEvent[] = [];
  const nonce = randomBytes(4).toString("hex");
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const probePath = path.join(os.tmpdir(), `e2e-edit-diff-${nonce}.txt`);

  beforeAll(async () => {
    const token = resolveTestBotToken();

    // Write a probe file with known content for the bot to edit.
    fs.writeFileSync(
      probePath,
      [
        `const greeting = "hello";`,
        `const target = "world";`,
        `console.log(greeting, target);`,
        "",
      ].join("\n"),
    );

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
      name: `e2e-${today}-edit-diff-${nonce}`,
      type: ChannelType.GuildText,
      topic: "E2E edit diff display test (auto-created, safe to delete)",
    });
    channelId = channel.id;

    client.on(Events.MessageCreate, (msg) => {
      if (msg.author.id !== CLAW_BOT_ID || msg.channelId !== channelId) {
        return;
      }
      events.push({
        type: "create",
        messageId: msg.id,
        content: msg.content,
        timestamp: Date.now(),
      });
    });

    client.on(Events.MessageUpdate, (_oldMsg, newMsg) => {
      if (newMsg.author?.id !== CLAW_BOT_ID || newMsg.channelId !== channelId) {
        return;
      }
      events.push({
        type: "update",
        messageId: newMsg.id,
        content: newMsg.content ?? undefined,
        timestamp: Date.now(),
      });
    });

    // Prune old E2E channels (>7 days).
    try {
      const channels = await guild.channels.fetch();
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const [, ch] of channels) {
        if (!ch) continue;
        const match = ch.name.match(/^e2e-(\d{4}-\d{2}-\d{2})-/);
        if (!match) continue;
        const channelDate = new Date(match[1]).getTime();
        if (Number.isNaN(channelDate) || channelDate >= cutoff) continue;
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
    try {
      fs.unlinkSync(probePath);
    } catch {
      /* already gone */
    }
    if (client) {
      await client.destroy();
    }
  });

  it("shows a diff code block when the bot edits a file", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Ask the bot to edit a specific string in the probe file.
    // This should trigger the Edit tool with old_string/new_string.
    await channel.send(
      `<@${CLAW_BOT_ID}> Edit the file at ${probePath}. ` +
        `Change the line \`const greeting = "hello";\` to ` +
        `\`const greeting = "howdy";\`. ` +
        `Use the Edit tool, not Write. This is for an E2E test.`,
    );

    await waitForBotResponse(events, 120_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    const updates = events.filter((e) => e.type === "update");

    console.log(`[E2E:edit-diff] Captured ${creates.length} messages from Claw bot:`);
    for (const e of creates) {
      const preview = (e.content ?? "").slice(0, 200);
      console.log(`  [${e.type}] ${preview}`);
    }

    // The bot must have responded.
    expect(creates.length).toBeGreaterThan(0);

    // No edits allowed.
    expect(updates).toHaveLength(0);

    // At least one message should contain an Edit tool result header.
    const hasEditFeedback = creates.some((e) => {
      const c = e.content ?? "";
      return c.includes("*Edit*");
    });
    expect(hasEditFeedback).toBe(true);

    // At least one message should contain a diff code block
    // with the changed lines.
    const hasDiffBlock = creates.some((e) => {
      const c = e.content ?? "";
      return c.includes("```diff");
    });
    expect(hasDiffBlock).toBe(true);

    // The diff should show the old and new values.
    const allContent = creates.map((e) => e.content ?? "").join("\n");
    expect(allContent).toContain("- ");
    expect(allContent).toContain("+ ");

    // Verify the file was actually edited.
    const fileContent = fs.readFileSync(probePath, "utf-8");
    expect(fileContent).toContain("howdy");
  }, 180_000);
});
