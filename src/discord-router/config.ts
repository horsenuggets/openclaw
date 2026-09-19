import fs from "node:fs";
import path from "node:path";

export type OnboardingState = "none" | "greeted" | "named" | "google_pending" | "complete";

export type UserPreferences = {
  /** Show "Back online." / "Shutting down..." lifecycle messages. Default: false. */
  lifecycleMessages?: boolean;
};

export type InstanceConfig = {
  channelId: string;
  port: number;
  token: string;
  onboarded: boolean;
  onboardingState: OnboardingState;
  preferences: UserPreferences;
  configPath: string;
  instanceDir: string;
};

/**
 * Filename of the per-instance port file. Each instance directory owns its
 * port as a plain-integer dotfile (e.g. `.openclaw-instances/<id>/.port`),
 * so the port travels with the instance and cannot drift from a central
 * registry.
 */
export const PORT_FILENAME = ".port";

export type RouterConfig = {
  discordToken: string;
  instances: Map<string, InstanceConfig>; // keyed by channelId
  instancesDir: string;
  agentTimeoutMs: number;
};

/**
 * Read an instance's port from its `.port` dotfile. Returns undefined when
 * the file is missing or does not contain a positive integer.
 */
export function readInstancePort(instanceDir: string): number | undefined {
  const portPath = path.join(instanceDir, PORT_FILENAME);
  if (!fs.existsSync(portPath)) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(portPath, "utf-8").trim();
    // Require the entire value to be a positive integer. `parseInt` would
    // accept malformed prefixes like "18789junk"; the boot script and
    // `openclawctl list` use Python's strict int() and would skip such a
    // file, so the router must reject it too to avoid loading an instance
    // that boot never starts.
    if (!/^\d+$/.test(raw)) {
      return undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load router configuration by scanning the instances directory.
 * Each instance directory is named by Discord channel ID and contains an
 * openclaw.json with gateway config plus a `.port` dotfile with its port.
 */
export function loadRouterConfig(opts: {
  instancesDir?: string;
  discordToken?: string;
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

  if (!fs.existsSync(instancesDir)) {
    throw new Error(`Instances directory not found: ${instancesDir}`);
  }

  const instances = new Map<string, InstanceConfig>();
  const DISCORD_ID_RE = /^\d{17,20}$/;

  const entries = fs.readdirSync(instancesDir, { withFileTypes: true });
  const sortedEntries = entries
    .filter((e) => e.isDirectory() && DISCORD_ID_RE.test(e.name))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  for (const entry of sortedEntries) {
    const channelId = entry.name;
    const instanceDir = path.join(instancesDir, channelId);
    const configPath = path.join(instanceDir, "openclaw.json");

    // Each instance owns its port via a `.port` dotfile — no port, no route.
    const port = readInstancePort(instanceDir);
    if (port === undefined) {
      continue;
    }

    let gatewayToken = "";
    if (fs.existsSync(configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        gatewayToken = raw?.gateway?.auth?.token ?? "";
      } catch {
        // Fall through with defaults
      }
    }

    // Onboarding state
    const onboardingPath = path.join(instanceDir, ".onboarding.json");
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
    const legacyOnboardedPath = path.join(instanceDir, ".onboarded");
    if (onboardingState === "none" && fs.existsSync(legacyOnboardedPath)) {
      onboardingState = "complete";
    }

    // Env var overrides
    const envToken = process.env[`OPENCLAW_${channelId}_TOKEN`];
    const envPort = process.env[`OPENCLAW_${channelId}_PORT`];
    if (envToken) {
      gatewayToken = envToken;
    }

    instances.set(channelId, {
      channelId,
      port: envPort && Number.isFinite(Number(envPort)) ? Number(envPort) : port,
      token: gatewayToken,
      onboarded: onboardingState === "complete",
      onboardingState,
      preferences,
      configPath,
      instanceDir,
    });
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
