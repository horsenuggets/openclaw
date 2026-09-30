import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./test-helpers.js";

describe("config workspace context", () => {
  it("accepts and preserves agents.defaults.context", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify(
          {
            agents: {
              defaults: {
                context: {
                  default: "preamble",
                  files: { "memory.md": "off", "user.md": "inline" },
                  pointer: "inline",
                },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      const context = cfg.agents?.defaults?.context;
      expect(context?.default).toBe("preamble");
      expect(context?.files?.["memory.md"]).toBe("off");
      expect(context?.files?.["user.md"]).toBe("inline");
      expect(context?.pointer).toBe("inline");
    });
  });

  it("is absent by default (built-in per-file defaults apply at runtime)", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({ agents: { defaults: {} } }, null, 2),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.agents?.defaults?.context).toBeUndefined();
    });
  });
});
