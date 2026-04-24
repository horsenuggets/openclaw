#!/usr/bin/env bash
# OpenClaw distro-specific boot script.
# Called by wsl-boot.sh after Docker is ready.
# Starts all OpenClaw containers from ~/deploy/.
set -euo pipefail

# Start gateway
docker compose -f ~/deploy/docker/gateway.yml up -d

# Start whisper (if binary exists)
if [ -f ~/deploy/bin/whisper ]; then
  docker compose -f ~/deploy/docker/whisper.yml up -d
fi

# Per-user instances are managed by the gateway (not started on boot).
# To start manually:
#   OPENCLAW_USER_ID=<id> OPENCLAW_USER_PORT=<port> \
#     docker compose -f ~/deploy/docker/user.yml -p openclaw-user-<id> up -d
