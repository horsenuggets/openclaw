import fs from "node:fs/promises";
import path from "node:path";
import { logVerbose } from "../../globals.js";
import { loadJobIndex, resolveJobStorePath, saveJobIndex } from "./store.js";

const DEFAULT_ARCHIVE_AFTER_MS = 86_400_000; // 24h
const DEFAULT_PRUNE_AFTER_MS = 604_800_000; // 7d
const SWEEP_INTERVAL_MS = 3_600_000; // 1h

let sweeper: ReturnType<typeof setInterval> | null = null;

async function archiveCompletedJobs(agentId: string, archiveAfterMs: number): Promise<number> {
  const { indexPath, jobsDir, archiveDir } = resolveJobStorePath(agentId);
  const index = await loadJobIndex(indexPath);
  const now = Date.now();
  let archived = 0;

  for (const [jobId, entry] of Object.entries(index)) {
    if (entry.status !== "completed" && entry.status !== "failed") {
      continue;
    }
    const age = now - (entry.completedAt ?? entry.updatedAt);
    if (age < archiveAfterMs) {
      continue;
    }

    // Move JSONL to archive directory.
    const src = path.join(jobsDir, `${jobId}.jsonl`);
    const dest = path.join(archiveDir, `${jobId}.jsonl`);
    try {
      await fs.mkdir(archiveDir, { recursive: true });
      await fs.rename(src, dest);
    } catch {
      // Source may not exist; that's fine.
    }

    delete index[jobId];
    archived++;
  }

  if (archived > 0) {
    await saveJobIndex(indexPath, index);
    logVerbose(`jobs: archived ${archived} completed job(s)`);
  }
  return archived;
}

async function pruneArchivedJobs(agentId: string, pruneAfterMs: number): Promise<number> {
  const { archiveDir } = resolveJobStorePath(agentId);
  let pruned = 0;
  const now = Date.now();

  let files: string[];
  try {
    files = await fs.readdir(archiveDir);
  } catch {
    return 0;
  }

  for (const file of files) {
    if (!file.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(archiveDir, file);
    try {
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > pruneAfterMs) {
        await fs.unlink(filePath);
        pruned++;
      }
    } catch {
      // Ignore stat/unlink errors.
    }
  }

  if (pruned > 0) {
    logVerbose(`jobs: pruned ${pruned} archived job file(s)`);
  }
  return pruned;
}

export function startJobArchiver(
  agentId: string,
  opts?: { archiveAfterMs?: number; pruneAfterMs?: number },
): { stop: () => void } {
  if (sweeper) {
    return { stop: () => stopJobArchiver() };
  }

  const archiveAfterMs = opts?.archiveAfterMs ?? DEFAULT_ARCHIVE_AFTER_MS;
  const pruneAfterMs = opts?.pruneAfterMs ?? DEFAULT_PRUNE_AFTER_MS;

  sweeper = setInterval(() => {
    void archiveCompletedJobs(agentId, archiveAfterMs);
    void pruneArchivedJobs(agentId, pruneAfterMs);
  }, SWEEP_INTERVAL_MS);

  sweeper.unref?.();

  return { stop: () => stopJobArchiver() };
}

function stopJobArchiver() {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}
