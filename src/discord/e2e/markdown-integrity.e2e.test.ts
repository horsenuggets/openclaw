import { Client, Events, GatewayIntentBits } from "discord.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";
import { parseFenceSpans } from "../../markdown/fences.js";
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

// 2-char inline markers that Discord renders as formatting toggles.
const INLINE_MARKERS = ["**", "__", "~~", "||"];

/**
 * Count occurrences of a 2-char marker outside of fenced code blocks
 * and inline code spans. Returns true if the count is even (balanced).
 */
function hasBalancedInlineMarkers(text: string, marker: string): boolean {
  const fenceSpans = parseFenceSpans(text);
  let inInlineCode = false;
  let count = 0;
  let i = 0;

  while (i < text.length) {
    if (!inInlineCode) {
      const fence = fenceSpans.find((s) => i >= s.start && i < s.end);
      if (fence) {
        i = fence.end;
        continue;
      }
    }

    if (text[i] === "`") {
      inInlineCode = !inInlineCode;
      i++;
      continue;
    }
    if (inInlineCode) {
      i++;
      continue;
    }

    if (i + 1 < text.length && `${text[i]}${text[i + 1]}` === marker) {
      count++;
      i += 2;
      continue;
    }

    i++;
  }

  return count % 2 === 0;
}

describeLive("Discord markdown formatting integrity", () => {
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
    const channel = await createE2eChannel(guild, "E2E test (auto-created, safe to delete)");
    channelId = channel.id;

    // Track message events from the Claw bot.
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
  });

  it("every message chunk has balanced inline formatting markers", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Prompt the bot for a long, markdown-heavy response that is
    // likely to span multiple Discord message chunks.
    await channel.send(
      `<@${BOT_ID}> Write a detailed guide with at least 20 ` +
        `numbered points about healthy habits. Use **bold** for each ` +
        `habit name, use ~~strikethrough~~ for at least two common ` +
        `myths, and use bullet points. Make the response as long and ` +
        `detailed as possible with multiple paragraphs per point. ` +
        `Do not use any tools.`,
    );

    // Wait for the response (long timeout since the response
    // should be large).
    await waitForBotResponse(events, 180_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    expect(creates.length).toBeGreaterThan(0);

    // Check every created message for balanced inline markers.
    const failures: string[] = [];
    for (const event of creates) {
      const content = event.content ?? "";
      if (!content.trim()) continue;

      for (const marker of INLINE_MARKERS) {
        if (!hasBalancedInlineMarkers(content, marker)) {
          const preview = content.length > 120 ? `${content.slice(0, 120)}...` : content;
          failures.push(
            `Message ${event.messageId} has unbalanced "${marker}" ` +
              `marker. Preview: ${preview}`,
          );
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`Found messages with broken inline formatting:\n` + failures.join("\n"));
    }

    // Multi-chunk is a stronger signal that rebalancing worked.
    if (creates.length > 1) {
      console.log(
        `Verified ${creates.length} message chunks all have ` + `balanced inline formatting.`,
      );
    }
  }, 210_000);
});
