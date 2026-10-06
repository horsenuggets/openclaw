#!/usr/bin/env bash
# OpenClaw boot script.
# Shipped inside the deploy tarball. Installed to ~/boot.sh on the remote host.
# Starts per-channel agent containers and the discord router.
set -euo pipefail

# Load deployment env (Discord token, whitelist guild/role, provisioner
# port/token, etc.) so the compose files below get their ${VAR} substitutions.
# Without this the router would come up with whitelist and provisioning
# disabled after a reboot.
if [ -f "$HOME/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.env"
  set +a
fi

INSTANCES_DIR="$HOME/.openclaw-instances"

# Agent bridge network. Agent boxes run on this user-defined bridge (not the host
# network) so each gets its own netns and can reach only the two router proxies
# (bound to the bridge gateway IP) plus the public internet — not the host's
# loopback services. The bridge is created with inter-container communication
# disabled (enable_icc=false, below) so a box also cannot reach a sibling box over
# it. The subnet is fixed so the gateway IP is stable and the host-networked router
# can bind its proxies there. All three come from ~/.env (no defaults): a missing
# value is a deployment error, not something to paper over with a guessed subnet
# that might collide on the host.
: "${OPENCLAW_AGENT_NETWORK:?OPENCLAW_AGENT_NETWORK must be set in ~/.env (agent bridge name, e.g. oc-agents)}"
: "${OPENCLAW_AGENT_SUBNET:?OPENCLAW_AGENT_SUBNET must be set in ~/.env (agent bridge subnet, e.g. 172.30.0.0/24)}"
: "${OPENCLAW_AGENT_GATEWAY:?OPENCLAW_AGENT_GATEWAY must be set in ~/.env (agent bridge gateway IP, e.g. 172.30.0.1)}"

# The router binds its loopback proxies to the bridge gateway IP so boxes on the
# bridge can reach them while they stay off the public NIC. discord-router.yml
# substitutes this; export it here from the single source of truth above.
export OPENCLAW_PROXY_BIND="$OPENCLAW_AGENT_GATEWAY"

# Create the agent bridge if absent, with the fixed subnet/gateway and
# inter-container communication disabled. Must exist before the router starts (it
# binds the gateway IP) and before any agent box starts (it joins the network), so
# this runs ahead of both. When it already exists, validate its driver/subnet/
# gateway AND that enable_icc=false: docker does not update options/IPAM on an
# existing network and setup.sh removes containers but not networks, so a stale
# bridge from an earlier .env or the pre-isolation layout would leave boxes able to
# reach each other or on the wrong subnet. Fail with remediation rather than
# silently proceeding.
if docker network inspect "$OPENCLAW_AGENT_NETWORK" >/dev/null 2>&1; then
  if ! docker network inspect "$OPENCLAW_AGENT_NETWORK" | python3 -c '
import json, os, sys

net = json.load(sys.stdin)[0]
cfg = ((net.get("IPAM") or {}).get("Config") or [{}])[0]
icc = (net.get("Options") or {}).get("com.docker.network.bridge.enable_icc")
ok = (
    net.get("Driver") == "bridge"
    and cfg.get("Subnet") == os.environ["OPENCLAW_AGENT_SUBNET"]
    and cfg.get("Gateway") == os.environ["OPENCLAW_AGENT_GATEWAY"]
    and icc == "false"
)
if not ok:
    sys.stderr.write(
        f"  found driver={net.get('Driver')} subnet={cfg.get('Subnet')} "
        f"gateway={cfg.get('Gateway')} enable_icc={icc}\n"
    )
sys.exit(0 if ok else 1)
'; then
    echo "ERROR: existing docker network '$OPENCLAW_AGENT_NETWORK' does not match the" >&2
    echo "  configured driver=bridge subnet=$OPENCLAW_AGENT_SUBNET gateway=$OPENCLAW_AGENT_GATEWAY" >&2
    echo "  with inter-container communication disabled (enable_icc=false)." >&2
    echo "  Stop the agent boxes and remove it so it can be recreated:" >&2
    echo "    docker network rm $OPENCLAW_AGENT_NETWORK" >&2
    exit 1
  fi
else
  echo "Creating agent bridge $OPENCLAW_AGENT_NETWORK ($OPENCLAW_AGENT_SUBNET, gw $OPENCLAW_AGENT_GATEWAY, icc off)..."
  docker network create --driver bridge \
    -o com.docker.network.bridge.enable_icc=false \
    --subnet "$OPENCLAW_AGENT_SUBNET" \
    --gateway "$OPENCLAW_AGENT_GATEWAY" \
    "$OPENCLAW_AGENT_NETWORK"
fi

# Shared auth-profiles store mounted into every agent container (see
# infrastructure/docker/agent.yml). Must exist as a regular file before any
# container starts, or Docker bind-mounts it as an empty directory. Seed it once
# from an existing per-instance auth store (migration off the old copy-per-
# instance model) or an empty store; never clobber the live shared file.
SHARED_AUTH_DIR="$INSTANCES_DIR/shared/auth"
SHARED_AUTH_FILE="$SHARED_AUTH_DIR/auth-profiles.json"
# The shared auth store holds OAuth refresh tokens and is bind-mounted into
# every container, so require it to be a real regular file. Reject a symlink
# (which -f/-e would silently follow, letting the store be redirected outside
# the instances tree) and reject a non-file such as a Docker-created bind-mount
# directory. Fail fast with remediation rather than cp'ing *into* it.
if [ -L "$SHARED_AUTH_FILE" ] || { [ -e "$SHARED_AUTH_FILE" ] && [ ! -f "$SHARED_AUTH_FILE" ]; }; then
  echo "ERROR: $SHARED_AUTH_FILE must be a regular file, not a symlink or directory (e.g. a Docker-created bind-mount dir)." >&2
  echo "       Stop the agent containers, remove that path, and re-run so it can be seeded as a file." >&2
  exit 1
fi
if [ ! -f "$SHARED_AUTH_FILE" ]; then
  mkdir -p "$SHARED_AUTH_DIR"
  chmod 700 "$SHARED_AUTH_DIR" 2>/dev/null || true
  seeded=""
  for instdir in "$INSTANCES_DIR"/[0-9]*; do
    # Skip symlinked instance dirs to honour the same no-symlink boundary the
    # router (Dirent.isDirectory) applies, so a numeric symlink can't seed
    # secrets from a path outside the intended instances tree.
    if [ ! -d "$instdir" ] || [ -L "$instdir" ]; then
      continue
    fi
    existing="$instdir/agents/main/agent/auth-profiles.json"
    [ -f "$existing" ] || continue
    cp "$existing" "$SHARED_AUTH_FILE"
    chmod 600 "$SHARED_AUTH_FILE" 2>/dev/null || true
    echo "Seeded shared auth from $existing"
    seeded=1
    break
  done
  if [ -z "$seeded" ]; then
    printf '{\n  "version": 1,\n  "profiles": {}\n}\n' > "$SHARED_AUTH_FILE"
    chmod 600 "$SHARED_AUTH_FILE" 2>/dev/null || true
  fi
fi

# Each instance owns its port as a `.port` dotfile in its own directory, so
# there is no central ports.json to read or reconcile. Discover channels by
# scanning for those dotfiles.
ASSIGNMENTS=$(python3 -c "
import os, re
instances_dir = '$INSTANCES_DIR'
rows = []
if os.path.isdir(instances_dir):
    # Iterate with scandir and require a real, non-symlink directory — the
    # same no-symlink boundary the router applies via Dirent.isDirectory().
    # Otherwise a numeric symlink to an external dir could be started here
    # but never loaded by the router (and could escape INSTANCES_DIR).
    for entry in sorted(os.scandir(instances_dir), key=lambda e: e.name):
        if not re.match(r'^\d{17,20}\$', entry.name):
            continue
        if not entry.is_dir(follow_symlinks=False):
            continue
        pf = os.path.join(entry.path, '.port')
        if not os.path.isfile(pf):
            continue
        raw = open(pf).read().strip()
        # Same strict rule the router uses: all ASCII digits, value > 0.
        # Rejects '0', negatives, and trailing junk so the container we
        # start here always matches the instance set the router will load.
        if not re.fullmatch(r'[0-9]+', raw):
            continue
        port = int(raw)
        if port <= 0:
            continue
        rows.append((entry.name, port))
for cid, port in sorted(rows, key=lambda x: x[1]):
    print(f'{cid} {port}')
" 2>/dev/null)

# Start per-channel agent containers (router needs them running first). With no
# instances yet we still start the router below so a fresh deployment can create
# its first channel via /channel register.
if [ -z "$ASSIGNMENTS" ]; then
  echo "No registered instances found under $INSTANCES_DIR — starting router only; use /channel register to add one."
else
  while read -r channelId port; do
    [ -z "$channelId" ] && continue
    # Only start instances adopted into the token-free layout (marker written by
    # openclawctl prepare_instance_dirs). A pre-existing instance without it would
    # mount the new read-only-config / /state layout and crash-loop, so skip it with
    # a re-register hint instead. Migrating legacy instances in place is a follow-up.
    if [ ! -f "$INSTANCES_DIR/$channelId/.token-free" ]; then
      echo "Skipping channel $channelId: legacy layout (no .token-free marker)." >&2
      echo "  Re-register it to adopt the token-free layout (non-destructive; keeps the" >&2
      echo "  instance data): openclawctl remove $channelId && openclawctl add-channel $channelId" >&2
      continue
    fi
    # Re-assert the instance's proxy URLs from the current agent-bridge env before
    # starting it. A deploy that changed the bridge gateway IP (e.g. the
    # host-networking -> bridge migration) otherwise leaves the on-disk config
    # pointing at a stale address (an old 127.0.0.1 is now the box's own loopback),
    # so the model/container proxies are unreachable and the agent silently fails.
    # If the reconcile fails, skip this box rather than start it with unreachable
    # proxies; other instances still boot.
    if ! ~/deploy/bin/openclawctl reconcile "$channelId"; then
      echo "Skipping channel $channelId: could not reconcile its proxy URLs" >&2
      echo "  (would start with unreachable model/container proxies)." >&2
      continue
    fi
    OPENCLAW_CHANNEL_ID="$channelId" OPENCLAW_CHANNEL_PORT="$port" \
      docker compose -f ~/deploy/docker/agent.yml -p "agents-$channelId" up -d
  done <<< "$ASSIGNMENTS"
fi

# Resolve the router's Discord token. The durable source is DISCORD_BOT_TOKEN in
# ~/.env (loaded at the top of this script); setup.sh always installs that .env
# from the deploy tarball, so it is present on any properly deployed host. The
# per-instance openclaw.json scan below is a legacy fallback for hosts predating
# the .env-as-source-of-truth convention; new deploys should never hit it.
if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  echo "Warning: DISCORD_BOT_TOKEN not set in ~/.env; falling back to instance config scan." >&2
  for dir in "$INSTANCES_DIR"/[0-9]*; do
    # Keep the legacy fallback behind the same real-directory/no-symlink
    # boundary as startup and shared-auth seeding.
    if [ ! -d "$dir" ] || [ -L "$dir" ]; then
      continue
    fi
    DISCORD_BOT_TOKEN=$(python3 -c "
import json
try:
    cfg = json.load(open('${dir}/openclaw.json'))
    print(cfg.get('channels',{}).get('discord',{}).get('token',''))
except: pass
" 2>/dev/null)
    [ -n "$DISCORD_BOT_TOKEN" ] && break
  done
  export DISCORD_BOT_TOKEN
fi

# Whisper speech-to-text port. One value drives both the server bind
# (whisper.yml) and the router's transcription target (discord-router.yml passes
# it as OPENCLAW_WHISPER_PORT), so client and server can never drift. Default
# matches DEFAULT_WHISPER_PORT in src/config/port-defaults.ts; override in ~/.env
# if it collides on the host (e.g. WSL mirrored networking sharing the port with
# another distro). Kept off 8787, which clashes with RStudio and the Telegram
# webhook default. Normalize here with the same rule the router applies
# (resolveWhisperUrl): a missing, non-numeric, or out-of-range value falls back
# to the default so the server never gets a malformed --port and both sides stay
# in agreement.
WHISPER_PORT_DEFAULT=18700
case "${WHISPER_PORT:-}" in
  "")
    WHISPER_PORT="$WHISPER_PORT_DEFAULT"
    ;;
  *[!0-9]*)
    echo "Warning: ignoring non-numeric WHISPER_PORT='$WHISPER_PORT'; using $WHISPER_PORT_DEFAULT." >&2
    WHISPER_PORT="$WHISPER_PORT_DEFAULT"
    ;;
  *)
    # All digits. Strip leading zeros so a 0-prefixed value compares as decimal
    # (keeps the shell from treating it as octal); an empty result means it was
    # all zeros.
    stripped="${WHISPER_PORT#"${WHISPER_PORT%%[!0]*}"}"
    [ -z "$stripped" ] && stripped=0
    # Reject by length before the bounded numeric test: a value longer than 5
    # digits would overflow the shell's integer test, which inside this
    # if-condition would not trip set -e and would leak the bad value through.
    if [ "${#stripped}" -gt 5 ] || [ "$stripped" -lt 1 ] || [ "$stripped" -gt 65535 ]; then
      echo "Warning: ignoring out-of-range WHISPER_PORT='$WHISPER_PORT' (must be 1-65535); using $WHISPER_PORT_DEFAULT." >&2
      WHISPER_PORT="$WHISPER_PORT_DEFAULT"
    else
      WHISPER_PORT="$stripped"
    fi
    ;;
esac
export WHISPER_PORT

# Start whisper (speech-to-text) only when BOTH artifacts it needs are present:
# the locally-built whisper-server binary and the model file the compose command
# loads (`--model /models/ggml-base.en.bin`). Both are host-staged, not shipped in
# the tarball, and setup.sh only preserves them across deploys. If either is
# missing, starting the compose service bind-mounts a path Docker auto-creates as
# an empty directory (or hands whisper-server a model that is not there), so the
# process exits and the `restart: unless-stopped` container crash-loops forever
# (re-running apt-get every couple of seconds, starving the box). Gate on both
# real files so voice transcription is simply absent until it is fully provisioned
# instead of degrading the whole host.
if [ -f ~/deploy/bin/whisper-server ] && [ -f ~/deploy/models/ggml-base.en.bin ]; then
  docker compose -f ~/deploy/docker/whisper.yml -p services-whisper up -d
else
  echo "Skipping whisper: need both ~/deploy/bin/whisper-server (build with scripts/compile-whisper.sh) and the ~/deploy/models/ggml-base.en.bin model to enable voice transcription."
fi

# Start discord router
DISCORD_BOT_TOKEN="$DISCORD_BOT_TOKEN" \
  docker compose -f ~/deploy/docker/discord-router.yml -p services up -d
