import type { DiscordEmbed, DiscordEmbedField } from "./channel-commands.js";

/**
 * Embed category system. Every router embed belongs to a category that fixes
 * its accent color plus a footer label and icon, so the bot's messages stay
 * visually consistent. Categories are the single source of truth for that
 * styling; call sites only supply the title/description (and an optional
 * thumbnail). Icons are referenced via `attachment://<file>` and uploaded from
 * `assets/embeds` by the sender (see embed-send.ts).
 */

export type EmbedCategoryKey =
  | "commandResult"
  | "connections"
  | "debug"
  | "general"
  | "log"
  | "registration"
  | "secrets"
  | "system";

export type EmbedCategory = {
  /** Footer label shown on every embed in this category. */
  footerText: string;
  /**
   * Default footer icon filename in assets/embeds. Some categories (e.g. command
   * results) pick a state-specific icon per message via BuildEmbedInput.icon.
   */
  icon: string;
  /** Embed accent color (left bar). */
  color: number;
};

export const EMBED_CATEGORIES: Record<EmbedCategoryKey, EmbedCategory> = {
  commandResult: {
    footerText: "Command Result",
    icon: "command-result-default.png",
    color: 0x6c95b8,
  },
  general: { footerText: "General", icon: "general.png", color: 0xf26363 },
  log: { footerText: "Log Message", icon: "log-message.png", color: 0xa0a0a0 },
  registration: {
    footerText: "Channel Registration",
    icon: "channel-registration.png",
    color: 0xffff80,
  },
  system: { footerText: "System", icon: "injected-system-prompt.png", color: 0x80ff80 },
  connections: { footerText: "Connections", icon: "connections.png", color: 0xc080ff },
  secrets: { footerText: "Secrets", icon: "secrets.png", color: 0xa08060 },
  debug: { footerText: "Debug", icon: "debug.png", color: 0xff80e0 },
};

/**
 * Command-result state -> footer icon. `default` is neutral (any outcome);
 * `enabled`/`disabled` indicate a toggle turning on/off.
 */
export type CommandResultState = "default" | "disabled" | "enabled";

const COMMAND_RESULT_ICONS: Record<CommandResultState, string> = {
  default: "command-result-default.png",
  disabled: "command-result-false.png",
  enabled: "command-result-true.png",
};

/** Build a Command Result embed with the state-specific footer icon. */
export function buildCommandResultEmbed(
  description: string,
  state: CommandResultState = "default",
): BuiltEmbed {
  return buildEmbed({ category: "commandResult", description, icon: COMMAND_RESULT_ICONS[state] });
}

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
  /** Override the category's default footer icon (e.g. command-result state icons). */
  icon?: string;
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
  const footerIcon = input.icon ?? category.icon;
  const attachments = [footerIcon];
  const embed: DiscordEmbed = {
    ...(input.title ? { title: input.title } : {}),
    description: input.description,
    color: category.color,
    ...(input.fields ? { fields: input.fields } : {}),
    footer: { text: category.footerText, icon_url: attachmentRef(footerIcon) },
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
