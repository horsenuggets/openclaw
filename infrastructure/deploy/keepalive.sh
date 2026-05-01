#!/usr/bin/env bash
# Startup and keepalive script.
# Shipped inside the deploy tarball. Installed to ~/keepalive.sh on the remote host.
#
# Run on distro startup to start services and keep the host alive.
# Register in the Windows Task Scheduler:
#   wsl.exe -d OpenClaw -- bash ~/keepalive.sh
set -euo pipefail

mkdir -p ~/logs
LOG=~/logs/keepalive.log

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# Wait for Docker to be ready
while ! docker info >/dev/null 2>&1; do
  log "Waiting for Docker..."
  sleep 2
done

# Run the application boot script
if [ -f ~/boot.sh ]; then
  log "Running boot.sh..."
  bash ~/boot.sh >> "$LOG" 2>&1
fi

# Watchdog loop — keep host alive and restart services if they crash
log "Keepalive running."
while true; do
  if ! systemctl is-active --quiet ssh 2>/dev/null; then
    log "sshd stopped, restarting..."
    systemctl start ssh 2>/dev/null || true
  fi
  if ! systemctl is-active --quiet docker 2>/dev/null; then
    log "Docker stopped, restarting..."
    systemctl start docker 2>/dev/null || true
  fi
  sleep 30
done
