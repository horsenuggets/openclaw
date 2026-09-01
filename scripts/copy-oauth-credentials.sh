#!/usr/bin/env bash
# Copy OAuth credentials from macOS Keychain to the OpenClaw deploy host.
#
# This pushes the freshly-refreshed Claude Code OAuth tokens (access +
# refresh + expiry) from the local macOS Keychain to:
#
#   1. ~/.claude/.credentials.json on the deploy host (the shared
#      claude-cli credential blob).
#   2. ~/.openclaw/agents/main/agent/auth-profiles.json (the main agent
#      profile, kept for single-tenant deploys and CLI use).
#   3. Every <instances-root>/<digits>/agents/main/agent/auth-profiles.json
#      it finds (each per-channel agent container mounts its own instance
#      dir; without this fanout, only freshly-created instances would pick
#      up the new tokens). <instances-root> is $OPENCLAW_INSTANCES_DIR on
#      the deploy host if set (matching src/discord-router/config.ts),
#      else ~/.openclaw-instances.
#
# The gateway picks the new tokens up on the next refresh attempt — no
# container restart needed.
#
# Usage: OPENCLAW_DEPLOY_HOST=msi-openclaw scripts/copy-oauth-credentials.sh
#        Set OPENCLAW_INSTANCES_DIR locally to forward a non-default
#        instances root to the deploy host's fanout step.
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
# Wrap in `sh -lc` so the snippet always runs under a POSIX shell — the
# remote login shell may be fish or another non-POSIX shell that does not
# accept `&&`/`VAR=val` assignments. Also refuse to write through a
# symlinked ~/.claude, which could redirect the credentials blob outside
# the home directory. Use `mktemp` so a pre-planted symlink at a
# predictable temp path can't hijack the credentials write.
printf '%s' "$CREDS" | ssh "$HOST" 'sh -lc '\''umask 077 && if [ -L "$HOME/.claude" ]; then echo "Refusing to write: $HOME/.claude is a symlink" >&2; exit 1; fi && mkdir -p "$HOME/.claude" && chmod 700 "$HOME/.claude" && tmp=$(mktemp "$HOME/.claude/.credentials.json.XXXXXX") && chmod 600 "$tmp" && cat > "$tmp" && mv -f "$tmp" "$HOME/.claude/.credentials.json"'\'''

echo "Updating auth profiles (main + every per-channel instance) ..."
# Mirror src/discord-router/config.ts's instancesDir override so this script
# fans out to the same directory the router actually scans on hosts that set
# OPENCLAW_INSTANCES_DIR (e.g. non-default instance roots). Forward it
# base64-encoded so arbitrary path contents (spaces, quotes) can't affect
# how the remote shell parses the ssh command line.
REMOTE_CMD="python3 -"
if [ -n "${OPENCLAW_INSTANCES_DIR:-}" ]; then
  REMOTE_ENV_B64=$(printf '%s' "$OPENCLAW_INSTANCES_DIR" | base64 | tr -d '\n')
  # Use `env` explicitly rather than inline `VAR=val cmd` syntax — ssh runs
  # this string via the remote user's login shell, which may not be POSIX
  # (e.g. fish), and `env` works the same across all of them.
  REMOTE_CMD="env OPENCLAW_INSTANCES_DIR_B64=$REMOTE_ENV_B64 python3 -"
fi
ssh "$HOST" "$REMOTE_CMD" <<'REMOTE'
import base64
import errno
import json
import os
import random
import re
import tempfile
import time

home = os.path.expanduser("~")

# Match `proper-lockfile` semantics used by
# src/agents/auth-profiles/store.ts so this fanout coordinates with any
# concurrent agent refresh. proper-lockfile creates `<file>.lock` as a
# directory (mkdir is atomic on POSIX) and treats a lock as stale after
# `stale` ms based on the dir's mtime. Our critical section is short and
# synchronous, so we do not bother refreshing the mtime while held.
LOCK_STALE_MS = 30_000
LOCK_RETRIES = 10
LOCK_MIN_TIMEOUT_MS = 100
LOCK_MAX_TIMEOUT_MS = 10_000
LOCK_FACTOR = 2

def acquire_lock(target_path):
    # proper-lockfile defaults to `realpath: true`, so the running agent
    # locks `realpath(auth_path) + ".lock"`. Match that or we might grab
    # a different lock file than the agent and race with it. os.path.realpath
    # does not require the path to exist — it resolves whatever symlinked
    # ancestors do exist and leaves the rest as-is — so this is safe to call
    # unconditionally, even before auth_path has been created.
    resolved = os.path.realpath(target_path)
    lock_path = resolved + ".lock"
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
                        os.mkdir(lock_path)
                        return lock_path
                    except OSError as inner_exc:
                        if inner_exc.errno not in (errno.EEXIST, errno.ENOENT):
                            raise
            except OSError as stat_exc:
                if stat_exc.errno != errno.ENOENT:
                    raise
            if attempt >= LOCK_RETRIES:
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
    except OSError as exc:
        if exc.errno != errno.ENOENT:
            raise

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

def ensure_secure_dir(path):
    # Credential-adjacent dirs must be 0700; makedirs uses the remote
    # umask (often 022 → 0755) which would leak filenames/metadata. We
    # tighten every dir under $HOME up to (but not including) $HOME
    # itself — mutating $HOME's mode is disruptive on hosts that keep it
    # 0755 for shared read access. When the target is outside $HOME
    # (operator-set OPENCLAW_INSTANCES_DIR pointing at e.g.
    # /var/lib/openclaw) we don't chmod system dirs, but we still
    # reject symlinks in *every* intermediate component so a symlinked
    # <instance>/agents → /tmp can't redirect the write outside the
    # intended tree.
    home_prefix = home.rstrip("/") + "/"

    # Collect every path component (walking upward from the leaf) and
    # reject any existing symlink *before* calling os.makedirs — makedirs
    # follows symlinks, so a symlinked <instance>/agents → /tmp would let
    # it create directories outside the intended tree before any later
    # check runs.
    all_parts = []
    cur = path
    while cur and cur != "/":
        all_parts.append(cur)
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    for p in all_parts:
        if os.path.lexists(p) and os.path.islink(p):
            raise RuntimeError(
                f"Refusing to write secrets: {p} is a symlink"
            )

    # Determine which components we're about to create so we can chmod
    # exactly those (they were subject to the remote umask). We must
    # not chmod pre-existing operator-owned dirs (e.g. $HOME itself, or
    # the parent of OPENCLAW_INSTANCES_DIR like /var/lib) because
    # tightening them can break shared-access setups.
    to_create = [p for p in all_parts if not os.path.exists(p)]
    os.makedirs(path, mode=0o700, exist_ok=True)

    chmod_parts = to_create
    # Also always tighten dirs *under* $HOME that we didn't create — the
    # existing behavior — so a pre-existing but sloppily-permissioned
    # ~/.openclaw/agents doesn't leak filenames. Never touch $HOME
    # itself or anything above it.
    for p in all_parts:
        if p != home and p.startswith(home_prefix) and p not in chmod_parts:
            chmod_parts.append(p)
    if not chmod_parts:
        chmod_parts = [path]
    for p in chmod_parts:
        os.chmod(p, 0o700)
        mode = os.stat(p).st_mode & 0o777
        if mode & 0o077:
            raise RuntimeError(
                f"Refusing to write secrets: {p} is mode {oct(mode)}"
            )

def update_store(auth_path):
    # Refuse to write through a symlinked auth store: acquire_lock() locks
    # realpath(auth_path) (matching proper-lockfile) but os.replace(tmp,
    # auth_path) would replace the symlink itself, so the running agent
    # would keep reading the old target and our coordination would silently
    # break.
    if os.path.islink(auth_path):
        raise RuntimeError(
            f"Refusing to update {auth_path}: path is a symlink"
        )
    ensure_secure_dir(os.path.dirname(auth_path))
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
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(
                prefix=os.path.basename(auth_path) + ".tmp.",
                dir=os.path.dirname(auth_path),
            )
            try:
                os.fchmod(fd, 0o600)
            except BaseException:
                os.close(fd)
                raise
            try:
                f = os.fdopen(fd, "w")
            except BaseException:
                os.close(fd)
                raise
            with f:
                json.dump(store, f, indent=2)
                f.write("\n")
            os.replace(tmp, auth_path)
            tmp = None
        finally:
            if tmp is not None:
                try:
                    os.unlink(tmp)
                except FileNotFoundError:
                    pass
    finally:
        release_lock(lock_path)

targets = [os.path.join(home, ".openclaw/agents/main/agent/auth-profiles.json")]

# Per-channel dirs are named after the Discord snowflake channel ID.
# The router (src/discord-router/config.ts) applies additional filtering
# (e.g., must have a port assignment) that we do not replicate here; we
# only mirror its ID-regex + no-symlink safety checks to avoid fanning
# secrets into obviously invalid or dangling numeric dirs.
DISCORD_ID_RE = re.compile(r"^\d{17,20}$")

instances_root_b64 = os.environ.get("OPENCLAW_INSTANCES_DIR_B64")
instances_root = (
    base64.b64decode(instances_root_b64).decode()
    if instances_root_b64
    else os.path.join(home, ".openclaw-instances")
)
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
