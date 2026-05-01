#!/usr/bin/env bash
# Startup and keepalive script.
# Shipped inside the deploy tarball. Installed to ~/keepalive.sh on the remote host.
#
# Run on distro startup to start services and keep the host alive.
# Register in the Windows Task Scheduler:
#   wsl.exe -d OpenClaw -u openclaw -- bash /home/openclaw/keepalive.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$SCRIPT_DIR/logs"
LOG="$SCRIPT_DIR/logs/keepalive.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# Ensure sshd is running. Retries with exponential backoff (1s, 2s, 4s, 8s,
# 16s, 32s, 60s, 60s, ...) until sshd comes up. This handles the WSL startup
# race where wslrelay.exe briefly holds the SSH port, causing sshd to fail
# to bind and systemd to mark it failed.
ensure_sshd() {
  local delay=1
  local max_delay=60
  local attempt=1
  while ! systemctl is-active --quiet ssh; do
    log "sshd not running (attempt ${attempt}), starting..."
    # Reset any start-limit-hit state so systemd will actually attempt a start.
    sudo -n systemctl reset-failed ssh >> "$LOG" 2>&1 || true
    sudo -n systemctl start ssh >> "$LOG" 2>&1 || log "sudo systemctl start ssh failed (check sudo permissions)"
    # Re-check immediately; only sleep if sshd is still not up.
    systemctl is-active --quiet ssh && break
    log "Still not running, retrying in ${delay}s"
    sleep "$delay"
    delay=$(( delay * 2 < max_delay ? delay * 2 : max_delay ))
    attempt=$(( attempt + 1 ))
  done
  log "sshd is running."
}

# Wait for Docker to become ready; this loop only checks availability.
DOCKER_TIMEOUT=120
DOCKER_ELAPSED=0
while ! docker info >/dev/null 2>&1; do
  if [ "$DOCKER_ELAPSED" -ge "$DOCKER_TIMEOUT" ]; then
    log "ERROR: Docker did not become ready within ${DOCKER_TIMEOUT}s; giving up."
    exit 1
  fi
  log "Waiting for Docker... (${DOCKER_ELAPSED}/${DOCKER_TIMEOUT}s)"
  sleep 2
  DOCKER_ELAPSED=$((DOCKER_ELAPSED + 2))
done

# Ensure sshd is up before starting application services
ensure_sshd

# Run the application boot script
if [ -f "$SCRIPT_DIR/boot.sh" ]; then
  log "Running boot.sh..."
  if ! bash "$SCRIPT_DIR/boot.sh" >> "$LOG" 2>&1; then
    log "boot.sh failed; continuing to keepalive loop."
  fi
fi

# Keep the distro alive and watch sshd
log "Keepalive running."
while true; do
  sleep 30
  if ! systemctl is-active --quiet ssh; then
    log "sshd stopped unexpectedly; restarting."
    ensure_sshd
  fi
done
