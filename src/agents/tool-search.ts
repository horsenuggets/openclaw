/**
 * Tool search / deferral system for subscription providers.
 *
 * The Anthropic subscription (OAuth) plan quota has a per-request input token
 * limit. Sending all 25+ tools with full schemas exceeds this limit. This
 * module implements a Claude Code-style tool deferral system:
 *
 * 1. Only "essential" tools are sent in the initial API request.
 * 2. A `tool_search` tool lets the model discover and load deferred tools.
 * 3. Once loaded, deferred tools are included in subsequent API requests.
 * 4. All tools remain registered for execution regardless of deferral.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "./pi-tools.types.js";

/**
 * Tools always sent to the API (case-insensitive matching).
 * Keep this set small enough that the total schema tokens stay under the
 * subscription plan quota limit (~15 tools max with full schemas).
 */
const ESSENTIAL_TOOL_NAMES_LOWER = new Set([
  "read",
  "write",
  "edit",
  "exec",
  "process",
  "message",
  "web_search",
  "web_fetch",
  "memory_search",
  "tool_search",
]);

function isEssentialTool(name: string): boolean {
  return ESSENTIAL_TOOL_NAMES_LOWER.has(name.toLowerCase());
}

/**
 * Session-scoped state tracking which deferred tools have been loaded.
 */
export class ToolSearchState {
  private loaded = new Set<string>();

  markLoaded(name: string): void {
    this.loaded.add(name.toLowerCase());
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name.toLowerCase());
  }

  isIncluded(name: string): boolean {
    return isEssentialTool(name) || this.isLoaded(name);
  }
}

/**
 * Create the tool_search tool that lets the model discover deferred tools.
 */
export function createToolSearchTool(
  allTools: AnyAgentTool[],
  state: ToolSearchState,
): AnyAgentTool {
  // Build a lookup of deferred tools (name → description)
  const deferred = new Map<string, { name: string; description: string }>();
  for (const tool of allTools) {
    if (!isEssentialTool(tool.name)) {
      deferred.set(tool.name.toLowerCase(), {
        name: tool.name,
        description: (tool.description ?? "").substring(0, 200),
      });
    }
  }

  return {
    label: "ToolSearch",
    name: "tool_search",
    description:
      "Search for and load deferred tools that aren't in the current request. " +
      "Use this when you need a tool that isn't available yet. " +
      "Pass a query to search by keyword, or use 'select:name1,name2' to load specific tools by name. " +
      "Loaded tools become available for subsequent calls.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string" as const,
          description:
            'Search query (keyword search) or "select:name1,name2" to load specific tools by name.',
        },
      },
      required: ["query"],
    },
    execute: async (_toolCallId: string, args: { query: string }) => {
      const query = (args.query ?? "").trim();
      let matches: Array<{ name: string; description: string }>;

      if (query.startsWith("select:")) {
        // Exact name lookup
        const names = query
          .slice(7)
          .split(",")
          .map((n) => n.trim().toLowerCase());
        matches = names
          .map((n) => deferred.get(n))
          .filter((m): m is { name: string; description: string } => m != null);
      } else {
        // Keyword search
        const lower = query.toLowerCase();
        matches = [...deferred.values()].filter(
          (t) =>
            t.name.toLowerCase().includes(lower) || t.description.toLowerCase().includes(lower),
        );
      }

      // Mark matched tools as loaded
      for (const match of matches) {
        state.markLoaded(match.name);
      }

      if (matches.length === 0) {
        return {
          type: "text" as const,
          text: `No deferred tools match "${query}". Available deferred tools: ${[...deferred.values()].map((t) => t.name).join(", ")}`,
        };
      }

      const lines = matches.map((t) => `- ${t.name}: ${t.description}`);
      return {
        type: "text" as const,
        text: `Loaded ${matches.length} tool(s). They are now available for use:\n${lines.join("\n")}`,
      };
    },
  } as AnyAgentTool;
}

/**
 * Wrap a StreamFn to filter tool schemas in the API request, only sending
 * essential + loaded tools. All tools remain executable.
 */
export function wrapStreamFnWithToolSearch(streamFn: StreamFn, state: ToolSearchState): StreamFn {
  return (model, context, options) => {
    const wrappedOnPayload = (payload: unknown) => {
      const params = payload as Record<string, unknown>;
      const tools = params.tools as Array<{ name: string }> | undefined;
      if (tools && Array.isArray(tools)) {
        const before = tools.length;
        // Filter in place — keep essential + loaded tools
        const filtered = tools.filter((t) => state.isIncluded(t.name));
        params.tools = filtered;
        if (filtered.length !== before) {
          // Silence: don't log in production, just filter
        }
      }
      options?.onPayload?.(payload);
    };
    return streamFn(model, context, { ...options, onPayload: wrappedOnPayload });
  };
}

/**
 * Build a system prompt section listing deferred tools so the model knows
 * they exist and can search for them.
 */
export function buildDeferredToolsPromptSection(allTools: AnyAgentTool[]): string {
  const deferred = allTools.filter((t) => !isEssentialTool(t.name));
  if (deferred.length === 0) {
    return "";
  }

  const lines = deferred.map(
    (t) => `- ${t.name}: ${(t.description ?? "").split("\n")[0].substring(0, 120)}`,
  );

  return [
    "The following tools are available but not loaded. Use the tool_search tool to load them before calling:",
    ...lines,
  ].join("\n");
}
