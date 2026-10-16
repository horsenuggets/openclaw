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
its own location, so a `deploy` run from a worktree compiles that worktree's branch.

1. Create the worktree and `cd` into it. The `post-checkout` hook auto-provisions it: it
   copies the gitignored `.env`, `.env.mirror`, and `.prod-mirror/` from the main
   worktree, runs `pnpm install --ignore-scripts`, and then `pnpm build` so the worktree
   has its own `dist/`.
2. NEVER symlink `node_modules/` to the main checkout. pnpm wires each extension's
   `openclaw` package as a physical-path-relative symlink
   (`extensions/*/node_modules/openclaw -> ../../..`), so a symlinked `node_modules`
   resolves the `openclaw` package from MAIN's tree and the compiled binary silently ships
   MAIN's code, not your branch's. Each worktree must keep its own real `node_modules`. If
   the hook did not run (manual clone, or `OPENCLAW_SKIP_WORKTREE_BUILD=1`), run
   `pnpm install && pnpm build` in the worktree itself.
3. If the hook did not copy them, copy the rig creds into the worktree (they live in the
   original checkout where `up` was run):
   `mkdir -p .prod-mirror && cp -p <main>/.prod-mirror/{id_rig,id_rig.pub,box.env} .prod-mirror/`
   then `chmod 600 .prod-mirror/id_rig .prod-mirror/box.env`.
4. Check `box.env` has a non-empty `OPENCLAW_MOCK_USER_BOT_ID`. This is the big gotcha:
   without it the router drops the mock-user's chat as an "untrusted bot" and keeps
   re-firing onboarding, so only slash commands work and no conversation lands. A copied
   `box.env` can be stale and predate the id landing in `.env.mirror`. `prod-mirror.sh`
   now refuses to deploy a connected box when this is blank, pointing you back at
   `.env.mirror`.

## Deploy the Branch

Run `./scripts/prod-mirror.sh deploy` from the worktree. It recompiles the four linux
binaries from the current source by default, redeploys over the box's sshd, and restarts
the router and provisioner. Confirm the compile log shows the worktree path.

Recompiling is the default on purpose: a plain `deploy` must never resurrect a stale
`dist/` artifact on top of edited code (that previously shipped old binaries and made live
tests run code that did not match the working tree). After a deploy, confirm the shipped
binary actually carries your change by grepping it for a unique marker:
`docker exec openclaw-prod-mirror sh -lc 'grep -c "<a unique string from your edit>" /root/deploy/bin/openclaw'`
(expect a non-zero count). Markers can live in split bundle chunks, so grep the compiled
`dist/*-linux-<arch>` binary, not just `dist/entry.js`.

A deploy stops and recreates every registered `agents.channel-*` container with the new
binary (`setup.sh` removes all containers, `boot.sh` brings each channel back up), so
existing channels DO pick up new code. Workspace files are the exception » They are seeded
only when missing (`writeFileIfMissing`, `src/agents/workspace.ts`), so an existing
workspace keeps its OLD templates (e.g. `SOUL.md`). To exercise a template or other
workspace-file change, register a FRESH channel (or delete that file from the channel's
workspace so it gets re-seeded).

If you only changed env (e.g. adding `OPENCLAW_MOCK_USER_BOT_ID` to `box.env`) and the
`dist/*-linux-<arch>` binaries are already current, run `deploy --reuse` » It ships the
existing binaries and skips compilation; it still runs the full `setup.sh` teardown (every
container stopped and removed, then recreated), the same full-stack interruption as any
deploy, just faster. Only use `--reuse` when you are sure `dist/` matches the source you
want on the box. Verify:

```bash
docker exec openclaw-prod-mirror docker inspect services.discord-router \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep MOCK_USER
```

For a template change, confirm it shipped:

```bash
docker exec openclaw-prod-mirror \
  grep -n '<your new wording>' /root/deploy/docs/reference/templates/SOUL.md
```

## Skipping Onboarding (OPENCLAW_SKIP_BOOTSTRAP)

`OPENCLAW_SKIP_BOOTSTRAP` is a mirror-rig-only debug toggle. When truthy, the provisioner
(`infrastructure/scripts/openclawctl`) seeds each new channel's workspace normally
(`SOUL.md` and the other bootstrap files) and then removes just `BOOTSTRAP.md`, so the
agent keeps its full persona but the router has no first-run ritual to drive. It is
narrower than `agents.defaults.skipBootstrap`, which suppresses every workspace file and
leaves the agent persona-less.

Rules...

- Default OFF (unset). Leave it unset so the onboarding path is exercised like prod; the
  onboarding e2e only works when bootstrap runs.
- Pass it INLINE on the launch/deploy command when you want to skip onboarding for a quick
  functional test, e.g. `OPENCLAW_SKIP_BOOTSTRAP=1 ./scripts/prod-mirror.sh up` or
  `... deploy`. `prod-mirror.sh` forwards it from its own shell into the box's provisioner
  process (`start_provisioner` adds `docker exec -e OPENCLAW_SKIP_BOOTSTRAP=...` only when
  it is set), which is what reads it at provision time (via `openclawctl` workspace
  seeding). The provisioner must be (re)started for a change to take effect, so pass it on
  an `up`/`deploy` run, not after the box is already up.
- Never bake it into a committed or gitignored env file (`.env`, `.env.mirror`,
  `.prod-mirror/*`). It is a per-run debug flag, not configuration. This is the general
  convention for rig debug env vars » pass them inline on the launch command, do not store
  them.

With `BOOTSTRAP.md` absent, the router's `kickOnboarding` (`src/discord/router/router.ts`)
skips the first-run welcome embed, which used to be a silent no-op that made the cause
invisible. It now logs
`[router] skipping onboarding for channel <id>: BOOTSTRAP.md absent (likely OPENCLAW_SKIP_BOOTSTRAP set at provision time)`,
so if the welcome card never appears, grep the router logs for that line to confirm the
toggle (or a seeding failure) is the reason.

## Drive the Conversation

> **ALWAYS test inside a Lab Testing THREAD, never a loose guild channel.** Create the
> thread with `scripts/lab/create_new_thread.sh "<scenario title>"` (it prints the thread
> url; the last path segment is the thread id). Threads can be registered just like
> channels, and the `scripts/lab` archiver keeps them tidy on a schedule. A loose
> `POST /guilds/<guild>/channels` channel has no home in the Lab layout and has to be
> hand-moved into Sandbox or deleted afterwards — do not create them. See
> `.agents/docs/lab-server.md` for the Testing/Sandbox/Archive layout.

Drive the mock-user bot over the raw Discord REST API (`https://discord.com/api/v10`,
header `Authorization: Bot <token>`). The token is `DISCORD_E2E_BOT_TOKEN` from `box.env`;
source it with `set -a; source .prod-mirror/box.env; set +a` and read the guild id from
the env too (do not hardcode it).

Flow for a behavior check...

1. Create a Testing thread » `scripts/lab/create_new_thread.sh "<scenario title>"`, and
   take the thread id from the url it prints. Everything below uses that thread id as the
   channel id (a thread IS a channel to the REST API).
2. Register it » `POST /channels/<threadId>/messages {content: "/channel register"}`.
   Registration kicks onboarding, so the agent's first turn is the welcome greeting that
   asks for a name.
3. Post your probe messages and, after each, poll
   `GET /channels/<threadId>/messages?after=<lastId>` for messages whose author is a bot
   and is not the mock-user (those are the agent's/router's replies). Stop once the bot
   goes quiet for a few seconds.
4. Assert on the collected text/embeds. Do not hardcode the router bot id (bots get
   renamed); derive the mock-user id from `GET /users/@me` and treat every other bot
   author as the agent/router.

A worked example driver lives in `.prod-mirror/e2e-debug-commands.mjs` (gitignored): it
registers a thread passed as `argv[2]` and asserts each `/debug` reply is a title-less
Debug embed. Keep finished drivers in `.prod-mirror/` as evidence.

Pick probes that surface the change. A tone edit was verified with » Give a capitalized
name ("call me Alexander") and check the reply says "alexander"; ask for a web search
(unconfigured) and check it says "brave search api" not "Brave Search API"; count `:)`
across all turns. Keep the finished driver in gitignored `.prod-mirror/` as evidence (e.g.
`.prod-mirror/e2e-tone.mjs`).

For organizing scratch scenarios on the Lab server itself (not the DinD rig),
`scripts/lab/create_new_thread.sh` creates a dated `Testing` day channel and a numbered
thread for each scenario, and the sibling `scripts/lab` scripts archive expired days into
the `Archive NNNN` categories. Those scripts talk to the Lab server as the Mirror bot and
read their ids from env; see `.agents/docs/lab-server.md` for the full workflow.

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
- Do NOT `docker cp` a binary into the box's `/root/deploy/bin/` to "quickly" update it.
  That copy is transient: any later `up`/`deploy` overwrites it, and because the agent and
  router containers bind-mount those binaries, replacing the file creates a new inode a
  running container will not pick up until it is RECREATED (a plain `docker restart` is
  not enough). The supported way to update rig binaries is `deploy` (which recompiles by
  default). If you must hand-place a binary for a one-off, recreate the affected container
  afterward and expect the next deploy to replace it.
- Leave the test channel in place as evidence. Do not auto-delete channels or driver
  scripts after a run.
