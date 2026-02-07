import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createJob,
  getActiveJobForUser,
  loadJobIndex,
  updateJob,
  appendJobEvent,
  listJobsForUser,
  resolveJobStorePath,
} from "./store.js";

// Use a temp directory for tests to avoid touching real state.
const testDir = path.join(os.tmpdir(), `job-store-test-${process.pid}-${Date.now()}`);

vi.mock("../../config/paths.js", () => ({
  resolveStateDir: () => testDir,
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: (id: string) => id,
  DEFAULT_AGENT_ID: "test-agent",
}));

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("job store", () => {
  it("creates a job and loads index", async () => {
    const job = await createJob({
      agentId: "test-agent",
      userId: "user-1",
      sessionKey: "agent:test-agent:discord:dm:user-1",
      prompt: "Help me write a script",
    });

    expect(job.jobId).toBeTruthy();
    expect(job.status).toBe("active");
    expect(job.prompt).toBe("Help me write a script");
    expect(job.userId).toBe("user-1");

    const { indexPath } = resolveJobStorePath("test-agent");
    const index = await loadJobIndex(indexPath);
    expect(index[job.jobId]).toBeTruthy();
    expect(index[job.jobId].status).toBe("active");
  });

  it("updates job status to completed", async () => {
    const job = await createJob({
      agentId: "test-agent",
      userId: "user-1",
      sessionKey: "key",
      prompt: "test",
    });

    await updateJob({
      agentId: "test-agent",
      jobId: job.jobId,
      status: "completed",
    });

    const { indexPath } = resolveJobStorePath("test-agent");
    const index = await loadJobIndex(indexPath);
    expect(index[job.jobId].status).toBe("completed");
    expect(index[job.jobId].completedAt).toBeGreaterThan(0);
  });

  it("gets active job for user", async () => {
    await createJob({
      agentId: "test-agent",
      userId: "user-1",
      sessionKey: "key",
      prompt: "first",
    });

    const second = await createJob({
      agentId: "test-agent",
      userId: "user-1",
      sessionKey: "key",
      prompt: "second",
    });

    const active = await getActiveJobForUser("test-agent", "user-1");
    expect(active).toBeTruthy();
    expect(active!.jobId).toBe(second.jobId);
    expect(active!.prompt).toBe("second");
  });

  it("returns null when no active job", async () => {
    const active = await getActiveJobForUser("test-agent", "no-such-user");
    expect(active).toBeNull();
  });

  it("ignores completed jobs in active lookup", async () => {
    const job = await createJob({
      agentId: "test-agent",
      userId: "user-1",
      sessionKey: "key",
      prompt: "done",
    });

    await updateJob({
      agentId: "test-agent",
      jobId: job.jobId,
      status: "completed",
    });

    const active = await getActiveJobForUser("test-agent", "user-1");
    expect(active).toBeNull();
  });

  it("appends job events to JSONL", async () => {
    const job = await createJob({
      agentId: "test-agent",
      userId: "user-1",
      sessionKey: "key",
      prompt: "test",
    });

    await appendJobEvent("test-agent", job.jobId, {
      ts: Date.now(),
      jobId: job.jobId,
      event: "message",
      data: { prompt: "follow-up" },
    });

    const { jobsDir } = resolveJobStorePath("test-agent");
    const jsonlPath = path.join(jobsDir, `${job.jobId}.jsonl`);
    const raw = await fs.readFile(jsonlPath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(2); // created + message
  });

  it("lists jobs for user sorted by updatedAt", async () => {
    await createJob({
      agentId: "test-agent",
      userId: "user-1",
      sessionKey: "key",
      prompt: "first",
    });
    await createJob({
      agentId: "test-agent",
      userId: "user-1",
      sessionKey: "key",
      prompt: "second",
    });
    await createJob({
      agentId: "test-agent",
      userId: "user-2",
      sessionKey: "key",
      prompt: "other user",
    });

    const jobs = await listJobsForUser("test-agent", "user-1");
    expect(jobs.length).toBe(2);
    expect(jobs[0].updatedAt).toBeGreaterThanOrEqual(jobs[1].updatedAt);
  });

  it("loads empty index from nonexistent path", async () => {
    const index = await loadJobIndex("/nonexistent/path/index.json");
    expect(index).toEqual({});
  });

  it("updates job summary", async () => {
    const job = await createJob({
      agentId: "test-agent",
      userId: "user-1",
      sessionKey: "key",
      prompt: "write code",
    });

    await updateJob({
      agentId: "test-agent",
      jobId: job.jobId,
      status: "completed",
      summary: "User asked to write code",
    });

    const { indexPath } = resolveJobStorePath("test-agent");
    const index = await loadJobIndex(indexPath);
    expect(index[job.jobId].summary).toBe("User asked to write code");
  });
});
