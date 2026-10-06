import { streamSimple, type Model, type Tool } from "@mariozechner/pi-ai";
import { wrapRegisteredTool } from "@mariozechner/pi-coding-agent";
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

  it("sends a server-tool payload through the Anthropic transport", async () => {
    const tool = createWebSearchTool({
      config: { tools: { web: { search: { maxUses: 7 } } } },
      preferAnthropicServerTool: true,
    })!;
    const [definition] = toToolDefinitions([tool]);
    const fakeRunner = { createContext: () => ({}) } as never;
    const wrapped = wrapRegisteredTool({ definition } as never, fakeRunner);
    let requestBody: Record<string, unknown> | undefined;
    let requestUrl: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "test response" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      await streamSimple(
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 100,
        } satisfies Model<"anthropic-messages">,
        {
          messages: [{ role: "user", content: "search for something" }],
          tools: [wrapped as unknown as Tool],
        },
        { apiKey: "sk-ant-oat01-test" },
      ).result();
    } finally {
      globalThis.fetch = originalFetch;
    }

    const wirePayload = (requestBody?.tools as Record<string, unknown>[] | undefined)?.[0];
    expect(requestUrl).toContain("/v1/messages");
    expect(wirePayload).toMatchObject({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 7,
    });
    expect(wirePayload).not.toHaveProperty("input_schema");
  });
});
