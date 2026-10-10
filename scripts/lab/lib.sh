# Shared setup for the scripts/lab/*.sh wrappers. Source this, do not execute it.
#
# Loads the repo-root .env and the gitignored .env.mirror overlay so the Lab
# TypeScript entrypoints see OPENCLAW_MIRROR_DISCORD_TOKEN (the OpenClaw Mirror
# bot) and OPENCLAW_LAB_GUILD_ID (the OpenClaw Lab server). Missing values are
# left for the TypeScript to report loudly; the Lab scripts never fall back to
# the production DISCORD_BOT_TOKEN.

_LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_ROOT_DIR="$(cd "$_LAB_DIR/../.." && pwd)"
_LAB_MIRROR_ENV="$LAB_ROOT_DIR/.env.mirror"

# Preserve a caller-exported mirror token before sourcing the env files: .env (or
# .env.mirror) may also assign OPENCLAW_MIRROR_DISCORD_TOKEN, which would
# otherwise clobber an explicit `OPENCLAW_MIRROR_DISCORD_TOKEN=... scripts/lab/...`
# override. Restored after the load so the caller always wins.
_LAB_CALLER_MIRROR_TOKEN="${OPENCLAW_MIRROR_DISCORD_TOKEN:-}"

set -a
# shellcheck disable=SC1091
[ -f "$LAB_ROOT_DIR/.env" ] && . "$LAB_ROOT_DIR/.env"
# shellcheck disable=SC1091
[ -f "$_LAB_MIRROR_ENV" ] && . "$_LAB_MIRROR_ENV"
set +a

if [ -n "$_LAB_CALLER_MIRROR_TOKEN" ]; then
  OPENCLAW_MIRROR_DISCORD_TOKEN="$_LAB_CALLER_MIRROR_TOKEN"
  export OPENCLAW_MIRROR_DISCORD_TOKEN
fi

# The mirror overlay convention (see .env.template and scripts/sync-app-emojis.sh)
# stores the Mirror bot token as DISCORD_BOT_TOKEN, overriding the base prod
# value. loadLabConfig reads it as OPENCLAW_MIRROR_DISCORD_TOKEN, so map it here
# when the overlay did not already set that name. The isolated subshell unsets
# DISCORD_BOT_TOKEN first, so an overlay that omits it yields an empty result
# (and a loud failure downstream) rather than silently reusing the prod token.
if [ -z "${OPENCLAW_MIRROR_DISCORD_TOKEN:-}" ] && [ -f "$_LAB_MIRROR_ENV" ]; then
  OPENCLAW_MIRROR_DISCORD_TOKEN="$(
    unset DISCORD_BOT_TOKEN
    set -a
    # shellcheck disable=SC1091
    . "$_LAB_MIRROR_ENV"
    set +a
    printf '%s' "${DISCORD_BOT_TOKEN:-}"
  )"
  export OPENCLAW_MIRROR_DISCORD_TOKEN
fi
