#!/usr/bin/env bash
# Deploy OpenClaw to the production host.
#
# Compiles the binaries, assembles a deploy tarball, ships it to
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

# Target architecture for the shipped binaries. Prod hosts are linux-x64, so
# that stays the default; the local docker "fake prod host" rig sets
# OPENCLAW_DEPLOY_ARCH=arm64 on Apple Silicon so the inner containers run native.
ARCH="${OPENCLAW_DEPLOY_ARCH:-x64}"
case "$ARCH" in
  x64 | arm64) ;;
  *)
    echo "Invalid OPENCLAW_DEPLOY_ARCH \"$ARCH\" (use \"x64\" or \"arm64\")." >&2
    exit 1
    ;;
esac

# Optional ssh/scp overrides so this can target a non-standard host such as the
# rig's containerised sshd (custom port, throwaway key). Empty by default, which
# leaves prod ssh-config-alias behaviour unchanged. ssh takes -p, scp takes -P.
SSH_PORT_FLAG=()
SCP_PORT_FLAG=()
if [ -n "${OPENCLAW_DEPLOY_PORT:-}" ]; then
  SSH_PORT_FLAG=(-p "$OPENCLAW_DEPLOY_PORT")
  SCP_PORT_FLAG=(-P "$OPENCLAW_DEPLOY_PORT")
fi
SSH_OPTS=()
if [ -n "${OPENCLAW_SSH_OPTS:-}" ]; then
  read -ra SSH_OPTS <<<"$OPENCLAW_SSH_OPTS"
fi

echo "=== OpenClaw Deploy ==="
echo "Host: $HOST"
echo "Arch: linux-$ARCH"

# 1. Compile (unless --skip-compile)
if [ "${1:-}" != "--skip-compile" ]; then
  echo "[1/4] Compiling for linux-$ARCH..."
  cd "$PROJECT_ROOT"
  node scripts/compile.mjs --target "linux-$ARCH"
else
  echo "[1/4] Skipping compile..."
fi

# 2. Assemble staging directory
echo "[2/4] Assembling deploy tarball..."
rm -rf "$STAGING"
mkdir -p "$STAGING/deploy/bin" "$STAGING/deploy/docker"

# Binaries
cp "$PROJECT_ROOT/dist/openclaw-linux-$ARCH" "$STAGING/deploy/bin/openclaw"
cp "$PROJECT_ROOT/dist/discord-router-linux-$ARCH" "$STAGING/deploy/bin/discord-router"
cp "$PROJECT_ROOT/dist/health-monitor-linux-$ARCH" "$STAGING/deploy/bin/health-monitor"
cp "$PROJECT_ROOT/dist/provisioner-linux-$ARCH" "$STAGING/deploy/bin/provisioner"
# cp "$PROJECT_ROOT/dist/whisper-linux-$ARCH" "$STAGING/deploy/bin/whisper"  # when available

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

# Discord embed icons. The router uploads these with each category embed; the
# compiled binary runs in a bare image with no repo tree, so ship them next to
# the binaries and point OPENCLAW_EMBED_ASSETS_DIR at the mount (discord-router.yml).
cp -r "$PROJECT_ROOT/assets/embeds" "$STAGING/deploy/embeds"

# Docker compose files
cp "$INFRA_DIR/docker/discord-router.yml" "$STAGING/deploy/docker/"
cp "$INFRA_DIR/docker/agent.yml" "$STAGING/deploy/docker/"
cp "$INFRA_DIR/docker/whisper.yml" "$STAGING/deploy/docker/"
cp "$INFRA_DIR/scripts/openclawctl" "$STAGING/deploy/bin/openclawctl"
chmod +x "$STAGING/deploy/bin/openclawctl"

# systemd unit for the host provisioning daemon
cp "$INFRA_DIR/systemd/openclaw-provisioner.service" "$STAGING/openclaw-provisioner.service"

# Environment variables (local .env or CI-generated). The source can be
# overridden so the local rig can ship a variant .env (e.g. a different or blank
# DISCORD_BOT_TOKEN so the fake host doesn't fight prod for the same bot session).
ENV_FILE="${OPENCLAW_DEPLOY_ENV_FILE:-$PROJECT_ROOT/.env}"
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$STAGING/.env"
else
  echo "Error: No .env file found at $ENV_FILE"
  exit 1
fi

# Setup + boot scripts (wsl-prod owns the keepalive watchdog now)
cp "$SCRIPT_DIR/setup.sh" "$STAGING/"
cp "$SCRIPT_DIR/boot.sh" "$STAGING/"

# Create tarball (preserves permissions). COPYFILE_DISABLE=1 stops macOS's BSD
# tar from embedding AppleDouble (._*) resource-fork files, which otherwise
# litter the remote deploy tree with hundreds of junk files.
COPYFILE_DISABLE=1 tar czf /tmp/openclaw-deployment.tar.gz --exclude='._*' -C "$STAGING" .
rm -rf "$STAGING"

# 3. Ship to remote
echo "[3/4] Uploading to $HOST..."
scp -C "${SCP_PORT_FLAG[@]}" "${SSH_OPTS[@]}" /tmp/openclaw-deployment.tar.gz "$HOST:/tmp/"

# 4. Extract and run setup
echo "[4/4] Running setup on $HOST..."
ssh "${SSH_PORT_FLAG[@]}" "${SSH_OPTS[@]}" "$HOST" "rm -rf /tmp/openclaw-deployment && mkdir /tmp/openclaw-deployment && cd /tmp/openclaw-deployment && tar xzf /tmp/openclaw-deployment.tar.gz && bash setup.sh && rm -rf /tmp/openclaw-deployment /tmp/openclaw-deployment.tar.gz"

echo ""
echo "=== Deploy Complete ==="
