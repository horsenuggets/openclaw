import type { Guild } from "discord.js";
import { ChannelType } from "discord.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Names already generated in this process, so rapid-fire calls
// (e.g. multi-tool-feedback creating 10 channels in a loop) never
// collide even before the guild channel list is re-fetched.
const generatedNames = new Set<string>();

/**
 * Generate a standardized E2E channel name using the local
 * timestamp: `e2e-YYYY-MM-DD-t-HH-MM-SS`. When `existingNames`
 * is provided the seconds (and minutes/hours) are incremented
 * until the name is unique — the timestamp may not reflect the
 * real wall-clock time, but the format stays valid.
 */
export function e2eChannelName(existingNames?: Iterable<string>): string {
  const taken = new Set<string>(existingNames);
  for (const n of generatedNames) {
    taken.add(n);
  }

  const cursor = new Date();
  cursor.setMilliseconds(0);

  let name = formatChannelTimestamp(cursor);

  while (taken.has(name)) {
    cursor.setSeconds(cursor.getSeconds() + 1);
    name = formatChannelTimestamp(cursor);
  }

  generatedNames.add(name);
  return name;
}

function formatChannelTimestamp(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const min = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `e2e-${yyyy}-${mm}-${dd}-t-${hh}-${min}-${ss}`;
}

/**
 * Create an E2E text channel with a clash-free timestamp name.
 * Fetches existing guild channels, picks a unique name, and
 * creates the channel.
 */
export async function createE2eChannel(guild: Guild, topic: string) {
  const channels = await guild.channels.fetch();
  const existingNames = new Set<string>();
  for (const [, ch] of channels) {
    if (ch) {
      existingNames.add(ch.name);
    }
  }

  const name = e2eChannelName(existingNames);
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    topic,
  });
}

export function resolveTestBotToken(): string {
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

export type MessageEvent = {
  type: "create" | "update" | "delete";
  messageId: string;
  content?: string;
  timestamp: number;
};

export async function waitForBotResponse(
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
