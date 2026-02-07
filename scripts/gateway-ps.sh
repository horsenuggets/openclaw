#!/usr/bin/env bash
# List all running OpenClaw gateway/watchdog processes across the OS.
# Usage: bash scripts/gateway-ps.sh

set -euo pipefail

# --- Gateway processes ---
echo "=== Gateway Processes ==="

procs=$(ps aux | grep -E "(openclaw|watchdog/cli).*gateway|gateway.*(openclaw|watchdog)" | grep -v "grep" | grep -v "gateway-ps" || true)
if [ -n "$procs" ]; then
  echo "$procs"
else
  echo "(none found)"
fi

# --- Port 18789 listeners ---
echo ""
echo "=== Port 18789 ==="

listeners=$(lsof -iTCP:18789 -sTCP:LISTEN -P 2>/dev/null | tail -n +2 || true)
if [ -n "$listeners" ]; then
  echo "$listeners"
else
  echo "(none found)"
fi

# --- Watchdog PID files ---
echo ""
echo "=== Watchdog PID Files ==="

pid_found=0
for pidfile in .watchdog/gateway.pid ../../../git/openclaw/.watchdog/gateway.pid; do
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ -n "$pid" ]; then
      pid_found=1
      if kill -0 "$pid" 2>/dev/null; then
        echo "$pidfile: PID $pid (running)"
      else
        echo "$pidfile: PID $pid (stale)"
      fi
    fi
  fi
done

if [ "$pid_found" -eq 0 ]; then
  echo "(none found)"
fi
