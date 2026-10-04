import { describe, expect, it } from "vitest";
import { buildWelcomeEmbed } from "./onboarding.js";

describe("buildWelcomeEmbed", () => {
  it("builds a General-category welcome card with the OpenClaw thumbnail", () => {
    const { embed, attachments } = buildWelcomeEmbed();
    expect(embed.title).toBe("Welcome to OpenClaw!");
    expect(embed.description).toContain("personal everything-assistant");
    expect(embed.color).toBe(0xf26363);
    expect(embed.footer).toEqual({ text: "General", icon_url: "attachment://general.png" });
    expect(embed.thumbnail).toEqual({ url: "attachment://openclaw.png" });
    expect(attachments).toEqual(["general.png", "openclaw.png"]);
    expect(embed.timestamp).toBeDefined();
  });
});
