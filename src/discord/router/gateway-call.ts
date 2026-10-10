/**
 * Lightweight gateway WebSocket call for the discord-router.
 * Uses the OpenClaw gateway wire protocol (not JSON-RPC).
 * No config loading, TLS, tailnet, or device identity.
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

type AgentResult = {
  runId: string;
  status: string;
  result?: {
    // `isError` is set by the agent run on an error reply (e.g. a model/API
    // failure formatted by errors.ts), so the router can render it as a Log
    // embed instead of plain text.
    payloads?: Array<{
      text?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      isError?: boolean;
    }>;
    // Set by the agent run when the model deliberately emitted the silent-reply
    // token, so the router can treat an empty result as an intentional no-op.
    meta?: { silent?: boolean };
  };
};

export type CallGatewayOpts = {
  url: string;
  token?: string;
  method: string;
  params?: Record<string, unknown>;
  expectFinal?: boolean;
  timeoutMs?: number;
};

/** Build the OpenClaw gateway `connect` handshake request (protocol v3). */
function buildConnectRequest(connectId: string, version: string, token?: string): string {
  return JSON.stringify({
    type: "req",
    id: connectId,
    method: "connect",
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "cli",
        version,
        platform: "linux",
        mode: "backend",
        instanceId: randomUUID(),
      },
      caps: [],
      auth: token ? { token } : undefined,
      role: "operator",
      scopes: ["operator.admin"],
    },
  });
}

/**
 * Readiness probe for the onboarding kick. A bare TCP connect (`probePort`) can
 * report ready before the agent gateway's WebSocket upgrade handler is actually
 * serving: a freshly created container binds its TCP listener first, so the
 * socket accepts and is then reset ("Connection ended") when the real routed
 * turn runs. This opens a ws and sends the gateway `connect` handshake; any
 * response to it (even an auth rejection) proves the ws handler is serving and
 * can accept the real, tokened turn. Only a connection-level failure (reset,
 * close, or timeout before any response) counts as not-ready. The probe is
 * deliberately tokenless: it tests reachability, not authorization.
 */
export function probeGatewayReady(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const connectId = randomUUID();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const done = (ready: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(ready);
    };
    ws.on("open", () => ws.send(buildConnectRequest(connectId, "router-probe")));
    ws.on("message", (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // Any response to our connect (ok or an auth error) means the gateway is
      // serving the protocol, so the real tokened turn can proceed.
      if (msg.type === "res" && msg.id === connectId) {
        done(true);
      }
    });
    ws.on("error", () => done(false));
    ws.on("close", () => done(false));
    const timer = setTimeout(() => done(false), timeoutMs);
  });
}

/**
 * Connect to a gateway container via WebSocket, send a connect handshake,
 * then send the actual request and wait for the final response.
 */
export async function callGatewaySimple<T = AgentResult>(opts: CallGatewayOpts): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const connectId = randomUUID();
    const requestId = randomUUID();

    const stop = (err?: Error, value?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (err) {
        reject(err);
      } else {
        resolve(value as T);
      }
    };

    const ws = new WebSocket(opts.url);

    ws.on("open", () => {
      // Send connect handshake (OpenClaw gateway protocol)
      ws.send(buildConnectRequest(connectId, "router", opts.token));
    });

    ws.on("message", (raw: Buffer) => {
      if (settled) {
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const msgType = msg.type as string | undefined;
      const msgId = msg.id as string | undefined;

      // Handle connect response — send the actual request
      if (msgType === "res" && msgId === connectId && msg.ok !== false) {
        ws.send(
          JSON.stringify({
            type: "req",
            id: requestId,
            method: opts.method,
            params: opts.params ?? {},
          }),
        );
        return;
      }

      // Handle connect error
      if (msgType === "res" && msgId === connectId && msg.ok === false) {
        const err = msg.error as { message?: string } | undefined;
        stop(new Error(`gateway connect failed: ${err?.message ?? "unknown error"}`));
        return;
      }

      // Handle response to our request
      if (msgType === "res" && msgId === requestId) {
        if (msg.ok === false) {
          const err = msg.error as { message?: string } | undefined;
          stop(new Error(err?.message ?? "gateway request failed"));
          return;
        }
        // If expectFinal, skip "accepted" acks and wait for the final result
        const payload = msg.payload as { status?: string } | undefined;
        if (opts.expectFinal && payload?.status === "accepted") {
          return; // keep waiting
        }
        stop(undefined, msg.payload as T);
        return;
      }

      // Ignore streaming notifications (type: "event", etc.) — wait for final "res"
    });

    ws.on("error", (err: Error) => {
      stop(new Error(`gateway connection failed: ${err.message}`));
    });

    ws.on("close", (code: number, reason: Buffer) => {
      if (!settled) {
        stop(new Error(`gateway closed (${code}): ${reason?.toString() || "no reason"}`));
      }
    });

    const timer = setTimeout(() => {
      stop(new Error(`gateway timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}
