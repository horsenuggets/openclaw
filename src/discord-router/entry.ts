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

const runtime = {
  log: console.log,
  error: console.error,
};

// Start even with zero instances: the router still registers slash commands and
// connects to Discord, so a fresh deployment can create its first channel with
// `/channel register` instead of needing one seeded out of band.
if (config.instances.size === 0) {
  console.warn("No instances registered yet; starting router so /channel register can seed one.");
} else {
  console.log(`Starting Discord router with ${config.instances.size} instance(s)...`);
}
startRouter(config, runtime).catch((err: unknown) => {
  console.error("Router error:", err);
  process.exit(1);
});
