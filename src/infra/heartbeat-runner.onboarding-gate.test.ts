import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as replyModule from "../auto-reply/reply.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";

describe("heartbeat onboarding gate", () => {
  it("skips with onboarding-incomplete while BOOTSTRAP.md exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-gate-"));
    const storePath = path.join(tmpDir, "sessions.json");
    await fs.writeFile(storePath, "{}");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "5m", gateUntilOnboarded: true, target: "none" },
        },
      },
      session: { store: storePath },
    } as OpenClawConfig;

    // BOOTSTRAP.md present => first-run onboarding in progress => gated, and the
    // model is never called (no wasted API spend during setup).
    await fs.writeFile(path.join(tmpDir, "BOOTSTRAP.md"), "# Setup\n- [ ] Pick a name\n");
    const gated = await runHeartbeatOnce({ cfg });
    expect(gated).toEqual({ status: "skipped", reason: "onboarding-incomplete" });
    expect(replySpy).not.toHaveBeenCalled();

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not gate when gateUntilOnboarded is off, even with BOOTSTRAP.md present", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-nogate-"));
    const storePath = path.join(tmpDir, "sessions.json");
    await fs.writeFile(storePath, "{}");
    await fs.writeFile(path.join(tmpDir, "BOOTSTRAP.md"), "# Setup\n- [ ] Pick a name\n");
    // Empty HEARTBEAT.md so the run skips for that reason instead — proving the
    // onboarding gate did not fire.
    await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "# HEARTBEAT.md\n# (comments only)\n");

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "5m", target: "none" },
        },
      },
      session: { store: storePath },
    } as OpenClawConfig;

    const res = await runHeartbeatOnce({ cfg });
    expect(res.status === "skipped" && res.reason === "onboarding-incomplete").toBe(false);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
