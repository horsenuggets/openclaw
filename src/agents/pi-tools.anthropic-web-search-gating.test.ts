import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAnthropicServerWebSearchInputs,
  supportsAnthropicServerWebSearch,
} from "./pi-tools.js";

// Anthropic's hosted web_search_20250305 tool is a first-party capability, not
// a property of the anthropic-messages wire format. Several non-Anthropic
// providers also speak that transport, so the gate must require BOTH the
// transport and a genuine Anthropic provider using the first-party endpoint.
describe("supportsAnthropicServerWebSearch", () => {
  it("enables native search for first-party Anthropic API", () => {
    expect(
      supportsAnthropicServerWebSearch({
        modelApi: "anthropic-messages",
        modelProvider: "anthropic",
        modelBaseUrl: "https://api.anthropic.com",
      }),
    ).toBe(true);
  });

  it("enables native search for Claude subscription OAuth", () => {
    expect(
      supportsAnthropicServerWebSearch({
        modelApi: "anthropic-messages",
        modelProvider: "anthropic-subscription",
        modelBaseUrl: "https://api.anthropic.com/v1",
      }),
    ).toBe(true);
  });

  it("requires explicit capability opt-in for custom Anthropic endpoints", () => {
    const params = {
      modelApi: "anthropic-messages",
      modelProvider: "anthropic",
      modelBaseUrl: "https://anthropic-proxy.example",
    };
    expect(supportsAnthropicServerWebSearch(params)).toBe(false);
    expect(
      supportsAnthropicServerWebSearch({
        ...params,
        modelSupportsAnthropicServerWebSearch: true,
      }),
    ).toBe(true);
  });

  it.each(["http://api.anthropic.com", "https://api.anthropic.com.attacker.test"])(
    "rejects non-first-party endpoint %s",
    (modelBaseUrl) => {
      expect(
        supportsAnthropicServerWebSearch({
          modelApi: "anthropic-messages",
          modelProvider: "anthropic",
          modelBaseUrl,
        }),
      ).toBe(false);
    },
  );

  it.each(["minimax-portal", "synthetic", "xiaomi", "cloudflare", "custom-proxy"])(
    "does not enable native search for non-Anthropic provider %s on the anthropic-messages wire",
    (provider) => {
      expect(
        supportsAnthropicServerWebSearch({
          modelApi: "anthropic-messages",
          modelProvider: provider,
        }),
      ).toBe(false);
    },
  );

  it("does not enable native search when the transport is not anthropic-messages", () => {
    expect(
      supportsAnthropicServerWebSearch({
        modelApi: "openai-responses",
        modelProvider: "anthropic",
      }),
    ).toBe(false);
  });

  it("does not enable native search when provider is unknown", () => {
    expect(supportsAnthropicServerWebSearch({ modelApi: "anthropic-messages" })).toBe(false);
  });
});

// pi-coding-agent's ModelRegistry reconstructs models from known fields and
// drops custom props like supportsAnthropicServerWebSearch, so the capability
// must be read from config by provider/model id, not off the runtime model.
describe("resolveAnthropicServerWebSearchInputs", () => {
  it("reads the capability opt-in from the configured model entry", () => {
    const config = {
      models: {
        providers: {
          anthropic: {
            api: "anthropic-messages",
            baseUrl: "https://anthropic-proxy.example",
            models: [{ id: "claude-proxy", supportsAnthropicServerWebSearch: true }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const inputs = resolveAnthropicServerWebSearchInputs({
      config,
      provider: "anthropic",
      modelId: "claude-proxy",
      model: { api: "anthropic-messages", baseUrl: "https://anthropic-proxy.example" },
    });
    expect(inputs.modelSupportsAnthropicServerWebSearch).toBe(true);
    expect(inputs.modelBaseUrl).toBe("https://anthropic-proxy.example");
    // The gate should now allow native search on this custom endpoint.
    expect(
      supportsAnthropicServerWebSearch({
        modelApi: inputs.modelApi,
        modelProvider: "anthropic",
        modelBaseUrl: inputs.modelBaseUrl,
        modelSupportsAnthropicServerWebSearch: inputs.modelSupportsAnthropicServerWebSearch,
      }),
    ).toBe(true);
  });

  it("falls back to the runtime model api/baseUrl when config has no entry", () => {
    const inputs = resolveAnthropicServerWebSearchInputs({
      config: {} as OpenClawConfig,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      model: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
    });
    expect(inputs.modelApi).toBe("anthropic-messages");
    expect(inputs.modelBaseUrl).toBe("https://api.anthropic.com");
    expect(inputs.modelSupportsAnthropicServerWebSearch).toBeUndefined();
  });
});
