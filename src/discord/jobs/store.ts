import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { JobEntry, JobEvent, JobStatus } from "./types.js";
import { resolveStateDir } from "../../config/paths.js";
import { logVerbose } from "../../globals.js";
import { normalizeAgentId, DEFAULT_AGENT_ID } from "../../routing/session-key.js";

type JobIndex = Record<string, JobEntry>;

export function resolveJobStorePath(agentId?: string) {
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  const root = resolveStateDir();
  const jobsDir = path.join(root, "agents", id, "jobs");
  return {
    indexPath: path.join(jobsDir, "job-index.json"),
    jobsDir,
    archiveDir: path.join(jobsDir, "archive"),
  };
}

export async function loadJobIndex(indexPath: string): Promise<JobIndex> {
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    return JSON.parse(raw) as JobIndex;
  } catch {
    return {};
  }
}

export async function saveJobIndex(indexPath: string, index: JobIndex): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const tmp = `${indexPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), "utf-8");
  await fs.rename(tmp, indexPath);
}

const writesByPath = new Map<string, Promise<void>>();

export async function appendJobEvent(
  agentId: string,
  jobId: string,
  event: JobEvent,
): Promise<void> {
  const { jobsDir } = resolveJobStorePath(agentId);
  const filePath = path.resolve(path.join(jobsDir, `${jobId}.jsonl`));
  const prev = writesByPath.get(filePath) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf-8");
    });
  writesByPath.set(filePath, next);
  await next;
}

export async function createJob(params: {
  agentId: string;
  userId: string;
  sessionKey: string;
  prompt: string;
}): Promise<JobEntry> {
  const { agentId, userId, sessionKey, prompt } = params;
  const { indexPath } = resolveJobStorePath(agentId);
  const now = Date.now();
  const jobId = crypto.randomUUID();

  const entry: JobEntry = {
    jobId,
    userId,
    sessionKey,
    prompt,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  const index = await loadJobIndex(indexPath);
  index[jobId] = entry;
  await saveJobIndex(indexPath, index);

  await appendJobEvent(agentId, jobId, {
    ts: now,
    jobId,
    event: "created",
    data: { prompt },
  });

  logVerbose(`jobs: created job ${jobId} for user ${userId}`);
  return entry;
}

export async function updateJob(params: {
  agentId: string;
  jobId: string;
  status: JobStatus;
  summary?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { agentId, jobId, status, summary, metadata } = params;
  const { indexPath } = resolveJobStorePath(agentId);
  const now = Date.now();

  const index = await loadJobIndex(indexPath);
  const entry = index[jobId];
  if (!entry) {
    logVerbose(`jobs: cannot update unknown job ${jobId}`);
    return;
  }

  entry.status = status;
  entry.updatedAt = now;
  if (status === "completed" || status === "failed") {
    entry.completedAt = now;
  }
  if (summary !== undefined) {
    entry.summary = summary;
  }
  await saveJobIndex(indexPath, index);

  await appendJobEvent(agentId, jobId, {
    ts: now,
    jobId,
    event: status === "completed" ? "completed" : status === "failed" ? "failed" : "message",
    data: metadata,
  });

  logVerbose(`jobs: updated job ${jobId} → ${status}`);
}

export async function getActiveJobForUser(
  agentId: string,
  userId: string,
): Promise<JobEntry | null> {
  const { indexPath } = resolveJobStorePath(agentId);
  const index = await loadJobIndex(indexPath);

  let latest: JobEntry | null = null;
  for (const entry of Object.values(index)) {
    if (entry.userId !== userId || entry.status !== "active") {
      continue;
    }
    if (!latest || entry.updatedAt > latest.updatedAt) {
      latest = entry;
    }
  }
  return latest;
}

export async function listJobsForUser(
  agentId: string,
  userId: string,
  limit = 20,
): Promise<JobEntry[]> {
  const { indexPath } = resolveJobStorePath(agentId);
  const index = await loadJobIndex(indexPath);

  return Object.values(index)
    .filter((e) => e.userId === userId)
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}
