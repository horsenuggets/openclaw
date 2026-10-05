#!/usr/bin/env bash
# Local "fake prod host" docker test rig.
#
# Boots a single privileged container that mirrors the WSL prod host (Ubuntu +
# Docker Engine, see infrastructure/docker/prod-mirror.Dockerfile), then runs the
# REAL deploy pipeline into it (infrastructure/deploy/deploy.sh -> setup.sh ->
# boot.sh) so the router + provisioner + per-channel agent containers come up
# inside it exactly like prod, with working host networking. You then register a
# channel from Discord and chat in a real channel.
#
# Usage:
#   scripts/prod-mirror.sh up [--live] [--build]  # build, start box, deploy, run provisioner
#   scripts/prod-mirror.sh deploy [--build] # re-run deploy into a running box (after code changes)
#   scripts/prod-mirror.sh register <id>    # openclawctl add-channel <id> (solo test, no Discord)
#   scripts/prod-mirror.sh mint             # mint a subscription token into the box (browser)
#   scripts/prod-mirror.sh inner <args...>  # run a docker command inside the box
#   scripts/prod-mirror.sh ps               # inner `docker ps`
#   scripts/prod-mirror.sh logs [name]      # box log, or an inner container's log
#   scripts/prod-mirror.sh sh               # shell into the box
#   scripts/prod-mirror.sh down [--clean]   # stop the box (and wipe the rig keypair)
#
# Discord: by default the box ships a BLANK DISCORD_BOT_TOKEN so it never fights
# prod for the same bot session. `up --live` overlays .env.mirror onto .env (the
# mirror file's DISCORD_BOT_TOKEN is the dedicated OpenClawMirror bot, not prod),
# so the box's router connects to real Discord as that bot. .env.mirror is
# gitignored and never deployed, so the prod bot and the mirror bot never mix.
#
# Env overrides:
#   OPENCLAW_MIRROR_SSH_PORT  host port mapped to the box sshd (default 2299)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="openclaw-prod-mirror"
CONTAINER="openclaw-prod-mirror"
DOCKERFILE="$ROOT_DIR/infrastructure/docker/prod-mirror.Dockerfile"
SSH_PORT="${OPENCLAW_MIRROR_SSH_PORT:-2299}"
RIG_DIR="$ROOT_DIR/.prod-mirror"
KEY="$RIG_DIR/id_rig"
BOX_ENV="$RIG_DIR/box.env"

case "$(uname -m)" in
  arm64 | aarch64) ARCH="arm64" ;;
  *) ARCH="x64" ;;
esac

SSH_COMMON=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)

die() {
  echo "error: $*" >&2
  exit 1
}

require_docker() {
  docker info >/dev/null 2>&1 || die "Docker is not running (open -a Docker)."
}

# Always build so edits to the Dockerfile/entrypoint are picked up on the next
# `up`. Docker's layer cache keeps this near-instant when nothing changed.
ensure_image() {
  echo "Building $IMAGE image..."
  docker build -f "$DOCKERFILE" -t "$IMAGE" "$(dirname "$DOCKERFILE")"
}

ensure_key() {
  mkdir -p "$RIG_DIR"
  if [ ! -f "$KEY" ]; then
    ssh-keygen -t ed25519 -N "" -f "$KEY" -q
  fi
}

box_ssh() {
  ssh -i "$KEY" -p "$SSH_PORT" "${SSH_COMMON[@]}" root@localhost "$@"
}

wait_ready() {
  echo "Waiting for the box (sshd + inner dockerd)..."
  local i
  for i in $(seq 1 60); do
    if box_ssh "docker info >/dev/null 2>&1 && echo ok" 2>/dev/null | grep -q ok; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Merge KEY=VALUE env files, later files overriding earlier on duplicate keys,
# preserving first-seen order. Comments and blank lines are dropped (box.env is a
# machine file). This is the same overlay the shell does with
# `set -a; . .env; . .env.mirror; set +a`, flattened into one deduped file.
merge_env_files() {
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
      eq = index($0, "=")
      if (eq == 0) next
      key = substr($0, 1, eq - 1)
      # Normalize the key so dedup is reliable: strip leading/trailing whitespace
      # and an optional `export ` prefix (e.g. `export FOO` and `FOO` collide).
      sub(/^[[:space:]]+/, "", key)
      sub(/^export[[:space:]]+/, "", key)
      sub(/[[:space:]]+$/, "", key)
      if (!(key in seen)) { order[++n] = key; seen[key] = 1 }
      val[key] = $0
    }
    END { for (i = 1; i <= n; i++) print val[order[i]] }
  ' "$@"
}

# Build the box's ~/.env. In offline mode it is the base .env with a BLANK
# DISCORD_BOT_TOKEN (the router stays down; use `register` for solo tests). In
# live mode it is .env overlaid with .env.mirror (the OpenClawMirror bot plus the
# mirror-only overrides), so the box never reuses the prod bot session.
build_box_env() {
  local mode="$1" # "live" or "offline"
  mkdir -p "$RIG_DIR"
  [ -f "$ROOT_DIR/.env" ] || die "repo .env not found; the box needs the provisioner + guild/role vars."
  # Assemble into a temp file and only move it into place after validation passes,
  # so a failed live-mode check never leaves a box.env behind that a later
  # `deploy` would reuse (which could ship the prod token to the mirror box).
  # mktemp creates it 0600, so the rig's secrets are not world-readable.
  local tmp
  tmp=$(mktemp "$RIG_DIR/.box.env.XXXXXX")
  if [ "$mode" = "live" ]; then
    [ -f "$ROOT_DIR/.env.mirror" ] ||
      { rm -f "$tmp"; die "--live requires .env.mirror (the OpenClawMirror bot token + mirror-only overrides)."; }
    merge_env_files "$ROOT_DIR/.env" "$ROOT_DIR/.env.mirror" >"$tmp"
    # The overlay must actually replace the prod token. If .env.mirror omits (or
    # blanks) DISCORD_BOT_TOKEN, the merged value falls back to .env's prod token
    # and the box would open a second gateway session on the prod bot, fighting
    # prod — the exact conflict this rig exists to avoid.
    # Compare the EFFECTIVE values boot.sh will see (each file sourced the same
    # way boot.sh sources ~/.env), not raw text. Comparing raw right-hand sides
    # would let shell-equivalent quoting/whitespace mask a reused prod token
    # (e.g. base `TOKEN=x` vs mirror `TOKEN="x"` are identical once sourced).
    local base_token merged_token
    base_token=$(set -a; . "$ROOT_DIR/.env"; printf '%s' "${DISCORD_BOT_TOKEN:-}")
    merged_token=$(set -a; . "$tmp"; printf '%s' "${DISCORD_BOT_TOKEN:-}")
    [ -n "$merged_token" ] && [ "$merged_token" != "$base_token" ] ||
      { rm -f "$tmp"; die ".env.mirror must set a non-empty DISCORD_BOT_TOKEN (the OpenClawMirror bot) that differs from the prod token in .env."; }
  else
    grep -vE '^[[:space:]]*(export[[:space:]]+)?DISCORD_BOT_TOKEN=' "$ROOT_DIR/.env" >"$tmp"
    printf 'DISCORD_BOT_TOKEN=\n' >>"$tmp"
  fi
  mv "$tmp" "$BOX_ENV"
}

# $1: "build" to force a recompile, anything else to reuse existing binaries.
run_deploy() {
  local force_build="${1:-}"
  local skip=()
  if [ "$force_build" != "build" ] &&
    [ -x "$ROOT_DIR/dist/openclaw-linux-$ARCH" ] &&
    [ -x "$ROOT_DIR/dist/discord-router-linux-$ARCH" ] &&
    [ -x "$ROOT_DIR/dist/health-monitor-linux-$ARCH" ] &&
    [ -x "$ROOT_DIR/dist/provisioner-linux-$ARCH" ]; then
    skip=(--skip-compile)
    echo "Reusing existing dist/*-linux-$ARCH binaries (pass 'deploy --build' to recompile)."
  fi
  OPENCLAW_DEPLOY_HOST="root@localhost" \
    OPENCLAW_DEPLOY_PORT="$SSH_PORT" \
    OPENCLAW_DEPLOY_ARCH="$ARCH" \
    OPENCLAW_DEPLOY_ENV_FILE="$BOX_ENV" \
    OPENCLAW_SSH_OPTS="-i $KEY ${SSH_COMMON[*]}" \
    bash "$ROOT_DIR/infrastructure/deploy/deploy.sh" "${skip[@]}"
}

# The provisioner runs as a systemd --user unit in prod; the box has no systemd,
# so start it with the same env (EnvironmentFile ~/.env, ExecStart
# ~/deploy/bin/provisioner). openclawctl is resolved next to the binary
# automatically.
#
# Start it with `docker exec -d` against the box container rather than over ssh.
# A backgrounded ssh child (setsid/nohup/`ssh -f`) is reaped when its parent
# process group is torn down, which killed the provisioner mid-startup. Docker's
# native detach runs it in the box's own PID namespace (PID 1 = the box
# entrypoint), so it survives independently of this script's ssh/exec lifetime.
start_provisioner() {
  echo "Starting the provisioner inside the box..."
  docker exec "$CONTAINER" bash -c \
    'pkill -f deploy/bin/provisioner 2>/dev/null || true' >/dev/null 2>&1 || true
  docker exec -d "$CONTAINER" bash -c \
    'set -a; . "$HOME/.env" 2>/dev/null; set +a;
     [ -n "${OPENCLAW_PROVISIONER_PORT:-}" ] && [ -n "${OPENCLAW_PROVISIONER_TOKEN:-}" ] || exit 0;
     exec "$HOME/deploy/bin/provisioner" >/var/log/provisioner.log 2>&1'
  local i
  for i in $(seq 1 12); do
    if docker exec "$CONTAINER" bash -c \
      'set -a; . "$HOME/.env" 2>/dev/null; set +a;
       ss -ltn 2>/dev/null | grep -q ":${OPENCLAW_PROVISIONER_PORT:-0}"' 2>/dev/null; then
      echo "  provisioner listening."
      return 0
    fi
    sleep 1
  done
  echo "  WARNING: provisioner did not come up (see 'prod-mirror.sh sh' -> /var/log/provisioner.log)" >&2
}

cmd_up() {
  local live="" build=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --live) live=1 ;;
      --build) build="build" ;;
      *) die "unknown 'up' flag: $1 (use --live and/or --build)" ;;
    esac
    shift
  done
  require_docker
  ensure_image
  ensure_key

  if [ -n "$live" ]; then
    # Overlay .env.mirror onto .env. The mirror file's DISCORD_BOT_TOKEN is the
    # dedicated OpenClawMirror bot, never prod: running the mirror's router on the
    # prod bot would start a second gateway session for the same bot and fight prod
    # for the connection, the exact conflict this rig exists to avoid. (To
    # knowingly reuse the prod bot while prod's own router is stopped, put its token
    # in .env.mirror.)
    echo "Live mode: overlaying .env.mirror (OpenClawMirror bot)."
    build_box_env "live"
  else
    # The router requires a Discord token (loadRouterConfig throws on an empty
    # one), so with a blank token its container just crash-loops under the health
    # monitor. Offline mode is for exercising the box + deploy + provisioner +
    # per-channel agents via `register` (solo, no Discord); use `up --live` to
    # bring the router up against real Discord.
    echo "Offline mode: no Discord token. The router will not run; use 'register <id>'"
    echo "for solo agent testing, or 'up --live' for the full stack against Discord."
    build_box_env "offline"
  fi

  echo "Starting the box (privileged, sshd on :$SSH_PORT)..."
  # -v on removal takes the anonymous /var/lib/docker volume (multi-GB inner image
  # store) with it, so repeated `up` runs do not orphan volumes. The sshd port is
  # bound to loopback only: the rig is driven entirely through localhost, so there
  # is no reason to expose root ssh to the LAN.
  docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --privileged --name "$CONTAINER" -p "127.0.0.1:$SSH_PORT:22" \
    -e AUTHORIZED_KEY="$(cat "$KEY.pub")" "$IMAGE" >/dev/null
  wait_ready || { echo "box did not become ready; see: scripts/prod-mirror.sh logs" >&2; exit 1; }

  run_deploy "$build"
  start_provisioner
  echo ""
  echo "Box up. Inner containers: scripts/prod-mirror.sh ps"
  [ -n "$live" ] && echo "Register a channel from Discord, or (solo) scripts/prod-mirror.sh register <id>"
}

cmd_deploy() {
  local build=""
  [ "${1:-}" = "--build" ] && build="build"
  require_docker
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "box not running; run 'up' first."
  # Reuse whatever the last box.env had; rebuild offline from repo if missing.
  [ -f "$BOX_ENV" ] || build_box_env "offline"
  run_deploy "$build"
  start_provisioner
}

cmd_register() {
  [ "$#" -ge 1 ] || die "usage: prod-mirror.sh register <channelId>"
  box_ssh "\$HOME/deploy/bin/openclawctl add-channel $1"
}

cmd_mint() {
  OPENCLAW_DEPLOY_HOST="root@localhost" \
    OPENCLAW_DEPLOY_PORT="$SSH_PORT" \
    OPENCLAW_SSH_OPTS="-i $KEY ${SSH_COMMON[*]}" \
    bash "$ROOT_DIR/scripts/mint-anthropic-reauth.sh" --store shared
}

cmd_inner() {
  [ "$#" -ge 1 ] || die "usage: prod-mirror.sh inner <docker args...>"
  box_ssh "docker $*"
}

cmd_ps() {
  box_ssh "docker ps --format 'table {{.Names}}\t{{.Status}}'"
}

cmd_logs() {
  if [ "$#" -ge 1 ]; then
    box_ssh "docker logs --tail 200 $1"
  else
    docker logs --tail 200 "$CONTAINER"
  fi
}

cmd_sh() {
  ssh -t -i "$KEY" -p "$SSH_PORT" "${SSH_COMMON[@]}" root@localhost
}

cmd_down() {
  # -v also removes the anonymous /var/lib/docker volume (inner image store).
  docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
  echo "Box removed."
  if [ "${1:-}" = "--clean" ]; then
    rm -rf "$RIG_DIR"
    echo "Wiped $RIG_DIR (keypair + box.env)."
  fi
}

main() {
  local sub="${1:-}"
  [ "$#" -ge 1 ] && shift || true
  case "$sub" in
    up) cmd_up "$@" ;;
    deploy) cmd_deploy "$@" ;;
    register) cmd_register "$@" ;;
    mint) cmd_mint "$@" ;;
    inner) cmd_inner "$@" ;;
    ps) cmd_ps "$@" ;;
    logs) cmd_logs "$@" ;;
    sh) cmd_sh "$@" ;;
    down) cmd_down "$@" ;;
    *)
      echo "usage: $0 {up [--live] [--build]|deploy [--build]|register <id>|mint|inner <args>|ps|logs [name]|sh|down [--clean]}" >&2
      exit 1
      ;;
  esac
}

main "$@"
