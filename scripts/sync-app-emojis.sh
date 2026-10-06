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
# Tokens (matching the .env / .env.mirror overlay convention in .env.template):
#   * prod (source):   DISCORD_BOT_TOKEN from .env
#   * mirror (target): DISCORD_BOT_TOKEN from the gitignored .env.mirror overlay,
#                      mapped here to OPENCLAW_MIRROR_DISCORD_TOKEN (which the sync
#                      reads). An OPENCLAW_MIRROR_DISCORD_TOKEN already in the
#                      environment wins and skips the overlay lookup.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
MIRROR_ENV_FILE="$ROOT_DIR/.env.mirror"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: no .env at $ENV_FILE (needs the prod DISCORD_BOT_TOKEN)." >&2
  exit 1
fi

# Preserve a caller-provided mirror token before sourcing .env: .env may also
# assign OPENCLAW_MIRROR_DISCORD_TOKEN (even empty), which would otherwise discard
# the caller's explicit override. Restored after the load so the caller wins.
CALLER_MIRROR_TOKEN="${OPENCLAW_MIRROR_DISCORD_TOKEN:-}"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [ -n "$CALLER_MIRROR_TOKEN" ]; then
  OPENCLAW_MIRROR_DISCORD_TOKEN="$CALLER_MIRROR_TOKEN"
  export OPENCLAW_MIRROR_DISCORD_TOKEN
fi

# Resolve the mirror (target) token. The overlay stores it as DISCORD_BOT_TOKEN
# (it overrides the base prod token when the mirror rig sources it), so read it in
# an isolated subshell and map it to OPENCLAW_MIRROR_DISCORD_TOKEN, keeping the
# prod DISCORD_BOT_TOKEN we just loaded intact.
if [ -z "${OPENCLAW_MIRROR_DISCORD_TOKEN:-}" ] && [ -f "$MIRROR_ENV_FILE" ]; then
  OPENCLAW_MIRROR_DISCORD_TOKEN="$(
    # Clear the inherited prod token first, so an overlay that omits
    # DISCORD_BOT_TOKEN yields an empty result (hitting the error path below)
    # rather than silently reusing the prod token and syncing prod to itself.
    unset DISCORD_BOT_TOKEN
    set -a
    # shellcheck disable=SC1090
    . "$MIRROR_ENV_FILE"
    set +a
    printf '%s' "${DISCORD_BOT_TOKEN:-}"
  )"
  export OPENCLAW_MIRROR_DISCORD_TOKEN
fi

if [ -z "${OPENCLAW_MIRROR_DISCORD_TOKEN:-}" ]; then
  echo "Error: no mirror bot token." >&2
  echo "       Set OPENCLAW_MIRROR_DISCORD_TOKEN, or put the mirror bot's" >&2
  echo "       DISCORD_BOT_TOKEN in $MIRROR_ENV_FILE (see .env.template)." >&2
  exit 1
fi

exec bun "$SCRIPT_DIR/sync-app-emojis.ts" "$@"
