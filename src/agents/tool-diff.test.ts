import { describe, expect, it } from "vitest";
import { computeConfigDiff, formatConfigDiff, formatTextDiff } from "./tool-diff.js";

// -- formatTextDiff ----------------------------------------------------------

describe("formatTextDiff", () => {
  it("returns undefined for identical strings", () => {
    expect(formatTextDiff("hello", "hello")).toBeUndefined();
  });

  it("shows single-line change", () => {
    const diff = formatTextDiff("const port = 3000;", "const port = 8080;");
    expect(diff).toBe("- const port = 3000;\n+ const port = 8080;");
  });

  it("shows multi-line change", () => {
    const diff = formatTextDiff("line1\nline2", "line1\nline3\nline4");
    expect(diff).toBe("- line1\n- line2\n+ line1\n+ line3\n+ line4");
  });

  it("handles empty old text (pure addition)", () => {
    const diff = formatTextDiff("", "new content");
    expect(diff).toBe("- \n+ new content");
  });

  it("handles empty new text (pure removal)", () => {
    const diff = formatTextDiff("old content", "");
    expect(diff).toBe("- old content\n+ ");
  });
});

// -- computeConfigDiff -------------------------------------------------------

describe("computeConfigDiff", () => {
  it("returns empty array for identical configs", () => {
    const config = { models: { subscription: "pro" } };
    expect(computeConfigDiff(config, config)).toEqual([]);
  });

  it("detects changed scalar values", () => {
    const entries = computeConfigDiff(
      { models: { subscription: "pro" } },
      { models: { subscription: "cli" } },
    );
    expect(entries).toEqual([
      {
        path: "models.subscription",
        kind: "changed",
        oldValue: "pro",
        newValue: "cli",
      },
    ]);
  });

  it("detects added keys", () => {
    const entries = computeConfigDiff({ models: {} }, { models: { subscription: "cli" } });
    expect(entries).toEqual([
      {
        path: "models.subscription",
        kind: "added",
        newValue: "cli",
      },
    ]);
  });

  it("detects removed keys", () => {
    const entries = computeConfigDiff({ models: { subscription: "pro" } }, { models: {} });
    expect(entries).toEqual([
      {
        path: "models.subscription",
        kind: "removed",
        oldValue: "pro",
      },
    ]);
  });

  it("handles nested object changes", () => {
    const entries = computeConfigDiff(
      { channels: { discord: { token: "abc", verbose: false } } },
      { channels: { discord: { token: "abc", verbose: true } } },
    );
    expect(entries).toEqual([
      {
        path: "channels.discord.verbose",
        kind: "changed",
        oldValue: false,
        newValue: true,
      },
    ]);
  });

  it("handles array values", () => {
    const entries = computeConfigDiff(
      { tools: { allowed: ["read", "write"] } },
      { tools: { allowed: ["read", "write", "exec"] } },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("changed");
    expect(entries[0].path).toBe("tools.allowed");
  });

  it("ignores meta.lastTouchedVersion", () => {
    const entries = computeConfigDiff(
      { meta: { lastTouchedVersion: "1.0.0" }, models: { subscription: "pro" } },
      { meta: { lastTouchedVersion: "2.0.0" }, models: { subscription: "pro" } },
    );
    expect(entries).toEqual([]);
  });

  it("ignores meta.lastTouchedAt", () => {
    const entries = computeConfigDiff(
      { meta: { lastTouchedAt: "2026-01-01" } },
      { meta: { lastTouchedAt: "2026-02-14" } },
    );
    expect(entries).toEqual([]);
  });
});

// -- formatConfigDiff --------------------------------------------------------

describe("formatConfigDiff", () => {
  it("returns undefined for identical configs", () => {
    expect(formatConfigDiff({ a: 1 }, { a: 1 })).toBeUndefined();
  });

  it("formats changed values with - and + lines", () => {
    const diff = formatConfigDiff(
      { models: { subscription: "pro" } },
      { models: { subscription: "cli" } },
    );
    expect(diff).toBe('- models.subscription: "pro"\n+ models.subscription: "cli"');
  });

  it("formats added values with + only", () => {
    const diff = formatConfigDiff({}, { channels: { discord: { verbose: true } } });
    expect(diff).toContain("+ channels.discord.verbose: true");
  });

  it("formats removed values with - only", () => {
    const diff = formatConfigDiff({ tools: { browser: { enabled: true } } }, { tools: {} });
    expect(diff).toContain("- tools.browser.enabled: true");
  });

  it("formats boolean and number values without quotes", () => {
    const diff = formatConfigDiff({ port: 3000 }, { port: 8080 });
    expect(diff).toBe("- port: 3000\n+ port: 8080");
  });

  it("formats null values", () => {
    const diff = formatConfigDiff({ key: "value" }, { key: null });
    expect(diff).toBe('- key: "value"\n+ key: null');
  });

  it("truncates long array values", () => {
    const longArray = Array.from({ length: 20 }, (_, i) => `item-${i}`);
    const diff = formatConfigDiff({ items: [] }, { items: longArray });
    expect(diff).toBeDefined();
    // Each line should stay reasonably short
    for (const line of diff!.split("\n")) {
      expect(line.length).toBeLessThan(100);
    }
  });
});
