# Sandbox and Permissions

What the per-channel agent box can and cannot do, why its exec tool runs unattended, and
how connection and secret values reach it. The box itself is described in
[architecture.md](architecture.md).

## The Exec Tool Runs Unattended in the Box

This is the important, non-obvious fact. The deployed agent box
(`infrastructure/docker/agent.yml`) runs with a box `openclaw.json` that has no
`tools.exec` block, so exec resolves to `host = "sandbox"`, `security = "deny"`,
`ask = "on-miss"`, with no interactive approval responder present.

Despite `security = "deny"`, the exec tool still runs commands with no approval prompt. In
`src/agents/bash-tools.exec.ts` the hard deny throw only fires in the `host === "node"`
and `host === "gateway"` branches. The `host === "sandbox"` path has no deny gate » It
flows straight to running the command in the sandbox. So inside the box the agent can
`cat` files, run pipes, and invoke CLIs unattended; the deny semantics only ever applied
to node and gateway execution, which the box never uses.

Implication » An agent inside the box can read its own delivered secrets (for example the
`/secret` command's delivery target) and can drive external CLIs. Treat the box boundary
(the hardened container » Read-only root, dropped capabilities, no new privileges,
non-root user) as the real security boundary, not the `security = "deny"` string.

## In-Box Command Policy

`src/auto-reply/command-policy.ts` gates in-session `/word` commands inside the box.
`ENABLED_COMMAND_KEYS` is intentionally empty, because this fork owns `/channel`,
`/lifecycle`, `/secret`, and `/connections` host-side in the router. Inside the box no
in-session command is enabled, so such text reaches the model as plain content.

## Secrets

`/secret` (host-side, `src/discord/router/secret-command.ts`) collects a sensitive value
through a Discord modal so it never appears in the channel or logs, then delivers it to
the box (its delivery target is a file the box can read). Because exec runs unattended
(above), the agent can read that file on demand.

## Connections

`/connections` (`src/discord/router/connect-commands.ts`) links external accounts for the
channel's agent. Direct-token connectors (Todoist, Notion, GitHub) are live; Google via
gog is listed and selectable but its connect flow is not wired yet (`available: false` in
`connectors.ts` pending client config and materialization), so `/connections add google`
replies with a TODO placeholder. The `available` flag no longer gates listing, choices, or
validation. Validated credentials are stored per instance in a `.connections.json` file
(`connections-store.ts`) and resolved by the router (`router.ts`).

Each connector composes an *auth flow* (`auth-flow.ts`), described by two independent axes
so the embed layer can present it without branching on the provider: `authKind` (`oauth` |
`direct` | `cli` — the nature of the auth) and `delivery` (`paste` via
`/connections add <service> <token>`, or `server-redirect` via a hosted callback), plus
`outgoing` (`link` | `instructions` — how the user is told to start, following from
`authKind`). The flow exposes `begin()` (what to show the user) and
`complete(input, pending)` (verify + capture). Flows:

- `DirectAuth` — the user already has a personal token; `begin()` shows instructions, the
  user pastes the token via `/connections add <service> <token>`, and a per-service
  `validate` closure (`connect-validators.ts`) confirms it. Todoist, Notion, GitHub.
- `OAuthPkceAuth` — the standard OAuth authorization-code flow with PKCE (RFC 7636), a
  two-step link. The first `/connections add <service>` calls `begin()`, which mints a
  `code_verifier` + `code_challenge` (S256) + CSRF `state`, shows the authorize link, and
  returns an opaque `pending` blob (the verifier + state); the handler stashes that blob
  via the `PendingAuthStore` (`pending-auth-store.ts`, a per-instance `.pending-auth.json`
  keyed by connector id, owner-bound and instance-key guarded like the token store). The
  user approves, lands on a loopback redirect (nothing needs to listen — the code is in
  the URL), and runs a second `/connections add <service> <pasted-url-or-code>`; the
  handler loads the `pending` blob, `complete()` validates the state and exchanges the
  code + verifier for tokens, and the blob is cleared on success. No client secret (public
  client); the client id is read from the environment at call time, never hardcoded. The
  MVP delivery is `paste`; a hosted `server-redirect` that auto-completes is a later UX
  upgrade. Google uses this flow but stays unavailable (see below) until
  `OPENCLAW_GOOGLE_CLIENT_ID` is set and the credential materializes into the box.
- `CliAuth` — a local CLI login placeholder; no catalog connector uses it now (Google
  moved to `OAuthPkceAuth`), but it is retained as the shape for a future CLI-login flow.

A connector and a skill are two layers. A *connector* captures one credential; a *skill*
is the installed tool that credential powers. One connector links to MANY skills:
`Connector.skills` (`connectors.ts`) lists the skill keys a single captured credential
enables, so linking Google is meant to light up every Google skill at once. The registry
indexes this both ways — `get(id)` for the connector, `forSkill(skillKey)` for the
inverse. `connector-skills.ts` holds the pure resolver: `skillsEnabledByConnection` /
`enabledSkillKeys` map an owner's connections to the deduped set of skill keys they enable
(only a `linked` connection enables its skills; `needs_reauth`/`not_linked` enable
nothing). These are the connection->skill LINKAGE only; actually injecting a credential
into a box (env var, a `gh` login, a gog cred file — it varies per skill) is a separate
materialization layer. Important » On prod the instances tree is mounted read-only (only
`shared/auth` is writable), so writing `.connections.json` throws `EROFS` (the router
catches it), which means direct-token connections are not currently persisted or
materialized into the boxes in production. Treat the connection store as best-effort until
that mount is made writable.

Skill keys are trimmed and case-insensitive throughout registry lookup and resolution.

Future direction (not built) » Today a materialized connection credential lands inside the
box (an env var, a `gh` login, a gog cred file under `/home`), so a compromised agent can
read its own connection secrets. The intended end state mirrors the existing model proxy »
a sibling **credential-broker** container, on its own network, holds the raw connection
secrets and exposes only scoped, per-service API calls the agent hooks into. The agent
then exercises a capability (make this Todoist call, send this Notion block) without ever
holding the token, the same way it reaches the model through the router's proxy without
holding the provider OAuth. Storing creds in the box home is acceptable only for the
current prototype; the broker is the real fix, and prompt-level secret hygiene (the safety
section in `docs/reference/templates/SYSTEM.md`) is defense in depth on top, never the
boundary.

The `/connections` slash-command reply is ephemeral by default, but — like `/debug` and
`/lifecycle` — it now honors the per-channel `ephemeralCommands` preference: a channel set
public via `/debug ephemeral off` defers its output with `flags: 0` so the result persists
for inspection during testing (see the preference carve-out in
[command-system.md](command-system.md)). That public output is acceptable by design » it
never contains the secret token (scrubbed from input and never echoed), only the validated
account label and which services are connected, and other than the static catalog command,
the command is owner-gated so it is the owner self-disclosing. `/connections available`
lists only the static service catalog and is accessible without registration or an owner
check. The text-command fallback is likewise public (Discord message replies cannot be
ephemeral) for the same reason. So do not force the public text fallback to be ephemeral
for privacy. Permission DENIALS, however, are always ephemeral regardless of the
preference. See the gating in [command-system.md](command-system.md), and still fix
genuine issues such as token leaks or mis-reported storage errors.

## Resource Limits and Self-Corruption

Escape is blocked (non-root, `cap_drop: ALL`, `no-new-privileges`, read-only root, no
docker socket, no host mounts), but a compromised or buggy agent still has two kinds of
in-box damage to think about, and the mitigations live in `agent.yml` /
`agent.Dockerfile`.

- **Self-corruption (accepted, contained).** `/workspace`, `/state`, and `/home/openclaw`
  are writable by design, so the agent can delete or corrupt its own sessions, memory
  index, and connection creds. This is self-inflicted and recoverable only from host-side
  copies; it never crosses the box boundary. Its "brain" is safe » the `openclaw`/`gog`
  binaries (`/bin/openclaw`, read-only mounts) and its config
  (`/etc/openclaw/openclaw.json`, read-only) cannot be overwritten. `/usr/local` and
  `/opt` are agent-owned and writable (that is the runtime-install feature), which also
  means the agent can shadow its own tools there » contained to its box, but a
  self-persistence vector to keep in mind.
- **Resource-exhaustion DoS (the cross-tenant risk).** The writable mounts are bind mounts
  from the shared DinD host disk and `/tmp` is RAM-backed, so an unbounded fork bomb,
  memory balloon, or disk fill in ONE box can starve every co-tenant box and the router.
  Mitigations that do **not** need cgroup delegation (which is unavailable in the deploy
  env, so `pids_limit`/`mem_limit` stay off » see the comment in `agent.yml`):
  > `tmpfs: /tmp:size=512m` caps the RAM-backed scratch space. `ulimits.fsize` caps any
  > single file (blunts one-shot disk fill of the host-backed mounts); `ulimits.nofile`
  > bounds fd exhaustion. setuid/setgid bits are stripped from the image
  > (`agent.Dockerfile`) » inert anyway under the runtime hardening, removed to shrink
  > surface. Residual, needing host support rather than a compose knob: a per-box **disk
  > quota** (`fsize` bounds one file, not many-small-files) and true per-container
  > **PID/RAM** caps (`pids_limit`/`mem_limit`) once cgroup v2 controller delegation is
  > confirmed on the host. `ulimits.nproc` is deliberately NOT used as a fork-bomb
  > stand-in » `RLIMIT_NPROC` is accounted per-uid host-wide, and every box runs as uid
  > 1000, so one value is shared across all boxes and a low value makes every box fail to
  > exec.

## Pitfalls

- Do not assume `security = "deny"` blocks execution in the box; it does not. If you need
  to actually restrict box commands, change the box config or the sandbox path, not just
  the security string.
- When adding a new connector, make sure its validated credential actually reaches the box
  the agent uses » Today the per-instance `.connections.json` write is blocked by the
  read-only prod mount (`EROFS`), so verify the delivery path end to end rather than
  assuming it persists. Keep the validated label the only account detail that surfaces in
  the public reply.
