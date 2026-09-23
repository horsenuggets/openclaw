#!/usr/bin/env bash
# End-to-end test for the Claude OAuth mint + tunnel flow against a Docker
# container that mirrors the deploy host (sshd + the compiled binary at
# ~/deploy/bin/openclaw + a mock token endpoint).
#
# It runs the real scripts/mint-anthropic-reauth.sh from "the laptop" (this host)
# against the container, with a mock browser that fulfils the OAuth redirect and
# a mock token server that returns a test key, then asserts the token landed in
# the container's shared auth store.
#
# Prereqs: Docker running, and dist/openclaw-linux-x64 built
#   (node scripts/compile.mjs --target linux-x64).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Match the Docker container arch (arm64 on Apple Silicon, else x64) so the
# compiled binary actually runs instead of failing under emulation.
case "$(uname -m)" in
  arm64 | aarch64) ARCH="arm64" ;;
  *) ARCH="x64" ;;
esac
BIN="$ROOT/dist/openclaw-linux-$ARCH"
IMAGE="openclaw-mint-e2e"
CONTAINER="openclaw-mint-e2e"
SSH_PORT="${E2E_SSH_PORT:-2222}"
MOCK_PORT="9109"
EXPECTED_TOKEN="e2e-access-$RANDOM$RANDOM"

if [ ! -f "$BIN" ]; then
  echo "Missing $BIN. Build it: node scripts/compile.mjs --target linux-$ARCH" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running." >&2
  exit 1
fi

WORK="$(mktemp -d)"
KEY="$WORK/id_e2e"
KNOWN="$WORK/known_hosts"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "=== Building e2e image ==="
ssh-keygen -t ed25519 -N "" -f "$KEY" -q
cp "$BIN" "$WORK/openclaw-linux-x64"
cp "$KEY.pub" "$WORK/authorized_keys"

# Only the token endpoint needs mocking; the authorize URL is left as the real
# claude.ai one (the mock browser never visits it, and the reauth script greps
# for it to know when to "open" the browser).
cat >"$WORK/profile-extra" <<PROF
export OPENCLAW_ANTHROPIC_TOKEN_URL=http://127.0.0.1:$MOCK_PORT/v1/oauth/token
PROF

cat >"$WORK/mock-token.py" <<PY
import http.server, json, os
PORT = int(os.environ.get("MOCK_PORT", "$MOCK_PORT"))
TOKEN = "$EXPECTED_TOKEN"
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        body = json.dumps({
            "access_token": TOKEN,
            "refresh_token": "e2e-refresh",
            "expires_in": 3600,
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
http.server.HTTPServer(("127.0.0.1", PORT), H).serve_forever()
PY

cat >"$WORK/entrypoint.sh" <<'ENTRY'
#!/bin/bash
set -e
ssh-keygen -A >/dev/null 2>&1
su openclaw -c "MOCK_PORT=${MOCK_PORT} nohup python3 /home/openclaw/mock-token.py >/tmp/mock.log 2>&1 &"
exec /usr/sbin/sshd -D -e
ENTRY

cat >"$WORK/Dockerfile" <<DOCKER
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \\
      openssh-server python3 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash openclaw && mkdir -p /run/sshd
COPY openclaw-linux-x64 /home/openclaw/deploy/bin/openclaw
COPY mock-token.py /home/openclaw/mock-token.py
COPY authorized_keys /home/openclaw/.ssh/authorized_keys
COPY profile-extra /home/openclaw/profile-extra
COPY entrypoint.sh /entrypoint.sh
RUN cat /home/openclaw/profile-extra >> /home/openclaw/.profile \\
 && chmod +x /home/openclaw/deploy/bin/openclaw /entrypoint.sh \\
 && chown -R openclaw:openclaw /home/openclaw \\
 && chmod 700 /home/openclaw/.ssh && chmod 600 /home/openclaw/.ssh/authorized_keys
EXPOSE 22
CMD ["/entrypoint.sh"]
DOCKER

docker build -t "$IMAGE" "$WORK" >/dev/null
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "127.0.0.1:$SSH_PORT:22" -e "MOCK_PORT=$MOCK_PORT" "$IMAGE" >/dev/null

echo "=== Waiting for sshd ==="
SSH_BASE=(-i "$KEY" -o UserKnownHostsFile="$KNOWN" -o StrictHostKeyChecking=no -o IdentitiesOnly=yes)
for _ in $(seq 1 30); do
  if ssh "${SSH_BASE[@]}" -o ConnectTimeout=2 -p "$SSH_PORT" openclaw@127.0.0.1 "echo up" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
ssh "${SSH_BASE[@]}" -p "$SSH_PORT" openclaw@127.0.0.1 "echo container-ready" || {
  echo "sshd never came up" >&2
  exit 1
}

# Mock browser: extract the callback port + state from the authorize URL and
# fulfil the redirect through the tunnel (localhost:<port> on this host).
cat >"$WORK/mock-browser.sh" <<'MB'
#!/usr/bin/env bash
url="$1"
dec=$(printf '%s' "$url" | sed 's/%3A/:/g; s/%2F/\//g')
port=$(printf '%s' "$dec" | sed -n 's#.*redirect_uri=http://localhost:\([0-9]*\)/callback.*#\1#p')
state=$(printf '%s' "$url" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p')
sleep 1
curl -s "http://localhost:${port}/callback?code=E2ECODE&state=${state}" >/dev/null || true
MB
chmod +x "$WORK/mock-browser.sh"

echo "=== Running mint-anthropic-reauth.sh against the container ==="
OPENCLAW_DEPLOY_HOST="openclaw@127.0.0.1" \
  OPENCLAW_DEPLOY_PORT="$SSH_PORT" \
  OPENCLAW_SSH_OPTS="-i $KEY -o UserKnownHostsFile=$KNOWN -o StrictHostKeyChecking=no -o IdentitiesOnly=yes" \
  BROWSER="$WORK/mock-browser.sh" \
  "$ROOT/scripts/mint-anthropic-reauth.sh" --store shared

echo ""
echo "=== Shared auth store in the container ==="
STORE_PATH="/home/openclaw/.openclaw-instances/shared/auth/auth-profiles.json"
docker exec -u openclaw "$CONTAINER" cat "$STORE_PATH"

echo ""
if docker exec -u openclaw "$CONTAINER" grep -q "$EXPECTED_TOKEN" "$STORE_PATH" \
  && docker exec -u openclaw "$CONTAINER" grep -q "anthropic-subscription:default" "$STORE_PATH"; then
  echo "E2E PASS: minted token '$EXPECTED_TOKEN' written to the shared store under anthropic-subscription:default"
else
  echo "E2E FAIL: expected token not found in the shared store" >&2
  exit 1
fi
