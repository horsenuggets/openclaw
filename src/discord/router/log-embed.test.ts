import { describe, expect, it } from "vitest";
import { autoLinkUrls, buildLogEmbed } from "./log-embed.js";

describe("autoLinkUrls", () => {
  it("wraps a bare https URL using the scheme-less label", () => {
    expect(autoLinkUrls("Add more at https://claude.ai/settings/usage and keep going.")).toBe(
      "Add more at [claude.ai/settings/usage](https://claude.ai/settings/usage) and keep going.",
    );
  });

  it("wraps http URLs too", () => {
    expect(autoLinkUrls("see http://example.com/x")).toBe(
      "see [example.com/x](http://example.com/x)",
    );
  });

  it("keeps trailing sentence punctuation outside the link", () => {
    expect(autoLinkUrls("go to https://example.com.")).toBe(
      "go to [example.com](https://example.com).",
    );
  });

  it("leaves URLs that are already markdown link targets alone", () => {
    const already = "see [the docs](https://example.com/docs)";
    expect(autoLinkUrls(already)).toBe(already);
  });

  it("links multiple URLs in one string", () => {
    expect(autoLinkUrls("https://a.com and https://b.com")).toBe(
      "[a.com](https://a.com) and [b.com](https://b.com)",
    );
  });

  it("returns text without URLs unchanged", () => {
    expect(autoLinkUrls("just a plain log line")).toBe("just a plain log line");
  });
});

describe("buildLogEmbed", () => {
  it("builds a Log-category embed with no title", () => {
    const { embed, attachments } = buildLogEmbed("Back online.");
    expect(embed.title).toBeUndefined();
    expect(embed.color).toBe(0xa0a0a0);
    expect(embed.footer).toEqual({ text: "Log Message", icon_url: "attachment://log-message.png" });
    expect(attachments).toEqual(["log-message.png"]);
    expect(embed.timestamp).toBeDefined();
  });

  it("italicizes the whole description and auto-links URLs", () => {
    const { embed } = buildLogEmbed(
      "You're out of extra usage. Add more at https://claude.ai/settings/usage and keep going.",
    );
    expect(embed.description).toBe(
      "*You're out of extra usage. Add more at [claude.ai/settings/usage](https://claude.ai/settings/usage) and keep going.*",
    );
  });

  it("trims surrounding whitespace before formatting", () => {
    expect(buildLogEmbed("  hi  ").embed.description).toBe("*hi*");
  });
});
