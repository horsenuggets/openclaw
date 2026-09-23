import { loginAnthropic, type OAuthCredentials } from "@mariozechner/pi-ai";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { AuthProfileStore, OAuthCredential } from "../agents/auth-profiles/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { AUTH_STORE_LOCK_OPTIONS } from "../agents/auth-profiles/constants.js";
import { ensureAuthStoreFile, resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { loadJsonFile } from "../infra/json-file.js";
import { loginAnthropicViaCallback } from "./auth-anthropic-login.js";

// The profile id every per-channel agent resolves for the Claude Max OAuth
// ("anthropic-subscription") provider, and the provider name stored alongside
// the credential. Mint writes the minted token here so the gateway picks it up.
export const ANTHROPIC_SUBSCRIPTION_PROFILE_ID = "anthropic-subscription:default";
export const ANTHROPIC_SUBSCRIPTION_PROVIDER = "anthropic-subscription";

export type MintStore = "shared" | "main";

export type MintAnthropicOptions = {
  store?: MintStore;
  instancesDir?: string;
  agentDir?: string;
  // When set, use the localhost-callback flow on this port instead of the paste
  // flow. A laptop-side script tunnels this port so the browser redirect is
  // captured automatically (no code paste, no TTY).
  callbackPort?: number;
  // Host the callback server binds to (default "localhost"). Use "0.0.0.0" when
  // the redirect must reach the server across a container/bind-mount boundary.
  bindHost?: string;
};

export type MintAnthropicDeps = {
  // Injectable paste-flow OAuth (defaults to pi-ai's claude.ai paste flow).
  // Kept injectable so tests can drive the command without a live browser.
  login?: (
    onAuthUrl: (url: string) => void,
    onPromptCode: () => Promise<string>,
  ) => Promise<OAuthCredentials>;
  // Injectable localhost-callback OAuth (defaults to loginAnthropicViaCallback).
  loginViaCallback?: typeof loginAnthropicViaCallback;
  // Injectable prompt for the pasted "code#state" (defaults to a clack input).
  promptCode?: () => Promise<string>;
};

// Resolve the per-host instances root the same way src/discord-router/config.ts
// does, so --store shared targets the directory the router actually scans.
export function resolveInstancesDir(override?: string): string {
  return (
    override ??
    process.env.OPENCLAW_INSTANCES_DIR ??
    path.join(process.env.HOME ?? os.homedir(), ".openclaw-instances")
  );
}

// Map the requested target to the agent dir passed to the store helpers.
// > agentDir - explicit dir wins over --store
// > "main" (default) - the main agent store (resolveAuthStorePath(undefined))
// > "shared" - the single shared store every per-channel container mounts
export function resolveMintTargetDir(opts: MintAnthropicOptions): string | undefined {
  if (opts.agentDir) {
    return opts.agentDir;
  }
  const store = opts.store ?? "main";
  if (store === "main") {
    return undefined;
  }
  if (store === "shared") {
    return path.join(resolveInstancesDir(opts.instancesDir), "shared", "auth");
  }
  throw new Error(`Unknown store "${store}". Use "shared", "main", or --agent-dir.`);
}

// Shape the minted OAuth credential into the stored profile. Pure so it can be
// asserted directly in tests.
export function buildAnthropicSubscriptionProfile(creds: OAuthCredentials): OAuthCredential {
  return {
    ...creds,
    type: "oauth",
    provider: ANTHROPIC_SUBSCRIPTION_PROVIDER,
  };
}

// Write the profile into the target store under a proper-lockfile lock so the
// write coordinates with any concurrent agent refresh. We load the raw file
// rather than ensureAuthProfileStore(), which cross-merges the main-agent store
// into non-main dirs and would leak main's profiles into the shared store.
async function writeAnthropicProfile(params: {
  agentDir?: string;
  profile: OAuthCredential;
}): Promise<string> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);
  const release = await lockfile.lock(authPath, AUTH_STORE_LOCK_OPTIONS);
  try {
    const raw = loadJsonFile(authPath);
    const store: AuthProfileStore =
      raw && typeof raw === "object" && "profiles" in raw
        ? (raw as AuthProfileStore)
        : { version: 1, profiles: {} };
    store.profiles[ANTHROPIC_SUBSCRIPTION_PROFILE_ID] = params.profile;
    saveAuthProfileStore(store, params.agentDir);
    return authPath;
  } finally {
    await release().catch(() => {});
  }
}

async function defaultPromptCode(): Promise<string> {
  const { text, isCancel } = await import("@clack/prompts");
  const value = await text({
    message: "Paste the authorization code (the code#state Anthropic shows after you approve)",
    validate: (input) => (input && String(input).trim() ? undefined : "Required"),
  });
  if (isCancel(value)) {
    throw new Error("Authentication cancelled.");
  }
  return String(value).trim();
}

export async function mintAnthropicCommand(
  opts: MintAnthropicOptions,
  runtime: RuntimeEnv,
  deps: MintAnthropicDeps = {},
): Promise<void> {
  const targetDir = resolveMintTargetDir(opts);

  let creds: OAuthCredentials;
  if (opts.callbackPort !== undefined) {
    // Localhost-callback flow: a local server captures the redirect (a laptop
    // script tunnels the port), so there is no code paste and no TTY needed.
    const loginViaCallback = deps.loginViaCallback ?? loginAnthropicViaCallback;
    creds = await loginViaCallback({
      callbackPort: opts.callbackPort,
      bindHost: opts.bindHost,
      onAuthUrl: (url) => {
        runtime.log("");
        runtime.log("Open this URL in a browser to authorize OpenClaw with your Claude account.");
        runtime.log("");
        runtime.log(url);
        runtime.log("");
        runtime.log("Waiting for the authorization redirect...");
      },
    });
  } else {
    // Paste flow: pi-ai prints the URL and we prompt for the code Anthropic shows.
    if (!deps.login && !process.stdin.isTTY) {
      throw new Error(
        "mint-anthropic requires an interactive TTY (run it over `ssh -t`), or pass --callback-port.",
      );
    }
    const login = deps.login ?? loginAnthropic;
    const promptCode = deps.promptCode ?? defaultPromptCode;
    creds = await login((url) => {
      runtime.log("");
      runtime.log("Open this URL in any browser to authorize OpenClaw with your Claude account.");
      runtime.log("");
      runtime.log(`  ${url}`);
      runtime.log("");
      runtime.log('After approving, Anthropic shows a code like "abc123#xyz". Paste it below.');
    }, promptCode);
  }

  const profile = buildAnthropicSubscriptionProfile(creds);
  const authPath = await writeAnthropicProfile({ agentDir: targetDir, profile });

  runtime.log("");
  runtime.log(`Wrote profile "${ANTHROPIC_SUBSCRIPTION_PROFILE_ID}" to "${authPath}".`);
  runtime.log(`Token expires ${new Date(creds.expires).toISOString()}.`);
}
