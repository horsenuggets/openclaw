#!/usr/bin/env bash
# OpenClaw distro-specific boot script.
# Called by wsl-boot.sh after Docker is ready.
# Starts the discord router and all per-user gateway containers.
set -euo pipefail

# Start per-user gateway containers first (router needs them running).
# Sorted alphabetically to match the discord-router's port assignment order.
PORT=18789
for id in $(ls ~/.openclaw-instances/ | grep -E '^[0-9]+$' | sort); do
  OPENCLAW_USER_ID="$id" OPENCLAW_USER_PORT="$PORT" \
    docker compose -f ~/deploy/docker/user.yml -p "openclaw-user-$id" up -d
  PORT=$((PORT + 2))
done

# Start discord router (connects to Discord, routes DMs to user containers)
# Reads DISCORD_BOT_TOKEN from the first user's openclaw.json if not set in env
if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  for dir in ~/.openclaw-instances/*/; do
    [ -d "$dir" ] || continue
    id=$(basename "$dir")
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    DISCORD_BOT_TOKEN=$(python3 -c "
import json, sys
try:
    cfg = json.load(open('$dir/openclaw.json'))
    print(cfg.get('channels',{}).get('discord',{}).get('token',''))
except: pass
" 2>/dev/null)
    [ -n "$DISCORD_BOT_TOKEN" ] && break
  done
  export DISCORD_BOT_TOKEN
fi

DISCORD_BOT_TOKEN="$DISCORD_BOT_TOKEN" \
  docker compose -f ~/deploy/docker/discord-router.yml up -d
