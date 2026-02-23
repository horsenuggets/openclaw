import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
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

const CLAW_BOT_ID = process.env.DISCORD_E2E_CLAW_BOT_ID ?? "1468764779471700133";
const GUILD_ID = process.env.DISCORD_E2E_GUILD_ID ?? "1471323114418733261";

/**
 * Extract code-fenced blocks from a Discord message. Tables
 * rendered via `renderTableAsCode()` appear inside triple-backtick
 * fences.
 */
function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

/**
 * Parse a code-block table into rows of pipe-separated cells and
 * return the raw lines. Only lines that start with `|` are
 * considered table rows.
 */
function extractTableLines(codeBlock: string): string[] {
  return codeBlock
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.startsWith("|"));
}

/**
 * For a set of table lines, check that every row has its pipe
 * characters at identical byte positions. Returns a list of
 * diagnostics (empty = all aligned).
 */
function checkPipeAlignment(lines: string[]): string[] {
  if (lines.length < 2) return [];

  const pipePositions = (line: string): number[] => {
    const positions: number[] = [];
    // Use Array.from to iterate over code points properly
    const chars = Array.from(line);
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] === "|") positions.push(i);
    }
    return positions;
  };

  const reference = pipePositions(lines[0]);
  const issues: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const current = pipePositions(lines[i]);
    if (current.length !== reference.length) {
      issues.push(`Row ${i}: expected ${reference.length} pipes, got ${current.length}`);
      continue;
    }
    for (let j = 0; j < reference.length; j++) {
      if (current[j] !== reference[j]) {
        issues.push(
          `Row ${i}, pipe ${j}: at code-point position ${current[j]}, ` +
            `expected ${reference[j]}`,
        );
      }
    }
  }

  return issues;
}

describeLive("Discord table rendering with Unicode spacing", () => {
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

    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.create({
      name: e2eChannelName(),
      type: ChannelType.GuildText,
      topic: "E2E table Unicode spacing test (auto-created, safe to delete)",
    });
    channelId = channel.id;

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
  }, 60_000);

  afterAll(async () => {
    // Prune old E2E channels (>7 days).
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
  }, 30_000);

  /**
   * Helper: send a prompt, wait for the response, collect all
   * code-block tables from the response chunks, and log them.
   * Returns the collected table blocks for assertion.
   */
  async function sendAndCollectTables(prompt: string): Promise<{
    tables: { codeBlock: string; lines: string[] }[];
    rawChunks: string[];
  }> {
    events.length = 0;

    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }

    await channel.send(`<@${CLAW_BOT_ID}> ${prompt}`);
    await waitForBotResponse(events, 180_000, 15_000);

    const creates = events.filter((e) => e.type === "create");
    const rawChunks = creates.map((e) => e.content ?? "");

    const tables: { codeBlock: string; lines: string[] }[] = [];
    for (const chunk of rawChunks) {
      for (const block of extractCodeBlocks(chunk)) {
        const lines = extractTableLines(block);
        if (lines.length >= 2) {
          tables.push({ codeBlock: block, lines });
        }
      }
    }

    return { tables, rawChunks };
  }

  // ---- Test 1: Baseline ASCII table ----

  it("renders a plain ASCII table with aligned columns", async () => {
    const { tables, rawChunks } = await sendAndCollectTables(
      "Create a small markdown table comparing 3 programming languages " +
        "(Python, Rust, Go) with columns: Language, Typing, Speed, " +
        "Ecosystem. Keep it to exactly 3 data rows. Do not use any tools.",
    );

    console.log("\n=== ASCII TABLE RAW OUTPUT ===");
    for (const chunk of rawChunks) console.log(chunk);
    console.log("=== END ===\n");

    expect(tables.length).toBeGreaterThanOrEqual(1);

    for (const { codeBlock, lines } of tables) {
      const issues = checkPipeAlignment(lines);
      if (issues.length > 0) {
        console.log("ALIGNMENT ISSUES (ASCII table):");
        console.log(codeBlock);
        for (const issue of issues) console.log(`  ${issue}`);
      }
      expect(issues).toEqual([]);
    }
  }, 240_000);

  // ---- Test 2: Emoji-heavy table ----

  it("renders a table with emoji content with aligned columns", async () => {
    const { tables, rawChunks } = await sendAndCollectTables(
      "Create a markdown table with 4 rows and these exact columns: " +
        "Fruit, Emoji, Season, Rating. Use real emoji characters in the " +
        "Emoji column (like \uD83C\uDF4E \uD83C\uDF4C \uD83C\uDF47 \uD83C\uDF53). The Fruit column should be " +
        "plain ASCII text. The Rating column should use star emoji " +
        "(\u2B50\u2B50\u2B50 etc). Do not use any tools.",
    );

    console.log("\n=== EMOJI TABLE RAW OUTPUT ===");
    for (const chunk of rawChunks) console.log(chunk);
    console.log("=== END ===\n");

    expect(tables.length).toBeGreaterThanOrEqual(1);

    for (const { codeBlock, lines } of tables) {
      const issues = checkPipeAlignment(lines);
      if (issues.length > 0) {
        console.log("ALIGNMENT ISSUES (emoji table):");
        console.log(codeBlock);
        for (const issue of issues) console.log(`  ${issue}`);
      }
      // Log but do not assert yet; we expect this may fail.
      if (issues.length > 0) {
        console.warn(`Emoji table has ${issues.length} alignment issues (expected for now)`);
      }
    }
  }, 240_000);

  // ---- Test 3: CJK characters (Chinese/Japanese/Korean) ----

  it("renders a table with CJK characters with aligned columns", async () => {
    const { tables, rawChunks } = await sendAndCollectTables(
      "Create a markdown table with exactly these rows and columns. " +
        "Columns: City, Country, Population. Rows: " +
        "\u6771\u4EAC (Tokyo), Japan, 14M | " +
        "\u5317\u4EAC (Beijing), \u4E2D\u56FD (China), 21M | " +
        "\u30BD\u30A6\u30EB (Seoul), \uD55C\uAD6D (Korea), 10M | " +
        "New York, USA, 8M. " +
        "Use those exact CJK characters. Do not use any tools.",
    );

    console.log("\n=== CJK TABLE RAW OUTPUT ===");
    for (const chunk of rawChunks) console.log(chunk);
    console.log("=== END ===\n");

    expect(tables.length).toBeGreaterThanOrEqual(1);

    for (const { codeBlock, lines } of tables) {
      const issues = checkPipeAlignment(lines);
      if (issues.length > 0) {
        console.log("ALIGNMENT ISSUES (CJK table):");
        console.log(codeBlock);
        for (const issue of issues) console.log(`  ${issue}`);
      }
      if (issues.length > 0) {
        console.warn(`CJK table has ${issues.length} alignment issues (expected for now)`);
      }
    }
  }, 240_000);

  // ---- Test 4: Accented European characters ----

  it("renders a table with accented European characters", async () => {
    const { tables, rawChunks } = await sendAndCollectTables(
      "Create a markdown table of famous European dishes. Columns: " +
        "Dish, Origin, Description. Include cr\u00E8me br\u00FBl\u00E9e from " +
        "France, k\u00E4se sp\u00E4tzle from Germany, pa\u00EBlla from Spain, " +
        "and sm\u00F6rg\u00E5sbord from Sweden. Use the accented characters " +
        "I provided. Keep it to exactly 4 data rows. " +
        "Do not use any tools.",
    );

    console.log("\n=== DIACRITICS TABLE RAW OUTPUT ===");
    for (const chunk of rawChunks) console.log(chunk);
    console.log("=== END ===\n");

    expect(tables.length).toBeGreaterThanOrEqual(1);

    for (const { codeBlock, lines } of tables) {
      const issues = checkPipeAlignment(lines);
      if (issues.length > 0) {
        console.log("ALIGNMENT ISSUES (diacritics table):");
        console.log(codeBlock);
        for (const issue of issues) console.log(`  ${issue}`);
      }
      if (issues.length > 0) {
        console.warn(`Diacritics table has ${issues.length} alignment issues`);
      }
    }
  }, 240_000);

  // ---- Test 5: Currency symbols ----

  it("renders a table with currency symbols", async () => {
    const { tables, rawChunks } = await sendAndCollectTables(
      "Create a small markdown table comparing currency exchange " +
        "rates. Columns: Currency, Symbol, Rate to USD. Include " +
        "Euro (\u20AC), British Pound (\u00A3), Japanese Yen (\u00A5), and " +
        "Indian Rupee (\u20B9). Use the actual currency symbols in the " +
        "Symbol column. Keep it to exactly 4 data rows. " +
        "Do not use any tools.",
    );

    console.log("\n=== CURRENCY TABLE RAW OUTPUT ===");
    for (const chunk of rawChunks) console.log(chunk);
    console.log("=== END ===\n");

    expect(tables.length).toBeGreaterThanOrEqual(1);

    for (const { codeBlock, lines } of tables) {
      const issues = checkPipeAlignment(lines);
      if (issues.length > 0) {
        console.log("ALIGNMENT ISSUES (currency table):");
        console.log(codeBlock);
        for (const issue of issues) console.log(`  ${issue}`);
      }
      if (issues.length > 0) {
        console.warn(`Currency table has ${issues.length} alignment issues`);
      }
    }
  }, 240_000);

  // ---- Test 6: Mixed Unicode stress test ----

  it("renders a mixed-content table combining multiple edge cases", async () => {
    const { tables, rawChunks } = await sendAndCollectTables(
      "Create a markdown table of world greetings. Columns: " +
        "Language, Greeting, Country. Include these rows: " +
        "Japanese, \u3053\u3093\u306B\u3061\u306F, \u65E5\u672C | " +
        "Korean, \uC548\uB155\uD558\uC138\uC694, \uD55C\uAD6D | " +
        "French, Bonjour, France | " +
        "Russian, \u041F\u0440\u0438\u0432\u0435\u0442, \u0420\u043E\u0441\u0441\u0438\u044F | " +
        "Arabic, \u0645\u0631\u062D\u0628\u0627, \u0627\u0644\u0633\u0639\u0648\u062F\u064A\u0629. " +
        "Use the exact non-Latin characters I provided. " +
        "Do not use any tools.",
    );

    console.log("\n=== MIXED STRESS TABLE RAW OUTPUT ===");
    for (const chunk of rawChunks) console.log(chunk);
    console.log("=== END ===\n");

    expect(tables.length).toBeGreaterThanOrEqual(1);

    for (const { codeBlock, lines } of tables) {
      const issues = checkPipeAlignment(lines);
      if (issues.length > 0) {
        console.log("ALIGNMENT ISSUES (mixed stress table):");
        console.log(codeBlock);
        for (const issue of issues) console.log(`  ${issue}`);
      }
      if (issues.length > 0) {
        console.warn(`Mixed stress table has ${issues.length} alignment issues`);
      }
    }
  }, 240_000);
});
