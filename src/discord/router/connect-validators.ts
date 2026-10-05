import type { TokenValidation } from "./connect-commands.js";

/**
 * Live token validation for paste-token connectors. Each hits a cheap "who am I"
 * endpoint to confirm the token works and to grab a friendly account label. Kept
 * separate from the command handler so the handler stays pure and testable; the
 * router injects this as `validateToken`.
 */

const VALIDATION_TIMEOUT_MS = 10_000;

/** Fetch with a hard timeout so a hung endpoint cannot stall the command. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function validateTodoist(token: string): Promise<TokenValidation> {
  // Todoist has no cheap identity endpoint; a projects fetch confirms the token.
  const resp = await fetchWithTimeout("https://api.todoist.com/rest/v2/projects", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    return { ok: false, message: `Todoist returned ${resp.status}` };
  }
  return { ok: true };
}

async function validateNotion(token: string): Promise<TokenValidation> {
  const resp = await fetchWithTimeout("https://api.notion.com/v1/users/me", {
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
  });
  if (!resp.ok) {
    return { ok: false, message: `Notion returned ${resp.status}` };
  }
  const body = (await resp.json().catch(() => null)) as {
    bot?: { owner?: unknown };
    name?: string;
  } | null;
  return { ok: true, ...(body?.name ? { accountLabel: body.name } : {}) };
}

async function validateGithub(token: string): Promise<TokenValidation> {
  const resp = await fetchWithTimeout("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "openclaw-connections",
    },
  });
  if (!resp.ok) {
    return { ok: false, message: `GitHub returned ${resp.status}` };
  }
  const body = (await resp.json().catch(() => null)) as { login?: string } | null;
  return { ok: true, ...(body?.login ? { accountLabel: body.login } : {}) };
}

/** Validate a pasted token for a connector. Unknown connectors pass through unchecked. */
export async function validateConnectorToken(
  connectorId: string,
  token: string,
): Promise<TokenValidation> {
  try {
    switch (connectorId) {
      case "todoist":
        return await validateTodoist(token);
      case "notion":
        return await validateNotion(token);
      case "github":
        return await validateGithub(token);
      default:
        return { ok: true };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "network error" };
  }
}
