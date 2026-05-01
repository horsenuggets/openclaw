#!/usr/bin/env bash
# Startup and keepalive script.
# Shipped inside the deploy tarball. Installed to ~/keepalive.sh on the remote host.
#
# Run on distro startup to start services and keep the host alive.
# Register in the Windows Task Scheduler:
#   wsl.exe -d OpenClaw -u root -- bash /home/openclaw/keepalive.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SCRIPT_DIR/logs"
LOG="$SCRIPT_DIR/logs/keepalive.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# Wait for Docker to be ready (attempt restart if it is not running)
DOCKER_TIMEOUT=120
DOCKER_ELAPSED=0
while ! docker info >/dev/null 2>&1; do
  if [ "$DOCKER_ELAPSED" -ge "$DOCKER_TIMEOUT" ]; then
    log "ERROR: Docker did not become ready within ${DOCKER_TIMEOUT}s; giving up."
    exit 1
  fi
  log "Waiting for Docker... (${DOCKER_ELAPSED}/${DOCKER_TIMEOUT}s)"
  systemctl start docker 2>/dev/null || true
  sleep 2
  DOCKER_ELAPSED=$((DOCKER_ELAPSED + 2))
done

# Run the application boot script
if [ -f "$SCRIPT_DIR/boot.sh" ]; then
  log "Running boot.sh..."
  if ! bash "$SCRIPT_DIR/boot.sh" >> "$LOG" 2>&1; then
    log "boot.sh failed; continuing to watchdog loop."
  fi
fi

# Watchdog loop — keep host alive and restart services if they crash
log "Keepalive running."
while true; do
  if ! systemctl is-active --quiet ssh 2>/dev/null; then
    log "ssh stopped, restarting..."
    systemctl start ssh 2>/dev/null || true
  fi
  if ! systemctl is-active --quiet docker 2>/dev/null; then
    log "docker stopped, restarting..."
    systemctl start docker 2>/dev/null || true
  fi
  sleep 30
done
