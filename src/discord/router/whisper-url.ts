import { DEFAULT_WHISPER_PORT } from "../../config/port-defaults.js";

/**
 * Resolve the whisper transcription endpoint the router POSTs audio to.
 *
 * Precedence:
 *   1. OPENCLAW_WHISPER_URL  - full endpoint override (used as-is)
 *   2. OPENCLAW_WHISPER_PORT - loopback port override (numeric)
 *   3. DEFAULT_WHISPER_PORT  - shared built-in default
 *
 * On prod, boot.sh binds the whisper server to WHISPER_PORT and passes the same
 * value to the router as OPENCLAW_WHISPER_PORT, so server and client always
 * agree on the port from a single source.
 */
export function resolveWhisperUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicitUrl = env.OPENCLAW_WHISPER_URL?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }
  const port = resolveWhisperPort(env.OPENCLAW_WHISPER_PORT);
  return `http://127.0.0.1:${port}/inference`;
}

function resolveWhisperPort(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (trimmed && /^[0-9]+$/.test(trimmed)) {
    const port = Number(trimmed);
    if (port > 0 && port <= 65535) {
      return port;
    }
  }
  return DEFAULT_WHISPER_PORT;
}
