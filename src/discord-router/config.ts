import fs from "node:fs";
import path from "node:path";

export type OnboardingState = "none" | "greeted" | "named" | "google_pending" | "complete";

export type UserPreferences = {
  /** Show "Back online." / "Shutting down..." lifecycle messages. Default: false. */
  lifecycleMessages?: boolean;
};

export type InstanceConfig = {
  port: number;
  token: string;
  onboarded: boolean;
  onboardingState: OnboardingState;
  preferences: UserPreferences;
  configPath: string;
  instanceDir: string;
};

export type RouterConfig = {
  discordToken: string;
  instances: Map<string, InstanceConfig>;
  instancesDir: string;
  agentTimeoutMs: number;
};

/**
 * Load router configuration by scanning the instances directory.
 * Each instance directory is named by Discord user ID and contains
 * an openclaw.json with gateway config.
 */
export function loadRouterConfig(opts: {
  instancesDir?: string;
  discordToken?: string;
  basePort?: number;
}): RouterConfig {
  const instancesDir =
    opts.instancesDir ??
    process.env.OPENCLAW_INSTANCES_DIR ??
    path.join(process.env.HOME ?? "/root", ".openclaw-instances");

  const discordToken =
    opts.discordToken ?? process.env.DISCORD_BOT_TOKEN ?? process.env.OPENCLAW_DISCORD_TOKEN;
  if (!discordToken) {
    throw new Error("Discord bot token required. Set DISCORD_BOT_TOKEN or pass --discord-token.");
  }

  const instances = new Map<string, InstanceConfig>();
  const basePort = opts.basePort ?? 18789;
  const DISCORD_ID_RE = /^\d{17,20}$/;

  if (!fs.existsSync(instancesDir)) {
    throw new Error(`Instances directory not found: ${instancesDir}`);
  }

  const entries = fs.readdirSync(instancesDir, { withFileTypes: true });
  let portOffset = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !DISCORD_ID_RE.test(entry.name)) {
      continue;
    }
    const discordUserId = entry.name;
    const configPath = path.join(instancesDir, discordUserId, "openclaw.json");

    let gatewayToken = "";
    let onboarded = false;
    // Each instance gets a unique host port: base, base+2, base+4, ...
    // This matches the Docker Compose port mapping pattern.
    let port = basePort + portOffset * 2;

    if (fs.existsSync(configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        gatewayToken = raw?.gateway?.auth?.token ?? "";
        // Don't read port from instance config — that's the container-internal
        // port (always 18789). The host-mapped port is computed from the offset.
      } catch {
        // Fall through with defaults
      }
    }

    // Onboarding state stored in a separate file (not openclaw.json which has schema validation)
    const onboardingPath = path.join(instancesDir, discordUserId, ".onboarding.json");
    let onboardingState: OnboardingState = "none";
    let preferences: UserPreferences = {};
    if (fs.existsSync(onboardingPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(onboardingPath, "utf-8"));
        onboardingState = raw?.state ?? "none";
        preferences = raw?.preferences ?? {};
      } catch {
        onboardingState = "none";
      }
    }
    // Legacy: check old .onboarded flag file
    const legacyOnboardedPath = path.join(instancesDir, discordUserId, ".onboarded");
    if (onboardingState === "none" && fs.existsSync(legacyOnboardedPath)) {
      onboardingState = "complete";
    }
    onboarded = onboardingState === "complete";

    // Env vars override computed values
    const envToken = process.env[`OPENCLAW_${discordUserId}_TOKEN`];
    const envPort = process.env[`OPENCLAW_${discordUserId}_PORT`];
    if (envToken) {
      gatewayToken = envToken;
    }
    if (envPort) {
      port = Number(envPort);
    }

    const instanceDir = path.join(instancesDir, discordUserId);
    instances.set(discordUserId, {
      port,
      token: gatewayToken,
      onboarded,
      onboardingState,
      preferences,
      configPath,
      instanceDir,
    });
    portOffset++;
  }

  return {
    discordToken,
    instances,
    instancesDir,
    agentTimeoutMs: 600_000,
  };
}

/** Read the full onboarding file (state + preferences). */
function readOnboardingFile(instance: InstanceConfig): Record<string, unknown> {
  try {
    const onboardingPath = path.join(instance.instanceDir, ".onboarding.json");
    return JSON.parse(fs.readFileSync(onboardingPath, "utf-8"));
  } catch {
    return {};
  }
}

/** Write the onboarding file preserving all fields. */
function writeOnboardingFile(instance: InstanceConfig, data: Record<string, unknown>): void {
  const onboardingPath = path.join(instance.instanceDir, ".onboarding.json");
  fs.writeFileSync(onboardingPath, JSON.stringify(data, null, 2));
}

/** Update onboarding state for an instance. */
export function setOnboardingState(instance: InstanceConfig, state: OnboardingState): void {
  try {
    const existing = readOnboardingFile(instance);
    existing.state = state;
    existing.updatedAt = new Date().toISOString();
    writeOnboardingFile(instance, existing);
    instance.onboardingState = state;
    instance.onboarded = state === "complete";
  } catch {
    // Best effort
  }
}

/** Update a user preference. */
export function setUserPreference(
  instance: InstanceConfig,
  key: keyof UserPreferences,
  value: boolean,
): void {
  try {
    const existing = readOnboardingFile(instance);
    const raw = existing.preferences;
    const prefs: UserPreferences =
      raw != null && typeof raw === "object" && !Array.isArray(raw) ? (raw as UserPreferences) : {};
    prefs[key] = value;
    existing.preferences = prefs;
    writeOnboardingFile(instance, existing);
    instance.preferences = prefs;
  } catch {
    // Best effort
  }
}

/** Legacy alias */
export function markOnboarded(instance: InstanceConfig): void {
  setOnboardingState(instance, "complete");
}

/**
 * Re-read the gateway token from disk. Called before each connection
 * so the router never uses a stale cached token after container restarts.
 */
export function refreshToken(instance: InstanceConfig): string {
  try {
    const raw = JSON.parse(fs.readFileSync(instance.configPath, "utf-8"));
    const token = raw?.gateway?.auth?.token ?? "";
    if (token && token !== instance.token) {
      instance.token = token;
    }
    return instance.token;
  } catch {
    return instance.token;
  }
}
