# Prod-Mirror E2E Testing

How to live-test OpenClaw agent behavior end-to-end in a real Discord channel using the
local prod-mirror rig.

This doc is intentionally generic » The real lab guild id, bot ids, and tokens live in the
gitignored `.env.mirror` / `.prod-mirror/box.env` (and the operator's private notes),
never here. Read the identifiers from those env files at runtime rather than hardcoding
them.

## When to Use It

The prod-mirror rig runs the full prod stack (Discord router + provisioner + per-channel
agent containers) inside one privileged docker-in-docker box on the host, so you can drive
a real Discord conversation against branch code before merging.

Reach for it only when a change affects agent-visible behavior you cannot confirm any
other way » Persona/tone (`SOUL.md`), onboarding, routing, command gating. For pure logic,
unit tests plus `pnpm build` are faster.

Test identity is always the dedicated mirror bot in the dedicated test ("lab") server,
driven by a separate mock-user bot. Never use the production bot or a real server. The
relevant values are...

- Lab guild id -> `.env.mirror` / `box.env` (not in this doc).
- Mock-user (driver) bot id -> `box.env` as `OPENCLAW_MOCK_USER_BOT_ID`; the driver can
  also read it at runtime from `GET /users/@me`.
- Router/bot-under-test id and all tokens -> `.prod-mirror/box.env` (gitignored), built
  from the repo `.env` plus `.env.mirror` (the mirror overlay).

## Setup

Work from a worktree so main stays clean. `scripts/prod-mirror.sh` computes its root from
its own location, so a `deploy --build` run from a worktree compiles that worktree's
branch.

1. Create the worktree and `cd` into it.
2. Symlink `node_modules/` to the main checkout's (worktrees have none, and a build needs
   it; a non-fork prettier can also corrupt markdown):
   `ln -s <main>/node_modules node_modules`.
3. Copy the rig creds into the worktree (they live in the original checkout where `up` was
   run):
   `mkdir -p .prod-mirror && cp -p <main>/.prod-mirror/{id_rig,id_rig.pub,box.env} .prod-mirror/`
   then `chmod 600 .prod-mirror/id_rig .prod-mirror/box.env`.
4. Check `box.env` has a non-empty `OPENCLAW_MOCK_USER_BOT_ID`. This is the big gotcha:
   without it the router drops the mock-user's chat as an "untrusted bot" and keeps
   re-firing onboarding, so only slash commands work and no conversation lands. A copied
   `box.env` can be stale and predate the id landing in `.env.mirror`. `prod-mirror.sh`
   now refuses to deploy a connected box when this is blank, pointing you back at
   `.env.mirror`.

## Deploy the Branch

Run `./scripts/prod-mirror.sh deploy --build` from the worktree. It recompiles the four
linux binaries, redeploys over the box's sshd, and restarts the router and provisioner.
Confirm the compile log shows the worktree path.

A deploy stops and recreates every registered `agents.channel-*` container with the new
binary (`setup.sh` removes all containers, `boot.sh` brings each channel back up), so
existing channels DO pick up new code. Workspace files are the exception » They are seeded
only when missing (`writeFileIfMissing`, `src/agents/workspace.ts`), so an existing
workspace keeps its OLD templates (e.g. `SOUL.md`). To exercise a template or other
workspace-file change, register a FRESH channel (or delete that file from the channel's
workspace so it gets re-seeded).

If you only changed env (e.g. adding `OPENCLAW_MOCK_USER_BOT_ID` to `box.env`), skip
`--build` and run `deploy` alone » It reuses the binaries and just recreates the router
with the new env. Verify:

```bash
docker exec openclaw-prod-mirror docker inspect services.discord-router \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep MOCK_USER
```

For a template change, confirm it shipped:

```bash
docker exec openclaw-prod-mirror \
  grep -n '<your new wording>' /root/deploy/docs/reference/templates/SOUL.md
```

## Drive the Conversation

Drive the mock-user bot over the raw Discord REST API (`https://discord.com/api/v10`,
header `Authorization: Bot <token>`). The token is `DISCORD_E2E_BOT_TOKEN` from `box.env`;
source it with `set -a; source .prod-mirror/box.env; set +a` and read the guild id from
the env too (do not hardcode it).

Flow for a behavior check...

1. Create a channel » `POST /guilds/<guild>/channels` with `{name, type: 0}`.
2. Register it » `POST /channels/<id>/messages {content: "/channel register"}`.
   Registration kicks onboarding, so the agent's first turn is the welcome greeting that
   asks for a name.
3. Post your probe messages and, after each, poll
   `GET /channels/<id>/messages?after=<lastId>` for messages whose author is a bot and is
   not the mock-user (those are the agent's replies). Stop once the bot goes quiet for a
   few seconds.
4. Assert on the collected text. Do not hardcode the router bot id (bots get renamed);
   derive the mock-user id from `GET /users/@me` and treat every other bot author as the
   agent.

Pick probes that surface the change. A tone edit was verified with » Give a capitalized
name ("call me Alexander") and check the reply says "alexander"; ask for a web search
(unconfigured) and check it says "brave search api" not "Brave Search API"; count `:)`
across all turns. Keep the finished driver in gitignored `.prod-mirror/` as evidence (e.g.
`.prod-mirror/e2e-tone.mjs`).

## Gotchas and Cleanup

- Single-box contention is the main failure mode. Every registered channel leaves a
  persistent `agents.channel-<id>` container behind; they accumulate and OOM-kill the box.
  Before a run, stop and remove stale agent containers and restart the router:
  ```bash
  docker exec openclaw-prod-mirror bash -c 'ids=$(docker ps -aq --filter name=agents.channel); for i in $ids; do docker update --restart=no $i; done; docker stop $ids; docker rm $ids; docker restart services.discord-router'
  ```
- A `deploy` recreates agent containers from persisted instance state, so cleaning them
  does not keep them gone across a redeploy. Only register a fresh channel when you need a
  fresh workspace (e.g. a template change); otherwise reuse existing channels to avoid
  piling up more persistent instances.
- The agent reaches the model through the router model-proxy using a minted subscription
  token in the box shared auth store. It expires about 24h after minting; re-mint with
  `scripts/prod-mirror.sh mint` if replies start 502-ing.
- `services.whisper` is skipped unless BOTH its binary (`~/deploy/bin/whisper-server`) and
  model (`~/deploy/models/ggml-base.en.bin`) are provisioned, so on Apple Silicon (no
  linux-arm64 whisper build) the container simply does not start. Voice transcription is
  absent until you stage both artifacts; the box is no longer degraded by a crash loop.
- Leave the test channel in place as evidence. Do not auto-delete channels or driver
  scripts after a run.
