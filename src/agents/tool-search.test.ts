import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { createToolSearchTool, ToolSearchState } from "./tool-search.js";

// Minimal fake tools: createToolSearchTool only reads name + description.
function fakeTool(name: string, description: string): AnyAgentTool {
  return { name, description } as unknown as AnyAgentTool;
}

type ExecResult = { content?: unknown; details?: unknown };
function getExecute(tool: AnyAgentTool) {
  return (
    tool as unknown as { execute: (id: string, args: { query: string }) => Promise<ExecResult> }
  ).execute;
}

describe("createToolSearchTool", () => {
  const allTools = [
    fakeTool("read", "essential"),
    fakeTool("web_search", "search the web for information"),
    fakeTool("calendar_list", "list calendar events"),
  ];

  // Regression: the tool used to return a bare `{ type: "text", text }` block
  // instead of an AgentToolResult, so `result.content` was undefined and the
  // next turn crashed with "undefined is not an object (evaluating 'content.some')".
  it("returns an AgentToolResult with a content array on a match", async () => {
    const state = new ToolSearchState();
    const tool = createToolSearchTool(allTools, state);
    const result = await getExecute(tool)("call-1", { query: "web" });

    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("web_search");
    expect(state.isLoaded("web_search")).toBe(true);
  });

  it("returns a content array (not a bare block) when nothing matches", async () => {
    const state = new ToolSearchState();
    const tool = createToolSearchTool(allTools, state);
    const result = await getExecute(tool)("call-2", { query: "nonexistent-xyz" });

    expect(Array.isArray(result.content)).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("No deferred tools match");
    // The bare-block regression: the result must not itself be a text block.
    expect((result as { type?: string }).type).toBeUndefined();
  });

  it("loads specific tools via select: syntax", async () => {
    const state = new ToolSearchState();
    const tool = createToolSearchTool(allTools, state);
    const result = await getExecute(tool)("call-3", { query: "select:calendar_list" });

    expect(Array.isArray(result.content)).toBe(true);
    expect(state.isLoaded("calendar_list")).toBe(true);
  });
});
