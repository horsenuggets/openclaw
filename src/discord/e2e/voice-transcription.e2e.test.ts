/**
 * Voice transcription E2E test.
 *
 * Creates a channel, sends a heads-up message, then waits for a
 * human-initiated voice message. The gateway has requireMention
 * disabled on the E2E guild so the bot auto-replies to every
 * message (including voice).
 *
 * Run:
 *   LIVE=1 npx vitest run --config vitest.e2e.config.ts \
 *     src/discord/e2e/voice-transcription.e2e.test.ts
 */
import { ChannelType, Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  e2eChannelName,
  type MessageEvent,
  resolveTestBotToken,
  waitForBotResponse,
} from "./helpers.js";

const GUILD_ID = process.env.DISCORD_E2E_GUILD_ID ?? "1471323114418733261";
const CLAW_BOT_ID = process.env.DISCORD_E2E_CLAW_BOT_ID ?? "1468764779471700133";
const TEST_BOT_TOKEN = resolveTestBotToken();

// Long timeout — human needs time to send voice message from phone.
const VOICE_MSG_WAIT_MS = 180_000;
const BOT_RESPONSE_WAIT_MS = 120_000;
const QUIET_PERIOD_MS = 15_000;

describe("voice transcription", () => {
  let client: Client;
  let channelId: string;
  const events: MessageEvent[] = [];

  beforeAll(async () => {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message],
    });

    await client.login(TEST_BOT_TOKEN);

    // Create a fresh test channel.
    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.create({
      name: e2eChannelName(),
      type: ChannelType.GuildText,
      topic: "Voice transcription E2E test (auto-created, safe to delete)",
    });
    channelId = channel.id;
    console.log(`\nTest channel created: #${channel.name} (${channelId})`);
    console.log(`Discord link: https://discord.com/channels/${GUILD_ID}/${channelId}`);

    // Track all bot messages in this channel.
    client.on(Events.MessageCreate, (msg) => {
      if (msg.channelId !== channelId) return;
      if (msg.author.id !== CLAW_BOT_ID) return;
      console.log(`[bot] ${msg.content.slice(0, 120)}`);
      events.push({
        type: "create",
        messageId: msg.id,
        content: msg.content,
        timestamp: Date.now(),
      });
    });

    client.on(Events.MessageUpdate, (_old, msg) => {
      if (msg.channelId !== channelId) return;
      if (msg.author?.id !== CLAW_BOT_ID) return;
      events.push({
        type: "update",
        messageId: msg.id,
        content: msg.content ?? undefined,
        timestamp: Date.now(),
      });
    });
  }, 30_000);

  afterAll(async () => {
    client?.destroy();
  });

  it(
    "bot transcribes a voice message sent by a human",
    async () => {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) throw new Error("Channel not text-based");

      // Send a heads-up so the human knows where to go.
      await channel.send("Waiting for a voice message. " + "Please send one from your phone now.");

      console.log("\n--- Waiting up to 3 minutes for a voice message ---\n");

      // Wait for any non-bot message with an audio attachment.
      const voiceReceived = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), VOICE_MSG_WAIT_MS);
        const handler = (msg: import("discord.js").Message) => {
          if (msg.channelId !== channelId) return;
          if (msg.author.id === CLAW_BOT_ID) return;
          if (msg.author.bot) return;
          const hasAudio = msg.attachments.some((a) => a.contentType?.startsWith("audio/"));
          if (hasAudio) {
            console.log(
              `Voice message received from ${msg.author.username} ` +
                `(${msg.attachments.size} attachment(s))`,
            );
            clearTimeout(timeout);
            client.off(Events.MessageCreate, handler);
            resolve(true);
          }
        };
        client.on(Events.MessageCreate, handler);
      });

      expect(voiceReceived).toBe(true);

      // Now wait for the bot to respond.
      console.log("\n--- Waiting for bot response ---\n");
      events.length = 0;
      await waitForBotResponse(events, BOT_RESPONSE_WAIT_MS, QUIET_PERIOD_MS);

      const creates = events.filter((e) => e.type === "create");
      console.log(`\nBot sent ${creates.length} message(s):`);
      for (const e of creates) {
        console.log(`  > ${e.content?.slice(0, 200)}`);
      }

      expect(creates.length).toBeGreaterThan(0);

      // The bot should have responded with something meaningful,
      // not an error about being unable to process audio.
      const fullResponse = creates.map((e) => e.content ?? "").join("\n");
      const looksLikeTranscription =
        fullResponse.length > 20 &&
        !fullResponse.toLowerCase().includes("unable to process") &&
        !fullResponse.toLowerCase().includes("cannot transcribe");
      expect(looksLikeTranscription).toBe(true);
    },
    VOICE_MSG_WAIT_MS + BOT_RESPONSE_WAIT_MS + 30_000,
  );
});
