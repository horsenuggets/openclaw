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
printf '%s' "$CREDS" | ssh "$HOST" 'umask 077 && mkdir -p ~/.claude && chmod 700 ~/.claude && tmp=~/.claude/.credentials.json.tmp && cat > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" ~/.claude/.credentials.json'

echo "Updating auth profiles (main + every per-channel instance) ..."
ssh "$HOST" 'python3 -' <<'REMOTE'
import errno
import json
import os
import random
import re
import time

home = os.path.expanduser("~")

# Match `proper-lockfile` semantics used by
# src/agents/auth-profiles/store.ts so this fanout coordinates with any
# concurrent agent refresh. proper-lockfile creates `<file>.lock` as a
# directory (mkdir is atomic on POSIX), touches its mtime to signal
# liveness, and treats a lock as stale after `stale` ms.
LOCK_STALE_MS = 30_000
LOCK_RETRIES = 10
LOCK_MIN_TIMEOUT_MS = 100
LOCK_MAX_TIMEOUT_MS = 10_000
LOCK_FACTOR = 2

def acquire_lock(target_path):
    lock_path = target_path + ".lock"
    for attempt in range(LOCK_RETRIES + 1):
        try:
            os.mkdir(lock_path)
            return lock_path
        except OSError as exc:
            if exc.errno != errno.EEXIST:
                raise
            # Reap stale lock (proper-lockfile checks dir mtime).
            try:
                age_ms = (time.time() - os.stat(lock_path).st_mtime) * 1000
                if age_ms > LOCK_STALE_MS:
                    try:
                        os.rmdir(lock_path)
                        continue
                    except OSError:
                        pass
            except OSError:
                pass
            if attempt == LOCK_RETRIES:
                raise RuntimeError(
                    f"Timed out acquiring auth-profiles lock at {lock_path}"
                )
            # Match npm `retry` (randomize: true) exponential backoff formula
            rand_factor = 1.0 + random.random()
            backoff_ms = min(
                LOCK_MAX_TIMEOUT_MS,
                LOCK_MIN_TIMEOUT_MS * (LOCK_FACTOR ** attempt) * rand_factor,
            )
            time.sleep(backoff_ms / 1000.0)

def release_lock(lock_path):
    try:
        os.rmdir(lock_path)
    except OSError:
        pass

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
    lock_path = acquire_lock(auth_path)
    try:
        store = {"version": 1, "profiles": {}}
        if os.path.exists(auth_path):
            # Fail loudly on corrupted JSON rather than silently
            # overwriting; this file holds multiple profiles + metadata
            # (order, lastGood, usageStats) and resetting it would wipe
            # unrelated state.
            with open(auth_path) as f:
                store = json.load(f)
        store.setdefault("profiles", {})
        store["profiles"]["anthropic-subscription:default"] = profile
        tmp = auth_path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(store, f, indent=2)
        os.replace(tmp, auth_path)
    finally:
        release_lock(lock_path)

targets = [os.path.join(home, ".openclaw/agents/main/agent/auth-profiles.json")]

# Per-channel dirs are named after the Discord snowflake channel ID; mirror
# the router's validation (src/discord-router/config.ts) so we don't fan
# secrets out into unrelated/stale numeric directories.
DISCORD_ID_RE = re.compile(r"^\d{17,20}$")

instances_root = os.path.join(home, ".openclaw-instances")
if os.path.isdir(instances_root):
    # Mirror the router's Dirent.isDirectory() check
    # (src/discord-router/config.ts) — do NOT follow symlinks, otherwise
    # this could fan secrets into a symlinked numeric dir the router
    # itself would refuse to load.
    with os.scandir(instances_root) as it:
        entries = sorted(it, key=lambda e: e.name)
    for entry in entries:
        if not DISCORD_ID_RE.match(entry.name):
            continue
        if not entry.is_dir(follow_symlinks=False):
            continue
        targets.append(os.path.join(
            entry.path, "agents/main/agent/auth-profiles.json"
        ))

for path in targets:
    label = path.replace(home + "/", "")
    print(f"BEGIN {label}")
    update_store(path)
    print(f"END {label}")

print(f"\nToken expires: {creds['expiresAt']} "
      f"({len(targets)} profile file(s) updated)")
REMOTE

echo ""
echo "Done. New tokens will be picked up on the next refresh; no restart needed."
