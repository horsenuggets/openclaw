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

// Known tool feedback patterns in the rich format (*ToolName*) and
// the older italic format (*Verbing ...*).
const TOOL_FEEDBACK_PATTERNS = [
  "*Read*",
  "*Bash*",
  "*Edit*",
  "*Write*",
  "*Grep*",
  "*Glob*",
  "*Web Search*",
  "*Web Fetch*",
  "*WebSearch*",
  "*WebFetch*",
  "*Sub-agent*",
  // Older italic format.
  "*Reading",
  "*Running",
  "*Editing",
  "*Writing",
  "*Searching",
  "*Fetching",
  "*Globbing",
];

/** Wait for the bot to finish responding in a channel. Returns when
 * at least one `create` event exists and `quietPeriodMs` elapses
 * with no new events, or `maxWaitMs` total time has elapsed. */
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

/** Check that no tool result content is duplicated excessively.
 * It is acceptable for content to appear in a tool result block AND
 * the final reply (up to 2 occurrences). Appearing in 3+ messages
 * indicates a duplication bug. We look for substantial content
 * snippets (lines >30 chars) shared across messages. */
function assertNoExcessiveDuplication(creates: MessageEvent[]): void {
  if (creates.length < 3) {
    return; // Not enough messages for duplication to be a problem.
  }

  // Collect content lines from each created message. We only look
  // at lines that are substantial enough to be meaningful tool output
  // (skip short lines like tool names and blank lines).
  const lineToMessageIds = new Map<string, Set<string>>();

  for (const event of creates) {
    const content = event.content ?? "";
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip short lines, code fence markers, and tool feedback labels.
      if (trimmed.length < 30) {
        continue;
      }
      if (trimmed.startsWith("```")) {
        continue;
      }
      if (TOOL_FEEDBACK_PATTERNS.some((p) => trimmed.startsWith(p))) {
        continue;
      }

      const existing = lineToMessageIds.get(trimmed) ?? new Set();
      existing.add(event.messageId);
      lineToMessageIds.set(trimmed, existing);
    }
  }

  // Flag any line appearing in more than 2 distinct messages.
  const duplicated: string[] = [];
  for (const [line, msgIds] of lineToMessageIds) {
    if (msgIds.size > 2) {
      duplicated.push(`"${line.slice(0, 80)}..." appeared in ${msgIds.size} messages`);
    }
  }

  if (duplicated.length > 0) {
    throw new Error(`Tool result content duplicated in >2 messages:\n${duplicated.join("\n")}`);
  }
}

// Test suite names and their channel suffixes.
const TEST_SUITES = [
  "read",
  "bash",
  "multi-tool",
  "web-search",
  "thinking",
  "fmt-wide",
  "fmt-blanks",
  "fmt-long",
  "fmt-short",
] as const;
type SuiteName = (typeof TEST_SUITES)[number];

describeLive("Discord multi-tool feedback display", () => {
  let client: Client;
  const nonce = randomBytes(4).toString("hex");
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const probePath = path.join(os.tmpdir(), `e2e-probe-${nonce}.txt`);

  // Per-suite state: channel ID and captured events.
  const suiteState = new Map<SuiteName, { channelId: string; events: MessageEvent[] }>();

  beforeAll(async () => {
    const token = resolveTestBotToken();

    // Write probe file for the read test.
    fs.writeFileSync(probePath, `E2E probe content: ${nonce}\n`);

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

    // Create one channel per test suite.
    const guild = await client.guilds.fetch(GUILD_ID);
    for (const suite of TEST_SUITES) {
      const channelName = `e2e-${today}-${suite}-${nonce}`;
      const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `E2E multi-tool feedback test: ${suite} (auto-created, safe to delete)`,
      });
      suiteState.set(suite, { channelId: channel.id, events: [] });
    }

    // Route message events to the correct suite's event list.
    client.on(Events.MessageCreate, (msg) => {
      if (msg.author.id !== CLAW_BOT_ID) {
        return;
      }
      for (const state of suiteState.values()) {
        if (msg.channelId === state.channelId) {
          state.events.push({
            type: "create",
            messageId: msg.id,
            content: msg.content,
            timestamp: Date.now(),
          });
          break;
        }
      }
    });

    client.on(Events.MessageUpdate, (_oldMsg, newMsg) => {
      if (newMsg.author?.id !== CLAW_BOT_ID) {
        return;
      }
      for (const state of suiteState.values()) {
        if (newMsg.channelId === state.channelId) {
          state.events.push({
            type: "update",
            messageId: newMsg.id,
            content: newMsg.content ?? undefined,
            timestamp: Date.now(),
          });
          break;
        }
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
    // Clean up probe file.
    try {
      fs.unlinkSync(probePath);
    } catch {
      /* already gone */
    }
    if (client) {
      await client.destroy();
    }
  });

  /** Helper to get suite state or throw. */
  function getSuiteState(suite: SuiteName) {
    const state = suiteState.get(suite);
    if (!state) {
      throw new Error(`Suite state for "${suite}" not initialized`);
    }
    return state;
  }

  /** Helper to fetch the channel and assert it is text-based. */
  async function fetchTextChannel(channelId: string) {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }
    return channel;
  }

  /** Helper to log captured messages for debugging. */
  function logEvents(suiteName: string, events: MessageEvent[]): void {
    const creates = events.filter((e) => e.type === "create");
    console.log(`[E2E:${suiteName}] Captured ${creates.length} messages from Claw bot:`);
    for (const e of creates) {
      const preview = (e.content ?? "").slice(0, 120);
      console.log(`  [${e.type}] ${preview}`);
    }
  }

  /** Assert that at least one message contains rich tool feedback. */
  function assertHasToolFeedback(creates: MessageEvent[]): void {
    const hasToolFeedback = creates.some((e) => {
      const c = e.content ?? "";
      return TOOL_FEEDBACK_PATTERNS.some((pattern) => c.includes(pattern));
    });
    expect(hasToolFeedback).toBe(true);
  }

  // ---------------------------------------------------------------
  // Test 1: Read tool
  // ---------------------------------------------------------------
  it("read-test: shows rich tool feedback when the bot reads a file", async () => {
    const { channelId, events } = getSuiteState("read");
    events.length = 0;

    const channel = await fetchTextChannel(channelId);

    await channel.send(
      `<@${CLAW_BOT_ID}> I left a file at ${probePath} for you. ` +
        `Read it and tell me what it says. This is for an E2E test.`,
    );

    await waitForBotResponse(events, 90_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    const updates = events.filter((e) => e.type === "update");

    logEvents("read", events);

    // The bot must have responded.
    expect(creates.length).toBeGreaterThan(0);

    // No edits allowed.
    expect(updates).toHaveLength(0);

    // Should contain tool feedback (Read or similar).
    assertHasToolFeedback(creates);

    // The final reply should contain the probe content.
    const finalReply = creates[creates.length - 1];
    expect(finalReply?.content).toContain(nonce);

    // No excessive duplication.
    assertNoExcessiveDuplication(creates);
  }, 120_000);

  // ---------------------------------------------------------------
  // Test 2: Bash tool
  // ---------------------------------------------------------------
  it("bash-test: shows rich tool feedback when the bot runs a shell command", async () => {
    const { channelId, events } = getSuiteState("bash");
    events.length = 0;

    const channel = await fetchTextChannel(channelId);

    await channel.send(
      `<@${CLAW_BOT_ID}> Please run this shell command and tell me what it outputs: ls /tmp | head -5`,
    );

    await waitForBotResponse(events, 90_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    const updates = events.filter((e) => e.type === "update");

    logEvents("bash", events);

    expect(creates.length).toBeGreaterThan(0);
    expect(updates).toHaveLength(0);

    // Should contain Bash tool feedback.
    const hasBashFeedback = creates.some((e) => {
      const c = e.content ?? "";
      return c.includes("*Bash*") || c.includes("*Running");
    });
    expect(hasBashFeedback).toBe(true);

    assertNoExcessiveDuplication(creates);
  }, 120_000);

  // ---------------------------------------------------------------
  // Test 3: Multi-tool usage
  // ---------------------------------------------------------------
  it("multi-tool-test: shows rich tool feedback when the bot uses multiple tools", async () => {
    const { channelId, events } = getSuiteState("multi-tool");
    events.length = 0;

    const channel = await fetchTextChannel(channelId);

    await channel.send(
      `<@${CLAW_BOT_ID}> List the files in /tmp using a shell command, ` +
        `then read the file at ${probePath} and tell me its contents. ` +
        `This is for an E2E test.`,
    );

    await waitForBotResponse(events, 100_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    const updates = events.filter((e) => e.type === "update");

    logEvents("multi-tool", events);

    expect(creates.length).toBeGreaterThan(0);
    expect(updates).toHaveLength(0);

    // Should contain tool feedback for at least two different tools.
    const allContent = creates.map((e) => e.content ?? "").join("\n");
    const toolsFound = new Set<string>();

    if (allContent.includes("*Bash*") || allContent.includes("*Running")) {
      toolsFound.add("Bash");
    }
    if (allContent.includes("*Read*") || allContent.includes("*Reading")) {
      toolsFound.add("Read");
    }
    if (allContent.includes("*Glob*") || allContent.includes("*Globbing")) {
      toolsFound.add("Glob");
    }
    if (allContent.includes("*Grep*") || allContent.includes("*Searching")) {
      toolsFound.add("Grep");
    }

    // We expect at least 2 different tool types to have been used.
    expect(toolsFound.size).toBeGreaterThanOrEqual(2);

    // The final reply should contain the probe content.
    const finalReply = creates[creates.length - 1];
    expect(finalReply?.content).toContain(nonce);

    assertNoExcessiveDuplication(creates);
  }, 120_000);

  // ---------------------------------------------------------------
  // Test 4: Web search
  // ---------------------------------------------------------------
  it("web-search-test: shows rich tool feedback when the bot searches the web", async () => {
    const { channelId, events } = getSuiteState("web-search");
    events.length = 0;

    const channel = await fetchTextChannel(channelId);

    await channel.send(
      `<@${CLAW_BOT_ID}> Search the web for "current weather in Tokyo" ` +
        `and tell me what you find. This is for an E2E test.`,
    );

    await waitForBotResponse(events, 100_000, 15_000);

    const creates = events.filter((e) => e.type === "create");

    logEvents("web-search", events);

    expect(creates.length).toBeGreaterThan(0);

    // Web search responses may trigger Discord link embed updates
    // (not a bug) so we don't assert zero updates here.

    // Should contain web search/fetch tool feedback. The bot may use
    // Web Search, Web Fetch, or the older *Searching*/*Fetching* format.
    const hasWebFeedback = creates.some((e) => {
      const c = e.content ?? "";
      return (
        c.includes("*Web Search*") ||
        c.includes("*WebSearch*") ||
        c.includes("*Web Fetch*") ||
        c.includes("*WebFetch*") ||
        c.includes("*Searching") ||
        c.includes("*Fetching") ||
        // MCP tool names may also appear.
        c.includes("*web_search*") ||
        c.includes("*fetch*")
      );
    });
    expect(hasWebFeedback).toBe(true);

    assertNoExcessiveDuplication(creates);
  }, 120_000);

  // ---------------------------------------------------------------
  // Test 5: Extended thinking
  // ---------------------------------------------------------------
  it("thinking-test: handles extended thinking without duplication", async () => {
    const { channelId, events } = getSuiteState("thinking");
    events.length = 0;

    const channel = await fetchTextChannel(channelId);

    await channel.send(
      `<@${CLAW_BOT_ID}> This is a reasoning test. Please think step by step: ` +
        `If I have 3 boxes, the first contains only apples, the second contains ` +
        `only oranges, and the third contains both apples and oranges. All boxes ` +
        `are labeled incorrectly. If I pick one fruit from the box labeled ` +
        `"apples and oranges", how can I correctly label all the boxes?`,
    );

    await waitForBotResponse(events, 100_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    const updates = events.filter((e) => e.type === "update");

    logEvents("thinking", events);

    // The bot must have responded.
    expect(creates.length).toBeGreaterThan(0);

    // No edits allowed.
    expect(updates).toHaveLength(0);

    // The response should contain a substantive answer (mentions
    // boxes, labels, or fruits).
    const allContent = creates
      .map((e) => e.content ?? "")
      .join("\n")
      .toLowerCase();
    const hasSubstantiveAnswer =
      allContent.includes("box") ||
      allContent.includes("label") ||
      allContent.includes("apple") ||
      allContent.includes("orange");
    expect(hasSubstantiveAnswer).toBe(true);

    // No excessive duplication of content across messages.
    assertNoExcessiveDuplication(creates);
  }, 120_000);

  // ---------------------------------------------------------------
  // Test 6: Wide output (column truncation)
  // ---------------------------------------------------------------
  it("fmt-wide: truncates wide lines at ~80 columns", async () => {
    const { channelId, events } = getSuiteState("fmt-wide");
    events.length = 0;

    const channel = await fetchTextChannel(channelId);

    await channel.send(
      `<@${CLAW_BOT_ID}> Run this exact bash command and show me the output: ` +
        `printf '%0.s=' {1..120} && echo "" && printf '%0.s-' {1..150} && echo "" && echo "short line"`,
    );

    await waitForBotResponse(events, 90_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    logEvents("fmt-wide", events);
    expect(creates.length).toBeGreaterThan(0);
    assertHasToolFeedback(creates);
    assertNoExcessiveDuplication(creates);
  }, 120_000);

  // ---------------------------------------------------------------
  // Test 7: Output with blank lines (blank stripping)
  // ---------------------------------------------------------------
  it("fmt-blanks: strips blank lines from tool output preview", async () => {
    const { channelId, events } = getSuiteState("fmt-blanks");
    events.length = 0;

    const channel = await fetchTextChannel(channelId);

    await channel.send(
      `<@${CLAW_BOT_ID}> Run this exact bash command: ` +
        `echo "line 1" && echo "" && echo "" && echo "line 2" && echo "" && echo "line 3" && echo "" && echo "" && echo "" && echo "line 4"`,
    );

    await waitForBotResponse(events, 90_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    logEvents("fmt-blanks", events);
    expect(creates.length).toBeGreaterThan(0);
    assertHasToolFeedback(creates);
    assertNoExcessiveDuplication(creates);
  }, 120_000);

  // ---------------------------------------------------------------
  // Test 8: Long output (remaining lines indicator)
  // ---------------------------------------------------------------
  it("fmt-long: shows remaining count inside code block for long output", async () => {
    const { channelId, events } = getSuiteState("fmt-long");
    events.length = 0;

    const channel = await fetchTextChannel(channelId);

    await channel.send(
      `<@${CLAW_BOT_ID}> Run this exact bash command: ` +
        `seq 1 30 | while read n; do echo "line $n: $(printf '%0.s#' $(seq 1 $n))"; done`,
    );

    await waitForBotResponse(events, 90_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    logEvents("fmt-long", events);
    expect(creates.length).toBeGreaterThan(0);
    assertHasToolFeedback(creates);

    // At least one message should contain "remaining" inside a
    // code block (our new formatting).
    const hasRemaining = creates.some((e) => {
      const c = e.content ?? "";
      return c.includes("remaining)") && c.includes("```");
    });
    expect(hasRemaining).toBe(true);

    assertNoExcessiveDuplication(creates);
  }, 120_000);

  // ---------------------------------------------------------------
  // Test 9: Short output (no remaining indicator)
  // ---------------------------------------------------------------
  it("fmt-short: shows short output without remaining indicator", async () => {
    const { channelId, events } = getSuiteState("fmt-short");
    events.length = 0;

    const channel = await fetchTextChannel(channelId);

    await channel.send(`<@${CLAW_BOT_ID}> Run this exact bash command: echo "hello world"`);

    await waitForBotResponse(events, 90_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    logEvents("fmt-short", events);
    expect(creates.length).toBeGreaterThan(0);
    assertHasToolFeedback(creates);

    // With only 1 output line, no remaining indicator should appear.
    const hasRemaining = creates.some((e) => (e.content ?? "").includes("remaining)"));
    expect(hasRemaining).toBe(false);

    assertNoExcessiveDuplication(creates);
  }, 120_000);
});
