#!/usr/bin/env bash
# Deploy OpenClaw to the production WSL instance.
#
# Compiles the binary, assembles a deploy tarball, ships it to
# the remote host, and runs setup.sh to install + restart.
#
# Usage:
#   infrastructure/deploy/deploy.sh                  # full deploy (compile + ship)
#   infrastructure/deploy/deploy.sh --skip-compile   # ship existing build
set -euo pipefail

HOST="${OPENCLAW_DEPLOY_HOST:?Set OPENCLAW_DEPLOY_HOST}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INFRA_DIR="$SCRIPT_DIR/.."
STAGING="/tmp/openclaw-deployment-staging"

echo "=== OpenClaw Deploy ==="
echo "Host: $HOST"

# 1. Compile (unless --skip-compile)
if [ "${1:-}" != "--skip-compile" ]; then
  echo "[1/4] Compiling for linux-x64..."
  cd "$PROJECT_ROOT"
  node scripts/compile.mjs --target linux-x64
else
  echo "[1/4] Skipping compile..."
fi

# 2. Assemble staging directory
echo "[2/4] Assembling deploy tarball..."
rm -rf "$STAGING"
mkdir -p "$STAGING/deploy/bin" "$STAGING/deploy/docker"

# Binaries
cp "$PROJECT_ROOT/dist/openclaw-linux-x64" "$STAGING/deploy/bin/openclaw"
cp "$PROJECT_ROOT/dist/discord-router-linux-x64" "$STAGING/deploy/bin/discord-router"
# cp "$PROJECT_ROOT/dist/whisper-linux-x64" "$STAGING/deploy/bin/whisper"  # when available

# Extensions (pre-compiled plugins)
# Extensions are now embedded in the binary. Still ship them as fallback
# for non-binary execution (dev/npm installs).
if [ -d "$PROJECT_ROOT/dist/extensions" ]; then
  cp -r "$PROJECT_ROOT/dist/extensions" "$STAGING/deploy/"
fi

# Workspace templates
if [ -d "$PROJECT_ROOT/dist/docs" ]; then
  cp -r "$PROJECT_ROOT/dist/docs" "$STAGING/deploy/"
fi

# Docker compose files
cp "$INFRA_DIR/docker/discord-router.yml" "$STAGING/deploy/docker/"
cp "$INFRA_DIR/docker/agent.yml" "$STAGING/deploy/docker/"
cp "$INFRA_DIR/docker/whisper.yml" "$STAGING/deploy/docker/"
cp "$INFRA_DIR/scripts/openclawctl" "$STAGING/deploy/bin/openclawctl"
chmod +x "$STAGING/deploy/bin/openclawctl"

# Setup + boot scripts
cp "$SCRIPT_DIR/setup.sh" "$STAGING/"
cp "$SCRIPT_DIR/boot.sh" "$STAGING/"

# Create tarball (preserves permissions)
tar czf /tmp/openclaw-deployment.tar.gz -C "$STAGING" .
rm -rf "$STAGING"

# 3. Ship to remote
echo "[3/4] Uploading to $HOST..."
scp -C /tmp/openclaw-deployment.tar.gz "$HOST:/tmp/"

# 4. Extract and run setup
echo "[4/4] Running setup on $HOST..."
ssh "$HOST" "rm -rf /tmp/openclaw-deployment && mkdir /tmp/openclaw-deployment && cd /tmp/openclaw-deployment && tar xzf /tmp/openclaw-deployment.tar.gz && bash setup.sh && rm -rf /tmp/openclaw-deployment /tmp/openclaw-deployment.tar.gz"

echo ""
echo "=== Deploy Complete ==="
