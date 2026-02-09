import { describe, expect, it } from "vitest";
import { formatToolDetail, formatToolSummary, resolveToolDisplay } from "./tool-display.js";

describe("MCP tool name normalization", () => {
  it("strips mcp__server__prefix from tool names", () => {
    const display = resolveToolDisplay({ name: "mcp__claude-code-mcp__claude_code" });
    expect(display.name).toBe("claude_code");
    expect(display.title).toBe("Claude Code");
    expect(display.emoji).toBe("🤖");
  });

  it("strips mcp prefix for unknown MCP tools", () => {
    const display = resolveToolDisplay({ name: "mcp__filesystem__read_file" });
    expect(display.name).toBe("read_file");
    expect(display.title).toBe("Read File");
  });

  it("leaves non-MCP tool names unchanged", () => {
    const display = resolveToolDisplay({ name: "read" });
    expect(display.name).toBe("read");
    expect(display.title).toBe("Read");
  });

  it("formats claude_code summary with prompt detail", () => {
    const summary = formatToolSummary(
      resolveToolDisplay({
        name: "mcp__claude-code-mcp__claude_code",
        args: { prompt: "list files in /tmp" },
      }),
    );
    expect(summary).toBe("🤖 Claude Code: list files in /tmp");
  });
});

describe("tool display details", () => {
  it("skips zero/false values for optional detail fields", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_spawn",
        args: {
          task: "double-message-bug-gpt",
          label: 0,
          runTimeoutSeconds: 0,
          timeoutSeconds: 0,
        },
      }),
    );

    expect(detail).toBe("double-message-bug-gpt");
  });

  it("includes only truthy boolean details", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "message",
        args: {
          action: "react",
          provider: "discord",
          to: "chan-1",
          remove: false,
        },
      }),
    );

    expect(detail).toContain("provider discord");
    expect(detail).toContain("to chan-1");
    expect(detail).not.toContain("remove");
  });

  it("keeps positive numbers and true booleans", () => {
    const detail = formatToolDetail(
      resolveToolDisplay({
        name: "sessions_history",
        args: {
          sessionKey: "agent:main:main",
          limit: 20,
          includeTools: true,
        },
      }),
    );

    expect(detail).toContain("session agent:main:main");
    expect(detail).toContain("limit 20");
    expect(detail).toContain("tools true");
  });
});
