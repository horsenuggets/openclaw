#!/usr/bin/env bash
# OpenClaw boot script.
# Shipped inside the deploy tarball. Installed to ~/boot.sh on the remote host.
# Starts per-channel agent containers and the discord router.
set -euo pipefail

INSTANCES_DIR="$HOME/.openclaw-instances"
PORTS_FILE="$INSTANCES_DIR/ports.json"

if [ ! -f "$PORTS_FILE" ]; then
  echo "No ports.json found at $PORTS_FILE — run openclawctl to register channels first."
  exit 1
fi

# Reconcile ports.json with actual instance directories on boot
~/deploy/bin/openclawctl reconcile

# Read port assignments into a temp file to avoid subshell issues with pipes
ASSIGNMENTS=$(python3 -c "
import json
ports = json.load(open('$PORTS_FILE'))
for cid, port in sorted(ports.get('assignments', {}).items(), key=lambda x: x[1]):
    print(f'{cid} {port}')
" 2>/dev/null)

# Start per-channel agent containers (router needs them running first)
while read -r channelId port; do
  [ -z "$channelId" ] && continue
  OPENCLAW_CHANNEL_ID="$channelId" OPENCLAW_CHANNEL_PORT="$port" \
    docker compose -f ~/deploy/docker/agent.yml -p "agents-$channelId" up -d
done <<< "$ASSIGNMENTS"

# Start discord router
if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  for dir in "$INSTANCES_DIR"/*/; do
    [ -d "$dir" ] || continue
    DISCORD_BOT_TOKEN=$(python3 -c "
import json
try:
    cfg = json.load(open('${dir}openclaw.json'))
    print(cfg.get('channels',{}).get('discord',{}).get('token',''))
except: pass
" 2>/dev/null)
    [ -n "$DISCORD_BOT_TOKEN" ] && break
  done
  export DISCORD_BOT_TOKEN
fi

# Start whisper (speech-to-text)
docker compose -f ~/deploy/docker/whisper.yml -p services-whisper up -d

# Start discord router
DISCORD_BOT_TOKEN="$DISCORD_BOT_TOKEN" \
  docker compose -f ~/deploy/docker/discord-router.yml -p services up -d
