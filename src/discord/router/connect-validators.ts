import type { AuthResult } from "./connector-auth.js";

/**
 * Live token validation for the paste-token connectors. Each hits a cheap
 * "who am I" endpoint to confirm the token works and to grab a friendly account
 * label. These are the `validate` closures composed into each connector's
 * `PasteTokenAuth` (see connectors.ts); that class owns the input guard and the
 * network-error handling, so these stay focused on the single request. Kept out
 * of the command handler so it never touches the network and stays testable.
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

export async function validateTodoist(token: string): Promise<AuthResult> {
  // Todoist has no cheap identity endpoint; a projects fetch confirms the token.
  // Uses the unified v1 API (`/api/v1/projects`); the older `/rest/v2/projects`
  // has been sunset, so a valid token would otherwise fail validation here.
  const resp = await fetchWithTimeout("https://api.todoist.com/api/v1/projects", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    return { ok: false, message: `Todoist returned ${resp.status}` };
  }
  return { ok: true };
}

export async function validateNotion(token: string): Promise<AuthResult> {
  const resp = await fetchWithTimeout("https://api.notion.com/v1/users/me", {
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" },
  });
  if (!resp.ok) {
    return { ok: false, message: `Notion returned ${resp.status}` };
  }
  const body = (await resp.json().catch(() => null)) as { name?: string } | null;
  return { ok: true, ...(body?.name ? { accountLabel: body.name } : {}) };
}

export async function validateGithub(token: string): Promise<AuthResult> {
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
