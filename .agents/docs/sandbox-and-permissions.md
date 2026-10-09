# sandbox and permissions

What the per-channel agent box can and cannot do, why its exec tool runs unattended, and
how connection and secret values reach it. The box itself is described in
[architecture.md](architecture.md).

## The exec tool runs unattended in the box

This is the important, non-obvious fact. The deployed agent box
(`infrastructure/docker/agent.yml`) runs with a box `openclaw.json` that has no
`tools.exec` block, so exec resolves to `host = "sandbox"`, `security = "deny"`,
`ask = "on-miss"`, with no interactive approval responder present.

Despite `security = "deny"`, the exec tool still runs commands with no approval prompt. In
`src/agents/bash-tools.exec.ts` the hard deny throw only fires in the `host === "node"`
and `host === "gateway"` branches. The `host === "sandbox"` path has no deny gate: it
flows straight to running the command in the sandbox. So inside the box the agent can
`cat` files, run pipes, and invoke CLIs unattended; the deny semantics only ever applied
to node and gateway execution, which the box never uses.

Implication: an agent inside the box can read its own delivered secrets (for example the
`/secret` command's delivery target) and can drive external CLIs. Treat the box boundary
(the hardened container: read-only root, dropped capabilities, no new privileges, non-root
user) as the real security boundary, not the `security = "deny"` string.

## In-box command policy

`src/auto-reply/command-policy.ts` gates in-session `/word` commands inside the box.
`ENABLED_COMMAND_KEYS` is intentionally empty, because this fork owns `/channel`,
`/lifecycle`, and `/secret` host-side in the router. Inside the box no in-session command
is enabled, so such text reaches the model as plain content.

## Secrets

`/secret` (host-side, `src/discord/router/secret-command.ts`) collects a sensitive value
through a Discord modal so it never appears in the channel or logs, then delivers it to
the box (its delivery target is a file the box can read). Because exec runs unattended
(above), the agent can read that file on demand.

## Connections

`/connections` (`src/discord/router/connect-commands.ts`) links external accounts for the
channel's agent. Paste-token connectors (Todoist, Notion, GitHub) are live; Google via gog
is coming soon and is still marked unavailable in `connectors.ts` pending a shared OAuth
client. The validated credentials are materialized into the box by
`applyConnectionCredentials` (`src/agents/connections/credentials.ts`), wired into the
embedded runner's attempt and compact paths, so the box gets the credential at run time.

The `/connections` reply is intentionally public (non-ephemeral). It never contains the
secret token (the token is scrubbed from input and never echoed); it only exposes the
validated account label and which services are connected, which are considered
non-sensitive, and the command is owner-gated so it is the owner self-disclosing. Do not
"fix" this to be ephemeral-only for privacy; see the gating in
[command-system.md](command-system.md). Still fix genuine issues such as token leaks or
mis-reported storage errors.

## Pitfalls

- Do not assume `security = "deny"` blocks execution in the box; it does not. If you need
  to actually restrict box commands, change the box config or the sandbox path, not just
  the security string.
- When adding a new connector, materialize its credential into the box home the agent
  actually uses, and keep the validated label the only account detail that surfaces in the
  public reply.
