import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";
import { getAnthropicServerTool } from "./common.js";
import { createWebSearchTool } from "./web-search.js";

describe("web_search Anthropic server-tool mode", () => {
  it("emits a server-tool marker on anthropic-messages models", () => {
    const tool = createWebSearchTool({ config: {}, preferAnthropicServerTool: true });
    expect(tool?.name).toBe("web_search");
    const marker = getAnthropicServerTool(tool);
    expect(marker).toEqual({
      type: "web_search_20250305",
      config: { max_uses: 5 },
    });
  });

  it("respects a configured maxUses", () => {
    const tool = createWebSearchTool({
      config: { tools: { web: { search: { maxUses: 3 } } } },
      preferAnthropicServerTool: true,
    });
    expect(getAnthropicServerTool(tool)?.config).toEqual({ max_uses: 3 });
  });

  it("falls back to the client tool when a provider is pinned explicitly", () => {
    const tool = createWebSearchTool({
      config: { tools: { web: { search: { provider: "brave" } } } },
      preferAnthropicServerTool: true,
    });
    expect(tool?.name).toBe("web_search");
    expect(getAnthropicServerTool(tool)).toBeUndefined();
  });

  it("stays a client tool when the model is not anthropic-messages", () => {
    const tool = createWebSearchTool({ config: {} });
    expect(getAnthropicServerTool(tool)).toBeUndefined();
  });

  it("returns null when web search is disabled, even in server-tool mode", () => {
    const tool = createWebSearchTool({
      config: { tools: { web: { search: { enabled: false } } } },
      preferAnthropicServerTool: true,
    });
    expect(tool).toBeNull();
  });

  it("never executes client-side: its execute is an inert no-op", async () => {
    const tool = createWebSearchTool({ config: {}, preferAnthropicServerTool: true });
    const result = (await tool?.execute?.("call-1", { query: "anything" })) as {
      details?: { status?: string };
    };
    expect(result?.details?.status).toBe("pending");
  });

  it("preserves the server-tool marker through toToolDefinitions", () => {
    const tool = createWebSearchTool({ config: {}, preferAnthropicServerTool: true });
    const [def] = toToolDefinitions([tool!]);
    expect(def.name).toBe("web_search");
    expect(getAnthropicServerTool(def)).toEqual({
      type: "web_search_20250305",
      config: { max_uses: 5 },
    });
  });
});
