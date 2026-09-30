/**
 * Router-side client for the host provisioning daemon.
 *
 * The router runs in a sandboxed container with the instances directory mounted
 * read-only and no Docker access, so it cannot create instances or start agent
 * containers itself. Those privileged operations live in a small daemon on the
 * host (see discord-provisioner/). This client talks to it over loopback
 * (the router is network_mode: host) with a shared bearer token.
 */

import type { ProvisioningClient, ProvisioningResult } from "./channel-commands.js";

/** Wire shapes shared with the daemon. */
export type RegisterRequest = { channelId: string; ownerId: string; isDM: boolean };
export type UnregisterRequest = { channelId: string };
export type ProvisionResponse = { ok: boolean; message: string };

/** A Discord snowflake (channel/user id). */
export function isSnowflake(id: string): boolean {
  return /^\d{17,20}$/.test(id);
}

export function createHttpProvisioningClient(opts: {
  /** e.g. http://127.0.0.1:18810 */
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): ProvisioningClient {
  const doFetch = opts.fetchImpl ?? fetch;

  async function call(path: string, body: unknown): Promise<ProvisioningResult> {
    try {
      const resp = await doFetch(`${opts.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify(body),
      });
      const data = (await resp.json().catch(() => ({}))) as Partial<ProvisionResponse>;
      const message =
        typeof data.message === "string" && data.message
          ? data.message
          : resp.ok
            ? "Done."
            : `Provisioning failed (${resp.status}).`;
      return { ok: resp.ok && data.ok !== false, message };
    } catch (err) {
      opts.log?.(`[provisioning] ${path} failed: ${String(err)}`);
      return { ok: false, message: "Could not reach the provisioning service." };
    }
  }

  return {
    register: (params) =>
      call("/register", {
        channelId: params.channelId,
        ownerId: params.ownerId,
        isDM: params.isDM,
      } satisfies RegisterRequest),
    unregister: (params) =>
      call("/unregister", { channelId: params.channelId } satisfies UnregisterRequest),
  };
}
