import type { Command } from "commander";
import { mintAnthropicCommand, type MintStore } from "../commands/auth-mint-anthropic.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";

export function registerAuthCli(program: Command) {
  const auth = program.command("auth").description("Authentication helpers");
  auth.action(() => {
    auth.help();
  });

  auth
    .command("mint-anthropic")
    .description(
      "Mint Claude (anthropic-subscription) OAuth tokens via the claude.ai flow and write them to an auth store",
    )
    .option(
      "--store <target>",
      'Target store, either "shared" (per-channel containers) or "main"',
      "main",
    )
    .option(
      "--instances-dir <path>",
      "Instances root for --store shared (defaults to $OPENCLAW_INSTANCES_DIR or ~/.openclaw-instances)",
    )
    .option(
      "--agent-dir <path>",
      "Explicit agent dir to write auth-profiles.json into (overrides --store)",
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await mintAnthropicCommand(
          {
            store: opts.store as MintStore,
            instancesDir: opts.instancesDir as string | undefined,
            agentDir: opts.agentDir as string | undefined,
          },
          defaultRuntime,
        );
      });
    });
}
