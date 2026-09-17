import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
  filterBootstrapOnboardingFile,
  hasBootstrapOnboardingFile,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const OTHER_STARTER_FILES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
];

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

describe("ensureAgentWorkspace bootstrap seeding", () => {
  it("seeds BOOTSTRAP.md on a brand-new workspace by default", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    await ensureAgentWorkspace({ dir: tempDir, ensureBootstrapFiles: true });

    for (const name of OTHER_STARTER_FILES) {
      expect(await exists(path.join(tempDir, name))).toBe(true);
    }
    expect(await exists(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME))).toBe(true);
  });

  it("seeds all starter files except BOOTSTRAP.md when skipBootstrapOnboardingFile is set", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");

    await ensureAgentWorkspace({
      dir: tempDir,
      ensureBootstrapFiles: true,
      skipBootstrapOnboardingFile: true,
    });

    for (const name of OTHER_STARTER_FILES) {
      expect(await exists(path.join(tempDir, name))).toBe(true);
    }
    expect(await exists(path.join(tempDir, DEFAULT_BOOTSTRAP_FILENAME))).toBe(false);
  });
});

describe("filterBootstrapOnboardingFile", () => {
  const files: WorkspaceBootstrapFile[] = [
    { name: DEFAULT_AGENTS_FILENAME, path: "AGENTS.md", missing: false },
    { name: DEFAULT_BOOTSTRAP_FILENAME, path: "BOOTSTRAP.md", missing: false },
  ];

  it("drops a stale BOOTSTRAP.md when the flag is set", () => {
    const result = filterBootstrapOnboardingFile(files, true);
    expect(result.map((f) => f.name)).toEqual([DEFAULT_AGENTS_FILENAME]);
  });

  it("keeps BOOTSTRAP.md when the flag is unset", () => {
    const result = filterBootstrapOnboardingFile(files, false);
    expect(result.map((f) => f.name)).toContain(DEFAULT_BOOTSTRAP_FILENAME);
  });
});

describe("hasBootstrapOnboardingFile", () => {
  it("treats BOOTSTRAP.md as absent when the flag is set", async () => {
    const tempDir = await makeTempWorkspace("openclaw-workspace-");
    await writeWorkspaceFile({
      dir: tempDir,
      name: DEFAULT_BOOTSTRAP_FILENAME,
      content: "stale bootstrap",
    });

    expect(await hasBootstrapOnboardingFile(tempDir, true)).toBe(false);
    expect(await hasBootstrapOnboardingFile(tempDir, false)).toBe(true);
  });
});
