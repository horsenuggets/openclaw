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
  invalidSession(canResume = false): void {
    this.emit("message", Buffer.from(JSON.stringify({ op: 9, d: canResume })));
  }

  // Drive a gateway RECONNECT request (op 7).
  reconnectRequest(): void {
    this.emit("message", Buffer.from(JSON.stringify({ op: 7, d: null })));
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

  resumeCount(): number {
    return this.sent.filter((raw) => {
      try {
        return JSON.parse(String(raw)).op === 6;
      } catch {
        return false;
      }
    }).length;
  }

  ready(sessionId = "session-1", resumeGatewayUrl = "wss://gateway.discord.gg"): void {
    this.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          op: 0,
          t: "READY",
          s: 1,
          d: { session_id: sessionId, resume_gateway_url: resumeGatewayUrl, user: { id: "bot-1" } },
        }),
      ),
    );
  }
}

vi.mock("ws", () => ({ default: FakeWebSocket }));
const proxyServerClose = vi.fn((callback?: (err?: Error) => void) => callback?.());
vi.mock("./container-proxy.js", () => ({
  startContainerProxyServer: () => ({
    server: { close: proxyServerClose },
  }),
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
  let startedRouters: Promise<void>[];
  let signalHandlers: Map<"SIGINT" | "SIGTERM", () => void>;

  const invokeRouterShutdown = () => {
    signalHandlers.get("SIGTERM")?.();
    signalHandlers.get("SIGINT")?.();
    signalHandlers.clear();
  };

  const startTestRouter = () => {
    const routerPromise = startRouter(makeConfig(), runtime);
    startedRouters.push(routerPromise);
    return routerPromise;
  };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    proxyServerClose.mockClear();
    logs = [];
    startedRouters = [];
    signalHandlers = new Map();
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
    const realProcessOnce = process.once.bind(process);
    vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers.set(event, listener);
        return process;
      }
      return realProcessOnce(event as never, listener as never);
    }) as typeof process.once);
  });

  afterEach(async () => {
    if (startedRouters.length > 0) {
      await vi.advanceTimersByTimeAsync(0);
      invokeRouterShutdown();
    }
    // Wait for each started router to run its shutdown path so process.once
    // listeners are consumed between tests instead of accumulating.
    await Promise.allSettled(startedRouters);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    startedRouters = [];
  });

  it("spawns exactly one new socket per invalid session", async () => {
    void startTestRouter();

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
    void startTestRouter();
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

  it("never schedules a reconnect below Discord's 5s IDENTIFY floor", async () => {
    void startTestRouter();
    await vi.advanceTimersByTimeAsync(0);

    // Drive a few reject cycles and capture every scheduled backoff delay.
    for (let round = 0; round < 4; round++) {
      const ws = FakeWebSocket.instances.find((s) => !s.closed);
      expect(ws).toBeDefined();
      ws!.emit("open");
      ws!.hello();
      ws!.invalidSession();
      await vi.advanceTimersByTimeAsync(30_000);
    }

    const delays = logs
      .filter((l) => l.includes("scheduling reconnect"))
      .map((l) => {
        const match = l.match(/in (\d+)ms/);
        return match ? Number(match[1]) : Number.NaN;
      });

    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) {
      // Floor is 5s (Discord allows one IDENTIFY per 5s); jitter is additive.
      expect(delay).toBeGreaterThanOrEqual(5_000);
      // Cap is 30s.
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  it("preserves resumable invalid sessions and resumes instead of re-identifying", async () => {
    void startTestRouter();
    await vi.advanceTimersByTimeAsync(0);

    const first = FakeWebSocket.instances[0];
    first.emit("open");
    first.hello();
    expect(first.identifyCount()).toBe(1);
    first.ready();
    first.invalidSession(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = FakeWebSocket.instances[1];
    second.emit("open");
    second.hello();
    expect(second.resumeCount()).toBe(1);
    expect(second.identifyCount()).toBe(0);
  });

  it("op 7 reconnect request opens exactly one replacement socket that resumes", async () => {
    void startTestRouter();
    await vi.advanceTimersByTimeAsync(0);

    const first = FakeWebSocket.instances[0];
    first.emit("open");
    first.hello();
    expect(first.identifyCount()).toBe(1);
    // Establish a session so the op 7 reconnect is resumable.
    first.ready();

    // Discord asks us to reconnect. A correct implementation schedules exactly
    // one reconnect (only the close handler); the original bug scheduled two.
    first.reconnectRequest();
    await vi.advanceTimersByTimeAsync(30_000);

    // Exactly one replacement socket, never doubling.
    expect(FakeWebSocket.instances).toHaveLength(2);
    const scheduleLogs = logs.filter((l) => l.includes("scheduling reconnect"));
    expect(scheduleLogs).toHaveLength(1);

    // The replacement resumes (op 6) rather than re-identifying (op 2), since
    // op 7 preserves the session.
    const second = FakeWebSocket.instances[1];
    second.emit("open");
    second.hello();
    expect(second.resumeCount()).toBe(1);
    expect(second.identifyCount()).toBe(0);
  });

  it("ignores stale closes without stopping the current heartbeat", async () => {
    void startTestRouter();
    await vi.advanceTimersByTimeAsync(0);

    const first = FakeWebSocket.instances[0];
    first.emit("open");
    first.hello(100);
    first.invalidSession();

    await vi.advanceTimersByTimeAsync(10_000);

    const second = FakeWebSocket.instances[1];
    second.emit("open");
    second.hello(100);

    const before = second.sent.length;
    first.emit("close", 1000);
    await vi.advanceTimersByTimeAsync(250);

    expect(second.sent.length).toBeGreaterThan(before);
  });

  it("does not reconnect after shutdown begins", async () => {
    const routerPromise = startTestRouter();
    await vi.advanceTimersByTimeAsync(0);

    const first = FakeWebSocket.instances[0];
    first.emit("open");
    first.hello();
    first.invalidSession();

    await vi.advanceTimersByTimeAsync(0);
    invokeRouterShutdown();
    await routerPromise;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("shutdown closes the active socket, heartbeat, and oauth callback server", async () => {
    const routerPromise = startTestRouter();
    await vi.advanceTimersByTimeAsync(0);

    const first = FakeWebSocket.instances[0];
    first.emit("open");
    first.hello(100);
    const beforeShutdownHeartbeats = first.sent.length;

    invokeRouterShutdown();
    await routerPromise;
    await vi.advanceTimersByTimeAsync(500);

    expect(first.closed).toBe(true);
    expect(first.sent.length).toBe(beforeShutdownHeartbeats);
    expect(proxyServerClose).toHaveBeenCalledTimes(1);
  });
});
