# Testing

The testing layers for this fork, from fastest to most realistic. Prefer the cheapest
layer that can actually catch the bug. The repo-wide testing kit is in `docs/testing.md`;
this doc covers the fork-specific layers and their gotchas.

## Layer 1 » Unit Tests and Build

Most changes are verifiable with `npx vitest run <file>` and `pnpm build`. Do not start
the full gateway, a watchdog, or a Discord connection unless you actually need live
behavior; use mocks for Discord API calls, CLI invocations, and external services. Extract
decision logic into pure helpers and test those, mocking only the boundaries.

One trap » `discord-health-monitor/` is outside `tsconfig.json`'s `include`, so
`pnpm tsgo` and `pnpm build` never typecheck it (it is compiled separately as a bun
binary). A missing import there sails through the whole CI gate and only fails at runtime.
When editing anything under `discord-health-monitor/`, verify it resolves with a bun
bundle:
`bun build discord-health-monitor/entry.ts --bundle --target=node --outfile /tmp/hm.js`.

## Layer 2 » Isolated Gateway

`openclaw gateway run --isolated` creates a throwaway environment (temp state dir,
auto-picked port, no channels, loopback-only). Use `--port <N>` on the gateway for a
specific port, and send a test message with `openclaw agent` against it (see
`docs/testing.md` for the exact isolated-gateway invocation). Multiple isolated instances
can run at once. Always stop any gateway you start » `pnpm gateway:killall` (and
`pnpm gateway:ps` to see what is running). Never leave gateway processes running.

## Layer 3 » The Local Prod-Mirror Rig

`scripts/prod-mirror.sh` boots one privileged docker-in-docker box on your machine and
runs the real deploy pipeline inside it, so the router, provisioner, and per-channel agent
boxes come up exactly like prod (including bridge networking, which bare containers cannot
do on macOS Docker Desktop). This is how you verify the router delivery path, embeds,
onboarding, and other agent-visible behavior against branch code before merging. The full
procedure (worktree setup, deploying branch code, the mock-user driver pattern, minting,
and the many gotchas) is in [prod-mirror-e2e-testing.md](prod-mirror-e2e-testing.md).

The rig is offline by default (it ships a blank Discord token so it never fights prod for
the bot session). `up --live` connects a dedicated mirror bot (never the production bot)
to the dedicated lab server. Read the lab guild and bot ids from the gitignored
`.env.mirror` and `.prod-mirror/box.env` at runtime; never hardcode them, and never test
with the production bot or a real server.

## Layer 4 » The Discord E2E Suite

`src/discord/e2e/*.e2e.test.ts` hit real Discord and need two bots » A driver (test) bot
and the bot under test running as a gateway. These can run against the rig's
bot-under-test. Key operational notes...

- The rig is a single box, so registered-channel agent containers accumulate and can
  OOM-kill it. Stop and prune stale `agents.channel-*` containers and restart the router
  before a run, and run the suite serially (`--maxWorkers=1`) for a clean tally; parallel
  runs on one box cause contention failures that are not real bugs.
- Some tests cannot pass against the containerized rig by nature » The ones that write a
  probe file to the host tmpdir and ask the box to read an absolute host path (the box
  shares no filesystem with the host), and `voice-transcription` (manual, and whisper is
  not built for linux-arm64).
- The agent box reaches the model through the router model-proxy using the minted
  subscription token in the shared auth store; it expires in about a day, so re-mint if
  replies start failing.

## Conventions

- Leave test artifacts in place. Do not auto-delete the Discord channels or driver scripts
  an E2E run creates; they are the user's evidence, and deleted Discord channels cannot be
  recovered. Tearing down ephemeral infra (the rig box, temp processes) is fine.
- Work in a worktree, and symlink `node_modules/` from the main checkout into it. A
  worktree has no `node_modules/`, so the pre-commit hook and `pnpm exec prettier` resolve
  a non-fork prettier that reformats markdown differently from CI and silently fails the
  format gate. Linking the main checkout's `node_modules/` makes the worktree resolve the
  pinned fork.
