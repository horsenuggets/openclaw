/**
 * Pure helpers for composing the health-monitor's lifecycle banners. Kept free
 * of process/IO so they can be unit-tested: entry.ts gathers the live runtime
 * values (uptime, memory, pid, ...) and passes them in.
 *
 * A banner is a static lead phrase followed by a compact JSON payload of
 * diagnostics. The send side (buildLogEmbed) pretty-prints that JSON into a
 * fenced block, and the router's recovery scan recognizes the lead phrase as a
 * banner (see router-filters.ts LIFECYCLE_BANNER_PREFIXES), so the diagnostics
 * never break recovery.
 */

export type LifecycleEvent = "startup" | "shutdown";

/**
 * Lead phrase per event. These are the prefixes the recovery scan matches, so
 * they must stay in sync with router-filters.ts LIFECYCLE_BANNER_PREFIXES.
 */
export const LIFECYCLE_LEAD: Record<LifecycleEvent, string> = {
  startup: "The agent is starting up...",
  shutdown: "The agent is shutting down...",
};

export type LifecycleInput = {
  event: LifecycleEvent;
  /** Why the event fired: "initial boot", "router restart", or a signal name. */
  reason: string;
  /** Router process id, when known. */
  pid?: number | null;
  /** Health-monitor process uptime, in seconds (reported on shutdown). */
  uptimeSeconds: number;
  /** When the router was last confirmed healthy (epoch ms), or null if never. */
  lastHealthyAt: number | null;
  /** Current time (epoch ms); injected so tests stay deterministic. */
  now: number;
  /** Discord REST round-trip latency in ms, or null if the probe failed. */
  discordApiPingMs?: number | null;
  /** Process memory snapshot, in bytes. */
  memory: { rss: number; heapUsed: number };
};

const BYTE_UNITS = ["B", "KB", "MB", "GB"];

/** Human-readable byte size, e.g. 89_214_976 -> "85.1 MB". */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/** Human-readable duration from seconds, e.g. 3723 -> "1h 2m 3s". */
export function formatDuration(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  const seconds = secs % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join(" ");
}

/**
 * Structured diagnostics payload for a lifecycle banner. Startup reports how long
 * the router was down (null on the initial boot, where there is no prior health);
 * shutdown reports how long it had been up. `pid` and `discordApiPing` are
 * omitted when unknown. Key order is deliberate and preserved through the JSON
 * round-trip the embed formatter performs.
 */
export function buildLifecycleInfo(input: LifecycleInput): Record<string, unknown> {
  const info: Record<string, unknown> = { reason: input.reason };
  if (input.pid != null) {
    info.pid = input.pid;
  }
  if (input.event === "startup") {
    // Downtime is only meaningful across a restart, where the router had been
    // healthy before it died; on the initial boot it is reported as null.
    info.downtime =
      input.lastHealthyAt != null ? formatDuration((input.now - input.lastHealthyAt) / 1000) : null;
  } else {
    info.uptime = formatDuration(input.uptimeSeconds);
  }
  if (input.discordApiPingMs != null) {
    info.discordApiPing = `${input.discordApiPingMs}ms`;
  }
  info.memory = {
    rss: formatBytes(input.memory.rss),
    heapUsed: formatBytes(input.memory.heapUsed),
  };
  return info;
}

/** The full banner string: lead phrase + compact JSON diagnostics. */
export function buildLifecycleMessage(input: LifecycleInput): string {
  const info = buildLifecycleInfo(input);
  return `${LIFECYCLE_LEAD[input.event]} ${JSON.stringify(info)}`;
}
