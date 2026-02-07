#!/usr/bin/env bash
# List all running OpenClaw gateway/watchdog processes across the OS.
# Usage: bash scripts/gateway-ps.sh

set -euo pipefail

echo "=== OpenClaw Gateway Processes ==="
echo ""

# Pattern 1: Watchdog-spawned gateways (node ... openclaw.mjs gateway)
# Pattern 2: Direct gateway runs (node ... dist/index.js gateway, etc.)
# Pattern 3: Watchdog CLI itself (node watchdog/cli.mjs run)
# Pattern 4: Gateway via pnpm (openclaw gateway)

found=0

# Find all node processes with "gateway" in their args that look like openclaw
while IFS= read -r line; do
  if [ -n "$line" ]; then
    found=1
    echo "$line"
  fi
done < <(ps aux | grep -E "(openclaw|watchdog/cli).*gateway|gateway.*(openclaw|watchdog)" | grep -v "grep" | grep -v "gateway-ps" || true)

echo ""

# Also check for processes listening on common gateway ports
echo "=== Ports with listeners (18789 and common test ports) ==="
for port in 18789; do
  result=$(lsof -iTCP:"$port" -sTCP:LISTEN -P 2>/dev/null | tail -n +2 || true)
  if [ -n "$result" ]; then
    found=1
    echo "Port $port:"
    echo "$result"
    echo ""
  fi
done

# Check watchdog state directories for PID files
echo "=== Watchdog PID files ==="
for pidfile in .watchdog/gateway.pid ../../../git/openclaw/.watchdog/gateway.pid; do
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ -n "$pid" ]; then
      if kill -0 "$pid" 2>/dev/null; then
        echo "$pidfile: PID $pid (running)"
        found=1
      else
        echo "$pidfile: PID $pid (stale)"
      fi
    fi
  fi
done

if [ "$found" -eq 0 ]; then
  echo "(none found)"
fi
