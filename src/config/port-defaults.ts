export type PortRange = { start: number; end: number };

function isValidPort(port: number): boolean {
  return Number.isFinite(port) && port > 0 && port <= 65535;
}

function clampPort(port: number, fallback: number): number {
  return isValidPort(port) ? port : fallback;
}

function derivePort(base: number, offset: number, fallback: number): number {
  return clampPort(base + offset, fallback);
}

export const DEFAULT_BRIDGE_PORT = 18790;
export const DEFAULT_BROWSER_CONTROL_PORT = 18791;
// Host-wide whisper speech-to-text server, shared by all per-channel agents.
// Sits BELOW the per-agent gateway allocation base (18789): openclawctl hands
// out agent gateway ports ascending from 18789, and each agent derives its
// browser control/relay/canvas/CDP ports upward from its own gateway port
// (relay = gatewayPort + 3, etc.), so the entire 18789+ range is agent
// territory that a fixed shared port must avoid. 18700 is clear of that space
// and of 8787 (the historical default, which collides with RStudio Server and
// OpenClaw's own Telegram webhook default). The prod deploy overrides this via
// the WHISPER_PORT env (see infrastructure/deploy/boot.sh); keep the two values
// in sync.
export const DEFAULT_WHISPER_PORT = 18700;
export const DEFAULT_CANVAS_HOST_PORT = 18793;
export const DEFAULT_BROWSER_CDP_PORT_RANGE_START = 18800;
export const DEFAULT_BROWSER_CDP_PORT_RANGE_END = 18899;

export function deriveDefaultBridgePort(gatewayPort: number): number {
  return derivePort(gatewayPort, 1, DEFAULT_BRIDGE_PORT);
}

export function deriveDefaultBrowserControlPort(gatewayPort: number): number {
  return derivePort(gatewayPort, 2, DEFAULT_BROWSER_CONTROL_PORT);
}

export function deriveDefaultCanvasHostPort(gatewayPort: number): number {
  return derivePort(gatewayPort, 4, DEFAULT_CANVAS_HOST_PORT);
}

export function deriveDefaultBrowserCdpPortRange(browserControlPort: number): PortRange {
  const start = derivePort(browserControlPort, 9, DEFAULT_BROWSER_CDP_PORT_RANGE_START);
  const end = clampPort(
    start + (DEFAULT_BROWSER_CDP_PORT_RANGE_END - DEFAULT_BROWSER_CDP_PORT_RANGE_START),
    DEFAULT_BROWSER_CDP_PORT_RANGE_END,
  );
  if (end < start) {
    return { start, end: start };
  }
  return { start, end };
}
