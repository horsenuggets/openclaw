import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Use high ephemeral ports to avoid conflicts with real services.
const TEST_PORT_A = 49151;
const TEST_PORT_B = 49152;

const CLI_PATH = path.resolve(import.meta.dirname, "cli.mjs");
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BUILDS_DIR = path.join(REPO_ROOT, ".builds");
const STUB_HASH = "__test-stub__";
const STUB_BUILD_DIR = path.join(BUILDS_DIR, STUB_HASH);
const CURRENT_LINK = path.join(BUILDS_DIR, "current");

// Minimal gateway stub that listens on the port and stays alive.
const STUB_ENTRY = `
import { createServer } from "node:http";
const port = parseInt(process.env.OPENCLAW_GATEWAY_PORT || "18789");
const server = createServer((_, res) => res.end("ok"));
server.listen(port, "127.0.0.1", () => {
  console.log(new Date().toISOString() + " [gateway] stub listening on port " + port);
});
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`;

function watchdogLockPath(port: number): string {
  return path.join(os.homedir(), ".openclaw", "watchdog", `port-${port}.lock`);
}

function gatewayLockDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const suffix = uid != null ? `openclaw-${uid}` : "openclaw";
  return path.join(os.tmpdir(), suffix);
}

function cleanupLock(port: number): void {
  try {
    fs.unlinkSync(watchdogLockPath(port));
  } catch {
    // ignore
  }
}

function killPort(port: number): void {
  try {
    const pids = execSync(`lsof -ti tcp:${port}`, { encoding: "utf-8" }).trim();
    for (const pid of pids.split("\n").filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // ignore
      }
    }
  } catch {
    // nothing on port
  }
}

// Ensure a stub build exists so cmdStart doesn't exit immediately.
// The tests verify lock file behavior, not actual gateway startup.
let savedCurrentTarget: string | null = null;

function ensureStubBuild(): void {
  fs.mkdirSync(STUB_BUILD_DIR, { recursive: true });
  fs.writeFileSync(path.join(STUB_BUILD_DIR, "openclaw.mjs"), STUB_ENTRY);

  // Preserve existing "current" symlink if present
  try {
    savedCurrentTarget = fs.readlinkSync(CURRENT_LINK);
  } catch {
    savedCurrentTarget = null;
  }

  // Point current → stub build
  try {
    fs.unlinkSync(CURRENT_LINK);
  } catch {
    // ignore
  }
  fs.symlinkSync(STUB_BUILD_DIR, CURRENT_LINK);
}

function cleanupStubBuild(): void {
  // Restore previous "current" symlink
  try {
    fs.unlinkSync(CURRENT_LINK);
  } catch {
    // ignore
  }
  if (savedCurrentTarget) {
    try {
      fs.symlinkSync(savedCurrentTarget, CURRENT_LINK);
    } catch {
      // ignore
    }
  }

  // Remove stub build directory
  try {
    fs.rmSync(STUB_BUILD_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe("watchdog port lock", () => {
  beforeAll(() => {
    ensureStubBuild();
  });

  afterAll(() => {
    cleanupStubBuild();
  });

  beforeEach(() => {
    cleanupLock(TEST_PORT_A);
    cleanupLock(TEST_PORT_B);
    killPort(TEST_PORT_A);
    killPort(TEST_PORT_B);
  });

  afterEach(() => {
    cleanupLock(TEST_PORT_A);
    cleanupLock(TEST_PORT_B);
    killPort(TEST_PORT_A);
    killPort(TEST_PORT_B);
  });

  it("creates a lock file on startup", async () => {
    const child = spawn("node", [CLI_PATH, "start", "--port", String(TEST_PORT_A)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for the lock to be written
    await new Promise((r) => setTimeout(r, 2000));

    const lockPath = watchdogLockPath(TEST_PORT_A);
    expect(fs.existsSync(lockPath)).toBe(true);

    const payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    expect(payload.pid).toBe(child.pid);
    expect(payload.port).toBe(TEST_PORT_A);
    expect(payload.repoRoot).toBe(REPO_ROOT);

    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }, 10000);

  it("rejects a second watchdog on the same port", async () => {
    const first = spawn("node", [CLI_PATH, "start", "--port", String(TEST_PORT_A)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for lock acquisition
    await new Promise((r) => setTimeout(r, 2000));

    // Try starting a second instance on the same port
    const result = execSync(`node ${CLI_PATH} run --port ${TEST_PORT_A} 2>&1 || true`, {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      timeout: 5000,
    });
    expect(result).toContain("Another watchdog is already managing port");
    expect(result).toContain(String(first.pid));

    first.kill("SIGTERM");
    await new Promise((r) => first.once("exit", r));
  }, 15000);

  it("allows different watchdogs on different ports", async () => {
    const first = spawn("node", [CLI_PATH, "start", "--port", String(TEST_PORT_A)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise((r) => setTimeout(r, 2000));

    // Second instance on a different port should succeed (creates its lock)
    const second = spawn("node", [CLI_PATH, "start", "--port", String(TEST_PORT_B)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise((r) => setTimeout(r, 2000));

    expect(fs.existsSync(watchdogLockPath(TEST_PORT_A))).toBe(true);
    expect(fs.existsSync(watchdogLockPath(TEST_PORT_B))).toBe(true);

    const payloadA = JSON.parse(fs.readFileSync(watchdogLockPath(TEST_PORT_A), "utf8"));
    const payloadB = JSON.parse(fs.readFileSync(watchdogLockPath(TEST_PORT_B), "utf8"));
    expect(payloadA.pid).toBe(first.pid);
    expect(payloadB.pid).toBe(second.pid);

    first.kill("SIGTERM");
    second.kill("SIGTERM");
    await Promise.all([
      new Promise((r) => first.once("exit", r)),
      new Promise((r) => second.once("exit", r)),
    ]);
  }, 15000);

  it("cleans up stale lock from dead process", async () => {
    // Write a fake lock with a dead PID
    const lockPath = watchdogLockPath(TEST_PORT_A);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        port: TEST_PORT_A,
        repoRoot: "/fake",
        startedAt: new Date().toISOString(),
      }),
    );

    // New watchdog should clean up the stale lock and succeed
    const child = spawn("node", [CLI_PATH, "start", "--port", String(TEST_PORT_A)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise((r) => setTimeout(r, 2000));

    const payload = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    expect(payload.pid).toBe(child.pid);

    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }, 10000);

  it("cleans up lock file on exit", async () => {
    const child = spawn("node", [CLI_PATH, "start", "--port", String(TEST_PORT_A)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise((r) => setTimeout(r, 2000));
    expect(fs.existsSync(watchdogLockPath(TEST_PORT_A))).toBe(true);

    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));

    // Give a moment for cleanup
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(watchdogLockPath(TEST_PORT_A))).toBe(false);
  }, 10000);
});

describe("gateway lock cleanup", () => {
  it("removes stale gateway lock files after killing processes", async () => {
    const lockDir = gatewayLockDir();
    fs.mkdirSync(lockDir, { recursive: true });

    // Create a fake gateway lock with a dead PID
    const fakeLock = path.join(lockDir, "gateway.testfake.lock");
    fs.writeFileSync(
      fakeLock,
      JSON.stringify({ pid: 999999, createdAt: new Date().toISOString(), configPath: "/fake" }),
    );

    // Import and call the cleanup function
    const { cleanupGatewayLockFiles } = (await import("./process-monitor.mjs")) as {
      cleanupGatewayLockFiles: (log?: (msg: string) => void) => void;
    };

    const logs: string[] = [];
    cleanupGatewayLockFiles((msg: string) => logs.push(msg));

    expect(fs.existsSync(fakeLock)).toBe(false);
    expect(logs.some((l) => l.includes("999999"))).toBe(true);
  });

  it("preserves gateway lock files for alive processes", async () => {
    const lockDir = gatewayLockDir();
    fs.mkdirSync(lockDir, { recursive: true });

    // Create a gateway lock with our own PID (alive)
    const fakeLock = path.join(lockDir, "gateway.testalive.lock");
    fs.writeFileSync(
      fakeLock,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: "/fake",
      }),
    );

    const { cleanupGatewayLockFiles } = (await import("./process-monitor.mjs")) as {
      cleanupGatewayLockFiles: (log?: (msg: string) => void) => void;
    };
    cleanupGatewayLockFiles();

    // Lock should still exist because we're alive
    expect(fs.existsSync(fakeLock)).toBe(true);

    // Clean up
    fs.unlinkSync(fakeLock);
  });
});
