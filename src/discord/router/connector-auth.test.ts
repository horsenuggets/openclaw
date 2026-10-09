import { describe, expect, it, vi } from "vitest";
import { type AuthResult, CliAuth, PasteTokenAuth } from "./connector-auth.js";

function pasteAuth(validate: (token: string) => Promise<AuthResult>) {
  return new PasteTokenAuth({
    url: "https://example.com/token",
    howto: "Grab your token.",
    validate,
  });
}

describe("PasteTokenAuth.begin", () => {
  it("surfaces the howto and url", () => {
    const prompt = pasteAuth(async () => ({ ok: true })).begin();
    expect(prompt).toEqual({
      kind: "paste-token",
      howto: "Grab your token.",
      url: "https://example.com/token",
    });
  });
});

describe("PasteTokenAuth.complete", () => {
  it("rejects a missing token without calling validate", async () => {
    const validate = vi.fn(async () => ({ ok: true }) as AuthResult);
    const result = await pasteAuth(validate).complete(undefined);
    expect(result).toEqual({ ok: false, message: "No token provided" });
    expect(validate).not.toHaveBeenCalled();
  });

  it("defaults the stored token to the pasted value on success", async () => {
    const result = await pasteAuth(async () => ({ ok: true, accountLabel: "octocat" })).complete(
      "ghp_secret",
    );
    expect(result).toEqual({ ok: true, token: "ghp_secret", accountLabel: "octocat" });
  });

  it("keeps a token the validator returned instead of the pasted one", async () => {
    const result = await pasteAuth(async () => ({ ok: true, token: "exchanged" })).complete("raw");
    expect(result).toEqual({ ok: true, token: "exchanged" });
  });

  it("passes a validation failure straight through", async () => {
    const result = await pasteAuth(async () => ({
      ok: false,
      message: "GitHub returned 401",
    })).complete("bad");
    expect(result).toEqual({ ok: false, message: "GitHub returned 401" });
  });

  it("turns a thrown network error into a failure result", async () => {
    const result = await pasteAuth(async () => {
      throw new Error("connect ETIMEDOUT");
    }).complete("tok");
    expect(result).toEqual({ ok: false, message: "connect ETIMEDOUT" });
  });
});

describe("CliAuth", () => {
  it("reports as not yet linkable", async () => {
    const auth = new CliAuth({ tool: "gog" });
    expect(auth.kind).toBe("cli");
    expect(auth.begin()).toEqual({ kind: "cli" });
    expect(await auth.complete()).toEqual({
      ok: false,
      message: "Linking via gog is not available yet",
    });
  });
});
