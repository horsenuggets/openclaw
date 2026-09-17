import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import { ensureSandboxWorkspace } from "./sandbox/workspace.js";
import { DEFAULT_AGENTS_FILENAME, DEFAULT_BOOTSTRAP_FILENAME } from "./workspace.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("ensureSandboxWorkspace", () => {
  it("skips BOOTSTRAP.md when skipBootstrapOnboardingFile is set", async () => {
    const seedDir = await makeTempWorkspace("openclaw-sandbox-seed-");
    const sandboxDir = await makeTempWorkspace("openclaw-sandbox-target-");

    await writeWorkspaceFile({ dir: seedDir, name: DEFAULT_AGENTS_FILENAME, content: "agents" });
    await writeWorkspaceFile({
      dir: seedDir,
      name: DEFAULT_BOOTSTRAP_FILENAME,
      content: "bootstrap",
    });

    await ensureSandboxWorkspace(sandboxDir, seedDir, {
      skipBootstrapOnboardingFile: true,
    });

    expect(await exists(path.join(sandboxDir, DEFAULT_AGENTS_FILENAME))).toBe(true);
    expect(await exists(path.join(sandboxDir, DEFAULT_BOOTSTRAP_FILENAME))).toBe(false);
  });
});
