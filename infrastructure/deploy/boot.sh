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

# Shared auth-profiles store mounted into every agent container (see
# infrastructure/docker/agent.yml). Must exist as a regular file before any
# container starts, or Docker bind-mounts it as an empty directory. Seed it once
# from an existing per-instance auth store (migration off the old copy-per-
# instance model) or an empty store; never clobber the live shared file.
SHARED_AUTH_DIR="$INSTANCES_DIR/shared/auth"
SHARED_AUTH_FILE="$SHARED_AUTH_DIR/auth-profiles.json"
if [ -e "$SHARED_AUTH_FILE" ] && [ ! -f "$SHARED_AUTH_FILE" ]; then
  echo "Error: shared auth path exists but is not a regular file: $SHARED_AUTH_FILE" >&2
  echo "Remove or move it, then rerun boot." >&2
  exit 1
fi
if [ ! -f "$SHARED_AUTH_FILE" ]; then
  mkdir -p "$SHARED_AUTH_DIR"
  seeded=""
  for instdir in "$INSTANCES_DIR"/[0-9]*; do
    # Skip symlinked instance dirs to honour the same no-symlink boundary the
    # router (Dirent.isDirectory) applies, so a numeric symlink can't seed
    # secrets from a path outside the intended instances tree.
    [ -d "$instdir" ] && [ ! -L "$instdir" ] || continue
    existing="$instdir/agents/main/agent/auth-profiles.json"
    [ -f "$existing" ] || continue
    cp "$existing" "$SHARED_AUTH_FILE"
    chmod 600 "$SHARED_AUTH_FILE" 2>/dev/null || true
    echo "Seeded shared auth from $existing"
    seeded=1
    break
  done
  if [ -z "$seeded" ]; then
    printf '{\n  "version": 1,\n  "profiles": {}\n}\n' > "$SHARED_AUTH_FILE"
    chmod 600 "$SHARED_AUTH_FILE" 2>/dev/null || true
  fi
fi

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

# Start per-channel agent containers (router needs them running first). With no
# instances yet we still start the router below so a fresh deployment can create
# its first channel via /channel register.
if [ -z "$ASSIGNMENTS" ]; then
  echo "No registered instances found under $INSTANCES_DIR — starting router only; use /channel register to add one."
else
  while read -r channelId port; do
    [ -z "$channelId" ] && continue
    OPENCLAW_CHANNEL_ID="$channelId" OPENCLAW_CHANNEL_PORT="$port" \
      docker compose -f ~/deploy/docker/agent.yml -p "agents-$channelId" up -d
  done <<< "$ASSIGNMENTS"
fi

# Resolve the router's Discord token. The durable source is DISCORD_BOT_TOKEN in
# ~/.env (loaded at the top of this script); setup.sh always installs that .env
# from the deploy tarball, so it is present on any properly deployed host. The
# per-instance openclaw.json scan below is a legacy fallback for hosts predating
# the .env-as-source-of-truth convention; new deploys should never hit it.
if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  echo "Warning: DISCORD_BOT_TOKEN not set in ~/.env; falling back to instance config scan." >&2
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
