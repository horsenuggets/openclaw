#!/usr/bin/env bash
# Deploy OpenClaw Docker instances.
#
# Usage:
#   ./scripts/docker-deploy.sh              # deploy all instances
#   ./scripts/docker-deploy.sh 0001         # deploy single instance
#   ./scripts/docker-deploy.sh --build-only # just build, don't start
#   ./scripts/docker-deploy.sh --setup 0003 # create new instance + onboard
#
# Environment:
#   OPENCLAW_INSTANCES_DIR  — base dir (default: ~/.openclaw-instances)
#   OPENCLAW_IMAGE          — Docker image name (default: openclaw:local)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.instances.yml"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
INSTANCES_DIR="${OPENCLAW_INSTANCES_DIR:-$HOME/.openclaw-instances}"

# Parse args
ACTION="deploy"
TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-only) ACTION="build"; shift ;;
    --setup) ACTION="setup"; shift ;;
    --stop) ACTION="stop"; shift ;;
    --status) ACTION="status"; shift ;;
    --logs) ACTION="logs"; shift ;;
    [0-9][0-9][0-9][0-9]) TARGET="$1"; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

build_image() {
  echo "Building Docker image: $IMAGE_NAME"
  cd "$ROOT_DIR"
  git pull --ff-only origin main 2>/dev/null || true
  docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"
  echo "Image built: $IMAGE_NAME"
}

ensure_instance_dir() {
  local id="$1"
  local dir="$INSTANCES_DIR/$id"
  if [ ! -d "$dir" ]; then
    echo "Creating instance directory: $dir"
    mkdir -p "$dir/workspace" "$dir/agents"
    # Generate a random gateway token
    local token
    token=$(openssl rand -hex 24 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(24))")
    echo "Generated gateway token for instance $id"
    # Write minimal env hint
    echo "OPENCLAW_${id}_TOKEN=$token" >> "$INSTANCES_DIR/.env"
    echo "Instance $id created at $dir"
    echo "  Token: $token"
    echo ""
    echo "Next: run onboarding to configure Discord, auth, etc.:"
    echo "  docker compose -f $COMPOSE_FILE run --rm openclaw-$id node dist/index.js onboard"
  fi
}

case "$ACTION" in
  build)
    build_image
    ;;

  setup)
    if [ -z "$TARGET" ]; then
      echo "Usage: $0 --setup NNNN"
      exit 1
    fi
    ensure_instance_dir "$TARGET"
    build_image
    echo ""
    echo "Running onboarding for instance $TARGET..."
    docker compose -f "$COMPOSE_FILE" run --rm "openclaw-$TARGET" \
      node dist/index.js onboard
    ;;

  deploy)
    build_image
    if [ -n "$TARGET" ]; then
      ensure_instance_dir "$TARGET"
      echo "Starting instance $TARGET..."
      docker compose -f "$COMPOSE_FILE" up -d "openclaw-$TARGET"
    else
      # Deploy all instances that have directories
      for dir in "$INSTANCES_DIR"/[0-9][0-9][0-9][0-9]; do
        [ -d "$dir" ] || continue
        id="$(basename "$dir")"
        ensure_instance_dir "$id"
      done
      echo "Starting all instances..."
      docker compose -f "$COMPOSE_FILE" up -d
    fi
    echo ""
    docker compose -f "$COMPOSE_FILE" ps
    ;;

  stop)
    if [ -n "$TARGET" ]; then
      docker compose -f "$COMPOSE_FILE" stop "openclaw-$TARGET"
    else
      docker compose -f "$COMPOSE_FILE" stop
    fi
    ;;

  status)
    docker compose -f "$COMPOSE_FILE" ps
    ;;

  logs)
    if [ -n "$TARGET" ]; then
      docker compose -f "$COMPOSE_FILE" logs -f "openclaw-$TARGET"
    else
      docker compose -f "$COMPOSE_FILE" logs -f
    fi
    ;;
esac
