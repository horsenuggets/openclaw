import { describe, expect, it } from "vitest";
import {
  type ArchiveClient,
  collectArchiveChannelIds,
  deleteChannels,
  tidyArchives,
} from "./archives.js";
import { ChannelType, type DiscordChannel } from "./discord.js";

/**
 * An in-memory Discord guild implementing the ArchiveClient surface, so the
 * archive repacking logic can be exercised without the network. When
 * `enforceCap` is set it mimics Discord's 50-channel-per-category ceiling,
 * rejecting a move into a full category (error code 30035).
 */
class FakeGuild implements ArchiveClient {
  channels: DiscordChannel[];
  private nextId = 9000;
  constructor(
    channels: DiscordChannel[],
    private readonly enforceCap = false,
  ) {
    this.channels = channels;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listGuildChannels(): Promise<DiscordChannel[]> {
    return this.channels.map((c) => ({ ...c }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createChannel(body: {
    name: string;
    type: number;
    parent_id?: string | null;
  }): Promise<DiscordChannel> {
    const channel: DiscordChannel = {
      id: String(this.nextId++),
      name: body.name,
      type: body.type,
      parent_id: body.parent_id ?? null,
    };
    this.channels.push(channel);
    return { ...channel };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async modifyChannel(channelId: string, body: Record<string, unknown>): Promise<DiscordChannel> {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) {
      throw new Error(`no channel ${channelId}`);
    }
    if ("parent_id" in body) {
      const target = (body.parent_id ?? null) as string | null;
      if (this.enforceCap && target !== null) {
        const occupancy = this.channels.filter(
          (c) => c.parent_id === target && c.type !== ChannelType.GuildCategory,
        ).length;
        if (occupancy >= 50) {
          throw new Error(
            '400 {"code": 30035, "message": "Maximum number of channels in category reached"}',
          );
        }
      }
      channel.parent_id = target;
    }
    if (typeof body.name === "string") {
      channel.name = body.name;
    }
    return { ...channel };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteChannel(channelId: string): Promise<void> {
    this.channels = this.channels.filter((c) => c.id !== channelId);
  }

  /** The current categories in id order, each with its ordered child ids. */
  layout(): Array<{ name: string; children: string[] }> {
    return this.channels
      .filter((c) => c.type === ChannelType.GuildCategory)
      .map((cat) => ({
        name: cat.name,
        children: this.channels
          .filter((c) => c.parent_id === cat.id && c.type !== ChannelType.GuildCategory)
          .map((c) => c.id),
      }));
  }
}

/** Build `count` text channels parented to `parentId`, ids prefixed with `prefix`. */
function texts(prefix: string, count: number, parentId: string): DiscordChannel[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    name: `${prefix}${i}`,
    type: ChannelType.GuildText,
    parent_id: parentId,
    position: i,
  }));
}

function category(id: string, name: string, position = 0): DiscordChannel {
  return { id, name, type: ChannelType.GuildCategory, parent_id: null, position };
}

describe("tidyArchives", () => {
  it("leaves an already-tidy archive untouched", async () => {
    const guild = new FakeGuild([
      category("c1", "Archive 0001"),
      ...texts("a", 50, "c1"),
      category("c2", "Archive 0002"),
      ...texts("b", 10, "c2"),
    ]);
    await tidyArchives(guild, { paceMs: 0 });
    const layout = guild.layout();
    expect(layout.map((l) => l.name)).toEqual(["Archive 0001", "Archive 0002"]);
    expect(layout[0].children).toHaveLength(50);
    expect(layout[1].children).toHaveLength(10);
  });

  it("appends included channels and creates categories as needed", async () => {
    const guild = new FakeGuild([
      category("c1", "Archive 0001"),
      ...texts("a", 48, "c1"),
      // Five loose channels (e.g. freshly expired Testing days) to be archived.
      ...texts("x", 5, "loose"),
    ]);
    await tidyArchives(guild, { include: ["x0", "x1", "x2", "x3", "x4"], paceMs: 0 });
    const layout = guild.layout();
    expect(layout.map((l) => l.name)).toEqual(["Archive 0001", "Archive 0002"]);
    expect(layout[0].children).toHaveLength(50);
    expect(layout[1].children).toHaveLength(3);
    // Every originally archived channel plus the five included are present.
    const all = layout.flatMap((l) => l.children);
    expect(all).toHaveLength(53);
    for (const id of ["x0", "x1", "x2", "x3", "x4"]) {
      expect(all).toContain(id);
    }
  });

  it("renames non-contiguous categories to a contiguous sequence", async () => {
    const guild = new FakeGuild([category("c9", "Archive 0009"), ...texts("a", 10, "c9")]);
    await tidyArchives(guild, { paceMs: 0 });
    expect(guild.layout().map((l) => l.name)).toEqual(["Archive 0001"]);
  });

  it("deletes categories left empty after repacking", async () => {
    const guild = new FakeGuild([
      category("c1", "Archive 0001"),
      ...texts("a", 10, "c1"),
      category("c2", "Archive 0002"),
    ]);
    await tidyArchives(guild, { paceMs: 0 });
    expect(guild.layout().map((l) => l.name)).toEqual(["Archive 0001"]);
  });

  it("removes every category when there is nothing to archive", async () => {
    const guild = new FakeGuild([category("c1", "Archive 0001"), category("c2", "Archive 0002")]);
    await tidyArchives(guild, { paceMs: 0 });
    expect(guild.layout()).toEqual([]);
  });

  it("ignores included ids that are not in the guild", async () => {
    const guild = new FakeGuild([category("c1", "Archive 0001"), ...texts("a", 3, "c1")]);
    await tidyArchives(guild, { include: ["does-not-exist"], paceMs: 0 });
    const layout = guild.layout();
    expect(layout).toHaveLength(1);
    expect(layout[0].children).toHaveLength(3);
  });

  it("respects the 50-channel ceiling while moving channels across categories", async () => {
    // cat0 under-filled, cat1 full: repacking pulls 20 channels from cat1 into
    // cat0 (ending at exactly 50) and must never trip the cap mid-move.
    const guild = new FakeGuild(
      [
        category("c1", "Archive 0001"),
        ...texts("a", 30, "c1"),
        category("c2", "Archive 0002"),
        ...texts("b", 50, "c2"),
      ],
      true,
    );
    await tidyArchives(guild, { paceMs: 0 });
    const layout = guild.layout();
    expect(layout.map((l) => l.name)).toEqual(["Archive 0001", "Archive 0002"]);
    expect(layout[0].children).toHaveLength(50);
    expect(layout[1].children).toHaveLength(30);
    // Order is preserved: cat0 holds the 30 a-channels then the first 20 b-channels.
    expect(layout[0].children.slice(0, 30)).toEqual(texts("a", 30, "c1").map((c) => c.id));
  });
});

describe("collectArchiveChannelIds", () => {
  it("gathers children across archive categories in order, skipping non-archive ones", async () => {
    const guild = new FakeGuild([
      category("c1", "Archive 0001"),
      ...texts("a", 2, "c1"),
      category("t", "Testing"),
      ...texts("day", 1, "t"),
      category("c2", "Archive 0002"),
      ...texts("b", 2, "c2"),
    ]);
    expect(await collectArchiveChannelIds(guild)).toEqual(["a0", "a1", "b0", "b1"]);
  });
});

describe("deleteChannels", () => {
  it("deletes each id and leaves the rest", async () => {
    const guild = new FakeGuild([category("c1", "Archive 0001"), ...texts("a", 3, "c1")]);
    await deleteChannels(guild, ["a0", "a2"], 0);
    expect(guild.channels.filter((c) => c.type === ChannelType.GuildText).map((c) => c.id)).toEqual(
      ["a1"],
    );
  });
});
