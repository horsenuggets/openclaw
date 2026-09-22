import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterRuntime } from "./router.js";
import { startOAuthCallbackServer } from "./oauth-callback.js";

// The callback server loads OAuth client creds from disk when building an auth
// URL. We only care about the pending-auth channel routing here, so stub fs to
// return minimal creds regardless of path.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const creds = JSON.stringify({
    client_id: "cid",
    client_secret: "secret",
    redirect_uri: "http://127.0.0.1/cb",
  });
  return {
    ...actual,
    default: { ...actual, readFileSync: () => creds },
    readFileSync: () => creds,
  };
});

const runtime: RouterRuntime = { log: () => {}, error: () => {} };

/** Extract the base64url `state` nonce Discord would echo back from an authUrl. */
function stateFromUrl(authUrl: string): string {
  const u = new URL(authUrl);
  return u.searchParams.get("state") ?? "";
}

describe("oauth callback per-channel routing", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
    vi.restoreAllMocks();
  });

  it("routes each auth completion back to the channel that requested it", async () => {
    const completions: Array<{ discordUserId: string; channelId?: string }> = [];
    // startOAuthCallbackServer already calls server.listen() internally, so we
    // wait for its own "listening" event and read the assigned port rather than
    // listening again (which would throw ERR_SERVER_ALREADY_LISTEN).
    const { server, requestAuth } = startOAuthCallbackServer({
      instancesDir: "/tmp/does-not-matter",
      runtime,
      onAuthComplete: ({ discordUserId, channelId }) =>
        completions.push({ discordUserId, channelId }),
    });
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;

    // Same user starts Google auth in two different channels concurrently.
    const first = requestAuth({ discordUserId: "user-1", channelId: "chan-A", email: "u" });
    const second = requestAuth({ discordUserId: "user-1", channelId: "chan-B", email: "u" });

    // Fire the GET callback for the SECOND channel first — with a shared,
    // user-keyed map the completion would resolve to the wrong channel.
    const stateB = stateFromUrl(second.authUrl);
    await fetch(`http://127.0.0.1:${port}/auth/receive?code=codeB&state=${stateB}`);

    const stateA = stateFromUrl(first.authUrl);
    await fetch(`http://127.0.0.1:${port}/auth/receive?code=codeA&state=${stateA}`);

    expect(completions).toEqual([
      { discordUserId: "user-1", channelId: "chan-B" },
      { discordUserId: "user-1", channelId: "chan-A" },
    ]);
  });
});
