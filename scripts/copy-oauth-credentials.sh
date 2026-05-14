#!/usr/bin/env bash
# Copy OAuth credentials from Mac Keychain to the OpenClaw WSL host.
#
# This pushes the freshly-refreshed Claude Code OAuth tokens (access +
# refresh + expiry) from the local macOS Keychain to:
#
#   1. ~/.claude/.credentials.json on the deploy host (the shared
#      claude-cli credential blob).
#   2. ~/.openclaw/agents/main/agent/auth-profiles.json (the main agent
#      profile, kept for single-tenant deploys and CLI use).
#   3. Every ~/.openclaw-instances/<digits>/agents/main/agent/auth-profiles.json
#      it finds (each per-channel agent container mounts its own instance
#      dir; without this fanout, only freshly-created instances would pick
#      up the new tokens).
#
# The gateway picks the new tokens up on the next refresh attempt — no
# container restart needed.
#
# Usage: OPENCLAW_DEPLOY_HOST=msi-openclaw scripts/copy-oauth-credentials.sh
set -euo pipefail

HOST="${OPENCLAW_DEPLOY_HOST:?Set OPENCLAW_DEPLOY_HOST}"

echo "Reading credentials from macOS Keychain..."
CREDS=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
if [ -z "$CREDS" ]; then
  echo "Error: No Claude Code credentials found in Keychain."
  echo "Run 'claude login' locally first."
  exit 1
fi

echo "Uploading credentials blob to $HOST:~/.claude/.credentials.json ..."
printf '%s' "$CREDS" | ssh "$HOST" 'mkdir -p ~/.claude && cat > ~/.claude/.credentials.json && chmod 600 ~/.claude/.credentials.json'

echo "Updating auth profiles (main + every per-channel instance) ..."
ssh "$HOST" 'python3 -' <<'REMOTE'
import json
import os
import sys

home = os.path.expanduser("~")
with open(os.path.join(home, ".claude/.credentials.json")) as f:
    creds = json.load(f)["claudeAiOauth"]

profile = {
    "type": "oauth",
    "provider": "anthropic-subscription",
    "access": creds["accessToken"],
    "refresh": creds["refreshToken"],
    "expires": creds["expiresAt"],
    "scopes": creds.get("scopes", []),
}

def update_store(auth_path):
    os.makedirs(os.path.dirname(auth_path), exist_ok=True)
    store = {"version": 1, "profiles": {}}
    if os.path.exists(auth_path):
        try:
            with open(auth_path) as f:
                store = json.load(f)
        except json.JSONDecodeError:
            pass
    store.setdefault("profiles", {})
    store["profiles"]["anthropic-subscription:default"] = profile
    tmp = auth_path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(store, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, auth_path)

targets = [os.path.join(home, ".openclaw/agents/main/agent/auth-profiles.json")]

instances_root = os.path.join(home, ".openclaw-instances")
if os.path.isdir(instances_root):
    for entry in sorted(os.listdir(instances_root)):
        # Per-channel dirs are named after numeric Discord channel IDs.
        if not entry.isdigit():
            continue
        targets.append(os.path.join(
            instances_root, entry, "agents/main/agent/auth-profiles.json"
        ))

for path in targets:
    update_store(path)
    label = path.replace(home + "/", "")
    print(f"  updated {label}")

print(f"\nToken expires: {creds['expiresAt']} "
      f"({len(targets)} profile file(s) updated)")
REMOTE

echo ""
echo "Done. New tokens will be picked up on the next refresh; no restart needed."
