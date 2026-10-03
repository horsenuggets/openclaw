import type { Guild, Message } from "discord.js";
import { ChannelType, Events } from "discord.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Names already generated in this process, so rapid-fire calls
// (e.g. multi-tool-feedback creating 10 channels in a loop) never
// collide even before the guild channel list is re-fetched.
const generatedNames = new Set<string>();

// Shared temp file for cross-process coordination. Vitest forks
// pool runs each test file in a separate process, each with its
// own generatedNames Set. Without a shared registry, two workers
// calling e2eChannelName in the same second both produce the same
// timestamp and create duplicate Discord channels. A directory-
// based lock (mkdir is atomic on all platforms) serialises the
// read-pick-claim cycle across workers.
const SHARED_NAMES_FILE = path.join(os.tmpdir(), "openclaw-e2e-channel-names.txt");
const SHARED_NAMES_LOCK = SHARED_NAMES_FILE + ".lock";

function acquireLock(): void {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(SHARED_NAMES_LOCK);
      return;
    } catch {
      // Lock held by another worker, spin briefly.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  // Deadline exceeded (stale lock from a crashed worker). Break
  // the lock and proceed — better than hanging the test suite.
  try {
    fs.rmdirSync(SHARED_NAMES_LOCK);
  } catch {
    // Already removed by another worker.
  }
  fs.mkdirSync(SHARED_NAMES_LOCK);
}

function releaseLock(): void {
  try {
    fs.rmdirSync(SHARED_NAMES_LOCK);
  } catch {
    // Already removed (shouldn't happen, but harmless).
  }
}

function readSharedNames(): Set<string> {
  try {
    const content = fs.readFileSync(SHARED_NAMES_FILE, "utf-8");
    return new Set(content.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * Generate a standardized E2E channel name using the local
 * timestamp: `e2e-YYYY-MM-DD-t-HH-MM-SS`. When `existingNames`
 * is provided the seconds (and minutes/hours) are incremented
 * until the name is unique — the timestamp may not reflect the
 * real wall-clock time, but the format stays valid.
 *
 * Names are coordinated across parallel vitest workers via a
 * shared temp file protected by a directory lock.
 */
export function e2eChannelName(existingNames?: Iterable<string>): string {
  const taken = new Set<string>(existingNames);
  for (const n of generatedNames) {
    taken.add(n);
  }

  acquireLock();
  try {
    for (const n of readSharedNames()) {
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
    fs.appendFileSync(SHARED_NAMES_FILE, name + "\n");
    return name;
  } finally {
    releaseLock();
  }
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
 * Upper bound a freshly registered channel's agent may take to provision (spin
 * up the box, reach the model) and post its first turn. The real wait is
 * usually far shorter; this is the ceiling before {@link createE2eChannel}
 * gives up and throws.
 */
export const AGENT_READY_TIMEOUT_MS = 120_000;

/**
 * Suggested `beforeAll` budget for a suite that provisions `channelCount`
 * channels through {@link createE2eChannel}. Each channel can take up to
 * {@link AGENT_READY_TIMEOUT_MS} to come up (they are created serially), plus a
 * flat allowance for client login and channel creation. Callers must size their
 * hook timeout with this (or the global `hookTimeout` in vitest.e2e.config.ts),
 * otherwise the hook aborts before provisioning can finish.
 */
export function e2eSetupTimeout(channelCount = 1): number {
  return channelCount * AGENT_READY_TIMEOUT_MS + 60_000;
}

/**
 * Resolve once the bot posts a non-empty text message in `channelId`,
 * signalling the per-channel agent is provisioned and has completed its first
 * turn. The router replies to `/channel register` with an embed first
 * (registration accepted) and then an onboarding/welcome text turn once the
 * agent box is up and the model is reachable; we wait for that text turn so a
 * test's first probe is not sent before the agent can answer.
 *
 * The `MessageCreate` listener is attached synchronously when this is called,
 * so callers must invoke it (capturing the promise) BEFORE posting
 * `/channel register`: Discord delivers gateway events independently of the REST
 * `send()` response, so a fast onboarding message can otherwise arrive before
 * the listener exists and be missed. Resolves `true` on the first bot text
 * message, or `false` after `timeoutMs`.
 *
 * Exported for unit testing.
 */
export function waitForAgentReady(
  guild: Guild,
  channelId: string,
  botId: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const client = guild.client;
    const done = (ready: boolean) => {
      clearTimeout(timer);
      client.off(Events.MessageCreate, onMessage);
      resolve(ready);
    };
    const onMessage = (m: Message) => {
      if (
        m.channelId === channelId &&
        m.author?.id === botId &&
        (m.content?.trim()?.length ?? 0) > 0
      ) {
        done(true);
      }
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    client.on(Events.MessageCreate, onMessage);
  });
}

/**
 * Create an E2E text channel with a clash-free timestamp name, register it with
 * the router, and wait for its agent to come up.
 *
 * The router only converses in registered channels (provisioning is explicit:
 * an unregistered guild channel is ignored), so every E2E channel must send
 * `/channel register` before it can get a reply. The tester bot is allowlisted
 * for provisioning (OPENCLAW_ADMIN_OVERRIDE_IDS / OPENCLAW_ROUTER_ALLOW_BOT_IDS),
 * so it can self-register. We then wait for the agent's first turn so callers do
 * not race the box spin-up, and throw if it never comes up so the failure is
 * attributed here rather than surfacing as a silent timeout in the first probe.
 *
 * `ownerId` registers the channel on another user's behalf (admin-only, which
 * the allowlisted tester bot is): the router routes guild messages only for the
 * recorded owner, so a test that expects a human (not the driver bot) to
 * converse must register under that human's user id. Defaults to the driver bot.
 *
 * `botId` is the id whose first message signals readiness; it defaults to the
 * configured bot-under-test and is injectable for unit tests.
 */
export function buildRegisterCommand(ownerId?: string): string {
  return ownerId ? `/channel register <@${ownerId}>` : "/channel register";
}

export async function createE2eChannel(
  guild: Guild,
  topic: string,
  ownerId?: string,
  botId: string = resolveE2eConfig().botId,
) {
  const channels = await guild.channels.fetch();
  const existingNames = new Set<string>();
  for (const [, ch] of channels) {
    if (ch) {
      existingNames.add(ch.name);
    }
  }

  const name = e2eChannelName(existingNames);
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    topic,
  });

  // Start listening BEFORE registering so a fast onboarding turn delivered over
  // the gateway cannot land before the listener is attached (see
  // waitForAgentReady). Await the result afterwards and fail loudly on timeout.
  const ready = waitForAgentReady(guild, channel.id, botId, AGENT_READY_TIMEOUT_MS);
  await channel.send(buildRegisterCommand(ownerId));
  if (!(await ready)) {
    throw new Error(
      `E2E channel #${name} (${channel.id}) agent did not post a ready message ` +
        `within ${AGENT_READY_TIMEOUT_MS}ms of /channel register`,
    );
  }

  return channel;
}

export function resolveTestBotToken(): string {
  const token = process.env.DISCORD_E2E_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "Discord E2E bot token not found. Set the DISCORD_E2E_BOT_TOKEN environment variable.",
    );
  }
  return token;
}

/**
 * Extract the bot user ID from a Discord bot token. Tokens are
 * structured as base64(user_id).timestamp.hmac — the first
 * dot-delimited segment decodes to the numeric user ID.
 */
export function botIdFromToken(token: string): string {
  const segment = token.split(".")[0];
  if (!segment) {
    throw new Error("Invalid Discord token format (no dot-delimited segments).");
  }
  const decoded = Buffer.from(segment, "base64").toString("utf-8");
  if (!/^\d+$/.test(decoded)) {
    throw new Error(
      "Invalid Discord token format (first segment does not decode to a numeric ID).",
    );
  }
  return decoded;
}

/**
 * Resolve E2E test configuration from environment variables and
 * the OpenClaw config file (~/.openclaw/openclaw.json).
 *
 * - `botId`: derived from the Discord bot token already configured
 *   in the OpenClaw config (channels.discord.token or
 *   channels.discord.accounts.default.token).
 * - `guildId`: from DISCORD_E2E_GUILD_ID env var or
 *   channels.discord.e2e.guildId in config.
 */
export function resolveE2eConfig(): { botId: string; guildId: string } {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");

  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    // Config file missing or malformed — env vars are still checked.
  }

  const discord = (cfg.channels as Record<string, unknown>)?.discord as
    | Record<string, unknown>
    | undefined;

  // Resolve bot ID from the configured Discord token.
  const token =
    (discord?.token as string | undefined) ??
    ((discord?.accounts as Record<string, Record<string, unknown>>)?.default?.token as
      | string
      | undefined);

  if (!token) {
    throw new Error(
      "Cannot derive Discord bot ID. Set channels.discord.token in ~/.openclaw/openclaw.json.",
    );
  }
  const botId = botIdFromToken(token);

  // Resolve guild ID.
  const e2e = discord?.e2e as Record<string, unknown> | undefined;
  const guildId = process.env.DISCORD_E2E_GUILD_ID?.trim() || (e2e?.guildId as string | undefined);

  if (!guildId) {
    throw new Error(
      "Discord E2E guild ID not found. Set DISCORD_E2E_GUILD_ID " +
        "or channels.discord.e2e.guildId in ~/.openclaw/openclaw.json.",
    );
  }

  return { botId, guildId };
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
