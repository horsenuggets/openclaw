import type { Browser, BrowserContext } from "playwright-core";
import { Client, Events, GatewayIntentBits } from "discord.js";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";
import { parseFenceSpans } from "../../markdown/fences.js";
import {
  type MessageEvent,
  createE2eChannel,
  resolveTestBotToken,
  waitForBotResponse,
} from "./helpers.js";
import {
  captureChannelScreenshots,
  ensureDiscordLogin,
  launchDiscordBrowser,
  saveStorageState,
} from "./visual-helpers.js";

// Gated behind LIVE=1 — these tests hit real Discord.
const LIVE = isTruthyEnvValue(process.env.LIVE) || isTruthyEnvValue(process.env.CLAWDBOT_LIVE_TEST);
const describeLive = LIVE ? describe : describe.skip;

const CLAW_BOT_ID = process.env.DISCORD_E2E_CLAW_BOT_ID ?? "1468764779471700133";
const GUILD_ID = process.env.DISCORD_E2E_GUILD_ID ?? "1471323114418733261";

const INLINE_MARKERS = ["**", "__", "~~", "||"];

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

describeLive("Discord visual formatting verification", () => {
  let client: Client;
  let channelId: string;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
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
    const channel = await createE2eChannel(
      guild,
      "E2E visual formatting test (auto-created, safe to delete)",
    );
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

    // Launch browser for visual screenshots (optional — CAPTCHA may
    // block automated login; the API-level check still runs).
    try {
      const launched = await launchDiscordBrowser();
      browser = launched.browser;
      context = launched.context;

      const page = await context.newPage();
      await ensureDiscordLogin(page);
      await saveStorageState(context);
      await page.close();
    } catch (err) {
      console.warn(
        "Browser login failed (screenshots will be skipped):",
        err instanceof Error ? err.message : err,
      );
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
      context = undefined;
      browser = undefined;
    }
  }, 60_000);

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

    if (context) {
      await saveStorageState(context).catch(() => {});
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (client) {
      await client.destroy();
    }
  }, 30_000);

  it("renders bold-heavy multi-chunk response with balanced markers and captures screenshots", async () => {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    // Prompt the bot for a long, formatting-heavy response that
    // exercises cross-chunk bold rebalancing, bullet lists, and
    // tables.
    await channel.send(
      `<@${CLAW_BOT_ID}> Compare REST vs GraphQL vs gRPC in detail. ` +
        `For each protocol, include: a description paragraph, a ` +
        `bullet list of **bold advantages** and **bold disadvantages** ` +
        `(use - dashes for list items), a comparison table, and a ` +
        `"When to Choose" section with bold terms. Make the response ` +
        `as long and detailed as possible with at least 30 bullet ` +
        `points total. Do not use any tools.`,
    );

    // Wait for the response (long timeout for multi-chunk output).
    await waitForBotResponse(events, 180_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    expect(creates.length).toBeGreaterThan(0);

    // API-level check: every chunk must have balanced inline markers.
    const failures: string[] = [];
    for (const event of creates) {
      const content = event.content ?? "";
      if (!content.trim()) continue;

      for (const marker of INLINE_MARKERS) {
        if (!hasBalancedInlineMarkers(content, marker)) {
          const preview = content.length > 120 ? `${content.slice(0, 120)}...` : content;
          failures.push(
            `Message ${event.messageId} has unbalanced ` +
              `"${marker}" marker. Preview: ${preview}`,
          );
        }
      }
    }

    if (failures.length > 0) {
      // Print full content of failing messages for debugging.
      for (const event of creates) {
        const content = event.content ?? "";
        if (!content.trim()) continue;
        for (const marker of INLINE_MARKERS) {
          if (!hasBalancedInlineMarkers(content, marker)) {
            console.log(`\n=== UNBALANCED "${marker}" in ${event.messageId} ===`);
            console.log(content);
            console.log("=== END ===\n");
            break;
          }
        }
      }
      throw new Error("Found messages with broken inline formatting:\n" + failures.join("\n"));
    }

    // Visual verification: capture screenshots if browser is available.
    if (context) {
      const page = await context.newPage();
      const channelUrl = `https://discord.com/channels/${GUILD_ID}/${channelId}`;
      const outputDir = path.join(import.meta.dirname, "screenshots");

      const result = await captureChannelScreenshots(page, channelUrl, outputDir);
      await page.close();

      console.log(
        `Captured ${result.files.length} screenshots for ` + `${creates.length} message chunks.`,
      );
      for (const file of result.files) {
        console.log(`  ${file}`);
      }

      expect(result.files.length).toBeGreaterThan(0);
    } else {
      console.log(
        "Browser not available, skipping visual screenshots. " +
          "API-level marker balance check still ran.",
      );
    }

    if (creates.length > 1) {
      console.log(
        `Verified ${creates.length} message chunks all have ` + "balanced inline formatting.",
      );
    }
  }, 240_000);
});
