import type { DiscordEmbed, DiscordEmbedField } from "./channel-commands.js";

/**
 * Embed category system. Every router embed belongs to a category that fixes
 * its accent color plus a footer label and icon, so the bot's messages stay
 * visually consistent. Categories are the single source of truth for that
 * styling; call sites only supply the title/description (and an optional
 * thumbnail). Icons are referenced via `attachment://<file>` and uploaded from
 * `assets/embeds` by the sender (see embed-send.ts).
 */

export type EmbedCategoryKey = "general" | "log" | "registration" | "system";

export type EmbedCategory = {
  /** Footer label shown on every embed in this category. */
  footerText: string;
  /** Icon filename in assets/embeds, shown as the footer icon. */
  icon: string;
  /** Embed accent color (left bar). */
  color: number;
};

export const EMBED_CATEGORIES: Record<EmbedCategoryKey, EmbedCategory> = {
  general: { footerText: "General", icon: "general.png", color: 0xf26363 },
  log: { footerText: "Log Message", icon: "log-message.png", color: 0xa0a0a0 },
  registration: {
    footerText: "Channel Registration",
    icon: "channel-registration.png",
    color: 0xffff80,
  },
  system: { footerText: "System", icon: "injected-system-prompt.png", color: 0x80ff80 },
};

/** Build the `attachment://` reference used to point an embed at an uploaded icon. */
export function attachmentRef(filename: string): string {
  return `attachment://${filename}`;
}

export type BuildEmbedInput = {
  category: EmbedCategoryKey;
  title?: string;
  description: string;
  /** Optional name/value fields (e.g. the status table). */
  fields?: DiscordEmbedField[];
  /** Icon filename in assets/embeds to show as the embed thumbnail. */
  thumbnail?: string;
  /**
   * ISO-8601 timestamp for the embed footer. Defaults to now; pass null to omit
   * the timestamp entirely.
   */
  timestamp?: string | null;
};

export type BuiltEmbed = {
  embed: DiscordEmbed;
  /** Icon filenames this embed references (footer icon plus optional thumbnail). */
  attachments: string[];
};

/**
 * Build a category-styled embed plus the list of icon files it references. The
 * caller passes the returned `embed`/`attachments` to the attachment-aware
 * sender, which uploads the icons (or reuses cached CDN URLs).
 */
export function buildEmbed(input: BuildEmbedInput): BuiltEmbed {
  const category = EMBED_CATEGORIES[input.category];
  const attachments = [category.icon];
  const embed: DiscordEmbed = {
    ...(input.title ? { title: input.title } : {}),
    description: input.description,
    color: category.color,
    ...(input.fields ? { fields: input.fields } : {}),
    footer: { text: category.footerText, icon_url: attachmentRef(category.icon) },
  };
  if (input.thumbnail) {
    embed.thumbnail = { url: attachmentRef(input.thumbnail) };
    if (!attachments.includes(input.thumbnail)) {
      attachments.push(input.thumbnail);
    }
  }
  if (input.timestamp !== null) {
    embed.timestamp = input.timestamp ?? new Date().toISOString();
  }
  return { embed, attachments };
}
