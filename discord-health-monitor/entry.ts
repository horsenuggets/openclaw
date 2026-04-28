#!/usr/bin/env bun
/**
 * Discord Health Monitor
 *
 * Supervises the discord-router process and manages lifecycle messages.
 * Runs as the container entrypoint, spawning discord-router as a child process.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const DISCORD_API = "https://discord.com/api/v10";
const HEALTH_PORT = 18801;
const INSTANCES_DIR =
  process.env.OPENCLAW_INSTANCES_DIR ??
  path.join(process.env.HOME ?? "/root", ".openclaw-instances");
const ROUTER_BIN = process.env.ROUTER_BIN ?? "/usr/local/bin/discord-router";
const DISCORD_ID_RE = /^\d{17,20}$/;
// Max time to wait for lifecycle messages before giving up (prevents hang)
const LIFECYCLE_TIMEOUT_MS = 5_000;

// --- Config loading ---

type ChannelConfig = {
  channelId: string;
  lifecycleMessages: boolean;
};

function loadDiscordToken(): string {
  const envToken = process.env.DISCORD_BOT_TOKEN ?? process.env.OPENCLAW_DISCORD_TOKEN;
  if (envToken) {
    return envToken;
  }
  if (!fs.existsSync(INSTANCES_DIR)) {
    return "";
  }
  for (const entry of fs.readdirSync(INSTANCES_DIR)) {
    if (!DISCORD_ID_RE.test(entry)) {
      continue;
    }
    const configPath = path.join(INSTANCES_DIR, entry, "openclaw.json");
    if (fs.existsSync(configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const token = raw?.channels?.discord?.token ?? "";
        if (token) {
          return token;
        }
      } catch {
        // continue
      }
    }
  }
  return "";
}

function loadChannels(): ChannelConfig[] {
  const portsPath = path.join(INSTANCES_DIR, "ports.json");
  if (!fs.existsSync(portsPath)) {
    return [];
  }
  let ports: { assignments?: Record<string, number> };
  try {
    ports = JSON.parse(fs.readFileSync(portsPath, "utf-8"));
  } catch {
    return [];
  }
  const channels: ChannelConfig[] = [];
  for (const channelId of Object.keys(ports.assignments ?? {})) {
    const onboardingPath = path.join(INSTANCES_DIR, channelId, ".onboarding.json");
    let lifecycleMessages = false;
    let onboardingComplete = false;
    if (fs.existsSync(onboardingPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(onboardingPath, "utf-8"));
        lifecycleMessages = raw?.preferences?.lifecycleMessages === true;
        onboardingComplete = raw?.state === "complete";
      } catch {
        // default false
      }
    }
    // Legacy: check .onboarded flag file
    if (!onboardingComplete) {
      const legacyPath = path.join(INSTANCES_DIR, channelId, ".onboarded");
      onboardingComplete = fs.existsSync(legacyPath);
    }
    // Only include fully onboarded channels with lifecycle enabled
    if (onboardingComplete && lifecycleMessages) {
      channels.push({ channelId, lifecycleMessages });
    }
  }
  return channels;
}

// --- Discord REST API ---

async function discordSend(token: string, channelId: string, content: string): Promise<void> {
  try {
    const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(
        `[health] Discord API error ${resp.status} for ${channelId}: ${body.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error(`[health] failed to send to ${channelId}: ${String(err)}`);
  }
}

/** Send lifecycle message to all opted-in channels with a timeout to prevent hangs. */
async function sendLifecycleMessage(token: string, message: string): Promise<void> {
  const channels = loadChannels();
  if (channels.length === 0) {
    return;
  }
  // Send in parallel with a global timeout
  const sends = channels.map((ch) => discordSend(token, ch.channelId, message));
  await Promise.race([
    Promise.allSettled(sends),
    new Promise((resolve) => setTimeout(resolve, LIFECYCLE_TIMEOUT_MS)),
  ]);
}

// --- Process supervisor ---

type SupervisorState = "starting" | "running" | "restarting" | "stopped";

let routerProcess: ChildProcess | null = null;
let supervisorState: SupervisorState = "stopped";
let reconnectAttempts = 0;
let lastHealthyAt = 0;
let shuttingDown = false;
let discordToken = "";

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }
  supervisorState = "restarting";
  reconnectAttempts++;

  const jitter = Math.floor(Math.random() * 1000);
  const backoff = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 300_000) + jitter;
  console.log(
    `[health] restarting in ${Math.round(backoff / 1000)}s (attempt ${reconnectAttempts})`,
  );

  setTimeout(() => {
    if (!shuttingDown) {
      routerProcess = spawnRouter();
    }
  }, backoff);
}

function spawnRouter(): ChildProcess {
  console.log(`[health] spawning discord-router (attempt ${reconnectAttempts})`);
  supervisorState = "starting";

  const child = spawn(ROUTER_BIN, [], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("spawn", () => {
    console.log(`[health] discord-router started (pid ${child.pid})`);
    supervisorState = "running";
    lastHealthyAt = Date.now();
    try {
      fs.writeFileSync("/tmp/health-monitor.ok", String(Date.now()));
    } catch {}

    // Send "Back online" now that router is confirmed running
    void sendLifecycleMessage(discordToken, "*Back online.*");

    // Reset backoff after 30s stable
    setTimeout(() => {
      if (supervisorState === "running" && !shuttingDown) {
        reconnectAttempts = 0;
        console.log("[health] connection stable, backoff reset");
      }
    }, 30_000);
  });

  child.on("exit", (code, signal) => {
    console.log(`[health] discord-router exited (code=${code}, signal=${signal})`);
    routerProcess = null;

    if (shuttingDown) {
      supervisorState = "stopped";
      return;
    }

    scheduleRestart();
  });

  child.on("error", (err) => {
    console.error(`[health] discord-router spawn error: ${err.message}`);
    routerProcess = null;
    // Treat spawn errors same as exit — schedule restart with backoff
    if (!shuttingDown && supervisorState !== "restarting") {
      scheduleRestart();
    }
  });

  return child;
}

// --- Health endpoint ---

const healthServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    const healthy = supervisorState === "running" && routerProcess !== null;
    res.writeHead(healthy ? 200 : 503);
    res.end(
      JSON.stringify({
        status: healthy ? "ok" : "unhealthy",
        state: supervisorState,
        routerPid: routerProcess?.pid ?? null,
        reconnectAttempts,
        lastHealthyAt: lastHealthyAt > 0 ? new Date(lastHealthyAt).toISOString() : null,
      }),
    );
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});

// --- Main ---

async function main() {
  discordToken = loadDiscordToken();
  if (!discordToken) {
    console.error("[health] no Discord bot token found");
    process.exit(1);
  }

  // Start health endpoint
  healthServer.listen(HEALTH_PORT, "127.0.0.1", () => {
    console.log(`[health] health endpoint at http://127.0.0.1:${HEALTH_PORT}/health`);
  });

  // Spawn router (lifecycle "Back online" sent after router confirms running)
  routerProcess = spawnRouter();

  // Periodic heartbeat file for Docker healthcheck (every 10s)
  setInterval(() => {
    if (supervisorState === "running") {
      try {
        fs.writeFileSync("/tmp/health-monitor.ok", String(Date.now()));
      } catch {}
    } else {
      try {
        fs.unlinkSync("/tmp/health-monitor.ok");
      } catch {}
    }
  }, 10_000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[health] received ${signal}, shutting down`);

    // Best-effort "Shutting down" with timeout (don't block shutdown)
    await sendLifecycleMessage(discordToken, "*Shutting down...*");

    // Stop router
    if (routerProcess) {
      routerProcess.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          routerProcess?.kill("SIGKILL");
          resolve();
        }, 10_000);
        routerProcess?.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    // Remove heartbeat file
    try {
      fs.unlinkSync("/tmp/health-monitor.ok");
    } catch {}

    healthServer.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
