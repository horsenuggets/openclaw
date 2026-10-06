import { describe, expect, it } from "vitest";
import { supportsAnthropicServerWebSearch } from "./pi-tools.js";

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
