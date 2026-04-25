#!/usr/bin/env bash
# OpenClaw deployment setup script.
# Shipped inside the deploy tarball. Runs on the WSL host.
#
# Stops all OpenClaw containers, replaces ~/deploy/ with new
# binaries and compose files, installs boot.sh and .env, restarts.
set -euo pipefail

echo "=== OpenClaw Setup ==="

# 1. Stop all containers (this WSL distro is exclusively OpenClaw)
echo "[1/5] Stopping containers..."
docker ps -a -q | xargs -r docker stop
docker ps -a -q | xargs -r docker rm

# 2. Replace deploy directory
echo "[2/5] Installing new deployment..."
rm -rf ~/deploy
mv deploy ~/deploy
chmod +x ~/deploy/bin/*

# 3. Install .env (if shipped in tarball)
if [ -f .env ]; then
  echo "[3/5] Installing .env..."
  cp .env ~/.env
else
  echo "[3/5] No .env in tarball, keeping existing..."
fi

# 4. Install boot script
echo "[4/5] Installing boot script..."
cp boot.sh ~/boot.sh
chmod +x ~/boot.sh

# 5. Start containers
echo "[5/5] Starting containers..."
bash ~/boot.sh

echo ""
echo "=== Setup Complete ==="
docker ps --format "table {{.Names}}\t{{.Status}}"
