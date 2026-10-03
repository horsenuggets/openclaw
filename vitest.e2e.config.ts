import os from "node:os";
import { defineConfig } from "vitest/config";

const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const cpuCount = os.cpus().length;
const e2eWorkers = isCI ? 2 : Math.min(4, Math.max(1, Math.floor(cpuCount * 0.25)));

export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: e2eWorkers,
    // Default hook budget. Setup hooks register a channel and wait for its agent
    // to provision (up to AGENT_READY_TIMEOUT_MS = 120s in
    // src/discord/e2e/helpers.ts), which the stock 10s hook timeout cannot cover;
    // this equals e2eSetupTimeout(1). Suites that provision several channels
    // override this per-hook with e2eSetupTimeout(n).
    hookTimeout: 180_000,
    include: ["test/**/*.e2e.test.ts", "src/**/*.e2e.test.ts"],
    setupFiles: ["test/setup.ts"],
    exclude: [
      "dist/**",
      "apps/macos/**",
      "apps/macos/.build/**",
      "**/vendor/**",
      "dist/OpenClaw.app/**",
    ],
  },
});
