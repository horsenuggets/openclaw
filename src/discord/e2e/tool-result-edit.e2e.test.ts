import { Client, Events, GatewayIntentBits } from "discord.js";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";
import { type MessageEvent, createE2eChannel, resolveTestBotToken } from "./helpers.js";

// Gated behind LIVE=1 — these tests hit real Discord.
const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

const CLAW_BOT_ID = process.env.DISCORD_E2E_CLAW_BOT_ID ?? "1468764779471700133";
const GUILD_ID = process.env.DISCORD_E2E_GUILD_ID ?? "1471323114418733261";

describeLive("Discord tool result edit-in-place", () => {
  let client: Client;
  let channelId: string;
  let events: MessageEvent[];
  const nonce = randomBytes(4).toString("hex");

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

    await client.login(token);

    await new Promise<void>((resolve) => {
      if (client.isReady()) {
        resolve();
      } else {
        client.once(Events.ClientReady, () => resolve());
      }
    });

    // Create ephemeral test channel.
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await createE2eChannel(
      guild,
      "E2E tool result edit-in-place test (auto-created, safe to delete)",
    );
    channelId = channel.id;

    // Track messages from the Claw bot in the new channel.
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
    if (client) {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
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
      await client.destroy();
    }
  });

  it("edits the status message to append tool results for a slow command", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Ask the bot to run a command that takes ~8 seconds. The tool
    // feedback buffer flushes after 4s, so a status message will be
    // sent first. When the command finishes, the result should be
    // edited into the existing status message rather than sent as
    // a separate message.
    await channel.send(
      `<@${CLAW_BOT_ID}> Run this exact bash command and tell me ` +
        `the output: sleep 8 && echo "E2E-MARKER-${nonce}"`,
    );

    // Wait for the bot to respond. 120s max, 15s quiet period.
    const startTime = Date.now();
    const maxWaitMs = 120_000;
    const quietPeriodMs = 15_000;
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

    const creates = events.filter((e) => e.type === "create");
    const updates = events.filter((e) => e.type === "update");

    // Debug: log all captured events for diagnosability.
    console.log(`[E2E] Captured ${events.length} events from Claw bot:`);
    for (const e of events) {
      const preview = (e.content ?? "").slice(0, 300);
      console.log(`  [${e.type}] msgId=${e.messageId} ${preview}`);
    }

    // The bot must have responded with at least one message.
    expect(creates.length).toBeGreaterThan(0);

    // There should be at least one edit event where the status
    // message was updated to include the tool result.
    expect(updates.length).toBeGreaterThan(0);

    // Find edited messages. The updated content should contain
    // both the tool status header and a code block (tool result).
    const editedMessageIds = new Set(updates.map((e) => e.messageId));
    const editedContents = updates
      .filter((e) => editedMessageIds.has(e.messageId))
      .map((e) => e.content ?? "");

    // At least one edited message should contain a code fence.
    const hasCodeBlock = editedContents.some((c) => c.includes("```"));
    expect(hasCodeBlock).toBe(true);

    // The edited message should also contain the tool status line.
    const hasToolStatus = editedContents.some(
      (c) => c.includes("*Running") || c.includes("*Bash*"),
    );
    expect(hasToolStatus).toBe(true);

    // The final reply or edit should contain our marker.
    const allContent = [...creates.map((e) => e.content ?? ""), ...editedContents].join("\n");
    expect(allContent).toContain(nonce);
  }, 180_000);
});
