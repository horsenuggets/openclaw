/**
 * Lightweight gateway WebSocket call for the discord-router.
 * No config loading, TLS, tailnet, or device identity — just a direct
 * WebSocket JSON-RPC call to a local container.
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
 * Connect to a gateway container via WebSocket, authenticate, send a
 * JSON-RPC request, and wait for the final response.
 */
export async function callGatewaySimple<T = AgentResult>(opts: CallGatewayOpts): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const requestId = randomUUID();

    const stop = (err?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (err) reject(err);
      else resolve(value as T);
    };

    const ws = new WebSocket(opts.url);

    ws.on("open", () => {
      // Send hello with auth
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "hello",
          params: {
            clientName: "cli",
            clientVersion: "router",
            mode: "backend",
            protocolVersion: 1,
            ...(opts.token ? { token: opts.token } : {}),
          },
          id: randomUUID(),
        }),
      );
    });

    ws.on("message", (raw: Buffer) => {
      if (settled) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Handle hello response — send the actual request
      if (
        msg.id &&
        msg.result &&
        typeof msg.result === "object" &&
        "ok" in (msg.result as object)
      ) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: opts.method,
            params: opts.params ?? {},
            id: requestId,
          }),
        );
        return;
      }

      // Handle final response
      if (msg.id === requestId && msg.result !== undefined) {
        stop(undefined, msg.result as T);
        return;
      }

      // Handle error
      if (msg.id === requestId && msg.error) {
        const err = msg.error as { message?: string; data?: string };
        stop(new Error(err.message ?? err.data ?? "gateway error"));
        return;
      }

      // Handle streaming notifications — ignore (wait for final)
      if (opts.expectFinal && !msg.id && msg.method) {
        return;
      }
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
