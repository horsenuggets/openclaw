import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "./workspace.js";

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.name === "EXTRA.md")).toBe(true);
  });

  it("suppresses an existing BOOTSTRAP.md when agents.defaults.skipBootstrapFile is set", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    // Simulate an already-provisioned workspace that still has BOOTSTRAP.md on disk.
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_BOOTSTRAP_FILENAME,
      content: "stale bootstrap",
    });

    const config = {
      agents: { defaults: { skipBootstrapFile: true } },
    } as OpenClawConfig;

    const present = (await resolveBootstrapFilesForRun({ workspaceDir })).find(
      (file) => file.name === DEFAULT_BOOTSTRAP_FILENAME,
    );
    expect(present?.missing).toBe(false);

    const suppressed = await resolveBootstrapFilesForRun({ workspaceDir, config });
    expect(suppressed.some((file) => file.name === DEFAULT_BOOTSTRAP_FILENAME)).toBe(false);
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find((file) => file.path === "EXTRA.md");

    expect(extra?.content).toBe("extra");
  });
});
