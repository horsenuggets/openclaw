import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterConfig } from "./config.js";

// Fake WebSocket that records every instantiation and lets the test drive
// gateway events. `close()` emits a "close" event asynchronously, mirroring
// the real `ws` module — that async close is what surfaces the double
// reconnect bug (the op-9 handler schedules a reconnect AND the close handler
// schedules another).
type Handler = (...args: unknown[]) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  handlers = new Map<string, Handler[]>();
  sent: unknown[] = [];
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  on(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) {
      cb(...args);
    }
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Real ws closes asynchronously; schedule the close event on a timer so
    // it interleaves with any reconnect the caller also schedules.
    setTimeout(() => this.emit("close", 1000), 0);
  }

  // Drive a gateway HELLO so the router sends its IDENTIFY.
  hello(heartbeatInterval = 45_000): void {
    this.emit(
      "message",
      Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatInterval } })),
    );
  }

  // Drive a gateway INVALID SESSION (op 9).
  invalidSession(): void {
    this.emit("message", Buffer.from(JSON.stringify({ op: 9, d: false })));
  }

  identifyCount(): number {
    return this.sent.filter((raw) => {
      try {
        return JSON.parse(String(raw)).op === 2;
      } catch {
        return false;
      }
    }).length;
  }
}

vi.mock("ws", () => ({ default: FakeWebSocket }));
vi.mock("./oauth-callback.js", () => ({
  startOAuthCallbackServer: () => ({ close: () => {} }),
}));

const { startRouter } = await import("./router.js");

function makeConfig(): RouterConfig {
  return {
    discordToken: "test-token",
    instances: new Map(),
    instancesDir: "/tmp/does-not-matter",
    agentTimeoutMs: 1000,
  };
}

describe("discord router reconnect", () => {
  let logs: string[];
  let runtime: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    logs = [];
    runtime = {
      log: (...args) => logs.push(args.join(" ")),
      error: (...args) => logs.push(args.join(" ")),
    };
    vi.useFakeTimers();
    // App id resolution + slash command registration.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => ({ id: "app-123" }) })) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("spawns exactly one new socket per invalid session", async () => {
    void startRouter(makeConfig(), runtime);

    // Let the top-of-function awaits (fetch app id, register commands) settle
    // so the first connect() runs and creates socket #0.
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    const first = FakeWebSocket.instances[0];
    first.emit("open");
    first.hello();
    expect(first.identifyCount()).toBe(1);

    // Discord rejects the identify. A correct implementation schedules exactly
    // one reconnect; the bug schedules two (op-9 handler + close handler).
    first.invalidSession();

    // Flush the close event and all reconnect timers.
    await vi.advanceTimersByTimeAsync(10_000);

    const scheduleLogs = logs.filter((l) => l.includes("scheduling reconnect"));
    const spawnedAfterFirst = FakeWebSocket.instances.length - 1;

    expect(scheduleLogs).toHaveLength(1);
    expect(spawnedAfterFirst).toBe(1);
  });

  it("never runs two sockets concurrently across repeated invalid sessions", async () => {
    void startRouter(makeConfig(), runtime);
    await vi.advanceTimersByTimeAsync(0);

    const openSocketCount = () => FakeWebSocket.instances.filter((ws) => !ws.closed).length;
    let peak = 0;

    // Drive several reject cycles; after each, at most one socket should be
    // open and each cycle should add exactly one new socket.
    for (let round = 0; round < 5; round++) {
      const ws = FakeWebSocket.instances.find((s) => !s.closed);
      expect(ws).toBeDefined();
      ws!.emit("open");
      ws!.hello();
      expect(ws!.identifyCount()).toBe(1);
      ws!.invalidSession();
      // Flush close + backoff (capped at 30s) so the next socket opens.
      await vi.advanceTimersByTimeAsync(30_000);
      peak = Math.max(peak, openSocketCount());
    }

    expect(peak).toBe(1);
    // 1 initial + 5 reconnects = 6 total sockets, never doubling.
    expect(FakeWebSocket.instances).toHaveLength(6);
  });
});
