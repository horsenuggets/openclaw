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

# 2. Replace deploy directory (preserve persistent data: models, locally-compiled tools)
echo "[2/5] Installing new deployment..."
# Back up persistent data that isn't in the tarball
for dir in models bin/gog bin/whisper-server; do
  if [ -e "$HOME/deploy/$dir" ]; then
    mkdir -p /tmp/deploy-preserve/$(dirname "$dir")
    cp -a "$HOME/deploy/$dir" "/tmp/deploy-preserve/$dir"
  fi
done
rm -rf ~/deploy
mv deploy ~/deploy
# Restore persistent data
if [ -d /tmp/deploy-preserve ]; then
  cp -a /tmp/deploy-preserve/* ~/deploy/ 2>/dev/null || true
  rm -rf /tmp/deploy-preserve
fi
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
