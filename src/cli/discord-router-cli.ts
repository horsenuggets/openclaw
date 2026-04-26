import type { Command } from "commander";

export function registerDiscordRouterCli(program: Command) {
  program
    .command("discord-router")
    .description("Run the Discord router for multi-channel Docker containers")
    .option("--discord-token <token>", "Discord bot token (or set DISCORD_BOT_TOKEN)")
    .option("--instances-dir <dir>", "Instances directory (default: ~/.openclaw-instances)")
    .action(async (opts: { discordToken?: string; instancesDir?: string }) => {
      const { loadRouterConfig } = await import("../discord-router/config.js");
      const { startRouter } = await import("../discord-router/router.js");

      const config = loadRouterConfig({
        discordToken: opts.discordToken,
        instancesDir: opts.instancesDir,
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
      await startRouter(config, runtime);
    });
}
