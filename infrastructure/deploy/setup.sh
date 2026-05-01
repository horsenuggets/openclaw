#!/usr/bin/env bash
# OpenClaw deployment setup script.
# Shipped inside the deploy tarball. Runs on the remote host.
#
# Stops all OpenClaw containers, replaces ~/deploy/ with new
# binaries, compose files, and .env, then restarts everything.
set -euo pipefail

echo "=== OpenClaw Setup ==="

# 1. Stop all containers
echo "[1/7] Stopping containers..."
docker ps -a -q | xargs -r docker stop
docker ps -a -q | xargs -r docker rm

# 2. Create data and log directories
echo "[2/7] Creating data directories..."
mkdir -p ~/logs/whisper

# 3. Replace deploy directory (preserve models and locally-compiled tools)
echo "[3/7] Installing new deployment..."
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

# 4. Install .env (always overwrite — source of truth is the tarball)
echo "[4/7] Installing .env..."
cp .env ~/.env

# 5. Install boot script
echo "[5/7] Installing boot script..."
cp boot.sh ~/boot.sh
chmod +x ~/boot.sh

# 6. Install keepalive script
echo "[6/7] Installing keepalive script..."
cp keepalive.sh ~/keepalive.sh
chmod +x ~/keepalive.sh

# 7. Start containers
echo "[7/7] Starting containers..."
bash ~/boot.sh

echo ""
echo "=== Setup Complete ==="
docker ps --format "table {{.Names}}\t{{.Status}}"
