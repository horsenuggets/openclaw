/**
 * A tiny Discord REST client scoped to the OpenClaw Lab server, shared by every
 * scripts/lab entrypoint. It only ever talks to the Lab guild as the OpenClaw
 * Mirror bot: the token and guild id come from the environment and there is no
 * fallback to the production bot token, by design (see .env.template and the
 * repo's "never test with the production bot or server" rule). A missing value
 * is a hard, loud failure rather than a silent prod reach.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LabEmbed } from "./lab-core.js";

const API = "https://discord.com/api/v10";

/** Discord channel types used by the Lab scripts. */
export const ChannelType = {
  GuildText: 0,
  GuildCategory: 4,
  PublicThread: 11,
} as const;

/** The subset of channel/thread fields the Lab scripts read. */
export type DiscordChannel = {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
  position?: number;
};

export type LabConfig = { token: string; guildId: string };

/**
 * Resolve the Lab bot token and guild id from the environment, failing loudly if
 * either is absent. The token is read only from OPENCLAW_MIRROR_DISCORD_TOKEN so
 * the prod DISCORD_BOT_TOKEN can never be used here even when both are loaded.
 */
export function loadLabConfig(env: NodeJS.ProcessEnv = process.env): LabConfig {
  const token = env.OPENCLAW_MIRROR_DISCORD_TOKEN?.trim();
  const guildId = env.OPENCLAW_LAB_GUILD_ID?.trim();
  if (!token) {
    throw new Error(
      "Missing OPENCLAW_MIRROR_DISCORD_TOKEN (the OpenClaw Mirror bot token). " +
        "Set it, or the Mirror bot's DISCORD_BOT_TOKEN in .env.mirror (see " +
        ".env.template); the Lab scripts never use the prod DISCORD_BOT_TOKEN.",
    );
  }
  if (!guildId) {
    throw new Error(
      "Missing OPENCLAW_LAB_GUILD_ID (the OpenClaw Lab server id). " +
        "Set it in .env.mirror (see .env.template).",
    );
  }
  return { token, guildId };
}

/** Absolute path to an embed icon shipped in assets/embeds. */
function embedAssetPath(fileName: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "assets", "embeds", fileName);
}

type RequestOptions = {
  method?: string;
  json?: unknown;
  form?: FormData;
};

export class LabDiscord {
  private readonly token: string;
  readonly guildId: string;

  constructor(config: LabConfig = loadLabConfig()) {
    this.token = config.token;
    this.guildId = config.guildId;
  }

  /** Issue a request, retrying once on a 429 using Discord's retry_after. */
  private async request(url: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bot ${this.token}` };
    let body: BodyInit | undefined;
    if (options.form) {
      body = options.form;
    } else if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await fetch(url, { method: options.method ?? "GET", headers, body });
      if (resp.status !== 429) {
        return resp;
      }
      const info = (await resp.json().catch(() => ({}))) as { retry_after?: number };
      const waitMs = Math.ceil((info.retry_after ?? 1) * 1000) + 250;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    return fetch(url, { method: options.method ?? "GET", headers, body });
  }

  private async json<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const resp = await this.request(url, options);
    if (!resp.ok) {
      throw new Error(
        `${options.method ?? "GET"} ${url} failed: ${resp.status} ${await resp.text()}`,
      );
    }
    return (await resp.json()) as T;
  }

  /** Every channel in the Lab guild (text, category, voice, ...). */
  listGuildChannels(): Promise<DiscordChannel[]> {
    return this.json<DiscordChannel[]>(`${API}/guilds/${this.guildId}/channels`);
  }

  /** All currently active (non-archived) threads in the guild. */
  async listActiveThreads(): Promise<DiscordChannel[]> {
    const body = await this.json<{ threads: DiscordChannel[] }>(
      `${API}/guilds/${this.guildId}/threads/active`,
    );
    return body.threads;
  }

  /** All archived public threads under a parent text channel (paginated). */
  async listArchivedPublicThreads(channelId: string): Promise<DiscordChannel[]> {
    const out: DiscordChannel[] = [];
    let before: string | undefined;
    for (;;) {
      const qs = before ? `?before=${encodeURIComponent(before)}&limit=100` : "?limit=100";
      const body = await this.json<{
        threads: DiscordChannel[];
        has_more: boolean;
        // Discord sorts archived public threads by archive_timestamp, used as the
        // `before` cursor for the next page.
      }>(`${API}/channels/${channelId}/threads/archived/public${qs}`);
      out.push(...body.threads);
      if (!body.has_more || body.threads.length === 0) {
        return out;
      }
      before = body.threads[body.threads.length - 1]?.id;
    }
  }

  createChannel(body: {
    name: string;
    type: number;
    parent_id?: string | null;
  }): Promise<DiscordChannel> {
    return this.json<DiscordChannel>(`${API}/guilds/${this.guildId}/channels`, {
      method: "POST",
      json: body,
    });
  }

  createThread(
    channelId: string,
    body: { name: string; type: number; auto_archive_duration?: number },
  ): Promise<DiscordChannel> {
    return this.json<DiscordChannel>(`${API}/channels/${channelId}/threads`, {
      method: "POST",
      json: body,
    });
  }

  modifyChannel(channelId: string, body: Record<string, unknown>): Promise<DiscordChannel> {
    return this.json<DiscordChannel>(`${API}/channels/${channelId}`, {
      method: "PATCH",
      json: body,
    });
  }

  async deleteChannel(channelId: string): Promise<void> {
    const resp = await this.request(`${API}/channels/${channelId}`, { method: "DELETE" });
    if (!resp.ok && resp.status !== 404) {
      throw new Error(`DELETE channel ${channelId} failed: ${resp.status} ${await resp.text()}`);
    }
  }

  /**
   * Post an embed to a channel or thread, uploading the referenced icon files so
   * `attachment://<file>` references in the embed resolve. The embed's footer
   * icon is consumed by the embed, so the message shows no visible attachment.
   */
  async sendEmbed(channelId: string, embed: LabEmbed, iconFiles: string[] = []): Promise<void> {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ embeds: [embed] }));
    iconFiles.forEach((fileName, i) => {
      const bytes = fs.readFileSync(embedAssetPath(fileName));
      form.append(`files[${i}]`, new Blob([bytes]), fileName);
    });
    const resp = await this.request(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      form,
    });
    if (!resp.ok) {
      throw new Error(`send embed to ${channelId} failed: ${resp.status} ${await resp.text()}`);
    }
  }
}
