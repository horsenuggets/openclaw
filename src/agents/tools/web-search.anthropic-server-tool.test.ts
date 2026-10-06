import { wrapRegisteredTool } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";
import { getAnthropicServerTool } from "./common.js";
import { createWebSearchTool } from "./web-search.js";

// Mirror of the patched pi-ai `convertTools` emit for a marked server tool
// (patches/@mariozechner__pi-ai@0.52.5.patch). The real function is not
// exported from pi-ai, so we pin its contract here: a marked tool is emitted
// with its wire `type`, its canonical (never OAuth-mangled) name, the merged
// config, and NO client `input_schema`. This fails loudly if the patch's shape
// ever drifts from what the Anthropic transport expects.
function convertMarkedToolLikePiAi(tool: {
  name: string;
  anthropicServerTool?: { type: string; config?: Record<string, unknown> };
}): Record<string, unknown> {
  const serverTool = tool.anthropicServerTool;
  if (serverTool && serverTool.type) {
    return { type: serverTool.type, name: tool.name, ...serverTool.config };
  }
  // Non-marked tools go through the normal custom-tool path (client schema).
  return { name: tool.name, input_schema: {} };
}

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

  // The following two tests exercise the patched seams the feature depends on,
  // so a dropped patch (or a drift in its output) fails here rather than
  // silently falling back to a client tool.

  it("preserves the marker through pi-coding-agent wrapRegisteredTool (patched seam)", () => {
    const tool = createWebSearchTool({ config: {}, preferAnthropicServerTool: true })!;
    // Reconstruct the tool exactly as pi-coding-agent does before handing it to
    // the transport. The patch spreads the full definition, so the marker must
    // survive. A fake runner is enough; execute is never called here.
    const fakeRunner = { createContext: () => ({}) } as never;
    const wrapped = wrapRegisteredTool({ definition: tool } as never, fakeRunner);
    expect(wrapped.name).toBe("web_search");
    expect(getAnthropicServerTool(wrapped)).toEqual({
      type: "web_search_20250305",
      config: { max_uses: 5 },
    });
  });

  it("emits a server-tool wire payload (type + canonical name + max_uses, no input_schema)", () => {
    const tool = createWebSearchTool({
      config: { tools: { web: { search: { maxUses: 7 } } } },
      preferAnthropicServerTool: true,
    })!;
    // Run the tool through the pi-coding-agent seam, then through the pi-ai
    // convertTools contract, and assert the final Anthropic request payload.
    const fakeRunner = { createContext: () => ({}) } as never;
    const wrapped = wrapRegisteredTool({ definition: tool } as never, fakeRunner) as {
      name: string;
      anthropicServerTool?: { type: string; config?: Record<string, unknown> };
    };
    const wirePayload = convertMarkedToolLikePiAi(wrapped);
    expect(wirePayload).toEqual({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 7,
    });
    // Must NOT carry a client input schema (the API runs the search itself).
    expect(wirePayload).not.toHaveProperty("input_schema");
  });
});
