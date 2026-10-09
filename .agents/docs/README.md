# agent docs

Shared, committed references for agents (CoderFish, Claude Code, and humans) working on
this OpenClaw fork. Each file explains one subsystem: how it works, how to test it, and
the pitfalls we have actually hit. `CLAUDE.md` is a symlink to `AGENTS.md`, and
`AGENTS.md` points here for extra context.

## This repo is public: keep every doc generic

`horsenuggets/openclaw` is a public repository, and everything under `.agents/` is tracked
(unlike the old `.claude/*`, which was gitignored except for `docs/`). So treat these docs
as if they were already public:

- No real Discord guild ids, bot or application ids, custom-emoji ids, or tokens.
- No machine or host names, SSH aliases, LAN or public IP addresses.
- No personal absolute paths (for example `/Users/<name>/...` or `C:\Users\<name>\...`).
- Refer to the production host generically as "the gateway host" or "the deploy host (from
  `OPENCLAW_DEPLOY_HOST`)", and read concrete identifiers from env or gitignored files at
  runtime rather than hardcoding them.

Repo-relative code paths (for example `src/discord/router/router.ts`) and generic env var
names are fine and encouraged. Private rig identifiers (lab guild, mirror and mock bot
ids, `.env.mirror` / `.prod-mirror/` contents) stay out of these docs; keep those in your
own local notes.

## Keep these docs current

When you change a subsystem, update its doc in the same change. These files are only
useful if they track reality, and memory snapshots go stale fast (this set already
corrected several). If a doc and the code disagree, trust the code and fix the doc.

## Index

- [architecture.md](architecture.md) - the fork's Docker multi-user production design and
  how this fork diverges from upstream OpenClaw. Start here.
- [command-system.md](command-system.md) - Discord slash and text commands, gating, the
  registration flow, and the control-command relay.
- [embed-system.md](embed-system.md) - embed categories, icon assets, application-emoji
  resolution, and the two outbound delivery paths.
- [deployment.md](deployment.md) - the deploy pipeline, the full-teardown setup,
  openclawctl, reconcile, and deploy gotchas.
- [logs-and-debugging.md](logs-and-debugging.md) - reading logs and session transcripts
  across prod, local, and the mirror rig, plus the non-intrusive smoke test.
- [heartbeats.md](heartbeats.md) - the heartbeat runner (the only proactive system), the
  silence ack, the delivery-target gap, and how to fast-test.
- [system-prompt.md](system-prompt.md) - how the embedded system prompt is built, the
  subscription prompt swap, and the system-reminder persona preamble.
- [auth-and-billing.md](auth-and-billing.md) - the Anthropic providers, OAuth minting and
  refresh, the shared auth store, plan-quota billing, and the model-catalog gotcha.
- [sandbox-and-permissions.md](sandbox-and-permissions.md) - the agent box sandbox, why
  exec runs unattended, the in-box command policy, and connection and secret
  materialization.
- [testing.md](testing.md) - the testing layers, from unit tests to the local prod-mirror
  rig to live E2E against the lab server.
- [prod-mirror-e2e-testing.md](prod-mirror-e2e-testing.md) - the full live E2E procedure
  on the local prod-mirror rig.
