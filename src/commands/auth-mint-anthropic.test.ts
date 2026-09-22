import type { OAuthCredentials } from "@mariozechner/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  ANTHROPIC_SUBSCRIPTION_PROFILE_ID,
  ANTHROPIC_SUBSCRIPTION_PROVIDER,
  buildAnthropicSubscriptionProfile,
  mintAnthropicCommand,
  resolveInstancesDir,
  resolveMintTargetDir,
} from "./auth-mint-anthropic.js";

const CREDS: OAuthCredentials = {
  access: "access-token",
  refresh: "refresh-token",
  expires: 1893456000000,
};

const silentRuntime: RuntimeEnv = {
  log: () => {},
  error: () => {},
  exit: (() => {
    throw new Error("unexpected exit");
  }) as RuntimeEnv["exit"],
};

function readStore(dir: string): {
  version: number;
  profiles: Record<string, Record<string, unknown>>;
} {
  const raw = fs.readFileSync(path.join(dir, "auth-profiles.json"), "utf8");
  return JSON.parse(raw);
}

describe("buildAnthropicSubscriptionProfile", () => {
  it("shapes the credential into an oauth profile", () => {
    const profile = buildAnthropicSubscriptionProfile(CREDS);
    expect(profile).toEqual({
      type: "oauth",
      provider: ANTHROPIC_SUBSCRIPTION_PROVIDER,
      access: "access-token",
      refresh: "refresh-token",
      expires: 1893456000000,
    });
  });

  it("is pure (same input yields equal output)", () => {
    expect(buildAnthropicSubscriptionProfile(CREDS)).toEqual(
      buildAnthropicSubscriptionProfile(CREDS),
    );
  });
});

describe("resolveMintTargetDir", () => {
  it("returns undefined for the main store (explicit and default)", () => {
    expect(resolveMintTargetDir({ store: "main" })).toBeUndefined();
    expect(resolveMintTargetDir({})).toBeUndefined();
  });

  it("resolves the shared store under the instances root", () => {
    expect(resolveMintTargetDir({ store: "shared", instancesDir: "/srv/inst" })).toBe(
      path.join("/srv/inst", "shared", "auth"),
    );
  });

  it("lets an explicit agent dir override the store", () => {
    expect(resolveMintTargetDir({ store: "shared", agentDir: "/custom/dir" })).toBe("/custom/dir");
  });

  it("rejects an unknown store", () => {
    expect(() => resolveMintTargetDir({ store: "bogus" as never })).toThrow(/Unknown store/);
  });
});

describe("resolveInstancesDir", () => {
  it("prefers an explicit override", () => {
    expect(resolveInstancesDir("/explicit")).toBe("/explicit");
  });
});

describe("mintAnthropicCommand", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-mint-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the minted profile into the target store", async () => {
    let seenUrl = "";
    await mintAnthropicCommand({ agentDir: dir }, silentRuntime, {
      login: async (onAuthUrl) => {
        onAuthUrl("https://claude.ai/oauth/authorize?code=true");
        return CREDS;
      },
      // Capture the URL the command surfaces to the operator.
      promptCode: async () => "unused",
    });

    // login received an onAuthUrl callback wired to runtime output.
    const captureRuntime: RuntimeEnv = {
      ...silentRuntime,
      log: (msg?: unknown) => {
        if (typeof msg === "string" && msg.includes("claude.ai/oauth/authorize")) {
          seenUrl = msg;
        }
      },
    };
    await mintAnthropicCommand({ agentDir: dir }, captureRuntime, {
      login: async (onAuthUrl) => {
        onAuthUrl("  https://claude.ai/oauth/authorize?code=true");
        return CREDS;
      },
    });
    expect(seenUrl).toContain("claude.ai/oauth/authorize");

    const store = readStore(dir);
    expect(store.profiles[ANTHROPIC_SUBSCRIPTION_PROFILE_ID]).toEqual({
      type: "oauth",
      provider: ANTHROPIC_SUBSCRIPTION_PROVIDER,
      access: "access-token",
      refresh: "refresh-token",
      expires: 1893456000000,
    });
  });

  it("preserves existing profiles in the store", async () => {
    fs.writeFileSync(
      path.join(dir, "auth-profiles.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai:default": { type: "api_key", provider: "openai", key: "sk-existing" },
          },
        },
        null,
        2,
      )}\n`,
    );

    await mintAnthropicCommand({ agentDir: dir }, silentRuntime, {
      login: async () => CREDS,
    });

    const store = readStore(dir);
    expect(store.profiles["openai:default"]).toEqual({
      type: "api_key",
      provider: "openai",
      key: "sk-existing",
    });
    expect(store.profiles[ANTHROPIC_SUBSCRIPTION_PROFILE_ID]?.access).toBe("access-token");
  });
});
