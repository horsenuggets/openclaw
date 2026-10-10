/**
 * Interactive confirmation guard for the destructive Lab scripts (clearing or
 * halving the archive). Deleting Discord channels is irreversible and the Lab
 * server is shared, so these scripts pause for a y/N confirmation unless `--yes`
 * (or `-y`) is passed. When there is no TTY to prompt on, `--yes` is required.
 */

import readline from "node:readline";

/** Whether the argv carries an explicit confirmation flag. */
export function hasYesFlag(argv: readonly string[]): boolean {
  return argv.includes("--yes") || argv.includes("-y");
}

/**
 * Resolve to true only if the caller confirmed. With `--yes` it returns true
 * immediately; otherwise it prompts, and without a TTY it returns false so the
 * caller can tell the user to pass `--yes`.
 */
export async function confirmDestructive(
  message: string,
  argv: readonly string[],
): Promise<boolean> {
  if (hasYesFlag(argv)) {
    return true;
  }
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(`${message} [y/N] `, resolve),
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
