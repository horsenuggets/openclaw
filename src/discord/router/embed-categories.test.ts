import { describe, expect, it } from "vitest";
import {
  EMBED_CATEGORIES,
  attachmentRef,
  buildCommandResultEmbed,
  buildEmbed,
} from "./embed-categories.js";

describe("EMBED_CATEGORIES", () => {
  it("defines each category with distinct colors and icons", () => {
    expect(EMBED_CATEGORIES.commandResult).toEqual({
      footerText: "Command Result",
      icon: "command-result-default.png",
      color: 0x6c95b8,
    });
    expect(EMBED_CATEGORIES.general).toEqual({
      footerText: "General",
      icon: "general.png",
      color: 0xf26363,
    });
    expect(EMBED_CATEGORIES.log).toEqual({
      footerText: "Log Message",
      icon: "log-message.png",
      color: 0xa0a0a0,
    });
    expect(EMBED_CATEGORIES.registration).toEqual({
      footerText: "Channel Registration",
      icon: "channel-registration.png",
      color: 0xffff80,
    });
    expect(EMBED_CATEGORIES.system).toEqual({
      footerText: "System",
      icon: "injected-system-prompt.png",
      color: 0x80ff80,
    });
    expect(EMBED_CATEGORIES.connections).toEqual({
      footerText: "Connections",
      icon: "connections.png",
      color: 0xa080ff,
    });
  });
});

describe("attachmentRef", () => {
  it("builds the attachment:// reference", () => {
    expect(attachmentRef("general.png")).toBe("attachment://general.png");
  });
});

describe("buildEmbed", () => {
  it("applies category color and footer, and references the footer icon", () => {
    const { embed, attachments } = buildEmbed({
      category: "general",
      title: "Welcome to OpenClaw!",
      description: "Hello",
    });
    expect(embed.title).toBe("Welcome to OpenClaw!");
    expect(embed.description).toBe("Hello");
    expect(embed.color).toBe(0xf26363);
    expect(embed.footer).toEqual({
      text: "General",
      icon_url: "attachment://general.png",
    });
    expect(attachments).toEqual(["general.png"]);
  });

  it("adds a thumbnail and includes it in the attachment list", () => {
    const { embed, attachments } = buildEmbed({
      category: "general",
      description: "Hi",
      thumbnail: "openclaw.png",
    });
    expect(embed.thumbnail).toEqual({ url: "attachment://openclaw.png" });
    expect(attachments).toEqual(["general.png", "openclaw.png"]);
  });

  it("defaults the timestamp to an ISO-8601 string", () => {
    const { embed } = buildEmbed({ category: "log", description: "x" });
    expect(embed.timestamp).toBeDefined();
    expect(() => new Date(embed.timestamp!).toISOString()).not.toThrow();
    expect(new Date(embed.timestamp!).toISOString()).toBe(embed.timestamp);
  });

  it("uses an explicit timestamp when provided", () => {
    const ts = "2026-01-02T03:04:05.000Z";
    const { embed } = buildEmbed({ category: "log", description: "x", timestamp: ts });
    expect(embed.timestamp).toBe(ts);
  });

  it("omits the timestamp when passed null", () => {
    const { embed } = buildEmbed({ category: "log", description: "x", timestamp: null });
    expect(embed.timestamp).toBeUndefined();
  });

  it("omits the title when not provided", () => {
    const { embed } = buildEmbed({ category: "log", description: "a log line" });
    expect(embed.title).toBeUndefined();
  });

  it("passes through fields (e.g. the status table)", () => {
    const { embed } = buildEmbed({
      category: "registration",
      title: "Status",
      description: "d",
      fields: [{ name: "Property", value: "Port", inline: true }],
    });
    expect(embed.fields).toEqual([{ name: "Property", value: "Port", inline: true }]);
  });

  it("overrides the footer icon when an icon is given", () => {
    const { embed, attachments } = buildEmbed({
      category: "commandResult",
      description: "d",
      icon: "command-result-true.png",
    });
    expect(embed.footer).toEqual({
      text: "Command Result",
      icon_url: "attachment://command-result-true.png",
    });
    expect(attachments).toEqual(["command-result-true.png"]);
  });
});

describe("buildCommandResultEmbed", () => {
  it("uses the Command Result category color and footer", () => {
    const { embed } = buildCommandResultEmbed("done");
    expect(embed.title).toBeUndefined();
    expect(embed.color).toBe(0x6c95b8);
    expect(embed.footer?.text).toBe("Command Result");
    expect(embed.timestamp).toBeDefined();
  });

  it("selects the state icon (default / enabled / disabled)", () => {
    expect(buildCommandResultEmbed("d").embed.footer?.icon_url).toBe(
      "attachment://command-result-default.png",
    );
    expect(buildCommandResultEmbed("d", "enabled").embed.footer?.icon_url).toBe(
      "attachment://command-result-true.png",
    );
    expect(buildCommandResultEmbed("d", "disabled").embed.footer?.icon_url).toBe(
      "attachment://command-result-false.png",
    );
  });
});
