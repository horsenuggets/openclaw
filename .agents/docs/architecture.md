# architecture

A map of how this fork runs in production and how it diverges from upstream OpenClaw. Read
this first; the other docs drill into each subsystem.

## How this fork diverges from upstream

Upstream OpenClaw is a single-process gateway that shells out to the Claude Code binary
per message. This fork replaces both halves:

- Direct Anthropic providers instead of the `claude-cli` backend. Two providers call the
  Anthropic API through pi-ai (`@mariozechner/pi-ai`) with prompt caching: `anthropic-api`
  (API-key billing) and `anthropic-subscription` (OAuth, Claude subscription billing). See
  [auth-and-billing.md](auth-and-billing.md) and [system-prompt.md](system-prompt.md).
- A Docker multi-user production topology instead of one process. A single Discord router
  fans each registered channel out to its own hardened agent container. See below.
- A custom Discord router with its own command and embed systems, owner gating,
  onboarding, connections, and secrets. See [command-system.md](command-system.md) and
  [embed-system.md](embed-system.md).
- Heartbeat-driven proactive messaging. The old standalone `ProactiveService` has been
  retired; heartbeats are the single proactive mechanism. See
  [heartbeats.md](heartbeats.md).
- An agent box sandbox with real HOME, skills, git, an in-box command policy, and
  connection and secret materialization. See
  [sandbox-and-permissions.md](sandbox-and-permissions.md).

## Production topology (Docker multi-user)

Production runs as Docker containers on the gateway host. Compose files live in
`infrastructure/docker/`. There is no git checkout on prod; it runs compiled binaries
staged under `~/deploy/bin/` (openclaw, discord-router, health-monitor, provisioner, and
optionally whisper-server).

Three container roles:

- `services.discord-router` (`discord-router.yml`) - one instance, host-networked, holds
  the Discord bot token, and owns all inbound and outbound Discord traffic. Its command is
  actually the `health-monitor` binary, which supervises the router. It also runs two
  proxies (see networking).
- `services.whisper` (`whisper.yml`) - one speech-to-text service. It only starts when
  both the `whisper-server` binary and the model file are present, so on platforms without
  a build (for example linux-arm64) it is simply absent rather than crash-looping.
- `agents.channel-<id>` (`agent.yml`) - one container per registered Discord channel,
  project `agents-<id>`, image `openclaw-agent:latest`. Hardened: read-only root,
  `cap_drop: ALL`, `no-new-privileges`, non-root uid, tmpfs `/tmp`. Each box runs with
  `OPENCLAW_SKIP_CHANNELS=1` because it is a pure per-channel executor; the router does
  the routing.

## Networking (bridge, not host)

Agent boxes run on a user-defined bridge network (`oc-agents`) with inter-container comms
disabled, not host networking. The router is host-networked and binds its two proxies to
the bridge gateway IP (`OPENCLAW_PROXY_BIND`). Each box reaches:

- the container proxy at `http://<bridge-gateway-ip>:18800` (outbound Discord sends go
  here, path `/discord/send`), and
- the model proxy at `http://<bridge-gateway-ip>:18702` (the model path).

Each box's own gateway port is published only to host loopback. The key pitfall: a stale
`127.0.0.1` proxy URL in an instance config points at the box's own loopback, where
nothing listens, so the model and send paths fail silently with "Connection error".
`openclawctl reconcile` rewrites these URLs to the bridge gateway; see
[deployment.md](deployment.md).

## Instance layout

Each registered channel is an instance directory, `~/.openclaw-instances/<channelId>/`:

- `openclaw.json` - the box config (mounted read-only into the container).
- `.port` - the port this instance's gateway listens on. The router builds its
  channel-to-port map by scanning these dotfiles at startup. No port, no route.
- `.token-free` - marker for the token-free box layout. Instances created before this
  layout lack it and are skipped on deploy or boot, so they must be re-registered.
- `.onboarding.json` - owner id and per-channel preferences (used for owner gating).
- `workspace/`, `state/`, `home/` - the box's mounted working directories.
- A shared auth store lives at `~/.openclaw-instances/shared/auth/` (OAuth profiles).

## Two outbound delivery paths

There are two separate Discord reply paths, and formatting or chunking changes must be
verified on the right one:

- Router path (prod and mirror): `src/discord/router/route-message.ts` ->
  `src/discord/router/discord-api.ts`. This is what the real bots use.
- Monitor path (single-process channel provider): `src/discord/monitor/reply-delivery.ts`.

Both now share the chunker `chunkDiscordTextWithMode` (`src/discord/chunk.ts`), but the
router path hardcodes `chunkMode: "newline"` while the monitor path takes it from config.
See [embed-system.md](embed-system.md).
