#!/usr/bin/env bash
# OpenClaw deployment setup script.
# Shipped inside the deploy tarball. Runs on the remote host.
#
# Stops all OpenClaw containers, replaces ~/deploy/ with new
# binaries, compose files, and .env, then restarts everything.
set -euo pipefail

echo "=== OpenClaw Setup ==="

# 1. Create data and log directories
echo "[1/7] Creating data directories..."
mkdir -p ~/logs/whisper

# 2. Preserve any legacy in-container workspace/memory before we remove old
# containers. Use the incoming openclawctl from the extracted deploy bundle so
# the latest repair logic runs even while the previous install is still live.
echo "[2/7] Preserving legacy agent data..."
bash deploy/bin/openclawctl sanitize-configs --preserve-legacy-data

# 3. Stop all containers
echo "[3/7] Stopping containers..."
docker ps -a -q | xargs -r docker stop
docker ps -a -q | xargs -r docker rm

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

# 7. Start containers
echo "[7/7] Starting containers..."
bash ~/boot.sh

echo ""
echo "=== Setup Complete ==="
docker ps --format "table {{.Names}}\t{{.Status}}"
