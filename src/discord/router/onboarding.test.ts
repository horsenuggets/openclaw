import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InstanceConfig } from "./config.js";
import { buildWelcomeEmbed, readBootstrapDirective } from "./onboarding.js";

function makeInstance(bootstrap?: string): InstanceConfig {
  const instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboarding-"));
  if (bootstrap !== undefined) {
    const workspace = path.join(instanceDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "BOOTSTRAP.md"), bootstrap, "utf-8");
  }
  return { instanceDir } as InstanceConfig;
}

describe("readBootstrapDirective", () => {
  it("passes the BOOTSTRAP.md content through verbatim (no injected instructions)", () => {
    const content = "# BOOTSTRAP.md\n\nwork through this checklist";
    const instance = makeInstance(content);
    expect(readBootstrapDirective(instance)).toBe(content);
  });

  it("preserves surrounding whitespace (trims only for the emptiness check)", () => {
    const content = "  \n# BOOTSTRAP.md\nitem\n\n";
    expect(readBootstrapDirective(makeInstance(content))).toBe(content);
  });

  it("returns null when BOOTSTRAP.md is missing or empty", () => {
    expect(readBootstrapDirective(makeInstance())).toBeNull();
    expect(readBootstrapDirective(makeInstance("   \n  "))).toBeNull();
  });
});

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
