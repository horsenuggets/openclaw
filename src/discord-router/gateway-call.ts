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
    payloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
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
      ws.send(
        JSON.stringify({
          type: "req",
          id: connectId,
          method: "connect",
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: "cli",
              version: "router",
              platform: "linux",
              mode: "backend",
              instanceId: randomUUID(),
            },
            caps: [],
            auth: opts.token ? { token: opts.token } : undefined,
            role: "operator",
            scopes: ["operator.admin"],
          },
        }),
      );
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
