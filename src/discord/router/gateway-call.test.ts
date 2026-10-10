import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { probeGatewayReady } from "./gateway-call.js";

let servers: WebSocketServer[] = [];

function startServer(onConnection: (ws: import("ws").WebSocket) => void): Promise<number> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      resolve((wss.address() as AddressInfo).port);
    });
    wss.on("connection", onConnection);
    servers.push(wss);
  });
}

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

describe("probeGatewayReady", () => {
  // A gateway that completes the connect handshake is genuinely serving, so the
  // probe reports ready.
  it("returns true when the connect handshake succeeds", async () => {
    const port = await startServer((ws) => {
      ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.method === "connect") {
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true }));
        }
      });
    });
    expect(await probeGatewayReady(port, 1000)).toBe(true);
  });

  // The probe is tokenless, so the gateway may reject the connect with ok:false.
  // That response still proves the ws handler is serving, so it counts as ready
  // (the real routed turn carries a token).
  it("returns true when the gateway rejects the tokenless connect", async () => {
    const port = await startServer((ws) => {
      ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.method === "connect") {
          ws.send(
            JSON.stringify({
              type: "res",
              id: msg.id,
              ok: false,
              error: { message: "unauthorized" },
            }),
          );
        }
      });
    });
    expect(await probeGatewayReady(port, 1000)).toBe(true);
  });

  // The cold-start case: the ws socket accepts and is immediately dropped, which
  // a bare TCP probe would miss but this handshake probe catches.
  it("returns false when the socket is dropped before the handshake completes", async () => {
    const port = await startServer((ws) => ws.close());
    expect(await probeGatewayReady(port, 1000)).toBe(false);
  });

  // Nothing listening at all (ECONNREFUSED) is not ready.
  it("returns false when nothing is listening", async () => {
    // Port 1 is privileged and unused in test envs, so the connect is refused.
    expect(await probeGatewayReady(1, 1000)).toBe(false);
  });
});
