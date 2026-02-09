# Suppress Wrapper Tool Feedback + Filter Watchdog Terminal Output

## Problem

1. **Discord shows "Claude Code" as tool feedback** — when the agent calls `mcp__claude-code-mcp__claude_code`, the tool feedback displays "🤖 Claude Code: ..." in Discord. The user wants to see _inner_ tool names (Read, Bash, Edit) but these are architecturally invisible — the Claude CLI only reports top-level tool calls via `AgentStreamEvent`. Inner MCP tool calls are a black box.

2. **Watchdog terminal is flooded with raw tool output** — `process-monitor.mjs` pipes ALL gateway stdout/stderr directly to the terminal. When `OPENCLAW_CLAUDE_CLI_LOG_OUTPUT=1` is set, raw subprocess output (ps listings, file contents, etc.) clutters the terminal. Real log lines have ISO timestamps; raw output does not.

## Fix 1: Suppress Tool Feedback for Wrapper MCP Tools

Since inner tool calls are invisible, the pragmatic fix is to suppress the unhelpful "Claude Code" wrapper feedback entirely. Add a `suppress` flag to the tool display system.

### 1a. Add `suppress` to types in `src/agents/tool-display.ts`

- Add `suppress?: boolean` to `ToolDisplaySpec` type (line 10-16)
- Add `suppress: boolean` to `ToolDisplay` return type (line 24-31)
- Set `suppress: spec?.suppress ?? false` in `resolveToolDisplay()` return object (line 270-278)

### 1b. Add `suppress: true` in `src/agents/tool-display.json`

Add to the `claude_code` entry:

```json
"claude_code": {
  "emoji": "🤖",
  "title": "Claude Code",
  "suppress": true,
  "detailKeys": ["prompt"]
}
```

### 1c. Check `suppress` in `src/auto-reply/reply/dispatch-from-config.ts`

In the `onToolStatus` callback (lines 303-311), add an early return:

```typescript
(info) => {
  const display = resolveToolDisplay({ name: info.toolName, args: info.input });
  if (display.suppress) return; // <-- add this
  const summary = formatToolSummary(display);
  // ... rest unchanged
};
```

### 1d. Add test in `src/agents/tool-display.test.ts`

```typescript
it("marks claude_code as suppressed", () => {
  const display = resolveToolDisplay({ name: "mcp__claude-code-mcp__claude_code" });
  expect(display.suppress).toBe(true);
});

it("does not suppress regular tools", () => {
  const display = resolveToolDisplay({ name: "read" });
  expect(display.suppress).toBe(false);
});
```

## Fix 2: Filter Watchdog Terminal Output

### 2a. Add line-based filtering in `watchdog/process-monitor.mjs`

Replace raw `process.stdout.write(chunk)` (line 301) with line-buffered filtering that only forwards gateway log lines to the terminal. All output still goes to the log file.

Gateway log lines match: `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z` (ISO 8601 timestamp at start of line).

```javascript
// Replace lines 299-307 with:
const LOG_LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;
let stdoutBuf = "";

this.process.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  logStream.write(`[${timestamp()}] [stdout] ${text}`);

  // Buffer and filter: only show log lines in terminal
  stdoutBuf += text;
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop() ?? ""; // keep incomplete last line in buffer
  for (const line of lines) {
    if (LOG_LINE_RE.test(line)) {
      process.stdout.write(line + "\n");
    }
  }
});

this.process.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  logStream.write(`[${timestamp()}] [stderr] ${text}`);
  process.stderr.write(text); // stderr always shown (errors, warnings)
});
```

Stderr is always shown since it contains errors/warnings that should be visible.

## Files Modified

| File                                           | Change                                 |
| ---------------------------------------------- | -------------------------------------- |
| `src/agents/tool-display.ts`                   | Add `suppress` to types + return value |
| `src/agents/tool-display.json`                 | Add `suppress: true` to `claude_code`  |
| `src/agents/tool-display.test.ts`              | Add suppress tests                     |
| `src/auto-reply/reply/dispatch-from-config.ts` | Early return when `display.suppress`   |
| `watchdog/process-monitor.mjs`                 | Line-buffered stdout filtering         |

## Verification

1. `pnpm test src/agents/tool-display.test.ts` — tool display tests pass
2. `pnpm test src/auto-reply/reply/dispatch-from-config.test.ts` — existing dispatch tests pass
3. `pnpm build` — type-checks clean
4. `pnpm check` — lint/format clean
5. Manual: run `pnpm watchdog:run`, trigger a tool call — no "Claude Code" feedback in Discord, terminal shows only timestamped log lines
