#!/usr/bin/env bash
# Copy OAuth credentials from Mac Keychain to the OpenClaw WSL host.
# Usage: scripts/copy-oauth-credentials.sh
set -euo pipefail

HOST="${OPENCLAW_DEPLOY_HOST:?Set OPENCLAW_DEPLOY_HOST}"

echo "Reading credentials from macOS Keychain..."
CREDS=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
if [ -z "$CREDS" ]; then
  echo "Error: No Claude Code credentials found in Keychain."
  echo "Run 'claude login' locally first."
  exit 1
fi

echo "Uploading to $HOST..."
echo "$CREDS" | ssh "$HOST" 'cat > ~/.claude/.credentials.json && chmod 600 ~/.claude/.credentials.json'

echo "Updating auth profiles..."
ssh "$HOST" 'python3 -c "
import json, os

with open(os.path.expanduser(\"~/.claude/.credentials.json\")) as f:
    creds = json.load(f)[\"claudeAiOauth\"]

agent_dir = os.path.expanduser(\"~/.openclaw/agents/main/agent\")
os.makedirs(agent_dir, exist_ok=True)
auth_path = os.path.join(agent_dir, \"auth-profiles.json\")

store = {\"version\": 1, \"profiles\": {}}
if os.path.exists(auth_path):
    with open(auth_path) as f:
        store = json.load(f)

store[\"profiles\"][\"anthropic-subscription:default\"] = {
    \"type\": \"oauth\",
    \"provider\": \"anthropic-subscription\",
    \"access\": creds[\"accessToken\"],
    \"refresh\": creds[\"refreshToken\"],
    \"expires\": creds[\"expiresAt\"],
    \"scopes\": creds.get(\"scopes\", []),
}

with open(auth_path, \"w\") as f:
    json.dump(store, f, indent=2)

print(f\"Token expires: {creds[\"expiresAt\"]}\")
"'

echo "Done. Restart the gateway to pick up new credentials:"
echo "  ssh $HOST 'docker restart openclaw-gateway'"
