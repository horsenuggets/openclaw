import type { Guild } from "discord.js";
import { Events } from "discord.js";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_READY_TIMEOUT_MS,
  buildRegisterCommand,
  createE2eChannel,
  e2eSetupTimeout,
  waitForAgentReady,
} from "./helpers.js";

const SHARED_NAMES_FILE = path.join(os.tmpdir(), "openclaw-e2e-channel-names.txt");
const SHARED_NAMES_LOCK = SHARED_NAMES_FILE + ".lock";

// Each test needs a fresh module to reset the generatedNames Set.
async function freshImport() {
  const mod = await import("./helpers.js");
  return mod.e2eChannelName;
}

function cleanSharedState() {
  try {
    fs.unlinkSync(SHARED_NAMES_FILE);
  } catch {
    // File doesn't exist, that's fine.
  }
  try {
    fs.rmdirSync(SHARED_NAMES_LOCK);
  } catch {
    // Lock doesn't exist, that's fine.
  }
}

describe("e2eChannelName", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    cleanSharedState();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanSharedState();
  });

  it("returns the expected timestamp format", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 14, 5, 9));
    const e2eChannelName = await freshImport();

    expect(e2eChannelName()).toBe("e2e-2026-02-22-t-14-05-09");
  });

  it("returns unchanged name when no clash exists", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-22-t-09-00-00"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-22-t-10-30-00");
  });

  it("increments seconds on a single clash", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-22-t-10-30-00"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-22-t-10-30-01");
  });

  it("skips through multiple consecutive clashes", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();
    const existing = new Set([
      "e2e-2026-02-22-t-10-30-00",
      "e2e-2026-02-22-t-10-30-01",
      "e2e-2026-02-22-t-10-30-02",
    ]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-22-t-10-30-03");
  });

  it("rolls seconds into next minute", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-22-t-10-30-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-22-t-10-31-00");
  });

  it("rolls minutes into next hour", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-22-t-10-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-22-t-11-00-00");
  });

  it("rolls hours into next day", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 23, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-22-t-23-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-23-t-00-00-00");
  });

  it("rolls day across month boundary", async () => {
    // Jan 31 at 23:59:59 → Feb 1
    vi.setSystemTime(new Date(2026, 0, 31, 23, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-01-31-t-23-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-02-01-t-00-00-00");
  });

  it("rolls day across year boundary", async () => {
    // Dec 31 at 23:59:59 → Jan 1 of next year
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-12-31-t-23-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2027-01-01-t-00-00-00");
  });

  it("handles leap day rollover", async () => {
    // Feb 28 2028 (leap year) at 23:59:59 → Feb 29
    vi.setSystemTime(new Date(2028, 1, 28, 23, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2028-02-28-t-23-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2028-02-29-t-00-00-00");
  });

  it("handles non-leap year Feb 28 rollover", async () => {
    // Feb 28 2026 (not a leap year) at 23:59:59 → Mar 1
    vi.setSystemTime(new Date(2026, 1, 28, 23, 59, 59));
    const e2eChannelName = await freshImport();
    const existing = new Set(["e2e-2026-02-28-t-23-59-59"]);

    expect(e2eChannelName(existing)).toBe("e2e-2026-03-01-t-00-00-00");
  });

  it("tracks generated names across consecutive calls", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();

    const first = e2eChannelName();
    const second = e2eChannelName();
    const third = e2eChannelName();

    expect(first).toBe("e2e-2026-02-22-t-10-30-00");
    expect(second).toBe("e2e-2026-02-22-t-10-30-01");
    expect(third).toBe("e2e-2026-02-22-t-10-30-02");
  });

  it("merges existing names with previously generated names", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();

    // First call takes 10:30:00.
    const first = e2eChannelName();
    expect(first).toBe("e2e-2026-02-22-t-10-30-00");

    // Second call with an existing name at 10:30:01 must skip past
    // both the generated 10:30:00 and the existing 10:30:01.
    const second = e2eChannelName(new Set(["e2e-2026-02-22-t-10-30-01"]));
    expect(second).toBe("e2e-2026-02-22-t-10-30-02");
  });

  it("simulates rapid 10-channel creation like multi-tool-feedback", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();
    const names: string[] = [];

    for (let i = 0; i < 10; i++) {
      names.push(e2eChannelName());
    }

    // All names are unique.
    expect(new Set(names).size).toBe(10);

    // They are sequential seconds starting from 10:30:00.
    for (let i = 0; i < 10; i++) {
      const ss = String(i).padStart(2, "0");
      expect(names[i]).toBe(`e2e-2026-02-22-t-10-30-${ss}`);
    }
  });

  it("persists names to shared file for cross-worker visibility", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));
    const e2eChannelName = await freshImport();

    e2eChannelName();
    e2eChannelName();

    const content = fs.readFileSync(SHARED_NAMES_FILE, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toEqual(["e2e-2026-02-22-t-10-30-00", "e2e-2026-02-22-t-10-30-01"]);
  });

  it("reads shared file to avoid names claimed by other workers", async () => {
    vi.setSystemTime(new Date(2026, 1, 22, 10, 30, 0));

    // Simulate another worker having already claimed 10:30:00.
    fs.writeFileSync(SHARED_NAMES_FILE, "e2e-2026-02-22-t-10-30-00\n");

    const e2eChannelName = await freshImport();

    expect(e2eChannelName()).toBe("e2e-2026-02-22-t-10-30-01");
  });
});

type FakeMessage = { channelId: string; author?: { id: string }; content?: string };

/**
 * Minimal `Guild` stand-in: an `EventEmitter` client (which is all
 * `waitForAgentReady` touches) plus a `channels` facade whose `create` returns
 * a channel that records what was sent and can run an `onSend` hook (used to
 * emit the onboarding message as if it raced in right after `send`).
 */
function makeFakeGuild(opts?: {
  onSend?: (ctx: { client: EventEmitter; channelId: string }) => void;
}) {
  const client = new EventEmitter();
  const sent: string[] = [];
  const channel = {
    id: "chan-1",
    name: "e2e-chan",
    send: async (content: string) => {
      sent.push(content);
      opts?.onSend?.({ client, channelId: "chan-1" });
    },
  };
  const guild = {
    client,
    channels: {
      fetch: async () => new Map(),
      create: async () => channel,
    },
  } as unknown as Guild;
  return { guild, client, sent, channel };
}

function emitMsg(client: EventEmitter, msg: FakeMessage) {
  client.emit(Events.MessageCreate, msg);
}

describe("buildRegisterCommand", () => {
  it("registers as the sender when no owner is given", () => {
    expect(buildRegisterCommand()).toBe("/channel register");
  });

  it("registers on behalf of an owner via a user mention", () => {
    expect(buildRegisterCommand("123456789012345678")).toBe(
      "/channel register <@123456789012345678>",
    );
  });
});

describe("e2eSetupTimeout", () => {
  it("budgets one channel plus overhead by default", () => {
    expect(e2eSetupTimeout()).toBe(AGENT_READY_TIMEOUT_MS + 60_000);
  });

  it("scales with the channel count", () => {
    expect(e2eSetupTimeout(10)).toBe(10 * AGENT_READY_TIMEOUT_MS + 60_000);
  });
});

describe("waitForAgentReady", () => {
  it("resolves true on the first non-empty bot message and detaches", async () => {
    const { guild, client } = makeFakeGuild();
    const ready = waitForAgentReady(guild, "chan-1", "bot-1", 1000);
    emitMsg(client, { channelId: "chan-1", author: { id: "bot-1" }, content: "hi" });
    expect(await ready).toBe(true);
    expect(client.listenerCount(Events.MessageCreate)).toBe(0);
  });

  it("ignores wrong channel, wrong author, and empty content", async () => {
    const { guild, client } = makeFakeGuild();
    const ready = waitForAgentReady(guild, "chan-1", "bot-1", 1000);
    emitMsg(client, { channelId: "other", author: { id: "bot-1" }, content: "hi" });
    emitMsg(client, { channelId: "chan-1", author: { id: "someone-else" }, content: "hi" });
    emitMsg(client, { channelId: "chan-1", author: { id: "bot-1" }, content: "   " });
    emitMsg(client, { channelId: "chan-1", author: { id: "bot-1" }, content: "ready" });
    expect(await ready).toBe(true);
  });

  it("attaches its listener synchronously and detaches on timeout", async () => {
    const { guild, client } = makeFakeGuild();
    const ready = waitForAgentReady(guild, "chan-1", "bot-1", 20);
    expect(client.listenerCount(Events.MessageCreate)).toBe(1);
    expect(await ready).toBe(false);
    expect(client.listenerCount(Events.MessageCreate)).toBe(0);
  });
});

describe("createE2eChannel", () => {
  beforeEach(cleanSharedState);
  afterEach(cleanSharedState);

  it("attaches the readiness listener before posting the register command", async () => {
    let listenersAtSend = -1;
    const { guild, sent } = makeFakeGuild({
      onSend: ({ client }) => {
        listenersAtSend = client.listenerCount(Events.MessageCreate);
        // Onboarding turn racing in right after send must still be caught.
        emitMsg(client, { channelId: "chan-1", author: { id: "bot-1" }, content: "welcome" });
      },
    });
    const channel = await createE2eChannel(guild, "topic", undefined, "bot-1");
    expect(listenersAtSend).toBe(1);
    expect(sent).toEqual(["/channel register"]);
    expect(channel.id).toBe("chan-1");
  });

  it("registers on behalf of an owner when ownerId is given", async () => {
    const { guild, sent } = makeFakeGuild({
      onSend: ({ client }) =>
        emitMsg(client, { channelId: "chan-1", author: { id: "bot-1" }, content: "hi" }),
    });
    await createE2eChannel(guild, "topic", "999", "bot-1");
    expect(sent).toEqual(["/channel register <@999>"]);
  });

  it("throws when the agent never posts a ready message", async () => {
    vi.useFakeTimers();
    try {
      const { guild } = makeFakeGuild(); // no onboarding message is emitted
      const p = createE2eChannel(guild, "topic", undefined, "bot-1");
      const assertion = expect(p).rejects.toThrow(/did not post a ready message/);
      await vi.advanceTimersByTimeAsync(AGENT_READY_TIMEOUT_MS + 100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a registration-send failure", async () => {
    vi.useFakeTimers();
    try {
      const client = new EventEmitter();
      const channel = {
        id: "chan-1",
        name: "e2e-chan",
        send: async () => {
          throw new Error("send failed");
        },
      };
      const guild = {
        client,
        channels: { fetch: async () => new Map(), create: async () => channel },
      } as unknown as Guild;
      await expect(createE2eChannel(guild, "topic", undefined, "bot-1")).rejects.toThrow(
        "send failed",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
