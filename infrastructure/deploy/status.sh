#!/usr/bin/env bash
# Check the status of the OpenClaw production deployment.
#
# Usage: infrastructure/deploy/status.sh
set -euo pipefail

HOST="${OPENCLAW_DEPLOY_HOST:?Set OPENCLAW_DEPLOY_HOST}"

echo "=== OpenClaw Production Status ==="
echo ""

echo "--- Host ---"
ssh "$HOST" 'echo "$(whoami)@$(hostname) | $(uptime)"'

echo ""
echo "--- Containers ---"
ssh "$HOST" 'docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'

echo ""
echo "--- Instances ---"
ssh "$HOST" 'ls ~/.openclaw-instances/ 2>/dev/null | grep -E "^[0-9]" | wc -l | xargs echo "Active instances:"'

echo ""
echo "--- Disk ---"
ssh "$HOST" 'df -h / 2>/dev/null | tail -1'
