import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMBED_CATEGORIES } from "./embed-categories.js";
import {
  MAX_SECRET_NAME_LENGTH,
  SECRET_COMMAND_SPEC,
  SECRET_MODAL_CUSTOM_ID,
  SECRET_NAME_INPUT_ID,
  SECRET_VALUE_INPUT_ID,
  buildSecretModal,
  buildSecretNoticeEmbed,
  buildSecretReceivedEmbed,
  parseSecretModalSubmit,
  sanitizeSecretName,
  secretPath,
  secretReminderMessage,
} from "./secret-command.js";

describe("SECRET_COMMAND_SPEC", () => {
  it("is a CHAT_INPUT command usable in guilds and 1:1 DMs but not group DMs", () => {
    expect(SECRET_COMMAND_SPEC.name).toBe("secret");
    expect(SECRET_COMMAND_SPEC.type).toBe(1);
    // Group DMs (context 2) are excluded: no guild_id to owner-gate on, multiple
    // participants, so any member could otherwise hand the agent a secret.
    expect(SECRET_COMMAND_SPEC.contexts).toEqual([0, 1]);
  });
});

describe("buildSecretModal", () => {
  it("builds a required short value input and an optional short name input", () => {
    const modal = buildSecretModal();
    expect(modal.custom_id).toBe(SECRET_MODAL_CUSTOM_ID);
    expect(modal.components).toHaveLength(2);
    const inputs = new Map(
      modal.components.map((row) => [row.components[0].custom_id, row.components[0]]),
    );
    const value = inputs.get(SECRET_VALUE_INPUT_ID);
    const name = inputs.get(SECRET_NAME_INPUT_ID);
    expect(value?.style).toBe(1); // short (single line; one-liner secrets)
    expect(value?.required).toBe(true);
    expect(name?.style).toBe(1); // short
    expect(name?.required).toBe(false);
    // Every input lives in its own action row (Discord allows one per row).
    for (const row of modal.components) {
      expect(row.type).toBe(1);
      expect(row.components).toHaveLength(1);
      expect(row.components[0].type).toBe(4);
    }
  });
});

describe("parseSecretModalSubmit", () => {
  const components = [
    { components: [{ custom_id: SECRET_VALUE_INPUT_ID, value: "https://cb?code=abc" }] },
    { components: [{ custom_id: SECRET_NAME_INPUT_ID, value: "Google OAuth" }] },
  ];

  it("extracts the value and name by custom_id across action rows", () => {
    expect(parseSecretModalSubmit(components)).toEqual({
      value: "https://cb?code=abc",
      name: "Google OAuth",
    });
  });

  it("defaults the name to empty when the optional input is blank or absent", () => {
    const onlyValue = [{ components: [{ custom_id: SECRET_VALUE_INPUT_ID, value: "tok" }] }];
    expect(parseSecretModalSubmit(onlyValue)).toEqual({ value: "tok", name: "" });
    expect(parseSecretModalSubmit(undefined)).toEqual({ value: "", name: "" });
  });
});

describe("sanitizeSecretName", () => {
  it("preserves case and keeps [A-Za-z0-9] + hyphen + underscore, stripping the rest", () => {
    expect(sanitizeSecretName("Google OAuth!", "v")).toBe("GoogleOAuth");
    // Hyphens and underscores are preserved; path/shell-unsafe chars are dropped.
    expect(sanitizeSecretName("MY-Token_42", "v")).toBe("MY-Token_42");
    expect(sanitizeSecretName("a/b c;d.e", "v")).toBe("abcde");
  });

  it("caps the length", () => {
    const long = "a".repeat(100);
    expect(sanitizeSecretName(long, "v")).toHaveLength(MAX_SECRET_NAME_LENGTH);
  });

  it("falls back to a deterministic uppercase hash of the value when the name is empty", () => {
    const value = "the-secret-value";
    const hash = createHash("sha256").update(value).digest("hex").slice(0, 8).toUpperCase();
    expect(sanitizeSecretName("", value)).toBe(`SECRET_${hash}`);
    expect(sanitizeSecretName("!!!", value)).toBe(`SECRET_${hash}`);
    // Deterministic: same value => same fallback name (so a re-submit overwrites).
    expect(sanitizeSecretName("", value)).toBe(sanitizeSecretName("", value));
  });

  it("resolves the same name for the same input (overwrite semantics)", () => {
    expect(sanitizeSecretName("redirect", "a")).toBe(sanitizeSecretName("redirect", "b"));
  });
});

describe("secretPath / secretReminderMessage", () => {
  it("writes the secret flat under /tmp/secrets (no per-channel nesting)", () => {
    expect(secretPath("foo")).toBe("/tmp/secrets/foo");
  });

  it("names the file, flags it temporary, and never includes the value", () => {
    const msg = secretReminderMessage("redirect");
    expect(msg).toContain("/tmp/secrets/redirect");
    expect(msg).toContain('"redirect"');
    expect(msg.toLowerCase()).toContain("temporary");
    // The reminder is value-free by construction (it takes only the name).
    expect(secretReminderMessage("redirect")).not.toContain("code=");
  });

  it("warns that tool output is persisted and steers the agent to use the path, not cat it", () => {
    const msg = secretReminderMessage("redirect").toLowerCase();
    // Must not over-claim that the value never persists; instead it warns the
    // agent that printing it would land in the transcript and to use it by path.
    expect(msg).toContain("transcript");
    expect(msg).toContain("path");
  });
});

describe("buildSecretReceivedEmbed / buildSecretNoticeEmbed", () => {
  it("styles both as Secrets-category embeds (color, footer, timestamp)", () => {
    const category = EMBED_CATEGORIES.secrets;
    for (const { embed } of [
      buildSecretReceivedEmbed("redirect"),
      buildSecretNoticeEmbed("T", "D"),
    ]) {
      expect(embed.color).toBe(category.color);
      expect(embed.footer?.text).toBe(category.footerText);
      expect(embed.footer?.icon_url).toBe(`attachment://${category.icon}`);
      expect(typeof embed.timestamp).toBe("string");
    }
  });

  it("names the secret in the received embed without leaking the value", () => {
    const { embed, attachments } = buildSecretReceivedEmbed("redirect");
    expect(embed.title).toBe("Secret Received!");
    expect(embed.description).toContain("`redirect`");
    // The builder takes only the name, so the value cannot appear by construction.
    expect(embed.description.toLowerCase()).toContain("temporary");
    expect(attachments).toContain(EMBED_CATEGORIES.secrets.icon);
  });

  it("passes the notice title and description straight through", () => {
    const { embed } = buildSecretNoticeEmbed(
      "Secret Not Provided.",
      "No secret value was provided.",
    );
    expect(embed.title).toBe("Secret Not Provided.");
    expect(embed.description).toBe("No secret value was provided.");
  });
});
