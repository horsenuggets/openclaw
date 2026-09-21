#!/usr/bin/env bash
# OpenClaw boot script.
# Shipped inside the deploy tarball. Installed to ~/boot.sh on the remote host.
# Starts per-channel agent containers and the discord router.
set -euo pipefail

# Load deployment env (Discord token, whitelist guild/role, provisioner
# port/token, etc.) so the compose files below get their ${VAR} substitutions.
# Without this the router would come up with whitelist and provisioning
# disabled after a reboot.
if [ -f "$HOME/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.env"
  set +a
fi

INSTANCES_DIR="$HOME/.openclaw-instances"

# Each instance owns its port as a `.port` dotfile in its own directory, so
# there is no central ports.json to read or reconcile. Discover channels by
# scanning for those dotfiles.
ASSIGNMENTS=$(python3 -c "
import os, re
instances_dir = '$INSTANCES_DIR'
rows = []
if os.path.isdir(instances_dir):
    # Iterate with scandir and require a real, non-symlink directory — the
    # same no-symlink boundary the router applies via Dirent.isDirectory().
    # Otherwise a numeric symlink to an external dir could be started here
    # but never loaded by the router (and could escape INSTANCES_DIR).
    for entry in sorted(os.scandir(instances_dir), key=lambda e: e.name):
        if not re.match(r'^\d{17,20}\$', entry.name):
            continue
        if not entry.is_dir(follow_symlinks=False):
            continue
        pf = os.path.join(entry.path, '.port')
        if not os.path.isfile(pf):
            continue
        raw = open(pf).read().strip()
        # Same strict rule the router uses: all ASCII digits, value > 0.
        # Rejects '0', negatives, and trailing junk so the container we
        # start here always matches the instance set the router will load.
        if not re.fullmatch(r'[0-9]+', raw):
            continue
        port = int(raw)
        if port <= 0:
            continue
        rows.append((entry.name, port))
for cid, port in sorted(rows, key=lambda x: x[1]):
    print(f'{cid} {port}')
" 2>/dev/null)

if [ -z "$ASSIGNMENTS" ]; then
  echo "No registered instances found under $INSTANCES_DIR — run openclawctl to register channels first."
  exit 1
fi

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
