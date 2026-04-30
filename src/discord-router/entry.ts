#!/usr/bin/env bun
/**
 * Standalone entry point for the Discord router.
 * Compiles to a small binary (~5-20MB) with only routing logic.
 */
import { loadRouterConfig } from "./config.js";
import { startRouter } from "./router.js";

const config = loadRouterConfig({
  discordToken: process.env.DISCORD_BOT_TOKEN,
  instancesDir: process.env.OPENCLAW_INSTANCES_DIR,
});

if (config.instances.size === 0) {
  console.error(
    "No instances found. Create instance directories with Discord channel IDs in the instances directory.",
  );
  process.exit(1);
}

const runtime = {
  log: console.log,
  error: console.error,
};

console.log(`Starting Discord router with ${config.instances.size} instance(s)...`);
startRouter(config, runtime).catch((err: unknown) => {
  console.error("Router error:", err);
  process.exit(1);
});
