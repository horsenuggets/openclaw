import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionStore, saveSessionStore } from "../../config/sessions.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

describe("persistSessionUsageUpdate", () => {
  it("sets lastAgentResponseAt when usage is present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-"));
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:telegram:dm:u1";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "s1",
        updatedAt: Date.now() - 5000,
      },
    });

    const before = Date.now();
    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      usage: { input: 100, output: 50, total: 150 },
      modelUsed: "claude-sonnet-4-5-20250929",
      providerUsed: "claude",
      contextTokensUsed: 200000,
    });
    const after = Date.now();

    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[sessionKey];
    expect(entry).toBeDefined();
    expect(entry?.lastAgentResponseAt).toBeGreaterThanOrEqual(before);
    expect(entry?.lastAgentResponseAt).toBeLessThanOrEqual(after);
    expect(entry?.inputTokens).toBe(100);
    expect(entry?.outputTokens).toBe(50);
  });

  it("sets lastAgentResponseAt on model-only updates (no usage)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-model-"));
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:telegram:dm:u2";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "s2",
        updatedAt: Date.now() - 5000,
      },
    });

    const before = Date.now();
    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
      modelUsed: "claude-sonnet-4-5-20250929",
      contextTokensUsed: 200000,
    });
    const after = Date.now();

    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[sessionKey];
    expect(entry).toBeDefined();
    expect(entry?.lastAgentResponseAt).toBeGreaterThanOrEqual(before);
    expect(entry?.lastAgentResponseAt).toBeLessThanOrEqual(after);
  });

  it("does not set lastAgentResponseAt when there is no update to persist", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-noop-"));
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:telegram:dm:u3";

    await saveSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "s3",
        updatedAt: Date.now() - 5000,
      },
    });

    // No usage, no model, no context tokens — nothing to persist.
    await persistSessionUsageUpdate({
      storePath,
      sessionKey,
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[sessionKey];
    expect(entry).toBeDefined();
    expect(entry?.lastAgentResponseAt).toBeUndefined();
  });
});
