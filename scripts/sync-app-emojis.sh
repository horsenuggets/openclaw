#!/usr/bin/env bash
# Sync the prod bot's application emojis onto the mirror bot.
#
# Convenience wrapper around scripts/sync-app-emojis.ts: loads the bot tokens
# from the repo-root .env, then runs the TypeScript sync with bun. Any flags are
# passed straight through.
#
# Usage:
#   scripts/sync-app-emojis.sh [--dry-run] [--prune]
#
# Env (from the repo-root .env):
#   DISCORD_BOT_TOKEN              prod bot token (source)
#   OPENCLAW_MIRROR_DISCORD_TOKEN  mirror bot token (target)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: no .env at $ENV_FILE" >&2
  echo "       needs DISCORD_BOT_TOKEN and OPENCLAW_MIRROR_DISCORD_TOKEN." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

exec bun "$SCRIPT_DIR/sync-app-emojis.ts" "$@"
