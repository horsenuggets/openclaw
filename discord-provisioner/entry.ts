#!/usr/bin/env bun
/**
 * OpenClaw provisioning daemon.
 *
 * Runs on the host (not in a container), where it has Docker access and write
 * access to the instances directory. It exposes a tiny loopback HTTP API that
 * the sandboxed discord-router calls to register/unregister channels. Each
 * operation shells out to `openclawctl` (the existing provisioning script).
 *
 * Security: binds 127.0.0.1 only and requires a shared bearer token. The router
 * reaches it because the router container is network_mode: host.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  isSnowflake,
  type ProvisionResponse,
  type RegisterRequest,
  type UnregisterRequest,
} from "../src/discord-router/provisioning.js";

const PORT = Number.parseInt(process.env.OPENCLAW_PROVISIONER_PORT ?? "", 10);
const TOKEN = process.env.OPENCLAW_PROVISIONER_TOKEN ?? "";
const INSTANCES_DIR =
  process.env.OPENCLAW_INSTANCES_DIR ??
  path.join(process.env.HOME ?? os.homedir(), ".openclaw-instances");
// openclawctl ships next to this binary in ~/deploy/bin; allow an override.
const OPENCLAWCTL_BIN =
  process.env.OPENCLAWCTL_BIN ?? path.join(path.dirname(process.execPath), "openclawctl");

// Fail closed on missing required config rather than starting insecure.
if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error("[provisioner] OPENCLAW_PROVISIONER_PORT must be a positive integer");
  process.exit(1);
}
if (!TOKEN) {
  console.error("[provisioner] OPENCLAW_PROVISIONER_TOKEN is required");
  process.exit(1);
}

const CTL_TIMEOUT_MS = 120_000;
const READINESS_TIMEOUT_MS = 30_000;
const READINESS_INTERVAL_MS = 500;

/** Run openclawctl with the given args; resolve with its exit code and output. */
function runCtl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(OPENCLAWCTL_BIN, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, CTL_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${String(err)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Read the port an instance was assigned (its `.port` dotfile). */
function readInstancePort(channelId: string): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(INSTANCES_DIR, channelId, ".port"), "utf-8").trim();
    if (!/^\d+$/.test(raw)) {
      return undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    return parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Wait until something is listening on the agent's loopback port. */
function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          resolve(false);
        } else {
          setTimeout(attempt, READINESS_INTERVAL_MS);
        }
      });
    };
    attempt();
  });
}

/** Record the owner (and DM flag) in the instance's onboarding file. */
function recordOwner(channelId: string, ownerId: string, isDM: boolean): void {
  const file = path.join(INSTANCES_DIR, channelId, ".onboarding.json");
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    // fresh file
  }
  data.ownerId = ownerId;
  data.isDM = isDM;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function handleRegister(body: RegisterRequest): Promise<ProvisionResponse> {
  if (!isSnowflake(body.channelId) || !isSnowflake(body.ownerId)) {
    return { ok: false, message: "Invalid channel or owner id." };
  }
  const result = await runCtl(["add-channel", body.channelId]);
  if (result.code !== 0) {
    console.error(`[provisioner] add-channel ${body.channelId} failed: ${result.stderr.trim()}`);
    return { ok: false, message: "Failed to create the instance. Check the provisioner logs." };
  }
  try {
    recordOwner(body.channelId, body.ownerId, Boolean(body.isDM));
  } catch (err) {
    console.error(`[provisioner] failed to record owner for ${body.channelId}: ${String(err)}`);
  }

  const port = readInstancePort(body.channelId);
  if (port === undefined) {
    return { ok: false, message: "Instance was created but no port was assigned." };
  }
  const ready = await waitForPort(port, READINESS_TIMEOUT_MS);
  console.log(`[provisioner] registered ${body.channelId} on port ${port} (ready=${ready})`);
  return {
    ok: true,
    message: ready
      ? "Channel registered and the agent is ready. Send a message to begin setup."
      : "Channel registered. The agent is still starting up, give it a few seconds before your first message.",
  };
}

async function handleUnregister(body: UnregisterRequest): Promise<ProvisionResponse> {
  if (!isSnowflake(body.channelId)) {
    return { ok: false, message: "Invalid channel id." };
  }
  const result = await runCtl(["remove", body.channelId]);
  if (result.code !== 0) {
    console.error(`[provisioner] remove ${body.channelId} failed: ${result.stderr.trim()}`);
    return { ok: false, message: "Failed to remove the instance. Check the provisioner logs." };
  }
  console.log(`[provisioner] unregistered ${body.channelId}`);
  return { ok: true, message: "Channel unregistered. The agent has been stopped (data is kept)." };
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
      if (raw.length > 64_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: ProvisionResponse): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "POST" || (req.url !== "/register" && req.url !== "/unregister")) {
    sendJson(res, 404, { ok: false, message: "not found" });
    return;
  }

  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    sendJson(res, 401, { ok: false, message: "unauthorized" });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { ok: false, message: "invalid request body" });
    return;
  }

  try {
    const response =
      req.url === "/register"
        ? await handleRegister(body as RegisterRequest)
        : await handleUnregister(body as UnregisterRequest);
    sendJson(res, response.ok ? 200 : 500, response);
  } catch (err) {
    console.error(`[provisioner] ${req.url} errored: ${String(err)}`);
    sendJson(res, 500, { ok: false, message: "internal error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[provisioner] listening on 127.0.0.1:${PORT} (openclawctl=${OPENCLAWCTL_BIN})`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
