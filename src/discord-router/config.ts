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

export type PortRegistry = {
  basePort: number;
  assignments: Record<string, number>; // channelId → port
};

export type RouterConfig = {
  discordToken: string;
  instances: Map<string, InstanceConfig>; // keyed by channelId
  instancesDir: string;
  agentTimeoutMs: number;
};

/**
 * Load router configuration by scanning the instances directory.
 * Each instance directory is named by Discord channel ID and contains
 * an openclaw.json with gateway config. Ports are read from ports.json.
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

  // Read port registry
  const portsPath = path.join(instancesDir, "ports.json");
  let portRegistry: PortRegistry = { basePort: 18789, assignments: {} };
  if (fs.existsSync(portsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(portsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && typeof parsed.basePort === "number") {
        portRegistry = {
          basePort: parsed.basePort,
          assignments:
            parsed.assignments && typeof parsed.assignments === "object"
              ? (parsed.assignments as Record<string, number>)
              : {},
        };
      }
    } catch {
      // Fall through with defaults
    }
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

    // Port must be in the registry — if missing, skip this instance
    const port = portRegistry.assignments[channelId];
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

/** Read the port registry from disk. */
export function readPortRegistry(instancesDir: string): PortRegistry {
  const portsPath = path.join(instancesDir, "ports.json");
  if (fs.existsSync(portsPath)) {
    try {
      return JSON.parse(fs.readFileSync(portsPath, "utf-8"));
    } catch {
      // Fall through
    }
  }
  return { basePort: 18789, assignments: {} };
}

/** Write the port registry to disk. */
export function writePortRegistry(instancesDir: string, registry: PortRegistry): void {
  const portsPath = path.join(instancesDir, "ports.json");
  fs.writeFileSync(portsPath, JSON.stringify(registry, null, 2) + "\n");
}

/** Allocate the next available port for a new channel. */
export function allocatePort(registry: PortRegistry): number {
  const usedPorts = new Set(Object.values(registry.assignments));
  let port = registry.basePort;
  while (usedPorts.has(port)) {
    port++;
  }
  return port;
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
