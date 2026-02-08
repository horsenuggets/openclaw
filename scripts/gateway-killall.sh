#!/usr/bin/env bash
# Kill all running OpenClaw gateway and watchdog processes across the OS.
# Usage: bash scripts/gateway-killall.sh
#
# This is useful when stale gateway instances are left behind by CI agents,
# Conductor worktrees, or crashed watchdog sessions.

set -euo pipefail

killed=0

echo "Searching for OpenClaw gateway processes..."

# Kill watchdog-spawned gateways and direct gateway runs.
# Matches: node <path>/openclaw.mjs gateway
#          node <path>/dist/index.js gateway
#          openclaw-gateway (compiled binary)
#          node watchdog/cli.mjs run
pids=$(pgrep -f "(openclaw\.mjs|dist/index\.js|dist/index\.mjs|dist/entry\.js) gateway|openclaw-gateway" 2>/dev/null || true)
if [ -n "$pids" ]; then
  for pid in $pids; do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    echo "  Killing PID $pid: $cmd"
    kill "$pid" 2>/dev/null || true
    killed=$((killed + 1))
  done
fi

# Kill watchdog CLI processes (node watchdog/cli.mjs run/start)
pids=$(pgrep -f "watchdog/cli\.mjs (run|start)" 2>/dev/null || true)
if [ -n "$pids" ]; then
  for pid in $pids; do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    echo "  Killing PID $pid: $cmd"
    kill "$pid" 2>/dev/null || true
    killed=$((killed + 1))
  done
fi

# Wait briefly for graceful shutdown, then force-kill any remaining.
if [ "$killed" -gt 0 ]; then
  echo "Sent SIGTERM to $killed process(es). Waiting 3s for graceful shutdown..."
  sleep 3

  # Check if any are still running and force-kill.
  remaining=$(pgrep -f "(openclaw\.mjs|dist/index\.js|dist/index\.mjs|dist/entry\.js) gateway|openclaw-gateway" 2>/dev/null || true)
  remaining2=$(pgrep -f "watchdog/cli\.mjs (run|start)" 2>/dev/null || true)
  remaining="$remaining $remaining2"
  remaining=$(echo "$remaining" | xargs)
  if [ -n "$remaining" ]; then
    echo "Force-killing remaining processes..."
    for pid in $remaining; do
      kill -9 "$pid" 2>/dev/null || true
      echo "  Force-killed PID $pid"
    done
  fi
fi

# Clean up stale PID files.
for pidfile in .watchdog/gateway.pid; do
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pidfile"
      echo "  Removed stale PID file: $pidfile"
    fi
  fi
done

if [ "$killed" -eq 0 ]; then
  echo "No OpenClaw gateway processes found."
else
  echo "Done. Killed $killed process(es)."
fi
