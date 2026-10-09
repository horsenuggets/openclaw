#!/usr/bin/env bash
# OpenClaw deployment setup script.
# Shipped inside the deploy tarball. Runs on the remote host.
#
# Stops all OpenClaw containers, replaces ~/deploy/ with new
# binaries, compose files, and .env, then restarts everything.
set -euo pipefail

echo "=== OpenClaw Setup ==="

# 1. Build the agent box image BEFORE tearing anything down. The per-channel
# agent.yml now builds a custom image (ubuntu + git) on first `up`; if that
# network-dependent build (base pull / apt) were deferred to boot.sh it would run
# after this script has already stopped and removed every container, so a build
# flake would leave the router and all agents offline. Building here, up front,
# from the freshly-staged Dockerfile (still at ./deploy, not yet moved to ~/deploy)
# means a failure aborts via `set -e` with the previous stack still running. On
# success boot's `compose up` finds openclaw-agent:latest and skips the rebuild.
echo "[1/7] Building agent box image..."
docker build -t openclaw-agent:latest -f deploy/docker/agent.Dockerfile deploy/docker

# 2. Stop all containers
echo "[2/7] Stopping containers..."
docker ps -a -q | xargs -r docker stop
docker ps -a -q | xargs -r docker rm

# 3. Create data and log directories
echo "[3/7] Creating data directories..."
mkdir -p ~/logs/whisper

# 4. Replace deploy directory (preserve models and locally-compiled tools)
echo "[4/7] Installing new deployment..."
PRESERVE_DIR=$(mktemp -d)
for dir in models bin/gog bin/whisper-server; do
  if [ -e "$HOME/deploy/$dir" ]; then
    mkdir -p "$PRESERVE_DIR/$(dirname "$dir")"
    cp -a "$HOME/deploy/$dir" "$PRESERVE_DIR/$dir"
  fi
done
rm -rf ~/deploy
mv deploy ~/deploy
# Restore persistent data
cp -a "$PRESERVE_DIR"/. ~/deploy/ 2>/dev/null || true
rm -rf "$PRESERVE_DIR"
chmod +x ~/deploy/bin/*

# 5. Install .env (always overwrite — source of truth is the tarball)
echo "[5/7] Installing .env..."
cp .env ~/.env

# 6. Install boot script. The wsl-prod scheduled task on the Windows host
# runs /usr/local/bin/wsl-boot.sh, which invokes ~/boot.sh as the deploy
# user once Docker is ready - we don't need a per-app keepalive shim.
echo "[6/7] Installing boot script..."
cp boot.sh ~/boot.sh
chmod +x ~/boot.sh

# 6b. Install + (re)start the provisioning daemon as a systemd --user unit.
# Best-effort: only meaningful when OPENCLAW_PROVISIONER_* are set in ~/.env.
if [ -f openclaw-provisioner.service ]; then
  echo "[6b] Installing provisioner systemd unit..."
  mkdir -p ~/.config/systemd/user
  cp openclaw-provisioner.service ~/.config/systemd/user/
  loginctl enable-linger "$(whoami)" 2>/dev/null || true
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable openclaw-provisioner.service 2>/dev/null || true
  # restart (not just enable --now) so a redeploy actually picks up the new
  # binary even when the unit is already running.
  systemctl --user restart openclaw-provisioner.service 2>/dev/null ||
    echo "  (provisioner unit not started; check OPENCLAW_PROVISIONER_* in ~/.env)"
fi

# 7. Start containers
echo "[7/7] Starting containers..."
bash ~/boot.sh

echo ""
echo "=== Setup Complete ==="
docker ps --format "table {{.Names}}\t{{.Status}}"
