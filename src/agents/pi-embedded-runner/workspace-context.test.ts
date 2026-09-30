import { describe, expect, it } from "vitest";
import type { WorkspaceContextConfig } from "../../config/types.agent-defaults.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
import {
  buildWorkspaceContextPointer,
  resolveWorkspaceContextDelivery,
  resolveWorkspaceContextMode,
} from "./workspace-context.js";

const file = (path: string, content = "x"): EmbeddedContextFile => ({ path, content });

describe("resolveWorkspaceContextMode", () => {
  it("uses the built-in defaults when no config is given", () => {
    expect(resolveWorkspaceContextMode("SOUL.md")).toBe("preamble");
    expect(resolveWorkspaceContextMode("AGENTS.md")).toBe("preamble");
    expect(resolveWorkspaceContextMode("USER.md")).toBe("preamble");
    expect(resolveWorkspaceContextMode("BOOTSTRAP.md")).toBe("preamble");
    expect(resolveWorkspaceContextMode("TOOLS.md")).toBe("off");
    expect(resolveWorkspaceContextMode("MEMORY.md")).toBe("off");
    expect(resolveWorkspaceContextMode("HEARTBEAT.md")).toBe("off");
  });

  it("falls back to inline for unknown files", () => {
    expect(resolveWorkspaceContextMode("NOTES.md")).toBe("inline");
  });

  it("matches by basename case-insensitively, ignoring directories", () => {
    expect(resolveWorkspaceContextMode("workspace/soul.md")).toBe("preamble");
  });

  it("lets a global default override the built-in per-file defaults", () => {
    const config: WorkspaceContextConfig = { default: "off" };
    expect(resolveWorkspaceContextMode("SOUL.md", config)).toBe("off");
    expect(resolveWorkspaceContextMode("NOTES.md", config)).toBe("off");
  });

  it("lets an explicit per-file override beat both global default and built-ins", () => {
    const config: WorkspaceContextConfig = { default: "off", files: { "soul.md": "inline" } };
    expect(resolveWorkspaceContextMode("SOUL.md", config)).toBe("inline");
    // Other files still follow the global default.
    expect(resolveWorkspaceContextMode("AGENTS.md", config)).toBe("off");
  });
});

describe("resolveWorkspaceContextDelivery", () => {
  it("routes files into inline / preamble / off buckets with defaults", () => {
    const { inlineFiles, preambleFiles, offFiles, pointerPlacement } =
      resolveWorkspaceContextDelivery([
        file("SOUL.md"),
        file("USER.md"),
        file("TOOLS.md"),
        file("MEMORY.md"),
        file("NOTES.md"),
      ]);
    expect(preambleFiles.map((f) => f.path)).toEqual(["SOUL.md", "USER.md"]);
    expect(offFiles.map((f) => f.path)).toEqual(["TOOLS.md", "MEMORY.md"]);
    expect(inlineFiles.map((f) => f.path)).toEqual(["NOTES.md"]);
    expect(pointerPlacement).toBe("preamble");
  });

  it("honors the configured pointer placement", () => {
    const { pointerPlacement } = resolveWorkspaceContextDelivery([file("TOOLS.md")], {
      pointer: "inline",
    });
    expect(pointerPlacement).toBe("inline");
  });
});

describe("buildWorkspaceContextPointer", () => {
  it("lists off files by basename", () => {
    const pointer = buildWorkspaceContextPointer([file("workspace/TOOLS.md"), file("MEMORY.md")]);
    expect(pointer).toContain("## Workspace Files");
    expect(pointer).toContain("TOOLS.md, MEMORY.md");
    expect(pointer).toContain("Read them");
  });

  it("returns undefined when there are no off files", () => {
    expect(buildWorkspaceContextPointer([])).toBeUndefined();
  });
});
