# Deployment

How this fork ships to the production gateway host and the gotchas that bite on deploy.
The prod topology and instance layout are in [architecture.md](architecture.md); this doc
is the operational procedure. Keep concrete host names and addresses out of here; the
deploy target comes from `OPENCLAW_DEPLOY_HOST` at runtime.

## The Deploy Pipeline

`infrastructure/deploy/deploy.sh` runs from a dev checkout and...

1. Cross-compiles the linux binaries with `node scripts/compile.mjs --target linux-<arch>`
   (works from Apple Silicon via bun). Skip this and re-ship the existing `dist/` build
   with the `--skip-compile` positional.
2. Stages the binaries, extensions, hand-picked workspace templates, skills, embed icons,
   the three compose files, the agent Dockerfile, `openclawctl`, the provisioner unit, and
   the repo-root `.env`, then tars it.
3. `scp`s the tarball to the host and runs `setup.sh` over ssh.

Env drivers » `OPENCLAW_DEPLOY_HOST` (required), `OPENCLAW_DEPLOY_ARCH` (default `x64`;
set `arm64` for the local rig), `OPENCLAW_DEPLOY_PORT` and `OPENCLAW_SSH_OPTS` (to target
a containerized sshd), and `OPENCLAW_DEPLOY_ENV_FILE` (to ship a variant `.env`).

The repo-root `.env` is the production env source of truth and must be fully populated
(Discord token, provisioner token, allowlist and override ids, agent-bridge vars, and so
on).

## setup.sh is a Full Teardown

`setup.sh` builds the agent image, then stops and removes all containers, replaces
`~/deploy` (preserving only a few artifacts such as models and the whisper or gog
binaries), always overwrites `~/.env` from the shipped tarball, reinstalls and restarts
the provisioner, and runs `boot.sh`. Consequences to expect » Brief full-stack downtime,
and the dev `.env` clobbers whatever was on prod.

`boot.sh` brings each registered channel back up. It runs `openclawctl reconcile <id>`
before starting each box, so a deploy self-heals stale instance configs.

## openclawctl

`infrastructure/scripts/openclawctl` manages instances. Subcommands » `add-dm`,
`add-channel`, `remove`, `purge`, `restart`, `reconcile`, and `list`. (Workspace seeding
is an internal function called during add, not a standalone subcommand.)

- `reconcile <id>` re-asserts the proxy URLs and `workspace=/workspace` in an instance
  config and keeps the same port, without recreating the container. It refuses legacy
  instances that were never prepared.
- `remove <id>` is non-destructive » it stops the container and frees the port but
  preserves instance data under `~/.openclaw-instances/<id>/`; deleting data is a separate
  manual step.
- `purge <id> [expectedRegToken]` is the destructive full teardown » it stops and deletes
  the container and wipes the whole instance directory (which also frees the port), so a
  re-register starts clean. It aborts before wiping if the container cannot be torn down
  (daemon down or removal denied) so it never strands a running container on a freed port
  while deleting its data. The commit point is an atomic rename of the instance dir to a
  `.purging-*` tombstone (which frees the port and unregisters the channel instantly); the
  slow `rm -rf` then runs detached so a provisioner timeout cannot leave a half-wipe, and
  `boot.sh` runs `openclawctl sweep-tombstones` to reap any interrupted tombstone. The
  optional `expectedRegToken` is the per-registration token (`.reg-token`, minted fresh on
  every (re-)register alongside the port) the caller recorded; `purge` validates it under
  the lifecycle lock and refuses (exit 2) on mismatch, so a stale unregister cannot wipe a
  channel re-registered since. The provisioner's `/channel unregister` now uses `purge`
  (not `remove`) and passes the token it returned at register time.
- `add-dm`, `add-channel`, `remove`, `purge`, and `restart` each hold a per-channel
  lifecycle lock across their whole operation, and `boot.sh` takes the same lock before
  reconciling and starting each instance. This serializes the complete add/remove/purge/
  restart/boot sequences for a channel (an add releases the port lock the moment it
  reserves a port, so without the lifecycle lock a purge could wipe the instance dir in
  the gap before the container starts, stranding it on a reusable port). Keep any new
  per-channel lifecycle operation under this lock to preserve the guarantee.
- Port allocation skips currently-listening ports to avoid bind clashes, and each gateway
  also opens a dynamic secondary port that is not recorded in `.port`.

## Deploy Gotchas

These have all bitten real deploys...

- Legacy agents without the `.token-free` marker are skipped by `setup.sh`, `boot.sh`, and
  `reconcile`, so they stay down after a deploy. Fix by re-registering each:
  `openclawctl remove <id>` then `openclawctl add-channel <id>` (non-destructive; data is
  preserved).
- Re-registration reassigns ports, but the router cached its channel-to-port map at
  startup. After re-registering, restart `services.discord-router` so it re-reads the
  `.port` dotfiles; otherwise moved channels are mis-routed.
- Stale `127.0.0.1` proxy URLs » After the host-to-bridge migration, existing instance
  configs can still point proxies at `127.0.0.1`, which is the box's own loopback on a
  bridge, so everything dies with "Connection error". `boot.sh` now reconciles before
  start, and `openclawctl reconcile <id>` fixes a running instance in place. Diagnose by
  grepping the instance config inside the box for the proxy host; it should be the bridge
  gateway IP, not `127.0.0.1`.
- Whisper is not shipped by `deploy.sh` and has no linux-arm64 build, so on arm hosts the
  whisper container simply does not start. That is expected, not a degraded deploy.

## Smoke Test after Deploy

Non-intrusive, no Discord needed » Exec a one-shot inside an agent box with a throwaway
session and no delivery. A `PONG` reply proves the binary, system-prompt build, and model
path work:

```bash
docker exec agents.channel-<id> sh -lc \
  'openclaw agent --message "Reply with exactly PONG" --session-id smoke-$(date +%s) --thinking low'
```

`openclaw agent` no longer takes a `--port`; it talks to the gateway via config, so run it
inside the container. Note that on a gateway error the command falls back to an embedded
run, so a `PONG` alone does not prove the gateway itself is healthy; probe the gateway or
model proxy health separately if that is what you are checking. Benign log noise to ignore
includes MDNS send errors, EROFS when the immutable box tries to persist config, and
"Missing Control UI assets".
