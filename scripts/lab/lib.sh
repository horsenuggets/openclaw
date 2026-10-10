# Shared setup for the scripts/lab/*.sh wrappers. Source this, do not execute it.
#
# Loads the repo-root .env and the gitignored .env.mirror overlay so the Lab
# TypeScript entrypoints see OPENCLAW_MIRROR_DISCORD_TOKEN (the OpenClaw Mirror
# bot, from .env) and OPENCLAW_LAB_GUILD_ID (the OpenClaw Lab server, from
# .env.mirror). Missing values are left for the TypeScript to report loudly; the
# Lab scripts never fall back to the production DISCORD_BOT_TOKEN.

_LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_ROOT_DIR="$(cd "$_LAB_DIR/../.." && pwd)"

set -a
# shellcheck disable=SC1091
[ -f "$LAB_ROOT_DIR/.env" ] && . "$LAB_ROOT_DIR/.env"
# shellcheck disable=SC1091
[ -f "$LAB_ROOT_DIR/.env.mirror" ] && . "$LAB_ROOT_DIR/.env.mirror"
set +a
