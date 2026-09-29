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
#   scripts/prod-mirror.sh up [--live]      # build, start box, deploy, run provisioner
#   scripts/prod-mirror.sh deploy           # re-run deploy into a running box (after code changes)
#   scripts/prod-mirror.sh register <id>    # openclawctl add-channel <id> (solo test, no Discord)
#   scripts/prod-mirror.sh mint             # mint a subscription token into the box (browser)
#   scripts/prod-mirror.sh inner <args...>  # run a docker command inside the box
#   scripts/prod-mirror.sh ps               # inner `docker ps`
#   scripts/prod-mirror.sh logs [name]      # box log, or an inner container's log
#   scripts/prod-mirror.sh sh               # shell into the box
#   scripts/prod-mirror.sh down [--clean]   # stop the box (and wipe the rig keypair)
#
# Discord: by default the box ships a BLANK DISCORD_BOT_TOKEN so it never fights
# prod for the same bot session. `up --live` requires OPENCLAW_MIRROR_DISCORD_TOKEN
# to be set (use a dedicated bot, not the prod one) so the box's router connects
# to real Discord.
#
# Env overrides:
#   OPENCLAW_MIRROR_SSH_PORT       host port mapped to the box sshd (default 2299)
#   OPENCLAW_MIRROR_DISCORD_TOKEN  bot token for `up --live`
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

ensure_image() {
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "Building $IMAGE image..."
    docker build -f "$DOCKERFILE" -t "$IMAGE" "$(dirname "$DOCKERFILE")"
  fi
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

# Copy the repo .env but force DISCORD_BOT_TOKEN to the rig's choice so the box
# never reuses the prod bot session by accident.
build_box_env() {
  local token="$1"
  mkdir -p "$RIG_DIR"
  [ -f "$ROOT_DIR/.env" ] || die "repo .env not found; the box needs the provisioner + guild/role vars."
  grep -v '^DISCORD_BOT_TOKEN=' "$ROOT_DIR/.env" >"$BOX_ENV"
  printf 'DISCORD_BOT_TOKEN=%s\n' "$token" >>"$BOX_ENV"
}

run_deploy() {
  local skip=()
  if [ -x "$ROOT_DIR/dist/openclaw-linux-$ARCH" ] &&
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
  local live=""
  [ "${1:-}" = "--live" ] && live=1
  require_docker
  ensure_image
  ensure_key

  local token=""
  if [ -n "$live" ]; then
    # Prefer an explicit override (a dedicated test bot); otherwise fall back to
    # the repo .env bot (the real OpenClaw bot). Reusing the prod bot is only safe
    # while prod's own router is stopped, or the two fight over one gateway session.
    token="${OPENCLAW_MIRROR_DISCORD_TOKEN:-}"
    if [ -n "$token" ]; then
      echo "Live mode: using OPENCLAW_MIRROR_DISCORD_TOKEN."
    else
      token="$(grep -m1 '^DISCORD_BOT_TOKEN=' "$ROOT_DIR/.env" | cut -d= -f2-)"
      [ -n "$token" ] || die "--live needs a token: set OPENCLAW_MIRROR_DISCORD_TOKEN or DISCORD_BOT_TOKEN in .env."
      echo "Live mode: using the OpenClaw bot from .env. Make sure prod's router is stopped."
    fi
  else
    echo "Offline mode: blank Discord token (router will idle). Use 'up --live' for real Discord."
  fi
  build_box_env "$token"

  echo "Starting the box (privileged, sshd on :$SSH_PORT)..."
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --privileged --name "$CONTAINER" -p "$SSH_PORT:22" \
    -e AUTHORIZED_KEY="$(cat "$KEY.pub")" "$IMAGE" >/dev/null
  wait_ready || { echo "box did not become ready; see: scripts/prod-mirror.sh logs" >&2; exit 1; }

  run_deploy
  start_provisioner
  echo ""
  echo "Box up. Inner containers: scripts/prod-mirror.sh ps"
  [ -n "$live" ] && echo "Register a channel from Discord, or (solo) scripts/prod-mirror.sh register <id>"
}

cmd_deploy() {
  require_docker
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "box not running; run 'up' first."
  # Reuse whatever token the last box.env had; regenerate from repo if missing.
  [ -f "$BOX_ENV" ] || build_box_env ""
  run_deploy
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
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
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
      echo "usage: $0 {up [--live]|deploy|register <id>|mint|inner <args>|ps|logs [name]|sh|down [--clean]}" >&2
      exit 1
      ;;
  esac
}

main "$@"
