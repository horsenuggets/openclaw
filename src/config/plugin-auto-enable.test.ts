import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";

describe("applyPluginAutoEnable", () => {
  it("enables configured channel plugins and updates allowlist", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { allow: ["telegram"] },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBe(true);
    expect(result.config.plugins?.allow).toEqual(["telegram", "slack"]);
    expect(result.changes.join("\n")).toContain("Slack configured, not enabled yet.");
  });

  it("respects explicit disable", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { entries: { slack: { enabled: false } } },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBe(false);
    expect(result.changes).toEqual([]);
  });

  it("enables provider auth plugins when profiles exist", () => {
    const result = applyPluginAutoEnable({
      config: {
        auth: {
          profiles: {
            "google-antigravity:default": {
              provider: "google-antigravity",
              mode: "oauth",
            },
          },
        },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.["google-antigravity-auth"]?.enabled).toBe(true);
  });

  it("skips when plugins are globally disabled", () => {
    const result = applyPluginAutoEnable({
      config: {
        channels: { slack: { botToken: "x" } },
        plugins: { enabled: false },
      },
      env: {},
    });

    expect(result.config.plugins?.entries?.slack?.enabled).toBeUndefined();
    expect(result.changes).toEqual([]);
  });

  describe("preferOver channel prioritization", () => {
    // No bundled extension declares preferOver anymore, so feed the catalog a fixture entry.
    let catalogDir = "";

    beforeAll(() => {
      catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auto-enable-"));
      const catalogPath = path.join(catalogDir, "catalog.json");
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          entries: [
            {
              name: "@openclaw/demo-bridge",
              openclaw: {
                channel: {
                  id: "demo-bridge",
                  label: "Demo Bridge",
                  selectionLabel: "Demo Bridge",
                  docsPath: "/channels/demo-bridge",
                  blurb: "Fixture channel that is preferred over iMessage.",
                  preferOver: ["imessage"],
                },
                install: { npmSpec: "@openclaw/demo-bridge" },
              },
            },
          ],
        }),
      );
      vi.stubEnv("OPENCLAW_PLUGIN_CATALOG_PATHS", catalogPath);
    });

    afterAll(() => {
      vi.unstubAllEnvs();
      fs.rmSync(catalogDir, { recursive: true, force: true });
    });

    it("prefers demo-bridge: skips imessage auto-enable when both are configured", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            "demo-bridge": { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.["demo-bridge"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBeUndefined();
      expect(result.changes.join("\n")).toContain("demo-bridge configured, not enabled yet.");
      expect(result.changes.join("\n")).not.toContain("iMessage configured, not enabled yet.");
    });

    it("keeps imessage enabled if already explicitly enabled (non-destructive)", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            "demo-bridge": { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { entries: { imessage: { enabled: true } } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.["demo-bridge"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
    });

    it("allows imessage auto-enable when demo-bridge is explicitly disabled", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            "demo-bridge": { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { entries: { "demo-bridge": { enabled: false } } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.["demo-bridge"]?.enabled).toBe(false);
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, not enabled yet.");
    });

    it("allows imessage auto-enable when demo-bridge is in deny list", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: {
            "demo-bridge": { serverUrl: "http://localhost:1234", password: "x" },
            imessage: { cliPath: "/usr/local/bin/imsg" },
          },
          plugins: { deny: ["demo-bridge"] },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.["demo-bridge"]?.enabled).toBeUndefined();
      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
    });

    it("enables imessage normally when only imessage is configured", () => {
      const result = applyPluginAutoEnable({
        config: {
          channels: { imessage: { cliPath: "/usr/local/bin/imsg" } },
        },
        env: {},
      });

      expect(result.config.plugins?.entries?.imessage?.enabled).toBe(true);
      expect(result.changes.join("\n")).toContain("iMessage configured, not enabled yet.");
    });
  });
});
