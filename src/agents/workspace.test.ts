import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  ensureAgentWorkspace,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";

async function hasGitDir(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dir, ".git"));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

describe("loadWorkspaceBootstrapFiles", () => {
  it("includes MEMORY.md when present", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "MEMORY.md", content: "memory" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe("memory");
  });

  it("includes memory.md when MEMORY.md is absent", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir: tempDir, name: "memory.md", content: "alt" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(1);
    expect(memoryEntries[0]?.missing).toBe(false);
    expect(memoryEntries[0]?.content).toBe("alt");
  });

  it("omits memory entries when no memory files exist", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const memoryEntries = files.filter((file) =>
      [DEFAULT_MEMORY_FILENAME, DEFAULT_MEMORY_ALT_FILENAME].includes(file.name),
    );

    expect(memoryEntries).toHaveLength(0);
  });
});

describe("ensureAgentWorkspace git repo", () => {
  it("initializes a git repo for a brand-new workspace", async () => {
    const dir = await makeTempWorkspace("openclaw-workspace-");
    expect(await hasGitDir(dir)).toBe(false);

    await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });

    expect(await hasGitDir(dir)).toBe(true);
  });

  it("backfills a git repo for an existing non-repo workspace", async () => {
    // Simulate a box seeded before git existed: starter files present, no `.git`.
    const dir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir, name: "AGENTS.md", content: "seeded" });
    await writeWorkspaceFile({ dir, name: "SOUL.md", content: "seeded" });
    expect(await hasGitDir(dir)).toBe(false);

    await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });

    expect(await hasGitDir(dir)).toBe(true);
  });

  it("leaves pre-seeded files untouched when backfilling the repo", async () => {
    const dir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({ dir, name: "AGENTS.md", content: "keep me" });

    await ensureAgentWorkspace({ dir, ensureBootstrapFiles: true });

    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8")).toBe("keep me");
    expect(await hasGitDir(dir)).toBe(true);
  });
});
