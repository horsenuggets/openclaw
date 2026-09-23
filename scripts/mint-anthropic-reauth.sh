#!/usr/bin/env bash
# Re-authenticate the Claude (anthropic-subscription) OAuth token on the deploy
# host from your laptop, with the browser on your machine.
#
# It opens an SSH tunnel so the OAuth redirect from your local browser reaches a
# short-lived callback server that `openclaw auth mint-anthropic` runs on the
# host. The minted tokens are written straight into the host's shared auth store;
# nothing is stored on the laptop and there is no code to copy-paste.
#
# Usage:
#   OPENCLAW_DEPLOY_HOST=<host> scripts/mint-anthropic-reauth.sh [--store <target>]
#
# Env:
#   OPENCLAW_DEPLOY_HOST  SSH host for the deploy server (required)
#   OPENCLAW_DEPLOY_PORT  SSH port (optional; omit to use the SSH config alias)
#   OPENCLAW_REMOTE_BIN   Path to openclaw on the host (optional; defaults to one
#                         on PATH, else ~/deploy/bin/openclaw)
set -euo pipefail

STORE="shared"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --store)
      STORE="${2:?--store needs a value}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: OPENCLAW_DEPLOY_HOST=<host> $0 [--store <target>]" >&2
      exit 1
      ;;
  esac
done

# Restrict --store to the documented values: it is interpolated into the remote
# command below, so an arbitrary value would be a shell-injection vector.
case "$STORE" in
  shared | main) ;;
  *)
    echo "Invalid --store \"$STORE\" (use \"shared\" or \"main\")." >&2
    exit 1
    ;;
esac

HOST="${OPENCLAW_DEPLOY_HOST:?Set OPENCLAW_DEPLOY_HOST}"

SSH_PORT_FLAG=()
if [ -n "${OPENCLAW_DEPLOY_PORT:-}" ]; then
  SSH_PORT_FLAG=(-p "$OPENCLAW_DEPLOY_PORT")
fi

# Extra ssh options (e.g. -i <key>, -o UserKnownHostsFile=...). Word-split so a
# space-separated list works; leave empty for normal use.
SSH_OPTS=()
if [ -n "${OPENCLAW_SSH_OPTS:-}" ]; then
  read -ra SSH_OPTS <<<"$OPENCLAW_SSH_OPTS"
fi

# Resolve the openclaw binary on the host: honour an explicit override, else
# prefer one on PATH, else fall back to the standard deploy location. This runs
# on the remote side under `sh -lc`, so $HOME is the host's home. The override is
# base64-encoded locally and decoded on the host so a value containing quotes or
# shell metacharacters can never alter the remote command (base64 output is safe
# to interpolate into the single-quoted remote program).
REMOTE_BIN_B64=$(printf %s "${OPENCLAW_REMOTE_BIN:-}" | base64 | tr -d '\n')
REMOTE_BIN_RESOLVE="B=\$(printf %s ${REMOTE_BIN_B64} | base64 -d 2>/dev/null); if [ -z \"\$B\" ]; then if command -v openclaw >/dev/null 2>&1; then B=openclaw; else B=\"\$HOME/deploy/bin/openclaw\"; fi; fi"

echo "=== Claude OAuth Re-auth ==="
echo "Host: $HOST"
echo "Store: $STORE"
echo ""

# Pick a free local port. The laptop and the host both need it free when the
# tunnel binds and when the host's callback server binds; a TOCTOU race is
# unavoidable, so retry on collision with a fresh port.
pick_port() {
  python3 -c "import socket; s=socket.socket(); s.bind(('', 0)); print(s.getsockname()[1]); s.close()"
}

open_browser() {
  local url="$1"
  if [ -n "${BROWSER:-}" ]; then
    "$BROWSER" "$url" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  else
    echo "No browser opener found; open this URL manually:" >&2
    echo "  $url" >&2
  fi
}

TUNNEL_PID=""
cleanup_tunnel() {
  if [ -n "${TUNNEL_PID:-}" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
    TUNNEL_PID=""
  fi
}
trap cleanup_tunnel EXIT

SENTINEL="__MINT_ANTHROPIC_SSH_EXIT__"

# One attempt with a freshly-picked port. Returns 0 on success, 2 on a port
# collision (retry), other codes on unrecoverable failure.
attempt() {
  local port
  port=$(pick_port)
  echo "Callback port: $port"

  # Forward laptop:port -> host:localhost:port. The host's callback server binds
  # localhost, so the mirrored port reaches it directly (no bridge lookup).
  ssh -N -L "$port:localhost:$port" "${SSH_PORT_FLAG[@]}" "${SSH_OPTS[@]}" "$HOST" \
    -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=accept-new &
  TUNNEL_PID=$!
  sleep 2

  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "SSH tunnel exited before becoming ready (likely a local port collision); retrying." >&2
    TUNNEL_PID=""
    return 2
  fi

  echo "Tunnel up. Starting mint on the host..."
  echo ""

  local ssh_exit="" opened=0 clean
  while IFS= read -r line; do
    clean=$(printf '%s' "$line" | sed 's/\r//')
    case "$clean" in
      "${SENTINEL}="*)
        ssh_exit="${clean#${SENTINEL}=}"
        continue
        ;;
    esac
    echo "$clean"
    if [ "$opened" = 0 ]; then
      case "$clean" in
        *oauth/authorize*)
          local url
          url=$(printf '%s' "$clean" | grep -oE 'https://[^ ]*oauth/authorize[^ ]*' || true)
          if [ -n "$url" ]; then
            echo ""
            echo "Opening your browser..."
            open_browser "$url"
            opened=1
          fi
          ;;
      esac
    fi
  done < <(
    # No `-t`: the callback flow needs no input, and a remote pty makes openclaw
    # emit fancy width-wrapped tables/ANSI that render as garbled output here.
    ssh "${SSH_PORT_FLAG[@]}" "${SSH_OPTS[@]}" "$HOST" \
      "sh -lc '${REMOTE_BIN_RESOLVE}; \"\$B\" auth mint-anthropic --store ${STORE} --callback-port ${port}'" 2>&1
    printf '\n%s=%d\n' "$SENTINEL" "$?"
  )

  cleanup_tunnel

  if [ -z "$ssh_exit" ]; then
    echo "Remote mint terminated without an exit code." >&2
    return 1
  fi
  return "$ssh_exit"
}

MAX_RETRIES=5
n=1
while :; do
  if [ "$n" -gt 1 ]; then
    echo ""
    echo "Retrying with a fresh port (attempt $n of $MAX_RETRIES)..."
    echo ""
  fi
  set +e
  attempt
  rc=$?
  set -e
  if [ "$rc" = 0 ]; then
    break
  fi
  if [ "$rc" != 2 ]; then
    exit "$rc"
  fi
  if [ "$n" -ge "$MAX_RETRIES" ]; then
    echo "Gave up after $MAX_RETRIES port-collision retries." >&2
    exit 1
  fi
  n=$((n + 1))
done

echo ""
echo "=== Re-auth complete ==="
