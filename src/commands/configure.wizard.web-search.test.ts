import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";

// Drive promptWebToolsConfig's provider/key decision tree directly: these
// branches decide whether the saved config silently changes the search backend
// (native keyless vs Brave vs Perplexity), so they get explicit prompt-level
// coverage.
const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  text: vi.fn(),
  note: vi.fn(),
}));

vi.mock("./configure.shared.js", () => ({
  confirm: mocks.confirm,
  text: mocks.text,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./onboard-helpers.js", () => ({
  guardCancel: <T>(value: T) => value,
}));

vi.mock("../cli/command-format.js", () => ({
  formatCliCommand: (cmd: string) => cmd,
}));

import { promptWebToolsConfig } from "./configure.wizard.js";

const runtime = {} as RuntimeEnv;

async function run(config: OpenClawConfig): Promise<NonNullable<OpenClawConfig["tools"]>["web"]> {
  const result = await promptWebToolsConfig(config, runtime);
  return result.tools?.web;
}

describe("promptWebToolsConfig web_search decision tree", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    mocks.confirm.mockReset();
    mocks.text.mockReset();
    mocks.note.mockReset();
    delete process.env.BRAVE_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    // Default: enable web_search, enable web_fetch.
    mocks.confirm.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("fresh config with no key leaves the provider unset (keyless native path) and notes native search", async () => {
    mocks.text.mockResolvedValueOnce(""); // leave key blank
    const web = await run({});
    expect(web?.search?.enabled).toBe(true);
    expect(web?.search?.provider).toBeUndefined();
    // The no-key notice should mention native search, not claim unavailability.
    const noteText = mocks.note.mock.calls.map((c) => String(c[0])).join("\n");
    expect(noteText).toMatch(/native server-side search/i);
  });

  it("entering a key pins provider to brave", async () => {
    mocks.text.mockResolvedValueOnce("BSA-new-key");
    const web = await run({});
    expect(web?.search?.apiKey).toBe("BSA-new-key");
    expect(web?.search?.provider).toBe("brave");
  });

  it("a stored brave key with no provider pins brave when kept", async () => {
    mocks.text.mockResolvedValueOnce(""); // keep existing key
    const web = await run({ tools: { web: { search: { enabled: true, apiKey: "stored-key" } } } });
    expect(web?.search?.provider).toBe("brave");
  });

  it("an environment brave key with no stored key pins brave", async () => {
    process.env.BRAVE_API_KEY = "env-brave-key";
    mocks.text.mockResolvedValueOnce("");
    const web = await run({});
    expect(web?.search?.provider).toBe("brave");
  });

  it("a pinned perplexity provider with its own key does not warn", async () => {
    process.env.PERPLEXITY_API_KEY = "pplx-key";
    mocks.text.mockResolvedValueOnce("");
    await run({ tools: { web: { search: { enabled: true, provider: "perplexity" } } } });
    const noteText = mocks.note.mock.calls.map((c) => String(c[0])).join("\n");
    expect(noteText).not.toMatch(/no perplexity key found/i);
  });

  it("a pinned perplexity provider without any key warns about the missing perplexity key", async () => {
    mocks.text.mockResolvedValueOnce("");
    await run({ tools: { web: { search: { enabled: true, provider: "perplexity" } } } });
    const noteText = mocks.note.mock.calls.map((c) => String(c[0])).join("\n");
    expect(noteText).toMatch(/no perplexity key found/i);
  });
});
